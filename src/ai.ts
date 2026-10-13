import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';

type PdfOcgConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { Layer } from 'ag-psd';
import { type Doc, type Node, type AiDocBacking, walk } from './model';
import { exportAiWithPdfLib } from './aiPdfLib';

GlobalWorkerOptions.workerSrc = pdfWorker;

let uid = 0;
const nextId = () => `ai${++uid}`;
const newDocId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function assertPdfAi(buf: ArrayBuffer, name: string) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf.slice(0, 8)));
  if (!head.startsWith('%PDF-')) {
    throw new Error(
      `"${name}" is not a PDF-compatible .ai file (legacy PostScript/EPS .ai is not supported in v1).`,
    );
  }
}

/** Best-effort OCG layer names from PDF object markers. */
export function parseOcgNames(buf: ArrayBuffer): string[] {
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
  const names: string[] = [];
  const re = /\/Type\s*\/OCG[\s\S]{0,800}?\/Name\s*\(([^)]*)\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = m[1].trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

/** Object refs listed under `/OCGs[...]` in the document catalog. */
export function parseOcgRefs(buf: ArrayBuffer): string[] {
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
  const m = text.match(/\/OCGs\[([^\]]*)\]/);
  if (!m?.[1]) return [];
  const refs: string[] = [];
  const re = /(\d+)\s+0\s+R/g;
  for (let hit = re.exec(m[1]); hit; hit = re.exec(m[1])) {
    refs.push(`${hit[1]} 0 R`);
  }
  return refs;
}

const EXT_GSTATE_DICT_RE = /<<[^>]*\/Type\s*\/ExtGState[^>]*>>/;

/** Read non-stroking opacity from the first PDF ExtGState dictionary (`/ca`). */
export function parseExtGStateOpacity(buf: ArrayBuffer): number | null {
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
  const dict = text.match(EXT_GSTATE_DICT_RE)?.[0];
  if (!dict) return null;
  const m = dict.match(/\/ca\s+([\d.]+)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
}

function formatPdfOpacity(opacity: number): string {
  const v = Math.max(0, Math.min(1, opacity));
  if (v === 0) return '0.0';
  if (v === 1) return '1.0';
  const rounded = Math.round(v * 100) / 100;
  const s = String(rounded);
  return s.includes('.') ? s : `${s}.0`;
}

/** After export, confirm `/ca` in the file matches the requested layer opacity. */
export function verifyExportedExtGStateOpacity(bytes: ArrayBuffer, expected: number): {
  ok: boolean;
  read: number | null;
} {
  const read = parseExtGStateOpacity(bytes);
  if (read === null) return { ok: false, read: null };
  return { ok: Math.abs(read - expected) < 0.015, read };
}

function pdfBytesForRender(original: ArrayBuffer, fileOpacity: number | null): Uint8Array {
  if (fileOpacity == null || Math.abs(fileOpacity - 1) < 1e-3) {
    return new Uint8Array(original.slice(0));
  }
  const r = patchExtGStateOpacity(new Uint8Array(original.slice(0)), 1);
  return r.ok ? r.bytes : new Uint8Array(original.slice(0));
}

function patchExtGStateOpacity(bytes: Uint8Array, opacity: number): { ok: boolean; bytes: Uint8Array } {
  const text = new TextDecoder('latin1').decode(bytes);
  const oldBlock = text.match(EXT_GSTATE_DICT_RE)?.[0];
  if (!oldBlock || !/\/ca\s+[\d.]+/.test(oldBlock) || !/\/CA\s+[\d.]+/.test(oldBlock)) {
    return { ok: false, bytes };
  }
  const o = formatPdfOpacity(opacity);
  const newBlock = oldBlock
    .replace(/\/ca\s+[\d.]+/, `/ca ${o}`)
    .replace(/\/CA\s+[\d.]+/, `/CA ${o}`);
  if (newBlock === oldBlock) return { ok: true, bytes };
  return patchPdfLatin1(bytes, oldBlock, newBlock);
}

function applyFileOpacityToNodes(roots: Node[], opacity: number) {
  for (const n of walk(roots)) {
    if (n.kind === 'group') continue;
    n.opacity = opacity;
    n.src.opacity = opacity;
  }
}

function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Shift xref byte offsets and `startxref` after an in-place length change before the xref table. */
function fixPdfXrefAfterInsert(text: string, patchPos: number, delta: number): string {
  if (delta === 0) return text;
  const xrefIdx = text.lastIndexOf('xref');
  if (xrefIdx < 0) return text;

  const trailerIdx = text.indexOf('trailer', xrefIdx);
  const head = text.slice(0, xrefIdx);
  let xrefBody = text.slice(xrefIdx, trailerIdx >= 0 ? trailerIdx : text.length);
  const tail = trailerIdx >= 0 ? text.slice(trailerIdx) : '';

  xrefBody = xrefBody.replace(/^(\d{10}) (\d{5}) ([fn])/gm, (line, offStr, gen, flag) => {
    const off = parseInt(offStr, 10);
    if (off > patchPos) {
      return `${String(off + delta).padStart(10, '0')} ${gen} ${flag}`;
    }
    return line;
  });

  const fixedTail = tail.replace(/startxref\r?\n(\d+)/, (_, n) => {
    const v = parseInt(n, 10);
    return `startxref\n${v > patchPos ? v + delta : v}`;
  });

  return head + xrefBody + fixedTail;
}

/** Replace the first `search` span; updates xref when the replacement changes byte length. */
function patchPdfLatin1(bytes: Uint8Array, search: string, replace: string): { ok: boolean; bytes: Uint8Array } {
  const text = new TextDecoder('latin1').decode(bytes);
  const idx = text.indexOf(search);
  if (idx < 0) return { ok: false, bytes };
  let newText = text.slice(0, idx) + replace + text.slice(idx + search.length);
  const delta = replace.length - search.length;
  if (delta !== 0) newText = fixPdfXrefAfterInsert(newText, idx, delta);
  return { ok: true, bytes: latin1Encode(newText) };
}

async function loadPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data, isEvalSupported: false }).promise;
}

async function renderPageToCanvas(
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  scale: number,
  optionalContentConfig?: PdfOcgConfig,
) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the AI preview.');
  await page.render({
    canvasContext: ctx,
    viewport,
    optionalContentConfigPromise: optionalContentConfig
      ? Promise.resolve(optionalContentConfig)
      : undefined,
  }).promise;
  return { canvas, viewport };
}

function ocgIndexForNode(n: Node): number | null {
  const m = /^ocg-(\d+)$/.exec(n.key);
  if (m) return parseInt(m[1], 10);
  if (n.key === '0') return 0;
  return null;
}

function leavesByOcgIndex(doc: Doc): Map<number, Node> {
  const map = new Map<number, Node>();
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') continue;
    const i = ocgIndexForNode(n);
    if (i !== null && !map.has(i)) map.set(i, n);
  }
  return map;
}

async function buildLayerRoots(
  pdf: PDFDocumentProxy,
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  scale: number,
  width: number,
  height: number,
  ocgNames: string[],
  unsupportedBase: string[],
): Promise<Node[]> {
  if (ocgNames.length === 0) {
    const { canvas } = await renderPageToCanvas(page, scale);
    return [buildLeaf('Artwork', canvas, width, height, 'artwork-0', [...unsupportedBase])];
  }

  const baseCfg = await pdf.getOptionalContentConfig();
  const nameToId = new Map<string, string>();
  const order = baseCfg.getOrder() ?? [];
  for (const id of order) {
    const g = baseCfg.getGroup(id);
    const nm = (g as { name?: string } | null)?.name;
    if (nm) nameToId.set(nm, id);
  }

  const roots: Node[] = [];
  for (let i = 0; i < ocgNames.length; i++) {
    const name = ocgNames[i];
    const cfg = await pdf.getOptionalContentConfig();
    const ids = cfg.getOrder() ?? order;
    for (const id of ids) cfg.setVisibility(id, false);
    const gid = nameToId.get(name);
    if (gid) cfg.setVisibility(gid, true);
    else if (ids.length === 1) cfg.setVisibility(ids[0], true);

    const { canvas } = await renderPageToCanvas(page, scale, cfg);
    roots.push(buildLeaf(name, canvas, width, height, `ocg-${i}`, [...unsupportedBase]));
  }
  return roots;
}

function stubLayer(name: string, w: number, h: number, canvas: HTMLCanvasElement): Layer {
  return { name, left: 0, top: 0, right: w, bottom: h, canvas, hidden: false, opacity: 1 };
}

function buildLeaf(
  name: string,
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  key: string,
  unsupported: string[],
): Node {
  return {
    id: nextId(),
    key,
    name,
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w,
    h,
    rotation: 0,
    ow: w,
    oh: h,
    ox: 0,
    oy: 0,
    canvas,
    children: [],
    parent: null,
    src: stubLayer(name, w, h, canvas),
    unsupported,
  };
}

/**
 * Import a PDF-compatible `.ai` file: render page 1 for the canvas, build a minimal layer tree.
 */
export async function importAi(name: string, buf: ArrayBuffer): Promise<Doc> {
  // Keep a copy pdf.js never transfers to its worker (getDocument can detach the buffer it parses).
  const original = buf.slice(0);
  assertPdfAi(original, name);
  const ocgNames = parseOcgNames(original);
  const ocgRefs = parseOcgRefs(original);
  const hasAiprivate = new TextDecoder('latin1').decode(new Uint8Array(original)).includes('AIPrivateData');
  const fileOpacity = parseExtGStateOpacity(original);
  const hasExtGStateOpacity = fileOpacity != null;
  const pdfData = pdfBytesForRender(original, fileOpacity);

  let pdf: PDFDocumentProxy;
  try {
    pdf = await loadPdf(pdfData);
  } catch (e) {
    throw new Error(`"${name}" could not be read as PDF (${(e as Error).message}). The file may be damaged.`);
  }

  if (pdf.numPages < 1) {
    throw new Error(`"${name}" has no pages to display.`);
  }

  const page = await pdf.getPage(1);
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const baseViewport = page.getViewport({ scale });
  const width = Math.round(baseViewport.width / scale);
  const height = Math.round(baseViewport.height / scale);

  const warnings: string[] = [];
  const unsupportedBase: string[] = [];

  if (hasAiprivate && ocgNames.length === 0) {
    unsupportedBase.push(
      'Illustrator native layers (AIPrivateData) are preserved in the file but not parsed; showing a flat PDF preview.',
    );
  }
  if (ocgNames.length > 1) {
    warnings.push(
      `This file has ${ocgNames.length} PDF optional layers (${ocgNames.join(', ')}). Each is shown as its own preview layer.`,
    );
  }
  unsupportedBase.push(
    'Vector anchor point editing stays in Illustrator. Move, resize, rotate, opacity, visibility, and layer names are exported to the PDF stream.',
  );
  if (hasExtGStateOpacity) {
    unsupportedBase.push(
      'Opacity is stored in PDF ExtGState when you export (re-import reads it back).',
    );
  } else if (ocgNames.length === 0) {
    unsupportedBase.push('PDF opacity (ExtGState) was not found in the original file; export creates ExtGState entries.');
  }

  const roots = await buildLayerRoots(pdf, page, scale, width, height, ocgNames, unsupportedBase);
  if (hasExtGStateOpacity && fileOpacity != null) applyFileOpacityToNodes(roots, fileOpacity);

  const ai: AiDocBacking = {
    kind: 'ai',
    pageCount: pdf.numPages,
    hasOcg: ocgNames.length > 0,
    ocgNames: [...ocgNames],
    ocgRefs: [...ocgRefs],
    hasExtGStateOpacity,
    extGStateCaAtImport: fileOpacity ?? 1,
  };

  const pageCount = pdf.numPages;
  await pdf.destroy();

  const doc: Doc = {
    id: newDocId(),
    name: name.toLowerCase().endsWith('.ai') ? name : `${name}.ai`,
    format: 'ai',
    width,
    height,
    offsetX: 0,
    offsetY: 0,
    roots,
    ai,
    original,
    warnings,
  };

  if (pageCount > 1) {
    doc.warnings.push(`Only page 1 of ${pageCount} is shown. Additional pages are kept in the file on export.`);
  }

  const missing = [...walk(doc.roots)].filter((n) => n.kind !== 'group' && !n.canvas);
  if (missing.length) {
    doc.warnings.push(`${missing.length} layer(s) have no preview pixels.`);
  }

  return doc;
}

/** Fetch a public sample `.ai` (Phase C demos). */
export async function fetchPublicAi(path: string, displayName: string): Promise<Doc> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return importAi(displayName, await res.arrayBuffer());
}

function escapePdfLiteralString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function ocgNameMarkers(name: string): string[] {
  const inner = escapePdfLiteralString(name);
  return [`/Name (${inner})`, `/Name(${inner})`];
}

function patchOcgVisibility(bytes: Uint8Array, ref: string, visible: boolean): { ok: boolean; bytes: Uint8Array } {
  const onWithRef = `/ON[${ref}]`;
  const onEmpty = `/ON[]`;
  const offWithRef = `/OFF[${ref}]`;
  const offEmpty = `/OFF[]`;

  const pairs: [string, string][] = visible
    ? [
        [`${onEmpty}${offWithRef}`, `${onWithRef}${offEmpty}`],
        [`${onEmpty}/${offWithRef}`, `${onWithRef}/${offEmpty}`],
        [`${onEmpty}/OFF[${ref}]`, `${onWithRef}/OFF[]`],
      ]
    : [
        [`${onWithRef}/OFF[]`, `${onEmpty}${offWithRef}`],
        [`${onWithRef}/${offEmpty}`, `${onEmpty}/${offWithRef}`],
        [`${onWithRef}/Order`, `${onEmpty}${offWithRef}/Order`],
      ];

  for (const [from, to] of pairs) {
    const r = patchPdfLatin1(bytes, from, to);
    if (r.ok) return r;
    bytes = r.bytes;
  }
  return { ok: false, bytes };
}

/** Copy model edits into stub layers and patch PDF optional-content metadata when possible. */
export function syncToAi(doc: Doc, bytes: Uint8Array): { bytes: Uint8Array; notes: string[] } {
  const notes: string[] = [];
  if (!doc.ai) return { bytes, notes };

  for (const n of walk(doc.roots)) {
    n.src.name = n.name;
    n.src.hidden = !n.visible;
    n.src.opacity = n.opacity;
  }

  const byOcg = leavesByOcgIndex(doc);

  for (let i = 0; i < doc.ai.ocgNames.length; i++) {
    const oldName = doc.ai.ocgNames[i];
    const node = byOcg.get(i);
    if (!node || oldName === node.name) continue;

    const replacements = ocgNameMarkers(node.name);
    const searches = ocgNameMarkers(oldName);
    let patched = false;
    for (const search of searches) {
      for (const rep of replacements) {
        const r = patchPdfLatin1(bytes, search, rep);
        bytes = r.bytes;
        if (r.ok) {
          doc.ai.ocgNames[i] = node.name;
          patched = true;
          break;
        }
      }
      if (patched) break;
    }
    if (!patched) {
      notes.push(
        `Layer "${node.name}" is renamed in the panel but the PDF still contains "${oldName}" (no matching OCG name marker).`,
      );
    }
  }

  if (doc.ai.ocgRefs.length === 1) {
    const node = byOcg.get(0) ?? [...walk(doc.roots)].find((n) => n.kind !== 'group');
    const ref = doc.ai.ocgRefs[0];
    if (node && ref) {
      const r = patchOcgVisibility(bytes, ref, node.visible);
      bytes = r.bytes;
      if (!r.ok && !node.visible) {
        notes.push('Could not write layer visibility into the PDF (unsupported OCProperties layout).');
      }
    }
  }

  const leafNodes = [...walk(doc.roots)].filter((x) => x.kind !== 'group');
  if (doc.ai.hasExtGStateOpacity && leafNodes.length) {
    const opacities = leafNodes.map((n) => n.opacity);
    const first = opacities[0];
    const mixed = opacities.some((o) => Math.abs(o - first) > 1e-3);
    if (mixed) {
      notes.push('Multiple layer opacities: exported PDF ExtGState uses the first layer’s opacity.');
    }
    const r = patchExtGStateOpacity(bytes, first);
    bytes = r.bytes;
    if (!r.ok) {
      notes.push(
        `Could not write opacity (${formatPdfOpacity(first)}) into the PDF ExtGState dictionary (object not found or not patchable).`,
      );
    }
  } else if (leafNodes.some((n) => Math.abs(n.opacity - 1) > 1e-3)) {
    notes.push('Opacity is not written into this .ai file (no patchable PDF ExtGState).');
  }

  for (const n of leafNodes) {
    if (
      n.x !== n.ox ||
      n.y !== n.oy ||
      n.w !== n.ow ||
      n.h !== n.oh ||
      Math.abs(n.rotation) > 1e-3
    ) {
      notes.push('Move, scale, or rotate on .ai layers is canvas-only until PDF content patching is supported.');
      break;
    }
  }

  return { bytes, notes };
}

/** Export Illustrator document using pdf-lib clean stream patching with fallback to legacy byte-patching. */
export async function exportAi(doc: Doc): Promise<ArrayBuffer> {
  if (doc.format !== 'ai' || !doc.ai) {
    throw new Error('Export to .ai requires an imported Illustrator document.');
  }
  if (!doc.original?.byteLength) {
    throw new Error('This document has no original file bytes to export.');
  }

  try {
    const { bytes, notes } = await exportAiWithPdfLib(doc);
    assertPdfAi(bytes, doc.name);

    if (notes.length) {
      const tag = 'Export note: ';
      for (const note of notes) {
        if (!doc.warnings.includes(tag + note)) doc.warnings.push(tag + note);
      }
    }
    return bytes;
  } catch (pdfLibErr) {
    console.warn('pdf-lib export failed, attempting legacy byte patching fallback:', pdfLibErr);

    let { bytes: out, notes: patchNotes } = syncToAi(doc, new Uint8Array(doc.original.slice(0)));
    const outBuf = new Uint8Array(out).buffer;
    assertPdfAi(outBuf, doc.name);

    const opacityFail = patchNotes.find((n) => n.startsWith('Could not write opacity'));
    if (opacityFail) {
      throw new Error(opacityFail);
    }

    if (doc.ai.hasExtGStateOpacity) {
      const leaves = [...walk(doc.roots)].filter((n) => n.kind !== 'group');
      const target = leaves[0]?.opacity ?? 1;
      const verify = verifyExportedExtGStateOpacity(outBuf, target);
      if (!verify.ok) {
        const exp = formatPdfOpacity(target);
        const got = verify.read == null ? 'missing' : formatPdfOpacity(verify.read);
        throw new Error(
          `Opacity export verification failed: PDF ExtGState /ca is ${got}, expected ${exp}. Re-open the downloaded file to confirm.`,
        );
      }
    }

    if (patchNotes.length) {
      const tag = 'Export note: ';
      for (const note of patchNotes) {
        if (!doc.warnings.includes(tag + note)) doc.warnings.push(tag + note);
      }
    }

    return outBuf;
  }
}

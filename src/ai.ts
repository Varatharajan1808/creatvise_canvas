import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';

type PdfOcgConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { Layer } from 'ag-psd';
import { type Doc, type Node, type AiDocBacking, walk } from './model';
import {
  exportAiWithPdfLib,
  decomposePdfTransformMatrix,
  readInjectedLayerTransforms,
  readPageExtGStateOpacity,
  neutralizePageExtGStateOpacity,
  type PdfMatrix,
} from './aiPdfLib';
import {
  applyAiVectorShapeImport,
  docHasAiShapeStreamEdits,
  readFirstPageContentStreamText,
} from './aiVectorShapes';

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

/** Object refs listed under `/OFF[...]` in the default optional-content configuration. */
export function parseOcgOffRefs(buf: ArrayBuffer): string[] {
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
  const m = text.match(/\/OFF\[([^\]]*)\]/);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/(\d+)\s+0\s+R/g)].map((hit) => `${hit[1]} 0 R`);
}

const EXT_GSTATE_DICT_RE = /<<[^>]*\/Type\s*\/ExtGState[^>]*>>/;

/** Read non-stroking opacity from the first plaintext PDF ExtGState dictionary (`/ca`). */
export function parseExtGStateOpacityLatin1(buf: ArrayBuffer): number | null {
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
  const dict = text.match(EXT_GSTATE_DICT_RE)?.[0];
  if (!dict) return null;
  const m = dict.match(/\/ca\s+([\d.]+)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
}

/** Read page ExtGState /ca from plaintext or (for pdf-lib object streams) the parsed PDF. */
export async function parseExtGStateOpacity(buf: ArrayBuffer): Promise<number | null> {
  return parseExtGStateOpacityLatin1(buf) ?? (await readPageExtGStateOpacity(buf));
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
export async function verifyExportedExtGStateOpacity(
  bytes: ArrayBuffer,
  expected: number,
): Promise<{ ok: boolean; read: number | null }> {
  const read = await parseExtGStateOpacity(bytes);
  if (read === null) return { ok: false, read: null };
  return { ok: Math.abs(read - expected) < 0.015, read };
}

async function pdfBytesForRender(original: ArrayBuffer, fileOpacity: number | null): Promise<Uint8Array> {
  if (fileOpacity == null || Math.abs(fileOpacity - 1) < 1e-3) {
    return new Uint8Array(original.slice(0));
  }
  // Latin1 ExtGState patches update /ca in-place but leave xref/streams in a shape browser pdf.js rejects;
  // pdf-lib rewrite neutralizes every page ExtGState reliably (Node and browser).
  return neutralizePageExtGStateOpacity(original);
}

function patchExtGStateOpacity(bytes: Uint8Array, opacity: number): { ok: boolean; bytes: Uint8Array } {
  const text = bytesToLatin1String(bytes);
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
    n.importOpacity = opacity;
    n.src.opacity = opacity;
  }
}

/**
 * Move/resize/rotate transforms a previous export wrote around each layer.
 * A single flat "Artwork" preview can only be un-transformed when the page has at most one layer block.
 */
async function readLayerTransforms(original: ArrayBuffer, ocgCount: number): Promise<Map<number, PdfMatrix>> {
  let stream: Awaited<ReturnType<typeof readFirstPageContentStreamText>> = null;
  try {
    stream = await readFirstPageContentStreamText(original);
  } catch {
    return new Map();
  }
  if (!stream) return new Map();
  const { transforms, blockCount } = readInjectedLayerTransforms(stream.text);
  if (ocgCount === 0 && blockCount > 1) return new Map();
  return transforms;
}

function applyFileVisibilityToNodes(roots: Node[], ocgRefs: string[], offRefs: string[]) {
  if (!offRefs.length) return;
  for (const n of walk(roots)) {
    if (n.kind === 'group') continue;
    const m = /^ocg-(\d+)$/.exec(n.key);
    const idx = m ? parseInt(m[1], 10) : n.key === 'artwork-0' && ocgRefs.length === 1 ? 0 : null;
    const ref = idx === null ? undefined : ocgRefs[idx];
    if (!ref || !offRefs.includes(ref)) continue;
    n.visible = false;
    n.importVisible = false;
    n.src.hidden = true;
  }
}

/** One code unit per byte (Node `latin1` semantics). Browser `TextDecoder('latin1')` uses Windows-1252 and breaks binary PDF streams on re-encode. */
function bytesToLatin1String(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
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
  const text = bytesToLatin1String(bytes);
  const idx = text.indexOf(search);
  if (idx < 0) return { ok: false, bytes };
  let newText = text.slice(0, idx) + replace + text.slice(idx + search.length);
  const delta = replace.length - search.length;
  if (delta !== 0) newText = fixPdfXrefAfterInsert(newText, idx, delta);
  return { ok: true, bytes: latin1Encode(newText) };
}

function legacyPdfWorkerFileUrl(cwd: string): string {
  const rel = `${cwd}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`.replace(/\\/g, '/');
  return rel.match(/^[a-zA-Z]:\//) ? `file:///${rel}` : `file://${rel.startsWith('/') ? '' : '/'}${rel}`;
}

async function loadPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const nodeProcess = (globalThis as { process?: { versions?: { node?: string }; cwd?: () => string } })
    .process;
  const cwd = nodeProcess?.cwd?.();
  if (nodeProcess?.versions?.node && cwd) {
    GlobalWorkerOptions.workerSrc = legacyPdfWorkerFileUrl(cwd);
  }
  return getDocument({ data, isEvalSupported: false }).promise;
}

/** Area to rasterize, in page units relative to the artboard's top-left corner. */
interface RenderRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `p · q`: apply `q` first, then `p`. */
function multiplyMatrix(p: readonly number[], q: readonly number[]): PdfMatrix {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

function invertMatrix(m: readonly number[]): PdfMatrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/**
 * @param pdfPreTransform Applied to page content in PDF user space before the viewport
 *   (used to undo an export transform so the raster shows the artwork in its own frame).
 */
async function renderPageToCanvas(
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  scale: number,
  optionalContentConfig?: PdfOcgConfig,
  region?: RenderRegion,
  pdfPreTransform?: PdfMatrix,
) {
  const viewport = page.getViewport({
    scale,
    offsetX: region ? -region.x * scale : 0,
    offsetY: region ? -region.y * scale : 0,
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((region?.w ?? viewport.width / scale) * scale);
  canvas.height = Math.ceil((region?.h ?? viewport.height / scale) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the AI preview.');
  let transform: PdfMatrix | undefined;
  if (pdfPreTransform) {
    // pdf.js applies `transform` after the viewport: device = T · V · p. Want V · pre · p.
    const vInv = invertMatrix(viewport.transform);
    if (vInv) transform = multiplyMatrix(multiplyMatrix(viewport.transform, pdfPreTransform), vInv);
  }
  // PDF pages have no paper fill; pdf.js would otherwise paint the canvas white.
  await page.render({
    canvasContext: ctx,
    viewport,
    transform,
    background: 'rgba(0,0,0,0)',
    optionalContentConfigPromise: optionalContentConfig
      ? Promise.resolve(optionalContentConfig)
      : undefined,
  }).promise;
  return { canvas, viewport };
}

/**
 * Artboard plus any artwork drawn outside it (within one artboard size on each side).
 * PDF viewers clip to the page box, but Illustrator keeps off-artboard art on the pasteboard.
 */
async function findArtworkRegion(
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  width: number,
  height: number,
  allLayersOn?: PdfOcgConfig,
  pdfPreTransform?: PdfMatrix,
): Promise<RenderRegion> {
  const artboard = { x: 0, y: 0, w: width, h: height };
  const probeScale = Math.min(0.25, 512 / Math.max(width, height));
  const probe = { x: -width, y: -height, w: width * 3, h: height * 3 };
  const { canvas } = await renderPageToCanvas(page, probeScale, allLayersOn, probe, pdfPreTransform);
  const ctx = canvas.getContext('2d');
  if (!ctx) return artboard;
  const { data, width: cw, height: ch } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = cw, minY = ch, maxX = -1, maxY = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (data[(y * cw + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return artboard;
  const left = probe.x + minX / probeScale - 1 / probeScale;
  const top = probe.y + minY / probeScale - 1 / probeScale;
  const right = probe.x + (maxX + 1) / probeScale + 1 / probeScale;
  const bottom = probe.y + (maxY + 1) / probeScale + 1 / probeScale;
  if (left >= 0 && top >= 0 && right <= width && bottom <= height) return artboard;
  const x = Math.floor(Math.max(probe.x, Math.min(0, left)));
  const y = Math.floor(Math.max(probe.y, Math.min(0, top)));
  const r = Math.ceil(Math.min(probe.x + probe.w, Math.max(width, right)));
  const b = Math.ceil(Math.min(probe.y + probe.h, Math.max(height, bottom)));
  return { x, y, w: r - x, h: b - y };
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
  region: RenderRegion = { x: 0, y: 0, w: width, h: height },
  allLayersOn?: PdfOcgConfig,
  layerTransforms: Map<number, PdfMatrix> = new Map(),
): Promise<Node[]> {
  /** Render one layer; a layer carrying an export transform is rendered untransformed and placed by it. */
  const renderLeaf = async (
    name: string,
    key: string,
    layerIndex: number,
    cfg: PdfOcgConfig | undefined,
  ): Promise<Node> => {
    const m = layerTransforms.get(layerIndex);
    const undo = m ? invertMatrix(m) : null;
    if (m && undo) {
      const frame = await findArtworkRegion(page, width, height, cfg, undo);
      const placement = decomposePdfTransformMatrix(m, frame, height);
      if (placement) {
        const { canvas } = await renderPageToCanvas(page, scale, cfg, frame, undo);
        return buildLeaf(name, canvas, frame, key, [...unsupportedBase], placement);
      }
    }
    const { canvas } = await renderPageToCanvas(page, scale, cfg, region);
    return buildLeaf(name, canvas, region, key, [...unsupportedBase]);
  };

  if (ocgNames.length === 0) {
    return [await renderLeaf('Artwork', 'artwork-0', 0, allLayersOn)];
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

    roots.push(await renderLeaf(name, `ocg-${i}`, i, cfg));
  }
  return roots;
}

function stubLayer(name: string, r: RenderRegion, canvas: HTMLCanvasElement): Layer {
  return { name, left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, canvas, hidden: false, opacity: 1 };
}

/**
 * @param frame Area the canvas covers, in untransformed artwork coordinates.
 * @param placement Where an export transform already in the file puts that frame (box + rotation).
 */
function buildLeaf(
  name: string,
  canvas: HTMLCanvasElement,
  frame: RenderRegion,
  key: string,
  unsupported: string[],
  placement?: RenderRegion & { rotation: number },
): Node {
  const p = placement ?? { ...frame, rotation: 0 };
  const src = stubLayer(name, p, canvas);
  if (placement) (src as Layer & { aiArtFrame?: RenderRegion }).aiArtFrame = { ...frame };
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
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    rotation: p.rotation,
    importRotation: p.rotation,
    ow: p.w,
    oh: p.h,
    ox: p.x,
    oy: p.y,
    canvas,
    children: [],
    parent: null,
    src,
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
  const fileOpacity = await parseExtGStateOpacity(original);
  const hasExtGStateOpacity = fileOpacity != null;
  const pdfData = await pdfBytesForRender(original, fileOpacity);

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

  // Layer pixels are rendered with every OCG on; the file's on/off state becomes node visibility.
  const allLayersOn = await pdf.getOptionalContentConfig();
  for (const id of Object.keys(allLayersOn.getGroups() ?? {})) allLayersOn.setVisibility(id, true, false);

  const region = await findArtworkRegion(page, width, height, allLayersOn);
  if (region.x < 0 || region.y < 0 || region.w > width || region.h > height) {
    warnings.push(
      'Some artwork lies outside the artboard. It is kept in the file and shown here on the pasteboard, but PDF viewers only display the artboard area.',
    );
  }
  const layerTransforms = await readLayerTransforms(original, ocgNames.length);
  const roots = await buildLayerRoots(
    pdf,
    page,
    scale,
    width,
    height,
    ocgNames,
    unsupportedBase,
    region,
    allLayersOn,
    layerTransforms,
  );
  applyFileVisibilityToNodes(roots, ocgRefs, parseOcgOffRefs(original));

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

  await applyAiVectorShapeImport(doc);
  if (fileOpacity != null) applyFileOpacityToNodes(doc.roots, fileOpacity);

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
      Math.abs(n.rotation - (n.importRotation ?? 0)) > 1e-3
    ) {
      notes.push('Move, scale, or rotate on .ai layers is canvas-only until PDF content patching is supported.');
      break;
    }
  }

  return { bytes, notes };
}

function docHasGeometryEdits(doc: Doc): boolean {
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') continue;
    if (
      n.x !== n.ox ||
      n.y !== n.oy ||
      n.w !== n.ow ||
      n.h !== n.oh ||
      Math.abs(n.rotation - (n.importRotation ?? 0)) > 1e-3
    ) {
      return true;
    }
  }
  return false;
}

function docHasAiMetadataEdits(doc: Doc): boolean {
  if (!doc.ai) return false;
  const byOcg = leavesByOcgIndex(doc);
  for (let i = 0; i < doc.ai.ocgNames.length; i++) {
    const node = byOcg.get(i);
    if (node && node.name !== doc.ai.ocgNames[i]) return true;
  }
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') continue;
    if (n.visible !== n.importVisible) return true;
    if (Math.abs(n.opacity - n.importOpacity) > 1e-3) return true;
  }
  return false;
}

function pushExportNotes(doc: Doc, notes: string[]) {
  if (!notes.length) return;
  const tag = 'Export note: ';
  for (const note of notes) {
    if (!doc.warnings.includes(tag + note)) doc.warnings.push(tag + note);
  }
}

function firstLeafOpacity(doc: Doc): number {
  return [...walk(doc.roots)].find((n) => n.kind !== 'group')?.opacity ?? 1;
}

async function opacityPersisted(bytes: ArrayBuffer, expected: number): Promise<boolean> {
  const verify = await verifyExportedExtGStateOpacity(bytes, expected);
  return verify.ok;
}

function toArrayBuffer(out: Uint8Array): ArrayBuffer {
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function exportViaPdfLib(doc: Doc): Promise<ArrayBuffer> {
  const { bytes, notes } = await exportAiWithPdfLib(doc);
  assertPdfAi(bytes, doc.name);
  const want = firstLeafOpacity(doc);
  if (Math.abs(want - 1) > 1e-3 || doc.ai!.hasExtGStateOpacity) {
    if (!(await opacityPersisted(bytes, want))) {
      throw new Error(
        `Opacity export verification failed: PDF ExtGState /ca does not match ${formatPdfOpacity(want)}.`,
      );
    }
  }
  pushExportNotes(doc, notes);
  return bytes;
}

async function finalizeMetadataExport(doc: Doc, out: Uint8Array, patchNotes: string[]): Promise<ArrayBuffer> {
  const outBuf = toArrayBuffer(new Uint8Array(out));
  assertPdfAi(outBuf, doc.name);
  const want = firstLeafOpacity(doc);
  const needOpacity = Math.abs(want - 1) > 1e-3 || doc.ai!.hasExtGStateOpacity;
  if (needOpacity && !(await opacityPersisted(outBuf, want))) {
    return exportViaPdfLib(doc);
  }
  pushExportNotes(doc, patchNotes);
  return outBuf;
}

/**
 * Export Illustrator document.
 * Unedited files return original bytes (preserves AIPrivateData). Metadata-only edits use in-place PDF patching.
 * Geometry and PDF rectangle fill/stroke edits use pdf-lib (may rewrite Illustrator private streams).
 */
export async function exportAi(doc: Doc): Promise<ArrayBuffer> {
  if (doc.format !== 'ai' || !doc.ai) {
    throw new Error('Export to .ai requires an imported Illustrator document.');
  }
  if (!doc.original?.byteLength) {
    throw new Error('This document has no original file bytes to export.');
  }

  const geometry = docHasGeometryEdits(doc);
  const shapeStream = docHasAiShapeStreamEdits(doc);
  const metadata = docHasAiMetadataEdits(doc);

  if (!geometry && !shapeStream && !metadata) {
    return doc.original.slice(0);
  }

  if (geometry || shapeStream) {
    try {
      return await exportViaPdfLib(doc);
    } catch (pdfLibErr) {
      console.warn('pdf-lib export failed, attempting legacy byte patching fallback:', pdfLibErr);
      if (geometry) {
        throw pdfLibErr;
      }
    }
  }

  const { bytes: out, notes: patchNotes } = syncToAi(doc, new Uint8Array(doc.original.slice(0)));
  return finalizeMetadataExport(doc, out, patchNotes);
}

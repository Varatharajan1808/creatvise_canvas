import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFString,
  PDFBool,
  PDFNumber,
  PDFRef,
} from 'pdf-lib';
import { inflate } from 'pako';
import { type Doc, type Node, walk, effVisible } from '../core/model';
import { patchAiImageXObjectsInPdf } from './aiImageExport';
import { patchAiShapeColorsInStream } from './aiVectorShapes';
import { patchAiTextInStream } from './aiTextEdit';
import {
  isAiDuplicateLayer,
  ocgIndexFromNodeKey,
  resolveAiMcIndex,
  resolveAiSourceMcIndex,
} from './aiLayerMeta';
import { docHasAiStackReordered, mcPaintOrderFromDoc, resolveStableOcgRef } from './aiReorder';

export interface ExportAiResult {
  bytes: ArrayBuffer;
  notes: string[];
}

function pageExtGStateDict(pdfDoc: PDFDocument): PDFDict | null {
  if (pdfDoc.getPageCount() < 1) return null;
  const page = pdfDoc.getPage(0);
  const res = pdfDoc.context.lookup(page.node.get(PDFName.of('Resources')));
  if (!(res instanceof PDFDict)) return null;
  const ext = pdfDoc.context.lookup(res.get(PDFName.of('ExtGState')));
  return ext instanceof PDFDict ? ext : null;
}

function extGStateCa(gs: PDFDict): number | null {
  const ca = gs.get(PDFName.of('ca'));
  if (ca instanceof PDFNumber) {
    const v = ca.asNumber();
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
  }
  return null;
}

/**
 * Page ExtGState /ca (prefers /GS0, the graphics state sample.ai already invokes).
 * Reads object streams that a latin1 scan of the file cannot see.
 */
export async function readPageExtGStateOpacity(buf: ArrayBuffer): Promise<number | null> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const ext = pageExtGStateDict(pdfDoc);
  if (!ext) return null;
  const gs0 = pdfDoc.context.lookup(ext.get(PDFName.of('GS0')));
  if (gs0 instanceof PDFDict) {
    const ca = extGStateCa(gs0);
    if (ca != null) return ca;
  }
  for (const key of ext.keys()) {
    const gs = pdfDoc.context.lookup(ext.get(key));
    if (gs instanceof PDFDict) {
      const ca = extGStateCa(gs);
      if (ca != null) return ca;
    }
  }
  return null;
}

/** Copy of `buf` with every page ExtGState /ca and /CA set to 1 so the preview raster is not pre-multiplied. */
export async function neutralizePageExtGStateOpacity(buf: ArrayBuffer): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const ext = pageExtGStateDict(pdfDoc);
  if (!ext) return new Uint8Array(buf.slice(0));
  for (const key of ext.keys()) {
    const gs = pdfDoc.context.lookup(ext.get(key));
    if (!(gs instanceof PDFDict)) continue;
    if (gs.has(PDFName.of('ca'))) gs.set(PDFName.of('ca'), PDFNumber.of(1));
    if (gs.has(PDFName.of('CA'))) gs.set(PDFName.of('CA'), PDFNumber.of(1));
  }
  const saved = await pdfDoc.save({ useObjectStreams: false });
  return new Uint8Array(saved);
}

/**
 * Format a number cleanly for PDF operators (up to 4 decimal places, no trailing zeros).
 */
export function formatPdfNumber(n: number): string {
  if (Math.abs(n) < 1e-6) return '0';
  const rounded = Math.round(n * 10000) / 10000;
  return Number(rounded.toFixed(4)).toString();
}

/**
 * Compute the 6-parameter affine transformation matrix for PDF content streams:
 * [a b c d e f cm]
 *
 * Accounts for coordinate system differences:
 * - Canvas: origin top-left, Y goes down, rotation clockwise in degrees.
 * - PDF: origin bottom-left, Y goes up, counter-clockwise radians.
 */
export function computePdfTransformMatrix(
  ox: number,
  oy: number,
  ow: number,
  oh: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rotationDeg: number,
  pageHeight: number,
): { a: number; b: number; c: number; d: number; e: number; f: number; isIdentity: boolean } {
  const isIdentity =
    Math.abs(x - ox) < 1e-3 &&
    Math.abs(y - oy) < 1e-3 &&
    Math.abs(w - ow) < 1e-3 &&
    Math.abs(h - oh) < 1e-3 &&
    Math.abs(rotationDeg) < 1e-3;

  if (isIdentity) {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, isIdentity: true };
  }

  const sx = ow > 0 ? w / ow : 1;
  const sy = oh > 0 ? h / oh : 1;

  // In canvas: clockwise rotation.
  // In PDF (Cartesian): clockwise rotation corresponds to negative angle (-theta).
  const rad = (rotationDeg * Math.PI) / 180;
  const alpha = -rad;
  const cos = Math.cos(alpha);
  const sin = Math.sin(alpha);

  // Centers in PDF coordinates (Y flipped)
  const c0x = ox + ow / 2;
  const c0y = pageHeight - (oy + oh / 2);
  const c1x = x + w / 2;
  const c1y = pageHeight - (y + h / 2);

  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const e = c1x - (a * c0x + c * c0y);
  const f = c1y - (b * c0x + d * c0y);

  return { a, b, c, d, e, f, isIdentity: false };
}

/**
 * Inverse of `computePdfTransformMatrix`: the placement (canvas box + clockwise rotation) that
 * `m` gives to `frame`. Null when `m` has skew or a flip, which this app never writes.
 */
export function decomposePdfTransformMatrix(
  m: readonly number[],
  frame: { x: number; y: number; w: number; h: number },
  pageHeight: number,
): { x: number; y: number; w: number; h: number; rotation: number } | null {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (sx < 1e-6 || sy < 1e-6) return null;
  if (a * d - b * c <= 0) return null;
  if (Math.abs(a * c + b * d) > 1e-3 * sx * sy) return null;
  const c0x = frame.x + frame.w / 2;
  const c0y = pageHeight - (frame.y + frame.h / 2);
  const c1x = a * c0x + c * c0y + e;
  const c1y = b * c0x + d * c0y + f;
  const w = frame.w * sx;
  const h = frame.h * sy;
  let rotation = (-Math.atan2(b, a) * 180) / Math.PI;
  if (rotation <= -180) rotation += 360;
  if (Math.abs(rotation) < 1e-6) rotation = 0;
  return { x: c1x - w / 2, y: pageHeight - c1y - h / 2, w, h, rotation };
}

function isPlacementMatrix(m: readonly number[]): boolean {
  return decomposePdfTransformMatrix(m, { x: 0, y: 0, w: 1, h: 1 }, 0) !== null;
}

/** Untransformed artwork rectangle (doc px) for a re-imported AI layer whose file already carried an export transform. */
export interface AiArtFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function aiArtFrame(n: Node): AiArtFrame | undefined {
  return (n.src as { aiArtFrame?: AiArtFrame }).aiArtFrame;
}

function ocgIndexForNode(n: Node): number | null {
  return ocgIndexFromNodeKey(n.key);
}

/** Max `/MCn` index and block count in a decompressed page content stream. */
export function readContentStreamMcStats(text: string): { maxMcIndex: number; blockCount: number } {
  const blocks = findLayerBlocks(text);
  let maxMcIndex = -1;
  for (const b of blocks) {
    if (b.layerIndex > maxMcIndex) maxMcIndex = b.layerIndex;
  }
  return { maxMcIndex, blockCount: blocks.length };
}

export async function readContentStreamMcStatsFromPdf(buf: ArrayBuffer): Promise<{
  maxMcIndex: number;
  blockCount: number;
}> {
  const text = await decompressPageContentStream(buf);
  return readContentStreamMcStats(text);
}

/** Read OCG layer names and refs in catalog order (works when latin1 scan misses object streams). */
export async function readOcgNamesAndRefsFromPdf(
  buf: ArrayBuffer,
): Promise<{ names: string[]; refs: string[] }> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties')));
  if (!(ocProps instanceof PDFDict)) return { names: [], refs: [] };
  const ocgs = pdfDoc.context.lookup(ocProps.get(PDFName.of('OCGs')));
  if (!(ocgs instanceof PDFArray)) return { names: [], refs: [] };
  const names: string[] = [];
  const refs: string[] = [];
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    if (ref instanceof PDFRef) refs.push(`${ref.objectNumber} 0 R`);
    const ocg = pdfDoc.context.lookup(ref);
    if (ocg instanceof PDFDict) {
      const nm = ocg.get(PDFName.of('Name'));
      names.push(nm instanceof PDFString ? nm.decodeText() : `Layer ${i + 1}`);
    }
  }
  return { names, refs };
}

async function decompressPageContentStream(buf: ArrayBuffer): Promise<string> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  if (pdfDoc.getPageCount() < 1) return '';
  const page = pdfDoc.getPage(0);
  const contentsRef = page.node.get(PDFName.of('Contents'));
  const contentsObj = pdfDoc.context.lookup(contentsRef);
  let originalRaw: Uint8Array | null = null;

  if (contentsObj && 'getContents' in contentsObj) {
    originalRaw = (contentsObj as { getContents(): Uint8Array }).getContents();
  } else if (contentsObj instanceof PDFArray) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < contentsObj.size(); i++) {
      const stream = pdfDoc.context.lookup(contentsObj.get(i));
      if (stream && 'getContents' in stream) {
        const raw = (stream as { getContents(): Uint8Array }).getContents();
        try {
          parts.push(inflate(raw));
        } catch {
          parts.push(raw);
        }
      }
    }
    if (parts.length > 0) {
      const joined = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        joined.set(p, offset);
        offset += p.length;
      }
      originalRaw = joined;
    }
  }

  if (!originalRaw) return '';
  let decompressed: Uint8Array;
  try {
    decompressed = inflate(originalRaw);
  } catch {
    decompressed = originalRaw;
  }
  return new TextDecoder('latin1').decode(decompressed);
}

interface McDuplicatePlan {
  exportMc: number;
  sourceMc: number;
}

/**
 * Insert copies of marked-content blocks for duplicated layers (before transform patching).
 * Inserts run from the end of the stream toward the start so indices stay stable.
 */
export function duplicateMarkedContentBlocks(text: string, plans: McDuplicatePlan[]): string {
  if (plans.length === 0) return text;
  const blocks = findLayerBlocks(text);
  if (blocks.length === 0) return text;

  const sorted = [...plans].sort((a, b) => {
    const blockA = blocks.find((bl) => bl.layerIndex === a.sourceMc);
    const blockB = blocks.find((bl) => bl.layerIndex === b.sourceMc);
    return (blockB?.emcEnd ?? 0) - (blockA?.emcEnd ?? 0);
  });

  let result = text;
  for (const plan of sorted) {
    const sourceBlock = findLayerBlocks(result).find((b) => b.layerIndex === plan.sourceMc);
    if (!sourceBlock) continue;

    const bdcTag = result.slice(sourceBlock.bdcStart, sourceBlock.bdcEnd);
    const newBdcTag = bdcTag.replace(/\/MC(\d+)/, `/MC${plan.exportMc}`);
    const segment = result.slice(sourceBlock.bdcEnd, sourceBlock.emcStart);
    const inner = parseInjectedWrapper(segment, true)?.body ?? segment;
    const emc = result.slice(sourceBlock.emcStart, sourceBlock.emcEnd);
    const newBlock = `${newBdcTag}${inner}${emc}`;

    result = result.slice(0, sourceBlock.emcEnd) + '\n' + newBlock + result.slice(sourceBlock.emcEnd);
  }
  return result;
}

function shallowClonePdfDict(pdfDoc: PDFDocument, source: PDFDict): PDFRef {
  const clone = pdfDoc.context.obj({}) as PDFDict;
  for (const key of source.keys()) {
    const val = source.get(key);
    if (val !== undefined) clone.set(key, val);
  }
  return pdfDoc.context.register(clone);
}

/** PDF affine matrix `[a b c d e f]`: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type PdfMatrix = [number, number, number, number, number, number];

interface LayerBlock {
  layerIndex: number;
  bdcStart: number;
  bdcEnd: number;
  emcStart: number;
  emcEnd: number;
}

const PDF_NUM = '-?\\d+(?:\\.\\d+)?';
const PDF_CM = `(?:(${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) cm\\n)?`;
/** Exact wrapper written by `patchStreamLayers` inside a layer block / around a stream without blocks. */
const INJECTED_IN_BLOCK_RE = new RegExp(`^\\nq\\n(/GS_L_\\d+ gs\\n)?${PDF_CM}([\\s\\S]*)\\nQ\\n$`);
const INJECTED_IN_STREAM_RE = new RegExp(`^q\\n(/GS_L_\\d+ gs\\n)?${PDF_CM}([\\s\\S]*)\\nQ$`);

/** Strip a transform/opacity wrapper previously written by this exporter, if present. */
function parseInjectedWrapper(
  segment: string,
  inBlock: boolean,
): { matrix: PdfMatrix | null; body: string } | null {
  const m = (inBlock ? INJECTED_IN_BLOCK_RE : INJECTED_IN_STREAM_RE).exec(segment);
  if (!m || (!m[1] && m[2] === undefined)) return null;
  const matrix =
    m[2] === undefined ? null : (m.slice(2, 8).map(Number) as PdfMatrix);
  if (matrix && !isPlacementMatrix(matrix)) return null;
  return { matrix, body: m[8] };
}

export function findLayerBlocks(text: string): LayerBlock[] {
  const bdcRegex = /(?:\/(?:OC|Layer)\s+\/MC(\d+)\s+BDC)/g;
  const blocks: LayerBlock[] = [];

  let match: RegExpExecArray | null;
  while ((match = bdcRegex.exec(text)) !== null) {
    const layerIndex = parseInt(match[1], 10);
    const bdcStart = match.index;
    const bdcEnd = bdcRegex.lastIndex;

    // Find matching EMC (taking into account any nested BDC/EMC pairs)
    let depth = 1;
    const subRegex = /(?:\/(?:[A-Za-z0-9_]+)\s+\/(?:[A-Za-z0-9_]+)\s+BDC)|(EMC)/g;
    subRegex.lastIndex = bdcEnd;
    let subMatch: RegExpExecArray | null;
    let emcStart = -1;
    let emcEnd = -1;

    while ((subMatch = subRegex.exec(text)) !== null) {
      if (subMatch[1] === 'EMC' || subMatch[0] === 'EMC') {
        depth--;
        if (depth === 0) {
          emcStart = subMatch.index;
          emcEnd = subRegex.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }

    if (emcStart !== -1) {
      blocks.push({ layerIndex, bdcStart, bdcEnd, emcStart, emcEnd });
      bdcRegex.lastIndex = emcEnd;
    }
  }
  return blocks;
}

/**
 * Reorder top-level `/MCn` BDC…EMC segments to match paint order (bottom→top).
 * Preserves prefix/suffix and inter-block text that followed each block in the source stream.
 */
export function reorderMarkedContentBlocksForPaintOrder(
  text: string,
  mcPaintOrder: number[],
): { text: string; changed: boolean } {
  const blocks = findLayerBlocks(text);
  if (blocks.length === 0 || mcPaintOrder.length === 0) return { text, changed: false };
  if (blocks.length !== mcPaintOrder.length) return { text, changed: false };

  const byMc = new Map<number, string>();
  for (const b of blocks) {
    if (byMc.has(b.layerIndex)) return { text, changed: false };
    byMc.set(b.layerIndex, text.slice(b.bdcStart, b.emcEnd));
  }
  for (const mc of mcPaintOrder) {
    if (!byMc.has(mc)) return { text, changed: false };
  }

  const sortedByStart = [...blocks].sort((a, b) => a.bdcStart - b.bdcStart);
  const regionStart = sortedByStart[0]!.bdcStart;
  const regionEnd = sortedByStart[sortedByStart.length - 1]!.emcEnd;
  const streamMcOrder = sortedByStart.map((b) => b.layerIndex);
  if (
    streamMcOrder.length === mcPaintOrder.length &&
    streamMcOrder.every((mc, i) => mc === mcPaintOrder[i])
  ) {
    return { text, changed: false };
  }

  const midAfterMc = new Map<number, string>();
  for (let i = 0; i < sortedByStart.length; i++) {
    const end = sortedByStart[i]!.emcEnd;
    const nextStart = sortedByStart[i + 1]?.bdcStart ?? regionEnd;
    midAfterMc.set(sortedByStart[i]!.layerIndex, text.slice(end, nextStart));
  }

  const prefix = text.slice(0, regionStart);
  const suffix = text.slice(regionEnd);
  let middle = '';
  for (const mc of mcPaintOrder) {
    middle += byMc.get(mc)!;
    middle += midAfterMc.get(mc) ?? '';
  }
  const newText = prefix + middle + suffix;
  return { text: newText, changed: newText !== text };
}

function pdfRefTag(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber} R`;
}

function findPdfRefByString(_pdfDoc: PDFDocument, refStr: string, ocgs?: PDFArray): PDFRef | null {
  const m = /^(\d+)\s+(\d+)\s+R$/.exec(refStr.trim());
  if (!m) return null;
  const objNum = parseInt(m[1]!, 10);
  const gen = parseInt(m[2]!, 10);
  if (ocgs) {
    for (let i = 0; i < ocgs.size(); i++) {
      const item = ocgs.get(i);
      if (item instanceof PDFRef && item.objectNumber === objNum && item.generationNumber === gen) {
        return item;
      }
    }
  }
  return PDFRef.of(objNum, gen);
}

/**
 * Layer transforms written by a previous export of this app, keyed by layer index
 * (layer 0 for streams without layer blocks).
 */
export function readInjectedLayerTransforms(text: string): {
  transforms: Map<number, PdfMatrix>;
  blockCount: number;
} {
  const transforms = new Map<number, PdfMatrix>();
  const blocks = findLayerBlocks(text);
  if (blocks.length === 0) {
    const w = parseInjectedWrapper(text, false);
    if (w?.matrix) transforms.set(0, w.matrix);
  }
  for (const b of blocks) {
    const w = parseInjectedWrapper(text.slice(b.bdcEnd, b.emcStart), true);
    if (w?.matrix && !transforms.has(b.layerIndex)) transforms.set(b.layerIndex, w.matrix);
  }
  return { transforms, blockCount: blocks.length };
}

/**
 * Patch layer marked content blocks in a decompressed PDF content stream.
 * Every layer present in `layerPatches` has any earlier export wrapper replaced, not nested.
 */
function patchStreamLayers(
  text: string,
  layerPatches: Map<number, { cm?: string; gsName?: string }>,
): string {
  const blocks = findLayerBlocks(text);

  if (blocks.length === 0) {
    // Single layer / no marked content tags: apply layer 0 patch to entire stream
    const p0 = layerPatches.get(0);
    if (!p0) return text;
    const inner = parseInjectedWrapper(text, false)?.body ?? text;
    let prefix = '';
    let suffix = '';
    if (p0.cm || p0.gsName) {
      prefix += 'q\n';
      suffix = '\nQ';
    }
    if (p0.gsName) prefix += `/${p0.gsName} gs\n`;
    if (p0.cm) prefix += `${p0.cm}\n`;
    return prefix + inner + suffix;
  }

  // Patch blocks from end to beginning so indices remain valid
  let result = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const patch = layerPatches.get(block.layerIndex);
    if (!patch) continue;

    const before = result.slice(0, block.bdcEnd);
    const segment = result.slice(block.bdcEnd, block.emcStart);
    const inner = parseInjectedWrapper(segment, true)?.body ?? segment;
    const after = result.slice(block.emcStart);

    if (!patch.gsName && !patch.cm) {
      result = before + inner + after;
      continue;
    }
    let prefix = 'q\n';
    if (patch.gsName) {
      prefix += `/${patch.gsName} gs\n`;
    }
    if (patch.cm) {
      prefix += `${patch.cm}\n`;
    }

    result = before + '\n' + prefix + inner + '\nQ' + '\n' + after;
  }

  return result;
}

/**
 * Export an Illustrator (.ai) document using pdf-lib clean stream patching.
 * Writes transforms (move, resize, rotate), layer names, layer visibility, and opacities.
 */
export async function exportAiWithPdfLib(doc: Doc): Promise<ExportAiResult> {
  if (doc.format !== 'ai' || !doc.ai) {
    throw new Error('Export to .ai requires an imported Illustrator document.');
  }
  if (!doc.original?.byteLength) {
    throw new Error('This document has no original file bytes to export.');
  }

  const notes: string[] = [];
  const pdfDoc = await PDFDocument.load(doc.original.slice(0), { ignoreEncryption: true });

  if (pdfDoc.getPageCount() < 1) {
    throw new Error('Document has no pages.');
  }

  const page = pdfDoc.getPage(0);
  const { height: pageH } = page.getSize();

  // Synchronize stub layer properties
  for (const n of walk(doc.roots)) {
    n.src.name = n.name;
    n.src.hidden = !n.visible;
    n.src.opacity = n.opacity;
  }

  const leafNodes = [...walk(doc.roots)].filter((n) => n.kind !== 'group');
  const duplicatePlans: McDuplicatePlan[] = leafNodes
    .filter((n) => isAiDuplicateLayer(n))
    .map((n) => ({ exportMc: resolveAiMcIndex(n), sourceMc: resolveAiSourceMcIndex(n) }));

  let hasGeometryEdits = duplicatePlans.length > 0;
  const layerPatches = new Map<number, { cm?: string; gsName?: string }>();
  const multiLeaf = leafNodes.length > 1;
  const anyNonDefaultOpacity = leafNodes.some((n) => Math.abs(n.opacity - 1) > 1e-3);

  // Ensure Resources dict exists
  let resDict = pdfDoc.context.lookup(page.node.get(PDFName.of('Resources'))) as PDFDict | undefined;
  if (!resDict || !(resDict instanceof PDFDict)) {
    resDict = pdfDoc.context.obj({});
    page.node.set(PDFName.of('Resources'), resDict);
  }

  // Ensure ExtGState dict exists
  let extGStateDict = pdfDoc.context.lookup(resDict.get(PDFName.of('ExtGState'))) as PDFDict | undefined;
  if (!extGStateDict || !(extGStateDict instanceof PDFDict)) {
    extGStateDict = pdfDoc.context.obj({});
    resDict.set(PDFName.of('ExtGState'), extGStateDict);
  }

  const gs0Ref = extGStateDict.get(PDFName.of('GS0'));
  const firstLeaf = leafNodes[0];
  // Single-layer files may use page GS0; multiple layers use per-block GS_L when opacities differ.
  if (gs0Ref && firstLeaf && !multiLeaf) {
    const gs0 = pdfDoc.context.lookup(gs0Ref);
    if (gs0 instanceof PDFDict) {
      gs0.set(PDFName.of('ca'), PDFNumber.of(firstLeaf.opacity));
      gs0.set(PDFName.of('CA'), PDFNumber.of(firstLeaf.opacity));
    }
  }

  for (const node of leafNodes) {
    const mcIndex = resolveAiMcIndex(node);
    const frame = aiArtFrame(node) ?? { x: node.ox, y: node.oy, w: node.ow, h: node.oh };
    const t = computePdfTransformMatrix(
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      node.x,
      node.y,
      node.w,
      node.h,
      node.rotation,
      pageH,
    );

    let cm: string | undefined;
    if (!t.isIdentity) {
      hasGeometryEdits = true;
      cm = `${formatPdfNumber(t.a)} ${formatPdfNumber(t.b)} ${formatPdfNumber(t.c)} ${formatPdfNumber(t.d)} ${formatPdfNumber(t.e)} ${formatPdfNumber(t.f)} cm`;
    }

    let gsName: string | undefined;
    const usePerLayerGs =
      (!gs0Ref && Math.abs(node.opacity - 1) > 1e-3) ||
      (multiLeaf && anyNonDefaultOpacity) ||
      (multiLeaf && Math.abs(node.opacity - (firstLeaf?.opacity ?? 1)) > 1e-3);
    if (usePerLayerGs && Math.abs(node.opacity - 1) > 1e-3) {
      gsName = `GS_L_${mcIndex}`;
      const gsDict = pdfDoc.context.obj({
        Type: 'ExtGState',
        ca: node.opacity,
        CA: node.opacity,
      });
      extGStateDict.set(PDFName.of(gsName), pdfDoc.context.register(gsDict));
    }

    if (cm || gsName || mcIndex >= 0) {
      layerPatches.set(mcIndex, { cm, gsName });
    }
  }

function isValidPdfLabel(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}

function buildOrderArray(
  pdfDoc: PDFDocument,
  nodes: readonly Node[],
  nodeToRef: Map<Node, PDFRef>,
  seenRefs: Set<string>,
): PDFArray {
  const arr = pdfDoc.context.obj([]) as PDFArray;
  for (const node of nodes) {
    if (node.kind === 'group') {
      if (node.children.length === 0) {
        throw new Error(`Cannot export AI document: group folder "${node.name}" is empty.`);
      }
      const childArr = buildOrderArray(pdfDoc, node.children, nodeToRef, seenRefs);
      if (isValidPdfLabel(node.name)) {
        arr.push(PDFString.of(node.name.trim()));
      }
      arr.push(childArr);
    } else {
      const ref = nodeToRef.get(node);
      if (!ref) {
        throw new Error(`Cannot export AI document: layer "${node.name}" has no OCG reference.`);
      }
      const tag = pdfRefTag(ref);
      if (seenRefs.has(tag)) {
        throw new Error(`Cannot export AI document: duplicate OCG reference ${tag} for layer "${node.name}".`);
      }
      seenRefs.add(tag);
      arr.push(ref);
    }
  }
  return arr;
}

  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocPropsRef = catalog.get(PDFName.of('OCProperties'));
  const ocProps = pdfDoc.context.lookup(ocPropsRef);
  let stackOcgRefs: PDFRef[] = [];
  const nodeToRef = new Map<Node, PDFRef>();

  if (ocProps instanceof PDFDict) {
    const ocgs = pdfDoc.context.lookup(ocProps.get(PDFName.of('OCGs')));
    if (ocgs instanceof PDFArray) {
      const orderedRefs: PDFRef[] = [];
      for (const node of leafNodes) {
        let ref: PDFRef | null = null;
        const catIdx = ocgIndexFromNodeKey(node.key);
        if (catIdx !== null && catIdx < ocgs.size()) {
          const item = ocgs.get(catIdx);
          if (item instanceof PDFRef) ref = item;
        }
        if (!ref) {
          const stableRefStr = resolveStableOcgRef(doc, node);
          if (stableRefStr) ref = findPdfRefByString(pdfDoc, stableRefStr, ocgs);
        }
        if (!ref && isAiDuplicateLayer(node)) {
          const sourceMc = resolveAiSourceMcIndex(node);
          const sourceRefStr =
            doc.ai.importOcgRefsByCatalogIndex?.[sourceMc] ?? doc.ai.ocgRefs[sourceMc];
          const sourceRef = sourceRefStr
            ? findPdfRefByString(pdfDoc, sourceRefStr, ocgs)
            : null;
          const sourceOcg = sourceRef ? pdfDoc.context.lookup(sourceRef) : null;
          if (sourceOcg instanceof PDFDict) {
            ref = shallowClonePdfDict(pdfDoc, sourceOcg);
            doc.ai.ocgRefs.push(pdfRefTag(ref));
          }
        }
        if (ref) {
          orderedRefs.push(ref);
          nodeToRef.set(node, ref);
        }
      }

      for (const node of leafNodes) {
        if (!nodeToRef.get(node)) {
          throw new Error(
            `Cannot export AI document: layer "${node.name}" could not be mapped to a PDF Optional Content Group reference.`,
          );
        }
      }

      if (orderedRefs.length === leafNodes.length && orderedRefs.length > 0) {
        const rebuilt = pdfDoc.context.obj([]) as PDFArray;
        for (const r of orderedRefs) rebuilt.push(r);
        const seenTag = new Set(orderedRefs.map(pdfRefTag));
        for (let i = 0; i < ocgs.size(); i++) {
          const item = ocgs.get(i);
          if (item instanceof PDFRef && !seenTag.has(pdfRefTag(item))) {
            rebuilt.push(item);
          }
        }
        ocProps.set(PDFName.of('OCGs'), pdfDoc.context.register(rebuilt));
        stackOcgRefs = orderedRefs;
      } else {
        for (let i = 0; i < ocgs.size(); i++) {
          const item = ocgs.get(i);
          if (item instanceof PDFRef) stackOcgRefs.push(item);
        }
      }

      while (doc.ai.ocgNames.length < leafNodes.length) doc.ai.ocgNames.push('');
      for (let i = 0; i < orderedRefs.length && i < leafNodes.length; i++) {
        const ocgRef = orderedRefs[i]!;
        const ocg = pdfDoc.context.lookup(ocgRef);
        const node = leafNodes[i]!;
        if (ocg instanceof PDFDict) {
          ocg.set(PDFName.of('Name'), PDFString.of(node.name));
        }
        doc.ai.ocgNames[i] = node.name;
      }
      while (doc.ai.ocgNames.length > leafNodes.length) doc.ai.ocgNames.pop();
      while (doc.ai.ocgRefs.length > orderedRefs.length) doc.ai.ocgRefs.pop();
    }

    const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D')));
    if (d instanceof PDFDict && stackOcgRefs.length > 0) {
      const onRefs: PDFRef[] = [];
      const offRefs: PDFRef[] = [];
      for (let i = 0; i < stackOcgRefs.length && i < leafNodes.length; i++) {
        const ocgRef = stackOcgRefs[i]!;
        const node = leafNodes[i]!;
        if (effVisible(node)) onRefs.push(ocgRef);
        else offRefs.push(ocgRef);
      }

      const rebuiltOn = pdfDoc.context.obj([]) as PDFArray;
      for (const r of onRefs) rebuiltOn.push(r);
      d.set(PDFName.of('ON'), pdfDoc.context.register(rebuiltOn));

      const rebuiltOff = pdfDoc.context.obj([]) as PDFArray;
      for (const r of offRefs) rebuiltOff.push(r);
      d.set(PDFName.of('OFF'), pdfDoc.context.register(rebuiltOff));

      const hasGroups = doc.roots.some((r) => r.kind === 'group');
      if (hasGroups) {
        const seenRefs = new Set<string>();
        const rebuiltOrder = buildOrderArray(pdfDoc, doc.roots, nodeToRef, seenRefs);
        d.set(PDFName.of('Order'), pdfDoc.context.register(rebuiltOrder));
      } else {
        const rebuiltOrder = pdfDoc.context.obj([]) as PDFArray;
        for (const r of stackOcgRefs) rebuiltOrder.push(r);
        d.set(PDFName.of('Order'), pdfDoc.context.register(rebuiltOrder));
      }
    }
  }

  const propsRef = resDict.get(PDFName.of('Properties'));
  const propsDict = pdfDoc.context.lookup(propsRef);
  if (propsDict instanceof PDFDict) {
    for (const node of leafNodes) {
      const mcIndex = resolveAiMcIndex(node);
      let propVal = propsDict.get(PDFName.of(`MC${mcIndex}`));
      if (!propVal) {
        const sourceMc = resolveAiSourceMcIndex(node);
        const templateVal = propsDict.get(PDFName.of(`MC${sourceMc}`));
        const template = templateVal ? pdfDoc.context.lookup(templateVal) : null;
        if (template instanceof PDFDict) {
          propVal = shallowClonePdfDict(pdfDoc, template);
          propsDict.set(PDFName.of(`MC${mcIndex}`), propVal);
        }
      }
      const propDict = propVal ? pdfDoc.context.lookup(propVal) : null;
      if (propDict instanceof PDFDict) {
        if (propDict.has(PDFName.of('Title'))) {
          propDict.set(PDFName.of('Title'), PDFString.of(node.name));
        }
        if (propDict.has(PDFName.of('Name'))) {
          propDict.set(PDFName.of('Name'), PDFString.of(node.name));
        }
        if (propDict.has(PDFName.of('Visible'))) {
          propDict.set(PDFName.of('Visible'), node.visible ? PDFBool.True : PDFBool.False);
        }
      }
    }
  }

  // 5. Patch Content Stream with transforms and opacities
  const contentsRef = page.node.get(PDFName.of('Contents'));
  if (contentsRef) {
    const contentsObj = pdfDoc.context.lookup(contentsRef);
    let originalRaw: Uint8Array | null = null;

    if (contentsObj && 'getContents' in contentsObj) {
      originalRaw = (contentsObj as any).getContents();
    } else if (contentsObj instanceof PDFArray) {
      // Multiple content streams: concatenate decompressed streams
      const parts: Uint8Array[] = [];
      for (let i = 0; i < contentsObj.size(); i++) {
        const stream = pdfDoc.context.lookup(contentsObj.get(i));
        if (stream && 'getContents' in stream) {
          const raw = (stream as any).getContents();
          try {
            parts.push(inflate(raw));
          } catch {
            parts.push(raw);
          }
        }
      }
      if (parts.length > 0) {
        let total = parts.reduce((acc, p) => acc + p.length, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) {
          joined.set(p, offset);
          offset += p.length;
        }
        originalRaw = joined;
      }
    }

    if (originalRaw) {
      let decompressed: Uint8Array;
      try {
        decompressed = inflate(originalRaw);
      } catch {
        decompressed = originalRaw;
      }

      const originalText = new TextDecoder('latin1').decode(decompressed);
      let streamText = originalText;
      if (duplicatePlans.length > 0) {
        streamText = duplicateMarkedContentBlocks(streamText, duplicatePlans);
        notes.push(
          `Duplicated ${duplicatePlans.length} PDF marked-content layer block(s) for copied layer(s).`,
        );
      }
      if (docHasAiStackReordered(doc)) {
        const paintOrder = mcPaintOrderFromDoc(doc);
        const reorder = reorderMarkedContentBlocksForPaintOrder(streamText, paintOrder);
        if (reorder.changed) {
          streamText = reorder.text;
          notes.push('Layer stack order was written to the PDF marked-content stream.');
        }
        hasGeometryEdits = true;
      }
      const shapePatch = patchAiShapeColorsInStream(streamText, doc);
      notes.push(...shapePatch.notes);
      const textPatch = patchAiTextInStream(shapePatch.text, doc);
      notes.push(...textPatch.notes);
      const patchedText = patchStreamLayers(textPatch.text, layerPatches);

      if (patchedText !== originalText) {
        const newStream = pdfDoc.context.flateStream(new TextEncoder().encode(patchedText));
        const newRef = pdfDoc.context.register(newStream);
        page.node.set(PDFName.of('Contents'), newRef);
      }
    }
  }

  // 6. Handle AIPrivateData / PieceInfo when geometry changed
  if (hasGeometryEdits) {
    page.node.delete(PDFName.of('PieceInfo'));
    catalog.delete(PDFName.of('PieceInfo'));
    notes.push(
      'Layer moves, resizing, or rotations were applied to the PDF vector stream. Illustrator AIPrivateData cache was cleared so Illustrator opens the edited layout directly.',
    );
  }

  const imagePatch = await patchAiImageXObjectsInPdf(pdfDoc, doc);
  notes.push(...imagePatch.notes);

  const savedBytes = await pdfDoc.save({ useObjectStreams: false });
  return {
    bytes: savedBytes.buffer as ArrayBuffer,
    notes,
  };
}

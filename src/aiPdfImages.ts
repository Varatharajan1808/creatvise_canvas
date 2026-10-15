import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import { inflate } from 'pako';
import type { Doc, Node } from './model';
import { walk } from './model';
import { asAiLayerStub, resolveAiMcIndex } from './aiLayerMeta';
import { readFirstPageContentStreamText } from './aiVectorShapes';

/** Stable tokens for a future export-time image patch (Phase 3+). */
export interface AiImagePatch {
  /** Exact `/Name Do` operator substring in the decompressed latin1 content stream. */
  doSearch: string;
  importDoSearch: string;
  /** Full `a b c d e f cm` immediately before `Do`. */
  cmSearch: string;
  importCmSearch: string;
}

/** One embedded PDF image detected inside a marked-content block (import metadata only). */
export interface AiPlacedImageRun {
  mcIndex: number;
  /** Resource name without leading slash (e.g. `Im0`). */
  xobjectName: string;
  /** Indirect object reference (e.g. `7 0 R`). */
  xobjectRef: string;
  width: number;
  height: number;
  bitsPerComponent: number;
  /** Normalized color space name (e.g. `DeviceRGB`). */
  colorSpace: string;
  filters: string[];
  hasSoftMask: boolean;
  /** PDF user-space matrix applied immediately before `Do`. */
  placementMatrix: [number, number, number, number, number, number];
  patch: AiImagePatch;
  supported: boolean;
  unsupportedReason?: string;
  /** Doc-space axis-aligned bounds of the placed image at import. */
  importBounds?: AiPlacedImageRunImportBounds;
  /** Decoded RGB payload from the PDF image XObject at import (DeviceRGB, 8 bpc). */
  importImageBytes?: Uint8Array;
  /** Raster snapshot of `importImageBytes` at intrinsic width × height. */
  importImageCanvas?: HTMLCanvasElement | null;
  /** Canvas preview edits (does not mutate import patch tokens or XObject bytes). */
  edit?: AiPlacedImageRunEdits;
}

export interface AiPlacedImageRunImportBounds {
  docX: number;
  docY: number;
  docW: number;
  docH: number;
}

export interface AiPlacedImageRunEdits {
  replacementCanvas?: HTMLCanvasElement | null;
}

export type McPlacedImageBlockResult = {
  mcIndex: number;
  images: AiPlacedImageRun[];
  mixed: boolean;
  mixedReason?: string;
};

const MC_BLOCK_RE = /\/OC\s+\/MC(\d+)\s+BDC([\s\S]*?)EMC/g;

const VECTOR_MARKERS =
  /\bre\b|\bf\b|\bF\b|\bS\b|\bs\b|\bB\b|\bB\*\b|\bW\b|\bn\b|\bm\b|\bl\b|\bc\b|\bsh\b|\bCS\b|\bcs\b|\bSCN\b|\bscn\b/;

const DO_OP_RE = /\/([A-Za-z0-9]+)\s+Do\b/g;
const CM6_RE =
  /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm/g;

const SUPPORTED_COLOR_SPACES = new Set(['DeviceRGB']);
const SUPPORTED_FILTERS = new Set(['FlateDecode']);

export type PageImageXObjectInfo = {
  ref: string;
  subtype: string;
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: string;
  filters: string[];
  hasSoftMask: boolean;
};

function pdfRefString(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber} R`;
}

function pdfNameKey(name: PDFName): string {
  return name.decodeText().replace(/^\//, '');
}

function readPdfName(value: unknown): string | null {
  if (value instanceof PDFName) return pdfNameKey(value);
  return null;
}

function readPdfNumber(value: unknown): number | null {
  if (value instanceof PDFNumber) return value.asNumber();
  return null;
}

function normalizeColorSpace(value: unknown): string {
  const name = readPdfName(value);
  if (name) return name;
  if (value instanceof PDFArray && value.size() > 0) {
    const head = readPdfName(value.get(0));
    if (head) return head;
  }
  return 'Unknown';
}

function readFilters(value: unknown): string[] {
  if (!value) return [];
  if (value instanceof PDFName) return [pdfNameKey(value)];
  if (value instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0; i < value.size(); i++) {
      const n = readPdfName(value.get(i));
      if (n) out.push(n);
    }
    return out;
  }
  return [];
}

function validateImageXObject(info: PageImageXObjectInfo): { supported: boolean; reason?: string } {
  if (info.subtype !== 'Image') {
    return { supported: false, reason: 'XObject is a Form, not an embedded image.' };
  }
  if (info.hasSoftMask) {
    return { supported: false, reason: 'Image uses a soft mask (/SMask), which is not supported yet.' };
  }
  if (!SUPPORTED_COLOR_SPACES.has(info.colorSpace)) {
    return { supported: false, reason: `Color space ${info.colorSpace} is not supported (DeviceRGB only).` };
  }
  if (info.bitsPerComponent !== 8) {
    return { supported: false, reason: `BitsPerComponent ${info.bitsPerComponent} is not supported (8 only).` };
  }
  if (info.filters.length === 0) {
    return { supported: false, reason: 'Image has no Filter entry.' };
  }
  for (const f of info.filters) {
    if (!SUPPORTED_FILTERS.has(f)) {
      return { supported: false, reason: `Filter ${f} is not supported (FlateDecode only).` };
    }
  }
  if (info.width < 1 || info.height < 1) {
    return { supported: false, reason: 'Invalid image dimensions.' };
  }
  return { supported: true };
}

/** Load page-1 `/XObject` image dictionaries keyed by resource name (`Im0`, …). */
export async function loadPageImageXObjects(original: ArrayBuffer): Promise<Map<string, PageImageXObjectInfo>> {
  const out = new Map<string, PageImageXObjectInfo>();
  const pdfDoc = await PDFDocument.load(original.slice(0), { ignoreEncryption: true });
  if (pdfDoc.getPageCount() < 1) return out;

  const page = pdfDoc.getPage(0);
  const resources = page.node.get(PDFName.of('Resources'));
  const resDict = pdfDoc.context.lookup(resources);
  if (!(resDict instanceof PDFDict)) return out;

  const xobjEntry = resDict.get(PDFName.of('XObject'));
  const xobjDict = pdfDoc.context.lookup(xobjEntry);
  if (!(xobjDict instanceof PDFDict)) return out;

  for (const [key, value] of xobjDict.entries()) {
    const name = pdfNameKey(key);
    const stream = pdfDoc.context.lookup(value);
    if (!(stream instanceof PDFStream)) continue;

    const dict = stream.dict;
    const subtype = readPdfName(dict.get(PDFName.of('Subtype'))) ?? 'Unknown';
    const width = readPdfNumber(dict.get(PDFName.of('Width'))) ?? 0;
    const height = readPdfNumber(dict.get(PDFName.of('Height'))) ?? 0;
    const bits = readPdfNumber(dict.get(PDFName.of('BitsPerComponent'))) ?? 0;
    const colorSpace = normalizeColorSpace(dict.get(PDFName.of('ColorSpace')));
    const filters = readFilters(dict.get(PDFName.of('Filter')));
    const hasSoftMask = dict.get(PDFName.of('SMask')) != null;

    let refStr = '';
    if (value instanceof PDFRef) refStr = pdfRefString(value);

    out.set(name, {
      ref: refStr,
      subtype,
      width,
      height,
      bitsPerComponent: bits,
      colorSpace,
      filters,
      hasSoftMask,
    });
  }

  return out;
}

function stripTextObjects(body: string): string {
  return body.replace(/\bBT\b[\s\S]*?\bET\b/g, '');
}

function findImagePlacement(body: string, doSearch: string): [number, number, number, number, number, number] | null {
  const idx = body.indexOf(doSearch);
  if (idx < 0) return null;
  const before = body.slice(0, idx);
  let last: RegExpExecArray | null = null;
  CM6_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CM6_RE.exec(before)) !== null) last = m;
  if (!last) return null;
  return [
    parseFloat(last[1]),
    parseFloat(last[2]),
    parseFloat(last[3]),
    parseFloat(last[4]),
    parseFloat(last[5]),
    parseFloat(last[6]),
  ];
}

function makeImagePatch(cmSearch: string, doSearch: string): AiImagePatch {
  return {
    cmSearch,
    importCmSearch: cmSearch,
    doSearch,
    importDoSearch: doSearch,
  };
}

/**
 * Parse one `/OC /MCn BDC … EMC` body for a single supported embedded image paint.
 * Does not treat Form XObjects or vector/text mixes as replaceable images.
 */
export function parseMcBlockPlacedImage(
  body: string,
  mcIndex: number,
  xobjects: Map<string, PageImageXObjectInfo>,
): McPlacedImageBlockResult {
  const trimmed = body.trim();
  if (!trimmed) {
    return { mcIndex, images: [], mixed: false };
  }

  if (/\bBT\b/.test(trimmed)) {
    return {
      mcIndex,
      images: [],
      mixed: true,
      mixedReason: 'Marked-content block mixes live PDF text with other content.',
    };
  }

  const withoutText = stripTextObjects(trimmed);
  if (VECTOR_MARKERS.test(withoutText)) {
    return {
      mcIndex,
      images: [],
      mixed: true,
      mixedReason: 'Marked-content block mixes vector path painting with an image.',
    };
  }

  const doHits: { name: string; full: string }[] = [];
  DO_OP_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = DO_OP_RE.exec(trimmed)) !== null) {
    doHits.push({ name: dm[1], full: dm[0] });
  }

  if (doHits.length === 0) {
    return { mcIndex, images: [], mixed: false };
  }

  if (doHits.length > 1) {
    return {
      mcIndex,
      images: [],
      mixed: true,
      mixedReason: 'Marked-content block contains multiple image paint operations.',
    };
  }

  const { name, full: doSearch } = doHits[0];
  const xobj = xobjects.get(name);
  if (!xobj) {
    return {
      mcIndex,
      images: [
        {
          mcIndex,
          xobjectName: name,
          xobjectRef: '',
          width: 0,
          height: 0,
          bitsPerComponent: 0,
          colorSpace: 'Unknown',
          filters: [],
          hasSoftMask: false,
          placementMatrix: [1, 0, 0, 1, 0, 0],
          patch: makeImagePatch('', doSearch),
          supported: false,
          unsupportedReason: `XObject /${name} was not found in page Resources.`,
        },
      ],
      mixed: false,
    };
  }

  const placementMatrix = findImagePlacement(trimmed, doSearch) ?? [1, 0, 0, 1, 0, 0];
  const cmSearch = `${placementMatrix.map((n) => String(n)).join(' ')} cm`;
  const validation = validateImageXObject(xobj);

  const run: AiPlacedImageRun = {
    mcIndex,
    xobjectName: name,
    xobjectRef: xobj.ref,
    width: xobj.width,
    height: xobj.height,
    bitsPerComponent: xobj.bitsPerComponent,
    colorSpace: xobj.colorSpace,
    filters: [...xobj.filters],
    hasSoftMask: xobj.hasSoftMask,
    placementMatrix,
    patch: makeImagePatch(cmSearch, doSearch),
    supported: validation.supported,
    unsupportedReason: validation.reason,
  };

  return { mcIndex, images: [run], mixed: false };
}

/** Scan decompressed page-1 content for embedded images inside marked-content blocks. */
export function parsePdfPlacedImages(
  content: string,
  xobjects: Map<string, PageImageXObjectInfo>,
): McPlacedImageBlockResult[] {
  const blocks: McPlacedImageBlockResult[] = [];
  MC_BLOCK_RE.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = MC_BLOCK_RE.exec(content)) !== null) {
    const mcIndex = parseInt(bm[1], 10);
    blocks.push(parseMcBlockPlacedImage(bm[2], mcIndex, xobjects));
  }
  return blocks;
}

export function supportedPlacedImageRuns(blocks: McPlacedImageBlockResult[]): AiPlacedImageRun[] {
  const out: AiPlacedImageRun[] = [];
  for (const b of blocks) {
    if (b.mixed) continue;
    out.push(...b.images.filter((r) => r.supported));
  }
  return out;
}

/** Read page-1 content stream and parse embedded image metadata from `original` bytes. */
export async function parseAiPlacedImagesFromOriginal(
  original: ArrayBuffer,
): Promise<{ blocks: McPlacedImageBlockResult[]; pageHeight: number } | null> {
  const stream = await readFirstPageContentStreamText(original);
  if (!stream) return null;
  const xobjects = await loadPageImageXObjects(original);
  const blocks = parsePdfPlacedImages(stream.text, xobjects);
  return { blocks, pageHeight: stream.pageHeight };
}

function transformImagePoint(
  m: [number, number, number, number, number, number],
  ix: number,
  iy: number,
): { pdfX: number; pdfY: number } {
  return {
    pdfX: m[0] * ix + m[2] * iy + m[4],
    pdfY: m[1] * ix + m[3] * iy + m[5],
  };
}

/** Axis-aligned doc-space bounds (top-left origin) for a placed PDF image. */
export function docBoundsForPlacedImage(
  run: Pick<AiPlacedImageRun, 'placementMatrix' | 'width' | 'height'>,
  pageHeight: number,
): AiPlacedImageRunImportBounds {
  const corners = [
    transformImagePoint(run.placementMatrix, 0, 0),
    transformImagePoint(run.placementMatrix, run.width, 0),
    transformImagePoint(run.placementMatrix, 0, run.height),
    transformImagePoint(run.placementMatrix, run.width, run.height),
  ];
  let minDocX = Infinity;
  let minDocY = Infinity;
  let maxDocX = -Infinity;
  let maxDocY = -Infinity;
  for (const c of corners) {
    const docX = c.pdfX;
    const docY = pageHeight - c.pdfY;
    minDocX = Math.min(minDocX, docX);
    minDocY = Math.min(minDocY, docY);
    maxDocX = Math.max(maxDocX, docX);
    maxDocY = Math.max(maxDocY, docY);
  }
  return {
    docX: minDocX,
    docY: minDocY,
    docW: Math.max(1, maxDocX - minDocX),
    docH: Math.max(1, maxDocY - minDocY),
  };
}

function parseRefObjectNumber(xobjectRef: string): number | null {
  const m = /^(\d+)\s+\d+\s+R$/.exec(xobjectRef.trim());
  return m ? parseInt(m[1], 10) : null;
}

/** Decode Flate-compressed DeviceRGB image stream bytes from the original file. */
export async function decodeSupportedImageXObjectBytes(
  original: ArrayBuffer,
  run: Pick<AiPlacedImageRun, 'xobjectRef' | 'width' | 'height' | 'colorSpace' | 'filters' | 'bitsPerComponent'>,
): Promise<Uint8Array | null> {
  if (run.colorSpace !== 'DeviceRGB' || run.bitsPerComponent !== 8) return null;
  if (run.filters.length !== 1 || run.filters[0] !== 'FlateDecode') return null;
  const objNum = parseRefObjectNumber(run.xobjectRef);
  if (objNum == null) return null;

  const pdfDoc = await PDFDocument.load(original.slice(0), { ignoreEncryption: true });
  const stream = pdfDoc.context.lookup(PDFRef.of(objNum, 0));
  if (!(stream instanceof PDFStream)) return null;
  const raw = stream.getContents();
  let decoded: Uint8Array;
  try {
    decoded = inflate(raw);
  } catch {
    decoded = raw;
  }
  const expected = run.width * run.height * 3;
  if (decoded.length < expected) return null;
  return decoded.slice(0, expected);
}

export function rgbBytesToCanvas(width: number, height: number, bytes: Uint8Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = bytes[i * 3];
    img.data[i * 4 + 1] = bytes[i * 3 + 1];
    img.data[i * 4 + 2] = bytes[i * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function clonePlacedImageRun(run: AiPlacedImageRun): AiPlacedImageRun {
  return {
    ...run,
    placementMatrix: [...run.placementMatrix] as AiPlacedImageRun['placementMatrix'],
    filters: [...run.filters],
    patch: {
      ...run.patch,
      importDoSearch: run.patch.importDoSearch,
      importCmSearch: run.patch.importCmSearch,
    },
    importBounds: run.importBounds ? { ...run.importBounds } : undefined,
    importImageBytes: run.importImageBytes ? run.importImageBytes.slice() : undefined,
    importImageCanvas: run.importImageCanvas
      ? (() => {
          const c = document.createElement('canvas');
          c.width = run.importImageCanvas!.width;
          c.height = run.importImageCanvas!.height;
          c.getContext('2d')!.drawImage(run.importImageCanvas!, 0, 0);
          return c;
        })()
      : undefined,
    edit: run.edit?.replacementCanvas
      ? {
          replacementCanvas: (() => {
            const src = run.edit!.replacementCanvas!;
            const c = document.createElement('canvas');
            c.width = src.width;
            c.height = src.height;
            c.getContext('2d')!.drawImage(src, 0, 0);
            return c;
          })(),
        }
      : run.edit
        ? { ...run.edit }
        : undefined,
  };
}

export function supportedPlacedImagesOnNode(n: Node): AiPlacedImageRun[] {
  const stub = asAiLayerStub(n.src);
  if (stub.aiPlacedImageUnsupported) return [];
  return stub.aiPlacedImages?.filter((r) => r.supported) ?? [];
}

export function countSupportedPlacedImageNodes(doc: Doc): number {
  let count = 0;
  for (const node of walk(doc.roots)) {
    if (node.kind === 'group') continue;
    if (supportedPlacedImagesOnNode(node).length) count++;
  }
  return count;
}

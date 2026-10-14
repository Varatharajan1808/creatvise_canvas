import { PDFDocument, PDFName } from 'pdf-lib';
import { inflate } from 'pako';
import type { Layer } from 'ag-psd';
import type { Doc, Node } from './model';
import { getShapeBorderInfo, getShapeColor } from './edit';

/** PDF stream tokens used for non-destructive fill/stroke replacement on export. */
export interface AiShapePatch {
  fillSearch: string;
  strokeSearch?: string;
  strokeWidthSearch?: string;
}

export type AiShapeImportSnapshot = {
  fill: { r: number; g: number; b: number };
  stroke?: { r: number; g: number; b: number };
  strokeWidth?: number;
  strokeEnabled: boolean;
};

export type AiShapeLayer = Layer & {
  aiShapePatch?: AiShapePatch;
  importShapeSnapshot?: AiShapeImportSnapshot;
};

const BEZIER_MARKERS = /\s[cm]\s|\s[cm]\n|\s c\s|\s c\n/;

export function pdfRgbToken01(r: number, g: number, b: number): string {
  const f = (c: number) => (Math.max(0, Math.min(255, c)) / 255).toFixed(3);
  return `${f(r)} ${f(g)} ${f(b)}`;
}

export function pdfRgbFillToken(r: number, g: number, b: number): string {
  return `${pdfRgbToken01(r, g, b)} rg`;
}

export function pdfRgbStrokeToken(r: number, g: number, b: number): string {
  return `${pdfRgbToken01(r, g, b)} RG`;
}

/** Decompress page 1 content stream to latin1 text (first page only). */
export async function readFirstPageContentStreamText(original: ArrayBuffer): Promise<{
  text: string;
  pageHeight: number;
} | null> {
  const pdfDoc = await PDFDocument.load(original.slice(0), { ignoreEncryption: true });
  if (pdfDoc.getPageCount() < 1) return null;
  const page = pdfDoc.getPage(0);
  const pageH = page.getSize().height;
  const contentsRef = page.node.get(PDFName.of('Contents'));
  if (!contentsRef) return null;
  const contentsObj = pdfDoc.context.lookup(contentsRef);
  let originalRaw: Uint8Array | null = null;
  if (contentsObj && 'getContents' in contentsObj) {
    originalRaw = (contentsObj as { getContents: () => Uint8Array }).getContents();
  }
  if (!originalRaw) return null;
  let decompressed: Uint8Array;
  try {
    decompressed = inflate(originalRaw);
  } catch {
    decompressed = originalRaw;
  }
  return { text: new TextDecoder('latin1').decode(decompressed), pageHeight: pageH };
}

function parseRgb01(triple: string): { r: number; g: number; b: number } | null {
  const p = triple.trim().split(/\s+/).map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
  return {
    r: Math.round(p[0] * 255),
    g: Math.round(p[1] * 255),
    b: Math.round(p[2] * 255),
  };
}

function parseCmTranslate(block: string): { tx: number; ty: number } | null {
  const m = block.match(/1\s+0\s+0\s+1\s+([-\d.]+)\s+([-\d.]+)\s+cm/);
  if (m) return { tx: parseFloat(m[1]), ty: parseFloat(m[2]) };
  if (/cm/.test(block) && !/1\s+0\s+0\s+1/.test(block)) return null;
  return { tx: 0, ty: 0 };
}

export interface ParsedPdfRectShape {
  ocgIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fillSearch: string;
  fillRgb: { r: number; g: number; b: number };
  strokeSearch?: string;
  strokeRgb?: { r: number; g: number; b: number };
  strokeWidthSearch?: string;
  strokeWidth?: number;
}

/**
 * Extract rectangle-only vector shapes from marked-content blocks.
 * Skips blocks containing Bézier/path operators (not safely editable as isolated shapes).
 */
export function parsePdfRectShapes(content: string, pageHeight: number): ParsedPdfRectShape[] {
  const out: ParsedPdfRectShape[] = [];
  const blockRe = /\/OC\s+\/MC(\d+)\s+BDC([\s\S]*?)EMC/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(content)) !== null) {
    const ocgIndex = parseInt(bm[1], 10);
    const body = bm[2];
    if (BEZIER_MARKERS.test(body)) continue;
    out.push(...parseRectShapesInBody(body, pageHeight, ocgIndex));
  }
  if (out.length === 0 && !BEZIER_MARKERS.test(content)) {
    out.push(...parseRectShapesInBody(content, pageHeight, 0));
  }
  return out;
}

function parseRectShapesInBody(body: string, pageHeight: number, ocgIndex: number): ParsedPdfRectShape[] {
  const shapes: ParsedPdfRectShape[] = [];
  const chunks = body.split(/\nQ\s*\n|\nQ\s*$/);
  for (const chunk of chunks) {
    if (!/\bre\b/.test(chunk) || (!/\bf\b/.test(chunk) && !/\bS\b/.test(chunk))) continue;
    if (BEZIER_MARKERS.test(chunk)) continue;
    const cm = parseCmTranslate(chunk);
    if (cm === null) continue;

    const fillM = chunk.match(/([\d.]+\s+[\d.]+\s+[\d.]+)\s+rg/);
    const strokeM = chunk.match(/([\d.]+\s+[\d.]+\s+[\d.]+)\s+RG/);
    const widthM = chunk.match(/([\d.]+)\s+w/);
    const reM = chunk.match(/([-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+)\s+re/);
    if (!fillM || !reM) continue;
    const fillRgb = parseRgb01(fillM[1]);
    if (!fillRgb) continue;
    const parts = reM[1].trim().split(/\s+/).map(Number);
    if (parts.length !== 4) continue;
    const [rx, ry, rw, rh] = parts;
    const px = rx + cm.tx;
    const pyBottom = ry + cm.ty;
    const x = px;
    const y = pageHeight - pyBottom - rh;

    shapes.push({
      ocgIndex,
      x,
      y,
      w: rw,
      h: rh,
      fillSearch: `${fillM[1]} rg`,
      fillRgb,
      strokeSearch: strokeM ? `${strokeM[1]} RG` : undefined,
      strokeRgb: strokeM ? parseRgb01(strokeM[1]) ?? undefined : undefined,
      strokeWidthSearch: widthM ? `${widthM[1]} w` : undefined,
      strokeWidth: widthM ? parseFloat(widthM[1]) : undefined,
    });
  }
  return shapes;
}

function renderAiShapeCanvas(n: Node): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const w = Math.max(1, Math.round(n.w));
  const h = Math.max(1, Math.round(n.h));
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const fill = getShapeColor(n) ?? { r: 128, g: 128, b: 128 };
  g.fillStyle = `rgb(${fill.r},${fill.g},${fill.b})`;
  g.fillRect(0, 0, w, h);
  const border = getShapeBorderInfo(n);
  if (border?.enabled && border.width > 0) {
    g.strokeStyle = `rgb(${border.color.r},${border.color.g},${border.color.b})`;
    g.lineWidth = border.width;
    g.strokeRect(border.width / 2, border.width / 2, w - border.width, h - border.width);
  }
  return c;
}

export function buildAiShapeNode(parsed: ParsedPdfRectShape, index: number, pageLabel: string): Node {
  const strokeEnabled = Boolean(parsed.strokeSearch && parsed.strokeRgb);
  const layer: AiShapeLayer = {
    name: `Shape ${index + 1}`,
    left: parsed.x,
    top: parsed.y,
    right: parsed.x + parsed.w,
    bottom: parsed.y + parsed.h,
    hidden: false,
    opacity: 1,
    vectorFill: { type: 'color', color: { ...parsed.fillRgb } },
    vectorStroke: strokeEnabled
      ? {
          strokeEnabled: true,
          lineWidth: { value: parsed.strokeWidth ?? 1, units: 'Pixels' },
          content: { type: 'color', color: { ...(parsed.strokeRgb ?? { r: 0, g: 0, b: 0 }) } },
        }
      : undefined,
    aiShapePatch: {
      fillSearch: parsed.fillSearch,
      strokeSearch: parsed.strokeSearch,
      strokeWidthSearch: parsed.strokeWidthSearch,
    },
    importShapeSnapshot: {
      fill: { ...parsed.fillRgb },
      stroke: parsed.strokeRgb ? { ...parsed.strokeRgb } : undefined,
      strokeWidth: parsed.strokeWidth,
      strokeEnabled: strokeEnabled,
    },
  };

  const n: Node = {
    id: `ai-shape-${index}`,
    key: `ai-shape-${parsed.ocgIndex}-${index}`,
    name: layer.name!,
    kind: 'shape',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: parsed.x,
    y: parsed.y,
    w: parsed.w,
    h: parsed.h,
    rotation: 0,
    ow: parsed.w,
    oh: parsed.h,
    ox: parsed.x,
    oy: parsed.y,
    canvas: null,
    children: [],
    parent: null,
    src: layer,
    unsupported: [
      `PDF rectangle from ${pageLabel}. Path point editing stays in Illustrator; fill and stroke patch the content stream.`,
    ],
  };
  n.canvas = renderAiShapeCanvas(n);
  return n;
}

/** Replace raster OCG/artwork leaves with parsed rectangle shapes when the stream allows it. */
export async function applyAiVectorShapeImport(doc: Doc): Promise<void> {
  if (doc.format !== 'ai' || !doc.original?.byteLength) return;
  const stream = await readFirstPageContentStreamText(doc.original);
  if (!stream) return;
  const shapes = parsePdfRectShapes(stream.text, stream.pageHeight);
  if (shapes.length === 0) return;

  const byOcg = new Map<number, ParsedPdfRectShape[]>();
  for (const s of shapes) {
    const list = byOcg.get(s.ocgIndex) ?? [];
    list.push(s);
    byOcg.set(s.ocgIndex, list);
  }

  const newRoots: Node[] = [];
  let shapeIdx = 0;
  const ocgCount = doc.ai?.ocgNames.length ?? 0;

  if (ocgCount === 0) {
    for (const s of shapes) {
      newRoots.push(buildAiShapeNode(s, shapeIdx++, 'page 1'));
    }
    doc.roots = newRoots;
    doc.warnings.push(
      `${shapes.length} editable PDF rectangle shape(s) detected. Complex paths in this file stay in the PDF but are not separate layers.`,
    );
    return;
  }

  for (let i = 0; i < ocgCount; i++) {
    const list = byOcg.get(i);
    const ocgName = doc.ai!.ocgNames[i] ?? `Layer ${i + 1}`;
    if (list?.length) {
      for (const s of list) {
        const node = buildAiShapeNode(s, shapeIdx++, ocgName);
        node.name = `${ocgName} — ${node.name}`;
        newRoots.push(node);
      }
    } else {
      const prev = doc.roots.find((r) => r.key === `ocg-${i}`);
      if (prev) newRoots.push(prev);
    }
  }
  doc.roots = newRoots;
  doc.warnings.push(
    `${shapes.length} editable PDF rectangle shape(s) imported. Layers with Bézier paths remain flat PDF previews only.`,
  );
}

/** Patch fill/stroke operators in decompressed content stream text from shape nodes. */
export function patchAiShapeColorsInStream(text: string, doc: Doc): { text: string; notes: string[] } {
  const notes: string[] = [];
  let out = text;
  for (const n of doc.roots) {
    if (n.kind !== 'shape') continue;
    const patch = (n.src as AiShapeLayer).aiShapePatch;
    if (!patch) continue;
    const fill = getShapeColor(n);
    if (fill && patch.fillSearch) {
      const rep = pdfRgbFillToken(fill.r, fill.g, fill.b);
      if (!out.includes(patch.fillSearch)) {
        notes.push(`Shape "${n.name}": fill operator not found in PDF stream (already edited elsewhere?).`);
      } else {
        out = out.split(patch.fillSearch).join(rep);
        patch.fillSearch = rep;
      }
    }
    const border = getShapeBorderInfo(n);
    if (border && patch.strokeSearch && border.enabled) {
      const rep = pdfRgbStrokeToken(border.color.r, border.color.g, border.color.b);
      if (out.includes(patch.strokeSearch)) {
        out = out.split(patch.strokeSearch).join(rep);
        patch.strokeSearch = rep;
      }
    }
    if (border && patch.strokeWidthSearch && border.enabled) {
      const w = Math.max(0.1, border.width);
      const rep = `${formatStrokeWidth(w)} w`;
      if (out.includes(patch.strokeWidthSearch)) {
        out = out.split(patch.strokeWidthSearch).join(rep);
        patch.strokeWidthSearch = rep;
      }
    }
  }
  return { text: out, notes };
}

function formatStrokeWidth(w: number): string {
  const r = Math.round(w * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/\.?0+$/, '');
}

/** True when fill/stroke/width differs from values captured at import (requires pdf-lib stream patch on export). */
export function docHasAiShapeStreamEdits(doc: Doc): boolean {
  for (const n of doc.roots) {
    if (n.kind !== 'shape') continue;
    const layer = n.src as AiShapeLayer;
    const snap = layer.importShapeSnapshot;
    if (!snap) continue;
    const fill = getShapeColor(n);
    if (
      fill &&
      (fill.r !== snap.fill.r || fill.g !== snap.fill.g || fill.b !== snap.fill.b)
    ) {
      return true;
    }
    const border = getShapeBorderInfo(n);
    const enabled = Boolean(border?.enabled && border.width > 0);
    if (enabled !== snap.strokeEnabled) return true;
    if (enabled && border && snap.stroke) {
      if (
        border.color.r !== snap.stroke.r ||
        border.color.g !== snap.stroke.g ||
        border.color.b !== snap.stroke.b
      ) {
        return true;
      }
      const w = Math.max(0.1, border.width);
      if (snap.strokeWidth != null && Math.abs(w - snap.strokeWidth) > 1e-3) return true;
    }
  }
  return false;
}

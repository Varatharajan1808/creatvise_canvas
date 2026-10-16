import type { Doc, Node } from '../core/model';
import { walk } from '../core/model';
import type { TextInfo, Rgb } from '../operations/edit';
import { asAiLayerStub } from './aiLayerMeta';
import type { AiLiveTextRun, AiLiveTextRunEdits } from './aiPdfText';
import { pdfRgbFillToken } from './aiVectorShapes';

export type AiTextPreviewMode = 'isolate' | 'overlay';

function copyCanvas(src: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!src) return null;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

function cloneRunEdits(e?: AiLiveTextRunEdits): AiLiveTextRunEdits | undefined {
  if (!e) return undefined;
  return {
    ...e,
    color: e.color ? { ...e.color } : undefined,
  };
}

function fontResourceToFamily(resource: string): string {
  const name = resource.replace(/^\//, '');
  if (/^F\d+$/.test(name)) return 'Helvetica';
  return name.replace(/-/g, ' ');
}

function cssFont(family: string, px: number, bold: boolean, italic: boolean): string {
  const clean = family.replace(/(MT|PS)$/i, '').split('-')[0].trim();
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${px}px "${family}", "${clean}", Arial, Helvetica, sans-serif`;
}

export function supportedAiRuns(n: Node): AiLiveTextRun[] {
  const stub = asAiLayerStub(n.src);
  if (stub.aiLiveTextUnsupported) return [];
  return stub.aiLiveTextRuns?.filter((r) => r.supported) ?? [];
}

/** True when this AI raster leaf has Phase A live text and is not a mixed MC block. */
export function canEditAiLiveTextOnNode(n: Node): boolean {
  if (n.kind !== 'raster') return false;
  return supportedAiRuns(n).length > 0;
}

function activeRunIndex(n: Node): number {
  const stub = asAiLayerStub(n.src);
  const runs = supportedAiRuns(n);
  if (!runs.length) return 0;
  const idx = stub.aiTextActiveRunIndex ?? 0;
  return Math.max(0, Math.min(idx, runs.length - 1));
}

function activeRun(n: Node): AiLiveTextRun | null {
  const runs = supportedAiRuns(n);
  const i = activeRunIndex(n);
  return runs[i] ?? null;
}

export function displayForRun(run: AiLiveTextRun): Required<Pick<AiLiveTextRunEdits, 'text' | 'fontSize' | 'fontFamily' | 'bold' | 'italic' | 'alignment'>> & {
  color: Rgb;
} {
  const e = run.edit;
  const fontFamily = e?.fontFamily ?? run.importFontFamily ?? fontResourceToFamily(run.fontResource);
  return {
    text: e?.text ?? run.text,
    fontSize: e?.fontSize ?? run.fontSize,
    fontFamily,
    color: e?.color ?? run.fillRgb ?? { r: 0, g: 0, b: 0 },
    bold: e?.bold ?? false,
    italic: e?.italic ?? false,
    alignment: e?.alignment ?? 'left',
  };
}

function textMatrixRotated(run: AiLiveTextRun): boolean {
  const m = run.textMatrix;
  return Math.abs(m[1]) > 1e-2 || Math.abs(m[2]) > 1e-2;
}

function measureRunBounds(
  run: AiLiveTextRun,
  display: ReturnType<typeof displayForRun>,
): { docX: number; docY: number; docW: number; docH: number } {
  const scale = Math.hypot(run.textMatrix[0], run.textMatrix[1]) || 1;
  const px = Math.max(1, display.fontSize * scale);
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = cssFont(display.fontFamily, px, display.bold, display.italic);
  const lines = display.text.split(/\r\n|\r|\n/);
  const widths = lines.map((l) => probe.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const m = probe.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? px * 0.9;
  const descent = m.fontBoundingBoxDescent ?? px * 0.25;
  const lineH = px * 1.2;
  const pad = Math.ceil(px * 0.35);
  const h = Math.max(1, ascent + descent + lineH * (lines.length - 1)) + pad * 2;
  let docX = run.docX;
  if (display.alignment === 'center') docX = run.textMatrix[4] - maxW / 2 - pad;
  else if (display.alignment === 'right') docX = run.textMatrix[4] - maxW - pad;
  else docX = run.docX - pad;
  const docY = run.docY - pad;
  return {
    docX: Math.floor(docX),
    docY: Math.floor(docY),
    docW: Math.ceil(maxW + pad * 2),
    docH: Math.ceil(h),
  };
}

function resolvePreviewMode(n: Node, runs: AiLiveTextRun[]): AiTextPreviewMode {
  if (runs.some((r) => textMatrixRotated(r))) return 'overlay';
  if (runs.length > 1) return 'overlay';
  return 'isolate';
}

/** After import: snapshot raster pixels and measure import bounds per run. */
export function prepareAiTextEditing(n: Node): void {
  const runs = supportedAiRuns(n);
  if (!runs.length || !n.canvas) return;

  if (!n.aiImportRasterCanvas) {
    n.aiImportRasterCanvas = copyCanvas(n.canvas);
  }

  for (const run of runs) {
    run.importFontFamily = fontResourceToFamily(run.fontResource);
    const display = displayForRun(run);
    run.importBounds = measureRunBounds(run, display);
  }

  const stub = asAiLayerStub(n.src);
  stub.aiTextPreviewMode = resolvePreviewMode(n, runs);
  if (stub.aiTextActiveRunIndex === undefined) stub.aiTextActiveRunIndex = 0;

  replaceUnsupportedPreviewNote(n);
}

function replaceUnsupportedPreviewNote(n: Node): void {
  const stub = asAiLayerStub(n.src);
  const old =
    /live PDF text run\(s\) detected[\s\S]*?(?:text editing is not enabled yet|preview only)/i;
  n.unsupported = n.unsupported.filter((u) => !old.test(u));
  const mode = stub.aiTextPreviewMode ?? 'isolate';
  const runs = supportedAiRuns(n).length;
  const preview =
    mode === 'overlay'
      ? `${runs} live PDF text run(s): preview draws edits on top of the PDF raster (export writes supported changes to the PDF stream).`
      : `${runs} live PDF text run(s): canvas preview replaces detected glyph areas; export writes supported text/fill to the PDF stream.`;
  if (!n.unsupported.includes(preview)) n.unsupported.push(preview);
}

export function getAiTextPreviewNote(n: Node): string | null {
  if (!canEditAiLiveTextOnNode(n)) return null;
  const mode = asAiLayerStub(n.src).aiTextPreviewMode ?? 'isolate';
  if (mode === 'overlay') {
    return 'Preview-limited: text matrix is rotated or multiple runs overlap the same raster — edited text is drawn on top without erasing unrelated pixels.';
  }
  return 'Live PDF text: content and fill color export to the PDF content stream. Font/size/alignment changes are preview-only unless the stream token supports them.';
}

export function getAiLiveTextInfo(n: Node): TextInfo | null {
  const run = activeRun(n);
  if (!run) return null;
  const d = displayForRun(run);
  let reason: string | undefined;
  if (textMatrixRotated(run)) {
    reason = 'Rotated PDF text: preview is overlay-only (no safe glyph erase). Content and styling can still be edited.';
  }
  const runs = supportedAiRuns(n);
  if (runs.length > 1 && (asAiLayerStub(n.src).aiTextActiveRunIndex ?? 0) === 0) {
    // allow edit but could add run picker later
  }
  return {
    text: d.text,
    fontSize: d.fontSize,
    color: d.color,
    fontFamily: d.fontFamily,
    bold: d.bold,
    italic: d.italic,
    alignment: d.alignment,
    reason,
  };
}

function drawRunOnLayer(
  g: CanvasRenderingContext2D,
  n: Node,
  run: AiLiveTextRun,
  display: ReturnType<typeof displayForRun>,
): void {
  const scale = Math.hypot(run.textMatrix[0], run.textMatrix[1]) || 1;
  const px = Math.max(1, display.fontSize * scale);
  const lines = display.text.split(/\r\n|\r|\n/);
  g.font = cssFont(display.fontFamily, px, display.bold, display.italic);
  const widths = lines.map((l) => g.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const m = g.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? px * 0.9;
  const lineH = px * 1.2;
  const pad = Math.ceil(px * 0.35);
  const align = display.alignment;
  const bounds = measureRunBounds(run, display);
  const lx = bounds.docX - n.x;
  const ly = bounds.docY - n.y;
  g.fillStyle = `rgb(${display.color.r},${display.color.g},${display.color.b})`;
  g.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const off =
      align === 'center' ? (maxW - widths[i]) / 2 : align === 'right' ? maxW - widths[i] : 0;
    g.fillText(line, lx + pad + off, ly + pad + ascent + i * lineH);
  });
}

/** Rebuild `n.canvas` from import raster + edited live-text runs. */
export function compositeAiTextLayerPreview(n: Node): void {
  const base = n.aiImportRasterCanvas ?? n.canvas;
  if (!base) return;
  const runs = supportedAiRuns(n);
  if (!runs.length) return;

  const out = copyCanvas(base);
  if (!out) return;
  const g = out.getContext('2d')!;
  const stub = asAiLayerStub(n.src);
  const mode = stub.aiTextPreviewMode ?? 'isolate';

  if (mode === 'isolate') {
    for (const run of runs) {
      const b = run.importBounds;
      if (!b) continue;
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = 'rgba(0,0,0,1)';
      g.fillRect(b.docX - n.x, b.docY - n.y, b.docW, b.docH);
      g.restore();
    }
  }

  for (const run of runs) {
    drawRunOnLayer(g, n, run, displayForRun(run));
  }

  n.canvas = out;
}

export function applyAiLiveTextEdit(
  n: Node,
  patch: {
    text?: string;
    fontSize?: number;
    color?: Rgb;
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
  },
): void {
  const run = activeRun(n);
  if (!run || !n.aiImportRasterCanvas) return;

  run.edit = {
    ...(run.edit ?? {}),
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
    ...(patch.color ? { color: { ...patch.color } } : {}),
    ...(patch.fontFamily !== undefined ? { fontFamily: patch.fontFamily } : {}),
    ...(patch.bold !== undefined ? { bold: patch.bold } : {}),
    ...(patch.italic !== undefined ? { italic: patch.italic } : {}),
    ...(patch.alignment !== undefined ? { alignment: patch.alignment } : {}),
  };

  n.aiTextEdited = true;
  compositeAiTextLayerPreview(n);
}

export interface AiTextUndoState {
  runs: AiLiveTextRun[];
  aiTextPreviewMode?: AiTextPreviewMode;
  aiTextActiveRunIndex?: number;
  aiTextEdited?: boolean;
  canvas: HTMLCanvasElement | null;
}

function cloneRuns(runs: AiLiveTextRun[]): AiLiveTextRun[] {
  return runs.map((r) => ({
    ...r,
    textMatrix: [...r.textMatrix] as AiLiveTextRun['textMatrix'],
    patch: { ...r.patch, importTjSearch: r.patch.importTjSearch, importFillSearch: r.patch.importFillSearch },
    fillRgb: r.fillRgb ? { ...r.fillRgb } : undefined,
    importBounds: r.importBounds ? { ...r.importBounds } : undefined,
    edit: cloneRunEdits(r.edit),
  }));
}

export function captureAiTextState(n: Node): AiTextUndoState | undefined {
  if (!canEditAiLiveTextOnNode(n)) return undefined;
  const stub = asAiLayerStub(n.src);
  const runs = stub.aiLiveTextRuns ?? [];
  return {
    runs: cloneRuns(runs),
    aiTextPreviewMode: stub.aiTextPreviewMode,
    aiTextActiveRunIndex: stub.aiTextActiveRunIndex,
    aiTextEdited: n.aiTextEdited,
    canvas: n.canvas,
  };
}

export function restoreAiTextState(n: Node, s: AiTextUndoState): void {
  const stub = asAiLayerStub(n.src);
  stub.aiLiveTextRuns = cloneRuns(s.runs);
  stub.aiTextPreviewMode = s.aiTextPreviewMode;
  stub.aiTextActiveRunIndex = s.aiTextActiveRunIndex;
  n.aiTextEdited = s.aiTextEdited;
  n.canvas = s.canvas;
}

// ---------------------------------------------------------------- PDF content-stream export (Phase C)

function escapePdfLiteralContent(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** PDF literal string show operator built from Unicode text (WinAnsi-safe subset). */
export function buildLiteralTjOperator(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c > 255) {
      throw new Error(`Character U+${c.toString(16)} cannot be encoded in a PDF literal text string.`);
    }
  }
  return `(${escapePdfLiteralContent(text)}) Tj`;
}

function isLiteralTjToken(tjSearch: string): boolean {
  return tjSearch.startsWith('(') && /\)\s*Tj$/.test(tjSearch);
}

function isHexTjToken(tjSearch: string): boolean {
  return tjSearch.startsWith('<') && />\s*Tj$/.test(tjSearch);
}

function isTjArrayToken(tjSearch: string): boolean {
  return tjSearch.includes('] TJ');
}

function importColor(run: AiLiveTextRun): Rgb {
  return run.fillRgb ?? { r: 0, g: 0, b: 0 };
}

function colorEqual(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function runHasPatchableStreamChange(run: AiLiveTextRun): boolean {
  if (!run.edit) return false;
  const d = displayForRun(run);
  if (d.text !== run.text) return true;
  if (run.patch.fillSearch && !colorEqual(d.color, importColor(run))) return true;
  return false;
}

function runHasPreviewOnlyEdits(run: AiLiveTextRun): boolean {
  if (!run.edit) return false;
  const d = displayForRun(run);
  if (d.fontSize !== run.fontSize) return true;
  if (d.fontFamily !== (run.importFontFamily ?? fontResourceToFamily(run.fontResource))) return true;
  if (d.bold || d.italic) return true;
  if (d.alignment !== 'left') return true;
  return false;
}

/** True when at least one live-text run has PDF-stream patchable edits. */
export function docHasAiTextStreamEdits(doc: Doc): boolean {
  for (const n of walk(doc.roots)) {
    if (!n.aiTextEdited) continue;
    for (const run of supportedAiRuns(n)) {
      if (runHasPatchableStreamChange(run)) return true;
    }
  }
  return false;
}

/** Nodes with preview edits that cannot be written to the content stream. */
export function docHasUnexportedAiTextPreviewEdits(doc: Doc): boolean {
  for (const n of walk(doc.roots)) {
    if (!n.aiTextEdited) continue;
    const runs = supportedAiRuns(n);
    const patchable = runs.some((r) => runHasPatchableStreamChange(r));
    const previewOnly = runs.some((r) => runHasPreviewOnlyEdits(r));
    if (previewOnly && !patchable) return true;
  }
  return false;
}

export class AiTextStreamExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiTextStreamExportError';
  }
}

/**
 * Patch decompressed page content stream text for supported live-text edits.
 * Uses import-time `patch.tjSearch` / `fillSearch` tokens only (never screen position).
 */
export function patchAiTextInStream(
  content: string,
  doc: Doc,
): { text: string; notes: string[] } {
  const notes: string[] = [];
  let out = content;
  let replacements = 0;

  for (const n of walk(doc.roots)) {
    if (!n.aiTextEdited) continue;
    for (const run of supportedAiRuns(n)) {
      if (!runHasPatchableStreamChange(run)) {
        if (runHasPreviewOnlyEdits(run)) {
          notes.push(
            `Layer "${n.name}": font, size, or alignment changes are preview-only and were not written to the PDF stream.`,
          );
        }
        continue;
      }

      const display = displayForRun(run);
      const tjSearch = run.patch.importTjSearch;
      const fillSearch = run.patch.importFillSearch ?? run.patch.fillSearch;

      if (display.text !== run.text) {
        if (isTjArrayToken(tjSearch)) {
          throw new AiTextStreamExportError(
            `Layer "${n.name}": TJ kerning arrays cannot be edited safely in the PDF stream yet.`,
          );
        }
        if (isHexTjToken(tjSearch)) {
          throw new AiTextStreamExportError(
            `Layer "${n.name}": hex-encoded PDF text strings cannot be edited safely yet.`,
          );
        }
        if (!isLiteralTjToken(tjSearch)) {
          throw new AiTextStreamExportError(
            `Layer "${n.name}": unsupported PDF text operator token for export.`,
          );
        }
        if (!out.includes(tjSearch)) {
          throw new AiTextStreamExportError(
            `Layer "${n.name}": original PDF text token not found in the content stream (file may have changed).`,
          );
        }
        const newTj = buildLiteralTjOperator(display.text);
        out = out.split(tjSearch).join(newTj);
        replacements++;
      }

      if (fillSearch && !colorEqual(display.color, importColor(run))) {
        const rep = pdfRgbFillToken(display.color.r, display.color.g, display.color.b);
        if (!out.includes(fillSearch)) {
          notes.push(`Layer "${n.name}": fill color operator not found in PDF stream.`);
        } else {
          out = out.split(fillSearch).join(rep);
          replacements++;
        }
      }
    }
  }

  if (replacements > 0) {
    notes.push(
      `${replacements} live PDF text stream token(s) updated. Illustrator AIPrivateData may still hold a separate native text representation.`,
    );
  }

  return { text: out, notes };
}

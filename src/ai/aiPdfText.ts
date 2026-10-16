import type { Doc, Node } from '../core/model';
import { walk } from '../core/model';
import { asAiLayerStub, resolveAiMcIndex } from './aiLayerMeta';
import { prepareAiTextEditing } from './aiTextEdit';
import { readFirstPageContentStreamText } from './aiVectorShapes';

/** Stable tokens for a future export-time text patch (Phase B+). */
export interface AiTextPatch {
  /** Exact `Tj`/`TJ` operator substring in the decompressed latin1 content stream. */
  tjSearch: string;
  /** Import-time `tjSearch` (immutable); export always patches from `doc.original` using this token. */
  importTjSearch: string;
  /** Non-stroking fill operator token when present (e.g. `0 0 0 rg`). */
  fillSearch?: string;
  importFillSearch?: string;
}

/** Doc-space bounds of imported text glyphs (for preview erase). */
export interface AiLiveTextRunImportBounds {
  docX: number;
  docY: number;
  docW: number;
  docH: number;
}

/** User edits stored separately from import-time PDF metadata (export Phase C+). */
export interface AiLiveTextRunEdits {
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: { r: number; g: number; b: number };
  bold?: boolean;
  italic?: boolean;
  alignment?: 'left' | 'center' | 'right';
}

/** One live PDF text show operation detected at import (not an editor text layer yet). */
export interface AiLiveTextRun {
  mcIndex: number;
  text: string;
  fontResource: string;
  fontSize: number;
  fillRgb?: { r: number; g: number; b: number };
  /** PDF text matrix `[a b c d e f]` in user space (bottom-left origin). */
  textMatrix: [number, number, number, number, number, number];
  /** Approximate doc-space top-left (1 px ≈ 1 pt at import scale). */
  docX: number;
  docY: number;
  patch: AiTextPatch;
  supported: boolean;
  unsupportedReason?: string;
  /** Measured at import for clearing original glyphs in canvas preview. */
  importBounds?: AiLiveTextRunImportBounds;
  importFontFamily?: string;
  /** Canvas preview / panel edits (does not mutate import `text` or stream patch tokens). */
  edit?: AiLiveTextRunEdits;
}

export type McLiveTextBlockResult = {
  mcIndex: number;
  runs: AiLiveTextRun[];
  /** Block mixes live text with paths, images, or Bézier curves. */
  mixed: boolean;
  mixedReason?: string;
};

const MC_BLOCK_RE = /\/OC\s+\/MC(\d+)\s+BDC([\s\S]*?)EMC/g;
const BEZIER_MARKERS = /\s[cm]\s|\s[cm]\n|\s c\s|\s c\n/;

/** Path/paint operators outside a pure-text stream (used to detect mixed MC blocks). */
const PATH_OR_IMAGE_MARKERS =
  /\bre\b|\bf\b|\bS\b|\bs\b|\bB\b|\bB\*\b|\bW\b|\bn\b|\bm\b|\bl\b|\bc\b|\bDo\b/;

function makeTextPatch(tjSearch: string, fillSearch?: string): AiTextPatch {
  return {
    tjSearch,
    importTjSearch: tjSearch,
    fillSearch,
    importFillSearch: fillSearch,
  };
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

function unescapePdfLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if ('nrtbf\\()'.includes(next)) {
      out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '(': '(', ')': ')' }[next]!;
    } else if (/[0-7]/.test(next)) {
      let oct = next;
      for (let j = 0; j < 2 && i + 1 < raw.length && /[0-7]/.test(raw[i + 1]); j++) {
        oct += raw[++i];
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else {
      out += next;
    }
  }
  return out;
}

function readPdfLiteralAt(text: string, openParen: number): { value: string; raw: string; end: number } | null {
  if (text[openParen] !== '(') return null;
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(openParen, i + 1);
        return { value: unescapePdfLiteral(raw.slice(1, -1)), raw, end: i + 1 };
      }
    }
  }
  return null;
}

function readPdfHexStringAt(text: string, open: number): { value: string; raw: string; end: number } | null {
  if (text[open] !== '<' || text[open + 1] === '<') return null;
  const close = text.indexOf('>', open + 1);
  if (close < 0) return null;
  const hex = text.slice(open + 1, close).replace(/\s/g, '');
  let value = '';
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.slice(i, i + 2);
    if (pair.length < 2) break;
    value += String.fromCharCode(parseInt(pair, 16));
  }
  return { value, raw: text.slice(open, close + 1), end: close + 1 };
}

function pdfMatrixIdentity(): [number, number, number, number, number, number] {
  return [1, 0, 0, 1, 0, 0];
}

function multiplyPdfMatrix(
  a: [number, number, number, number, number, number],
  b: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function textMatrixToDocPosition(
  m: [number, number, number, number, number, number],
  pageHeight: number,
): { docX: number; docY: number } {
  const fontScale = Math.hypot(m[0], m[1]) || 1;
  const docX = m[4];
  const docY = pageHeight - m[5] - fontScale;
  return { docX, docY };
}

function stripTextObjects(body: string): string {
  return body.replace(/\bBT\b[\s\S]*?\bET\b/g, '');
}

function bodyHasNonTextGraphics(body: string): boolean {
  const withoutText = stripTextObjects(body);
  if (BEZIER_MARKERS.test(withoutText)) return true;
  if (PATH_OR_IMAGE_MARKERS.test(withoutText)) return true;
  return false;
}

function parseTextObjectBody(segment: string, mcIndex: number, pageHeight: number): AiLiveTextRun[] {
  const runs: AiLiveTextRun[] = [];
  let fontResource = '';
  let fontSize = 12;
  let fillRgb: { r: number; g: number; b: number } | undefined;
  let fillSearch: string | undefined;
  let matrix = pdfMatrixIdentity();

  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i])) i++;
    if (i >= segment.length) break;

    const tf = segment.slice(i).match(/^\/([^\s]+)\s+([\d.]+)\s+Tf\b/);
    if (tf) {
      fontResource = tf[1];
      fontSize = parseFloat(tf[2]);
      i += tf[0].length;
      continue;
    }

    const rg = segment.slice(i).match(/^([\d.]+\s+[\d.]+\s+[\d.]+)\s+rg\b/);
    if (rg) {
      fillSearch = `${rg[1]} rg`;
      fillRgb = parseRgb01(rg[1]) ?? undefined;
      i += rg[0].length;
      continue;
    }

    const tm = segment.slice(i).match(/^([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm\b/);
    if (tm) {
      matrix = [
        parseFloat(tm[1]),
        parseFloat(tm[2]),
        parseFloat(tm[3]),
        parseFloat(tm[4]),
        parseFloat(tm[5]),
        parseFloat(tm[6]),
      ];
      i += tm[0].length;
      continue;
    }

    const td = segment.slice(i).match(/^([-\d.]+)\s+([-\d.]+)\s+Td\b/);
    if (td) {
      matrix = multiplyPdfMatrix(matrix, [1, 0, 0, 1, parseFloat(td[1]), parseFloat(td[2])]);
      i += td[0].length;
      continue;
    }

    if (segment[i] === '(') {
      const lit = readPdfLiteralAt(segment, i);
      if (lit && /^\s*Tj\b/.test(segment.slice(lit.end))) {
        if (lit.value) {
          const { docX, docY } = textMatrixToDocPosition(matrix, pageHeight);
          runs.push({
            mcIndex,
            text: lit.value,
            fontResource,
            fontSize,
            fillRgb,
            textMatrix: [...matrix] as AiLiveTextRun['textMatrix'],
            docX,
            docY,
            patch: makeTextPatch(`${lit.raw} Tj`, fillSearch),
            supported: true,
          });
        }
        i = lit.end;
        while (i < segment.length && /\s/.test(segment[i])) i++;
        if (segment.slice(i, i + 2) === 'Tj') i += 2;
        continue;
      }
    }

    if (segment[i] === '<' && segment[i + 1] !== '<') {
      const hex = readPdfHexStringAt(segment, i);
      if (hex && /^\s*Tj\b/.test(segment.slice(hex.end))) {
        const { docX, docY } = textMatrixToDocPosition(matrix, pageHeight);
        runs.push({
          mcIndex,
          text: hex.value,
          fontResource,
          fontSize,
          fillRgb,
          textMatrix: [...matrix] as AiLiveTextRun['textMatrix'],
          docX,
          docY,
          patch: makeTextPatch(`${hex.raw} Tj`, fillSearch),
          supported: true,
        });
        i = hex.end;
        while (i < segment.length && /\s/.test(segment[i])) i++;
        if (segment.slice(i, i + 2) === 'Tj') i += 2;
        continue;
      }
    }

    if (segment[i] === '[') {
      const close = segment.indexOf('] TJ', i);
      if (close >= 0) {
        const inner = segment.slice(i + 1, close);
        const tjSearch = segment.slice(i, close + 4);
        let text = '';
        let j = 0;
        while (j < inner.length) {
          while (j < inner.length && /\s/.test(inner[j])) j++;
          if (j >= inner.length) break;
          if (inner[j] === '(') {
            const lit = readPdfLiteralAt(inner, j);
            if (!lit) break;
            text += lit.value;
            j = lit.end;
            continue;
          }
          if (inner[j] === '<') {
            const hx = readPdfHexStringAt(inner, j);
            if (!hx) break;
            text += hx.value;
            j = hx.end;
            continue;
          }
          const num = inner.slice(j).match(/^[-\d.]+/);
          if (num) {
            j += num[0].length;
            continue;
          }
          j++;
        }
        if (text) {
          const { docX, docY } = textMatrixToDocPosition(matrix, pageHeight);
          runs.push({
            mcIndex,
            text,
            fontResource,
            fontSize,
            fillRgb,
            textMatrix: [...matrix] as AiLiveTextRun['textMatrix'],
            docX,
            docY,
            patch: makeTextPatch(tjSearch, fillSearch),
            supported: true,
          });
        }
        i = close + 4;
        continue;
      }
    }

    i++;
  }
  return runs;
}

function parseTextObject(body: string, mcIndex: number, pageHeight: number): AiLiveTextRun[] {
  const runs: AiLiveTextRun[] = [];
  const btRe = /\bBT\b/g;
  let bt: RegExpExecArray | null;
  while ((bt = btRe.exec(body)) !== null) {
    const etIdx = body.indexOf('ET', bt.index + 2);
    if (etIdx < 0) continue;
    const inner = body.slice(bt.index + 2, etIdx);
    runs.push(...parseTextObjectBody(inner, mcIndex, pageHeight));
  }
  return runs;
}

/** Parse one marked-content block body for live PDF text (no paths/images mixed in). */
export function parseMcBlockLiveText(body: string, mcIndex: number, pageHeight: number): McLiveTextBlockResult {
  const hasBt = /\bBT\b/.test(body);
  if (!hasBt) {
    return { mcIndex, runs: [], mixed: false };
  }

  if (bodyHasNonTextGraphics(body)) {
    return {
      mcIndex,
      runs: [],
      mixed: true,
      mixedReason: 'Marked-content block mixes live PDF text with paths, images, or curves.',
    };
  }

  const runs = parseTextObject(body, mcIndex, pageHeight);
  return { mcIndex, runs, mixed: false };
}

/**
 * Scan decompressed page-1 content stream for live PDF text in `/OC /MCn BDC … EMC` blocks.
 * Does not treat path-only artwork (outlined text) as live text.
 */
export function parsePdfLiveText(content: string, pageHeight: number): McLiveTextBlockResult[] {
  const blocks: McLiveTextBlockResult[] = [];
  let bm: RegExpExecArray | null;
  MC_BLOCK_RE.lastIndex = 0;
  while ((bm = MC_BLOCK_RE.exec(content)) !== null) {
    const mcIndex = parseInt(bm[1], 10);
    blocks.push(parseMcBlockLiveText(bm[2], mcIndex, pageHeight));
  }

  if (blocks.length === 0 && /\bBT\b/.test(content)) {
    blocks.push(parseMcBlockLiveText(content, 0, pageHeight));
  }

  return blocks;
}

export function supportedLiveTextRuns(blocks: McLiveTextBlockResult[]): AiLiveTextRun[] {
  const out: AiLiveTextRun[] = [];
  for (const b of blocks) {
    if (b.mixed) continue;
    out.push(...b.runs.filter((r) => r.supported));
  }
  return out;
}

/** Leaf nodes that carry import-detected live text metadata (still `kind: 'raster'`, not editable UI). */
export function countAiLiveTextRunNodes(doc: Doc): number {
  let n = 0;
  for (const node of walk(doc.roots)) {
    if (node.kind === 'group') continue;
    const runs = asAiLayerStub(node.src).aiLiveTextRuns;
    if (runs?.some((r) => r.supported)) n++;
  }
  return n;
}

export function totalSupportedAiLiveTextRuns(doc: Doc): number {
  let total = 0;
  for (const node of walk(doc.roots)) {
    if (node.kind === 'group') continue;
    const runs = asAiLayerStub(node.src).aiLiveTextRuns;
    if (runs) total += runs.filter((r) => r.supported).length;
  }
  return total;
}

/**
 * Attach parsed live-text metadata to AI layer stubs. Does not change layer kind, canvas pixels, or export.
 */
export async function applyAiLiveTextImport(doc: Doc): Promise<void> {
  if (doc.format !== 'ai' || !doc.original?.byteLength) return;

  const stream = await readFirstPageContentStreamText(doc.original);
  if (!stream) return;

  const blocks = parsePdfLiveText(stream.text, stream.pageHeight);
  const runsByMc = new Map<number, AiLiveTextRun[]>();
  const mixedByMc = new Map<number, string>();

  for (const block of blocks) {
    if (block.mixed) {
      mixedByMc.set(block.mcIndex, block.mixedReason ?? 'Mixed marked-content block.');
      continue;
    }
    if (block.runs.length) runsByMc.set(block.mcIndex, block.runs);
  }

  const supportedCount = supportedLiveTextRuns(blocks).length;
  if (supportedCount === 0 && mixedByMc.size === 0) return;

  for (const node of walk(doc.roots)) {
    if (node.kind === 'group') continue;
    const mc = resolveAiMcIndex(node);
    const stub = asAiLayerStub(node.src);

    const mixed = mixedByMc.get(mc);
    if (mixed) {
      stub.aiLiveTextUnsupported = mixed;
      if (!node.unsupported.includes(mixed)) node.unsupported.push(mixed);
      continue;
    }

    const runs = runsByMc.get(mc);
    if (runs?.length) {
      stub.aiLiveTextRuns = runs;
      prepareAiTextEditing(node);
    }
  }

  if (supportedCount > 0) {
    doc.warnings.push(
      `Detected ${supportedCount} live PDF text run(s) in the content stream. You can edit supported runs in the panel; changes are canvas preview only until export is implemented.`,
    );
  }
}

import type { Layer, Psd } from 'ag-psd';
import type { IdmlDocBacking, IdmlNodeMeta } from '../indd/types';
import type { InddImportReport } from '../indd/inddImportReport';

/** PDF-compatible `.ai` backing store (patched on export in Phase D). */
export interface AiDocBacking {
  readonly kind: 'ai';
  pageCount: number;
  /** PDF Optional Content groups detected in the file. */
  hasOcg: boolean;
  ocgNames: string[];
  /** Object refs from `/OCGs[...]` in catalog order (e.g. `"5 0 R"`). */
  ocgRefs: string[];
  /** PDF `/Type/ExtGState` with `/ca` found — opacity can be patched on export. */
  hasExtGStateOpacity: boolean;
  /** `/ca` read from file at import (1 when no ExtGState). Used for export verification. */
  extGStateCaAtImport: number;
  /** Next `/MCn` index available when duplicating layers (export allocates new marked content). */
  nextMcIndex: number;
  /** When false, duplicate is blocked (no marked-content blocks to clone safely). */
  canDuplicateMarkedContent: boolean;
  /** Top-level leaf node ids (bottom→top) captured at end of import; used to detect stack reorder. */
  importStackNodeIds?: string[];
  /** `/MC` block count in page Contents at import (before shape promotion). */
  markedContentBlockCount?: number;
  /** OCG object refs by catalog index (`ocg-N` → `[N]`); not permuted on stack reorder. */
  importOcgRefsByCatalogIndex?: string[];
  /** Pinned file bytes (safe when `doc.original` is detached by pdf.js). */
  originalPinnedBytes?: Uint8Array;
  /** Fingerprint of the tree hierarchy at import; used to detect grouping edits on export. */
  importTreeFingerprint?: string;
}

export type Kind = 'group' | 'raster' | 'text' | 'shape';

export interface Node {
  id: string;
  key: string; // position in the original file's layer tree (stable across reloads)
  name: string;
  kind: Kind;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  /** Opacity at PSD import (for preview dirty detection). */
  importOpacity: number;
  /** Visibility at PSD import. */
  importVisible: boolean;
  x: number; // doc px, top-left (leaf only; groups use nodeBounds)
  y: number;
  w: number;
  h: number;
  rotation: number; // degrees, clockwise, around the layer centre (raster layers only)
  importRotation?: number; // rotation at import time (AI layers re-imported with a transform); 0 when absent
  ow: number; // size at import time
  oh: number;
  ox: number; // position at import time (used to patch the original on export)
  oy: number;
  canvas: HTMLCanvasElement | null;
  baseShapeCanvas?: HTMLCanvasElement | null; // original raster silhouette cached for recoloring & outlining
  children: Node[]; // bottom -> top (same order as the PSD file)
  parent: Node | null;
  src: Layer; // native layer handle (PSD: ag-psd Layer; AI Phase C may use stub until full bridge)
  textTransform?: number[]; // text start point (baseline origin) at the time ox/oy were set, for idempotent export
  textEdited?: boolean; // text content/style changed, so Photoshop must redraw it on open
  /** AI: live PDF text preview edited in-browser (no .ai export in Phase B). */
  aiTextEdited?: boolean;
  /** AI: embedded PDF image preview replaced in-browser (XObject export not implemented yet). */
  aiImageEdited?: boolean;
  /** AI: pdf.js raster snapshot before live-text preview compositing. */
  aiImportRasterCanvas?: HTMLCanvasElement | null;
  /** Layer pixel content epoch at import (text/shape/raster edits). */
  importPreviewContentEpoch?: number;
  /** Incremented when preview-affecting pixels change since import. */
  previewContentEpoch?: number;
  unsupported: string[];
  idml?: IdmlNodeMeta;
}

export interface Doc {
  id: string;
  name: string;
  format: 'psd' | 'ai' | 'indd';
  width: number;
  height: number;
  offsetX: number; // placement on the infinite canvas
  offsetY: number;
  roots: Node[];
  /** Present when `format === 'psd'`. Patched on export via ag-psd. */
  psd?: Psd;
  /** Present when `format === 'ai'`. Filled in Phase C. */
  ai?: AiDocBacking;
  idml?: IdmlDocBacking;
  origin?: 'indd' | 'idml';
  uploadedBytes?: ArrayBuffer;
  inddImportReport?: InddImportReport;
  original: ArrayBuffer; // untouched copy of the uploaded file
  warnings: string[];
  /** PSD: how the canvas preview is built (layer quads vs 2D composite vs embedded file composite). */
  psdPreviewMode?: 'layers' | 'composite' | 'file-composite' | 'file-base-overlay';
  /** When true, live preview keeps embedded composite and overlays edited layers only. */
  psdFileCompositeBase?: boolean;
  /** PSD: embedded document composite from the file (includes adjustments). */
  fileComposite?: HTMLCanvasElement | null;
  /** When true, preview shows file composite until an edit forces dynamic composite. */
  psdStaticComposite?: boolean;
  /** Leaf count at import; used to detect delete/duplicate and avoid stale embedded composites. */
  psdImportLeafCount?: number;
}

export function* walk(nodes: Node[]): Generator<Node> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

/** Leaf nodes in paint order (bottom first). */
export function leaves(doc: Doc): Node[] {
  return [...walk(doc.roots)].filter((n) => n.kind !== 'group');
}

export function effVisible(n: Node): boolean {
  for (let c: Node | null = n; c; c = c.parent) if (!c.visible) return false;
  return true;
}

export function effOpacity(n: Node): number {
  let o = 1;
  for (let c: Node | null = n; c; c = c.parent) o *= c.opacity;
  return o;
}

export function isLocked(n: Node): boolean {
  for (let c: Node | null = n; c; c = c.parent) if (c.locked) return true;
  return false;
}

export interface Rect { x: number; y: number; w: number; h: number }

export function nodeBounds(n: Node): Rect | null {
  if (n.kind !== 'group') return { x: n.x, y: n.y, w: n.w, h: n.h };
  let r: Rect | null = null;
  for (const c of walk(n.children)) {
    if (c.kind === 'group') continue;
    if (!r) r = { x: c.x, y: c.y, w: c.w, h: c.h };
    else {
      const x2 = Math.max(r.x + r.w, c.x + c.w);
      const y2 = Math.max(r.y + r.h, c.y + c.h);
      r.x = Math.min(r.x, c.x);
      r.y = Math.min(r.y, c.y);
      r.w = x2 - r.x;
      r.h = y2 - r.y;
    }
  }
  return r;
}

export function docOf(n: Node, docs: Doc[]): Doc | null {
  return docs.find((d) => [...walk(d.roots)].includes(n)) ?? null;
}

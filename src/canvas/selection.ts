import type { Doc, Node, Rect } from '../core/model';
import { docOf, effOpacity, effVisible, isLocked, leaves, nodeBounds, walk } from '../core/model';
import { isCanvasPickTarget, isPointInGroupBounds, isPsdGroupCanvasSelectable } from './canvasHitTest';
import { leavesForPositionEdit } from '../psd/psdLayerInfo';

/**
 * Format-independent canvas selection (PSD, AI, and future INDD).
 *
 * INDD integration (not implemented yet):
 * - Wire `importIndd` / viewport sync the same as other formats; selection never reads format-specific fields.
 * - Multi-select may span open documents; overlay and drag hit-test use screen-space unions (`selectionBoundsScreen`).
 * - Move/export: call existing per-node patch paths from INDD export when that milestone lands; use
 *   `movableLeavesForSelection` + `positionsCommand` for undo — same as PSD/AI today.
 * - Panel/hit-test: reuse `hitTestCanvasLayer` once INDD layers participate in `isCanvasPickTarget`.
 */
export interface Selection {
  /** Last clicked / focused layer; drives properties when count === 1. */
  primary: Node | null;
  /** Ordered unique roots (layer row or group), bottom-to-top click order. */
  nodes: Node[];
}

export function emptySelection(): Selection {
  return { primary: null, nodes: [] };
}

export function singleSelection(n: Node | null): Selection {
  if (!n) return emptySelection();
  return { primary: n, nodes: [n] };
}

export function selectionCount(sel: Selection): number {
  return sel.nodes.length;
}

export function isNodeSelected(sel: Selection, n: Node): boolean {
  return sel.nodes.some((x) => x.id === n.id);
}

/** Document owning the current selection, if any. */
export function selectionDoc(sel: Selection, docs: Doc[]): Doc | null {
  const n = sel.primary ?? sel.nodes[0];
  return n ? docOf(n, docs) : null;
}

/** All selected nodes must belong to the same open document. */
export function sameDocument(nodes: Node[], docs: Doc[]): boolean {
  if (nodes.length <= 1) return true;
  let d: Doc | null = null;
  for (const n of nodes) {
    const nd = docOf(n, docs);
    if (!nd) return false;
    if (d && d !== nd) return false;
    d = nd;
  }
  return true;
}

/** True when the node exists in an open document (cross-document multi-select allowed). */
export function canAddNodeToSelection(_sel: Selection, node: Node, docs: Doc[]): boolean {
  return !!docOf(node, docs);
}

export function selectionSpansDocuments(sel: Selection, docs: Doc[]): boolean {
  const seen = new Set<string>();
  for (const n of sel.nodes) {
    const d = docOf(n, docs);
    if (!d) continue;
    if (seen.has(d.id)) continue;
    if (seen.size > 0) return true;
    seen.add(d.id);
  }
  return false;
}

export function selectionAffectedDocs(sel: Selection, docs: Doc[]): Doc[] {
  const out: Doc[] = [];
  const seen = new Set<string>();
  for (const n of sel.nodes) {
    const d = docOf(n, docs);
    if (d && !seen.has(d.id)) {
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

export interface ScreenProjection {
  docToScreen: (doc: Doc, x: number, y: number) => { x: number; y: number };
  screenToDoc: (doc: Doc, sx: number, sy: number) => { x: number; y: number };
}

export interface ScreenRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function nodeScreenAabb(n: Node, doc: Doc, proj: ScreenProjection): ScreenRect | null {
  const b = nodeBounds(n);
  if (!b || b.w <= 0 || b.h <= 0) return null;
  const rot = n.kind === 'group' ? 0 : (n.rotation * Math.PI) / 180;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const corners = [
    { x: -b.w / 2, y: -b.h / 2 },
    { x: b.w / 2, y: -b.h / 2 },
    { x: b.w / 2, y: b.h / 2 },
    { x: -b.w / 2, y: b.h / 2 },
  ];
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const dx = c.x * cs - c.y * sn;
    const dy = c.x * sn + c.y * cs;
    const p = proj.docToScreen(doc, cx + dx, cy + dy);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { sx: minX, sy: minY, sw: maxX - minX, sh: maxY - minY };
}

/** Screen-space axis-aligned union for all selected nodes (supports multiple open documents). */
export function selectionBoundsScreen(sel: Selection, docs: Doc[], proj: ScreenProjection): ScreenRect | null {
  let r: ScreenRect | null = null;
  for (const n of sel.nodes) {
    const d = docOf(n, docs);
    if (!d) continue;
    const a = nodeScreenAabb(n, d, proj);
    if (!a || a.sw <= 0 || a.sh <= 0) continue;
    if (!r) r = { ...a };
    else {
      const x2 = Math.max(r.sx + r.sw, a.sx + a.sw);
      const y2 = Math.max(r.sy + r.sh, a.sy + a.sh);
      r.sx = Math.min(r.sx, a.sx);
      r.sy = Math.min(r.sy, a.sy);
      r.sw = x2 - r.sx;
      r.sh = y2 - r.sy;
    }
  }
  return r;
}

/** Drop nodes that no longer exist in any open doc. */
export function pruneSelection(sel: Selection, docs: Doc[]): Selection {
  const nodes = sel.nodes.filter((n) => docOf(n, docs));
  if (!nodes.length) return emptySelection();
  const primary =
    sel.primary && nodes.some((n) => n.id === sel.primary!.id) ? sel.primary : nodes[nodes.length - 1];
  return { primary, nodes };
}

export function replaceSelection(node: Node | null): Selection {
  return singleSelection(node);
}

export function addToSelection(sel: Selection, node: Node): Selection {
  if (isNodeSelected(sel, node)) return { primary: node, nodes: sel.nodes };
  return { primary: node, nodes: [...sel.nodes, node] };
}

export function removeFromSelection(sel: Selection, node: Node): Selection {
  const nodes = sel.nodes.filter((n) => n.id !== node.id);
  if (!nodes.length) return emptySelection();
  const primary =
    sel.primary && nodes.some((n) => n.id === sel.primary!.id)
      ? sel.primary
      : nodes[nodes.length - 1];
  return { primary, nodes };
}

/** Shift-click toggle (add/remove), including layers from other open documents. */
export function toggleNodeInSelection(sel: Selection, node: Node, docs: Doc[]): Selection {
  if (!docOf(node, docs)) return sel;
  if (isNodeSelected(sel, node)) return removeFromSelection(sel, node);
  return addToSelection(sel, node);
}

/** Axis-aligned bounds for the selection overlay (single layer uses `nodeBounds`; multi uses union). */
export function selectionBounds(sel: Selection): Rect | null {
  if (!sel.nodes.length) return null;
  if (sel.nodes.length === 1) return nodeBounds(sel.nodes[0]);
  let r: Rect | null = null;
  for (const n of sel.nodes) {
    const b = nodeBounds(n);
    if (!b || b.w <= 0 || b.h <= 0) continue;
    if (!r) r = { ...b };
    else {
      const x2 = Math.max(r.x + r.w, b.x + b.w);
      const y2 = Math.max(r.y + r.h, b.y + b.h);
      r.x = Math.min(r.x, b.x);
      r.y = Math.min(r.y, b.y);
      r.w = x2 - r.x;
      r.h = y2 - r.y;
    }
  }
  return r;
}

/** Unique movable leaves across all selected roots (groups expand to children). */
export function movableLeavesForSelection(sel: Selection): Node[] {
  const seen = new Set<string>();
  const out: Node[] = [];
  for (const root of sel.nodes) {
    for (const l of leavesForPositionEdit(root)) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
    }
  }
  return out;
}

export function snapshotPositions(leaves: Node[]): Array<[Node, number, number]> {
  return leaves.map((l) => [l, l.x, l.y]);
}

export function moveLeavesBy(leaves: Node[], dx: number, dy: number) {
  for (const l of leaves) {
    l.x += dx;
    l.y += dy;
  }
}

/** Doc-space hit test (single-document multi-select only). */
export function pointInSelectionForMove(sel: Selection, px: number, py: number, pointInLayer: (n: Node, x: number, y: number) => boolean): boolean {
  if (!sel.nodes.length) return false;
  if (sel.nodes.length === 1) {
    const n = sel.nodes[0]!;
    if (n.kind === 'group') return isPointInGroupBounds(n, px, py);
    return pointInLayer(n, px, py);
  }
  const b = selectionBounds(sel);
  if (!b) return false;
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

/**
 * Screen-space move initiation: hit any selected layer (per-doc coords) or the combined screen bounds (multi).
 */
export function pointInSelectionForMoveAtScreen(
  sel: Selection,
  sx: number,
  sy: number,
  docs: Doc[],
  proj: ScreenProjection,
  pointInLayer: (n: Node, x: number, y: number) => boolean,
): boolean {
  if (!sel.nodes.length) return false;
  for (const n of sel.nodes) {
    const d = docOf(n, docs);
    if (!d) continue;
    const p = proj.screenToDoc(d, sx, sy);
    if (n.kind === 'group') {
      if (isPointInGroupBounds(n, p.x, p.y)) return true;
    } else if (pointInLayer(n, p.x, p.y)) return true;
  }
  if (sel.nodes.length === 1) return false;
  const sb = selectionBoundsScreen(sel, docs, proj);
  if (!sb || sb.sw <= 0 || sb.sh <= 0) return false;
  return sx >= sb.sx && sx < sb.sx + sb.sw && sy >= sb.sy && sy < sb.sy + sb.sh;
}

export function selectionCanMove(sel: Selection): boolean {
  return movableLeavesForSelection(sel).length > 0;
}
/** Minimum pointer travel (screen px) before a marquee replaces click-to-deselect. */
export const MARQUEE_DRAG_THRESHOLD_PX = 4;
 
export function normalizeScreenRect(sx0: number, sy0: number, sx1: number, sy1: number): ScreenRect {
  const x1 = Math.min(sx0, sx1);
  const y1 = Math.min(sy0, sy1);
  const x2 = Math.max(sx0, sx1);
  const y2 = Math.max(sy0, sy1);
  return { sx: x1, sy: y1, sw: x2 - x1, sh: y2 - y1 };
}
 
export function screenRectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  if (a.sw <= 0 || a.sh <= 0 || b.sw <= 0 || b.sh <= 0) return false;
  return a.sx < b.sx + b.sw && a.sx + a.sw > b.sx && a.sy < b.sy + b.sh && a.sy + a.sh > b.sy;
}
 
function isMarqueeCandidate(d: Doc, n: Node): boolean {
  if (!effVisible(n) || isLocked(n) || effOpacity(n) <= 0) return false;
  if (n.kind === 'group') return isPsdGroupCanvasSelectable(d, n);
  if (!isCanvasPickTarget(d, n)) return false;
  const b = nodeBounds(n);
  return !!(b && b.w > 0 && b.h > 0);
}
 
function leafIdsUnderGroup(root: Node): Set<string> {
  const ids = new Set<string>();
  if (root.kind !== 'group') return ids;
  for (const n of walk(root.children)) {
    if (n.kind !== 'group') ids.add(n.id);
  }
  return ids;
}
 
/**
 * All canvas-selectable layers whose screen bounds intersect the marquee (every open document).
 * Returns hits top-first (frontmost last in array); use `selectionFromMarqueeHits` for panel order.
 */
export function nodesInMarqueeRect(
  docs: Doc[],
  marquee: ScreenRect,
  proj: ScreenProjection,
): Node[] {
  if (marquee.sw <= 0 || marquee.sh <= 0) return [];
  const hitsTopFirst: Node[] = [];
  const seen = new Set<string>();
 
  for (let di = docs.length - 1; di >= 0; di--) {
    const d = docs[di]!;
    const docGroupHits: Node[] = [];
    for (const n of walk(d.roots)) {
      if (n.kind !== 'group') continue;
      if (!isMarqueeCandidate(d, n)) continue;
      const aabb = nodeScreenAabb(n, d, proj);
      if (!aabb || !screenRectsIntersect(marquee, aabb)) continue;
      docGroupHits.push(n);
    }
    for (const g of docGroupHits) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      hitsTopFirst.push(g);
    }
 
    const skipLeafIds = new Set<string>();
    for (const g of docGroupHits) {
      for (const id of leafIdsUnderGroup(g)) skipLeafIds.add(id);
    }
 
    const leafList = leaves(d).slice().reverse();
    for (const n of leafList) {
      if (skipLeafIds.has(n.id)) continue;
      if (!isMarqueeCandidate(d, n)) continue;
      const aabb = nodeScreenAabb(n, d, proj);
      if (!aabb || !screenRectsIntersect(marquee, aabb)) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      hitsTopFirst.push(n);
    }
  }
  return hitsTopFirst;
}
 
/** Build selection from marquee hits (`hits` top-first from `nodesInMarqueeRect`). */
export function selectionFromMarqueeHits(
  hitsTopFirst: Node[],
  prior: Selection,
  additive: boolean,
): Selection {
  if (!hitsTopFirst.length) {
    return additive ? prior : emptySelection();
  }
  const bottomToTop = [...hitsTopFirst].reverse();
  const primary = hitsTopFirst[0]!;
  if (!additive) {
    return { primary, nodes: bottomToTop };
  }
  let nodes = [...prior.nodes];
  for (const n of bottomToTop) {
    if (!nodes.some((x) => x.id === n.id)) nodes.push(n);
  }
  return { primary, nodes };
}
 
import type { Doc, Node } from './model';
import { effOpacity, effVisible, isLocked, leaves, nodeBounds } from './model';
import { isPsdCanvasPickTarget, leavesForPositionEdit } from './psdLayerInfo';

/** Sample alpha from a layer canvas (clamped coords). */
export function readCanvasAlpha(canvas: HTMLCanvasElement, x: number, y: number): number {
  try {
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(x)));
    const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(y)));
    return g.getImageData(px, py, 1, 1).data[3];
  } catch {
    return 255;
  }
}

const ALPHA_HIT = 8;

export function isCanvasPickTarget(d: Doc, n: Node): boolean {
  if (d.format === 'psd') return isPsdCanvasPickTarget(n, d);
  return !!(n.canvas && n.w > 0 && n.h > 0);
}

export interface CanvasHitTestContext {
  docs: Doc[];
  screenToDoc: (doc: Doc, sx: number, sy: number) => { x: number; y: number };
}

/**
 * Checks whether a doc-space point hits a layer, respecting its bounding box, rotation, and alpha.
 */
export function isPointInLayer(n: Node, px: number, py: number): boolean {
  if (!effVisible(n) || effOpacity(n) <= 0) return false;
  const th = (n.rotation * Math.PI) / 180;
  const dx = px - (n.x + n.w / 2);
  const dy = py - (n.y + n.h / 2);
  const lx = dx * Math.cos(th) + dy * Math.sin(th) + n.w / 2;
  const ly = -dx * Math.sin(th) + dy * Math.cos(th) + n.h / 2;
  if (lx < 0 || ly < 0 || lx >= n.w || ly >= n.h) return false;
  if (!n.canvas) return true;
  return readCanvasAlpha(n.canvas, (lx * n.canvas.width) / n.w, (ly * n.canvas.height) / n.h) > ALPHA_HIT;
}

/**
 * Layer under screen point using current top-first + alpha rules (same as canvas click select).
 */
export function hitTestCanvasLayer(ctx: CanvasHitTestContext, sx: number, sy: number): Node | null {
  for (let i = ctx.docs.length - 1; i >= 0; i--) {
    const d = ctx.docs[i];
    const p = ctx.screenToDoc(d, sx, sy);
    const list = leaves(d).reverse();
    for (const n of list) {
      if (!isCanvasPickTarget(d, n)) continue;
      if (isPointInLayer(n, p.x, p.y)) return n;
    }
  }
  return null;
}

function groupsTopFirst(roots: Node[]): Node[] {
  const out: Node[] = [];
  const rec = (nodes: Node[]) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (n.kind === 'group') out.push(n);
      if (n.children.length) rec(n.children);
    }
  };
  rec(roots);
  return out;
}

export function isPointInGroupBounds(g: Node, px: number, py: number): boolean {
  if (g.kind !== 'group') return false;
  const b = nodeBounds(g);
  if (!b || b.w <= 0 || b.h <= 0) return false;
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

function isPsdGroupCanvasSelectable(d: Doc, g: Node): boolean {
  if (d.format !== 'psd' || g.kind !== 'group') return false;
  if (!effVisible(g) || isLocked(g)) return false;
  if (leavesForPositionEdit(g).length === 0) return false;
  const b = nodeBounds(g);
  return !!(b && b.w > 0 && b.h > 0);
}

/** Topmost group whose union bounds contain the point (no opaque leaf required). PSD only. */
export function hitTestCanvasGroupChrome(ctx: CanvasHitTestContext, sx: number, sy: number): Node | null {
  for (let i = ctx.docs.length - 1; i >= 0; i--) {
    const d = ctx.docs[i]!;
    if (d.format !== 'psd') continue;
    const p = ctx.screenToDoc(d, sx, sy);
    for (const g of groupsTopFirst(d.roots)) {
      if (!isPsdGroupCanvasSelectable(d, g)) continue;
      if (isPointInGroupBounds(g, p.x, p.y)) return g;
    }
  }
  return null;
}

export interface CanvasClickOptions {
  /** Alt/Option-click: select the parent group folder instead of the leaf under the cursor. */
  preferGroup?: boolean;
}

/**
 * Canvas click target: leaf by default; Alt+click promotes to parent group; empty group bounds select the group.
 */
export function hitTestCanvasClickTarget(
  ctx: CanvasHitTestContext,
  sx: number,
  sy: number,
  opts: CanvasClickOptions = {},
): Node | null {
  const leaf = hitTestCanvasLayer(ctx, sx, sy);
  if (leaf) {
    if (opts.preferGroup) {
      for (let p = leaf.parent; p; p = p.parent) {
        if (p.kind === 'group') return p;
      }
    }
    return leaf;
  }
  return hitTestCanvasGroupChrome(ctx, sx, sy);
}

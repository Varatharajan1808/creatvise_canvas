import type { Doc, Node } from './model';
import { effOpacity, effVisible, leaves } from './model';
import { isPsdCanvasPickTarget } from './psdLayerInfo';

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

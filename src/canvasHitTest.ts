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
 * Layer under screen point using current top-first + alpha rules (same as canvas click select).
 */
export function hitTestCanvasLayer(ctx: CanvasHitTestContext, sx: number, sy: number): Node | null {
  for (let i = ctx.docs.length - 1; i >= 0; i--) {
    const d = ctx.docs[i];
    const p = ctx.screenToDoc(d, sx, sy);
    const list = leaves(d).reverse();
    for (const n of list) {
      if (!isCanvasPickTarget(d, n) || !effVisible(n) || effOpacity(n) <= 0) continue;
      const th = (n.rotation * Math.PI) / 180;
      const dx = p.x - (n.x + n.w / 2);
      const dy = p.y - (n.y + n.h / 2);
      const lx = dx * Math.cos(th) + dy * Math.sin(th) + n.w / 2;
      const ly = -dx * Math.sin(th) + dy * Math.cos(th) + n.h / 2;
      if (lx < 0 || ly < 0 || lx >= n.w || ly >= n.h) continue;
      const c = n.canvas!;
      if (readCanvasAlpha(c, (lx * c.width) / n.w, (ly * c.height) / n.h) > ALPHA_HIT) return n;
    }
  }
  return null;
}

import type { LayerMaskData } from 'ag-psd';
import { type Doc, type Node, effOpacity, effVisible, leaves } from '../core/model';
import { blendPixelsInto, isPixelBlendMode } from './psdBlend';
import { type EmbeddedCompositeStatus, embeddedCompositeStatus, unsimulatedFeatures } from './psdCompositeRule';
import { applyAdjustmentToCanvas, isSupportedAdjustment } from './psdAdjustment';
import { activeDropShadow, activeOuterGlow, activeStroke, paintDropShadow, paintOuterGlow, paintStroke } from './psdLayerEffects';

/**
 * Full-document scratch canvases reused across composes. The expensive part of a PSD preview is
 * rebuilding the adjustment stack; these only avoid allocating a new document-sized canvas per layer
 * per frame. Reset with `beginCanvasPool()` at the start of a compose — do not hold a pooled canvas
 * after that compose returns.
 */
let canvasPool: HTMLCanvasElement[] = [];
let canvasPoolTop = 0;
 
function beginCanvasPool() {
  canvasPoolTop = 0;
}
 
function allocCanvas(w: number, h: number): HTMLCanvasElement {
  let c = canvasPool[canvasPoolTop++];
  if (!c) {
    c = document.createElement('canvas');
    canvasPool.push(c);
    c.width = w;
    c.height = h;
    c.getContext('2d')!.save();
    return c;
  }
  const g = c.getContext('2d')!;
  // Pop back to the clean state saved below. Drawing state (clip, transform) resets; pixels do not.
  g.restore();
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    g.save();
    return c;
  }
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  return c;
}
 
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function objectId(o: object | null | undefined): number {
  if (!o) return 0;
  let id = objectIds.get(o);
  if (!id) {
    id = nextObjectId++;
    objectIds.set(o, id);
  }
  return id;
}
 
function ensureCanvas(existing: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
  if (existing && existing.width === w && existing.height === h) return existing;
  const c = existing ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
 
function reset2d(g: CanvasRenderingContext2D) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/**
 * Canvas `globalCompositeOperation` for Photoshop blend modes that canvas supports natively.
 * Modes covered by `isPixelBlendMode` are blended per pixel instead; dissolve falls back to normal.
 */
export function psdBlendToCompositeOp(mode: string | undefined): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
      return 'darken';
    case 'lighten':
      return 'lighten';
    case 'color dodge':
      return 'color-dodge';
    case 'color burn':
      return 'color-burn';
    case 'soft light':
      return 'soft-light';
    case 'hard light':
      return 'hard-light';
    case 'difference':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    case 'hue':
      return 'hue';
    case 'saturation':
      return 'saturation';
    case 'color':
      return 'color';
    case 'luminosity':
      return 'luminosity';
    case 'normal':
    case 'pass through':
    default:
      return 'source-over';
  }
}

function drawRotatedLayer(
  g: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  rotationDeg: number,
) {
  if (Math.abs(rotationDeg) < 0.01) {
    g.drawImage(canvas, x, y, w, h);
    return;
  }
  const th = (rotationDeg * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  g.save();
  g.translate(cx, cy);
  g.rotate(th);
  g.drawImage(canvas, -w / 2, -h / 2, w, h);
  g.restore();
}

function clipLayerToBase(
  docW: number,
  docH: number,
  layerDocCanvas: HTMLCanvasElement,
  baseDocCanvas: HTMLCanvasElement,
): HTMLCanvasElement {
const out = allocCanvas(docW, docH)
  const g = out.getContext('2d')!;
  g.drawImage(layerDocCanvas, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(baseDocCanvas, 0, 0);
  g.globalCompositeOperation = 'source-over';
  return out;
}

function nodeToDocCanvasAt(
  n: Node,
  docW: number,
  docH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rotationDeg: number,
): HTMLCanvasElement | null {
  if (!n.canvas) return null;
  const scratch = allocCanvas(docW, docH);
  const g = scratch.getContext('2d')!;
  drawRotatedLayer(g, n.canvas, x, y, w, h, rotationDeg);
  applyLayerMask(g, n.src.mask, !!n.src.vectorMask);
  return scratch;
}

/** Alpha copies of mask canvases; the originals are written back on export and must stay untouched. */
const maskAlphaCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

/**
 * ag-psd decodes a mask as opaque grayscale (value in red, alpha 255). Returns a white canvas whose
 * alpha is that gray value (times any source alpha), usable with `destination-in`.
 */
export function maskAlphaCanvas(maskCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const cached = maskAlphaCache.get(maskCanvas);
  if (cached) return cached;
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const src = maskCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const og = out.getContext('2d')!;
  const id = og.createImageData(w, h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = (src[i] * src[i + 3]) / 255;
  }
  og.putImageData(id, 0, 0);
  maskAlphaCache.set(maskCanvas, out);
  return out;
}

/**
 * Multiply doc-space layer pixels by the layer mask. Outside the mask rectangle Photoshop uses
 * `defaultColor` (0 hides, 255 shows). Density and feather are not simulated.
 */
function applyLayerMask(g: CanvasRenderingContext2D, mask: LayerMaskData | undefined, hasVectorMask: boolean): void {
  if (!mask || mask.disabled) return;
  const left = mask.left ?? 0;
  const top = mask.top ?? 0;
  const w = (mask.right ?? left) - left;
  const h = (mask.bottom ?? top) - top;
  const outsideVisible = (mask.defaultColor ?? 0) >= 128;
  if (!mask.canvas || w <= 0 || h <= 0) {
    // An empty "hide all" mask hides the layer; a mask record that only carries vector parameters does not.
    if (!outsideVisible && !mask.fromVectorData && !hasVectorMask) g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    return;
  }
  g.save();
  if (outsideVisible) {
    g.beginPath();
    g.rect(left, top, w, h);
    g.clip();
  }
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(maskAlphaCanvas(mask.canvas as HTMLCanvasElement), left, top);
  g.restore();
}

/** Layer geometry / visibility / opacity differs from import (includes live opacity scrub). */
export function isLayerPreviewDirty(n: Node): boolean {
  if (n.kind === 'group') return false;
  if (Math.round(n.x) !== Math.round(n.ox) || Math.round(n.y) !== Math.round(n.oy)) return true;
  if (Math.abs(n.rotation) > 0.01) return true;
  if (Math.round(n.w) !== Math.round(n.ow) || Math.round(n.h) !== Math.round(n.oh)) return true;
  if (n.visible !== n.importVisible) return true;
  if (Math.abs(n.opacity - n.importOpacity) > 0.001) return true;
  return false;
}

/** Text/shape/raster pixel edits since import. */
export function isLayerPreviewContentDirty(n: Node): boolean {
  if (n.kind === 'group') return false;
  if (n.textEdited) return true;
  const imp = n.importPreviewContentEpoch ?? 0;
  const cur = n.previewContentEpoch ?? 0;
  return cur !== imp;
}

/** Any preview-affecting change vs import state. */
export function isLayerPreviewAffecting(n: Node): boolean {
  return isLayerPreviewDirty(n) || isLayerPreviewContentDirty(n);
}

export function markNodePreviewContentChanged(n: Node): void {
  n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
}

export function docHasPreviewDirtyLayers(doc: Doc): boolean {
  return leaves(doc).some(isLayerPreviewAffecting);
}

/** Import had zero leaf layers (flattened PSD); embedded composite is the only artwork source. */
export function docPsdFlattenedAtImport(doc: Doc): boolean {
  return doc.format === 'psd' && (doc.psdImportLeafCount ?? 0) === 0;
}

/** Layer tree leaf count differs from import (delete, duplicate, etc.). */
export function docPsdStructureChanged(doc: Doc): boolean {
  if (doc.format !== 'psd') return false;
  const atImport = doc.psdImportLeafCount;
  if (atImport === undefined) return false;
  return leaves(doc).length !== atImport;
}

/** Whether a dirty layer should be drawn on top of the embedded file composite. */
export function shouldOverlayDirtyLayer(n: Node): boolean {
  if (!isLayerPreviewAffecting(n)) return false;
  if (!effVisible(n) || !n.canvas || n.w <= 0 || n.h <= 0) return false;
  if (effOpacity(n) <= 0.001) return false;
  return true;
}

type LayerPose = { x: number; y: number; w: number; h: number; rotation: number };

function importPose(n: Node): LayerPose {
  return { x: n.ox, y: n.oy, w: n.ow, h: n.oh, rotation: 0 };
}

function currentPose(n: Node): LayerPose {
  return { x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation };
}

/** Integer doc-space box covering the (possibly rotated) pose, clipped to the document. */
function poseBounds(pose: LayerPose, docW: number, docH: number): { x: number; y: number; w: number; h: number } | null {
  const th = (pose.rotation * Math.PI) / 180;
  const cx = pose.x + pose.w / 2;
  const cy = pose.y + pose.h / 2;
  const ex = Math.abs((pose.w / 2) * Math.cos(th)) + Math.abs((pose.h / 2) * Math.sin(th));
  const ey = Math.abs((pose.w / 2) * Math.sin(th)) + Math.abs((pose.h / 2) * Math.cos(th));
  const x0 = Math.max(0, Math.floor(cx - ex));
  const y0 = Math.max(0, Math.floor(cy - ey));
  const x1 = Math.min(docW, Math.ceil(cx + ex));
  const y1 = Math.min(docH, Math.ceil(cy + ey));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const siblingsOf = (doc: Doc, n: Node): Node[] => (n.parent ? n.parent.children : doc.roots);

/**
 * Photoshop clip base: the nearest non-clipped layer below in the same group (a group can be a base).
 * Null when nothing below is unclipped; such a layer is drawn unclipped.
 */
export function clipBaseOf(doc: Doc, n: Node): Node | null {
  if (!n.src.clipping) return null;
  const sibs = siblingsOf(doc, n);
  for (let i = sibs.indexOf(n) - 1; i >= 0; i--) if (!sibs[i].src.clipping) return sibs[i];
  return null;
}

function hasClippedLayerAbove(doc: Doc, n: Node): boolean {
  const sibs = siblingsOf(doc, n);
  return !!sibs[sibs.indexOf(n) + 1]?.src.clipping;
}

/** One stack render: which pose each layer is drawn at, which leaves are left out, and cached base shapes. */
interface StackRender {
  doc: Doc;
  poseOf: (n: Node) => LayerPose;
  excluded: ReadonlySet<string>;
  bases: Map<string, HTMLCanvasElement | null>;
}

function stackRender(doc: Doc, poseOf: (n: Node) => LayerPose, excluded: ReadonlySet<string> = new Set()): StackRender {
  return { doc, poseOf, excluded, bases: new Map() };
}

function layerPixelsAt(r: StackRender, n: Node): HTMLCanvasElement | null {
  const p = r.poseOf(n);
  if (!n.canvas || p.w <= 0 || p.h <= 0) return null;
  return nodeToDocCanvasAt(n, r.doc.width, r.doc.height, p.x, p.y, p.w, p.h, p.rotation);
}

/**
 * Doc-space pixels whose alpha clips the layers above `base`, or null when those layers are hidden
 * (base hidden, at zero opacity, left out of this render, or without pixels).
 */
function clipBaseShape(r: StackRender, base: Node): HTMLCanvasElement | null {
  if (r.bases.has(base.id)) return r.bases.get(base.id)!;
  let shape: HTMLCanvasElement | null = null;
  if (!r.excluded.has(base.id) && effVisible(base) && effOpacity(base) > 0.001) {
    if (base.kind === 'group') shape = groupShape(r, base);
    else if (base.canvas) shape = layerPixelsAt(r, base);
    else if (base.src.adjustment) shape = adjustmentShape(r, base);
  }
  r.bases.set(base.id, shape);
  return shape;
}

/** Group used as a clip base: union of its visible leaves (own opacity), drawn normally. */
function groupShape(r: StackRender, group: Node): HTMLCanvasElement | null {
  const c = allocCanvas(r.doc.width, r.doc.height);
  const g = c.getContext('2d')!;
  let any = false;
  const visit = (n: Node) => {
    if (r.excluded.has(n.id) || !n.visible || n.opacity <= 0.001) return;
    if (n.kind === 'group') return n.children.forEach(visit);
    const px = layerPixelsAt(r, n);
    if (!px) return;
    g.globalAlpha = n.opacity;
    g.drawImage(px, 0, 0);
    any = true;
  };
  group.children.forEach(visit);
  g.globalAlpha = 1;
  return any ? c : null;
}

/** Adjustment layer used as a clip base: its shape is its mask over the whole document. */
function adjustmentShape(r: StackRender, n: Node): HTMLCanvasElement {
  const c = allocCanvas(r.doc.width, r.doc.height);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  applyLayerMask(g, n.src.mask, !!n.src.vectorMask);
  return c;
}

function paintAdjustmentLeaf(
  g: CanvasRenderingContext2D,
  r: StackRender,
  n: Node,
  opacity: number,
): void {
  const doc = r.doc;
  const adj = n.src.adjustment;
  if (!adj || !isSupportedAdjustment(adj)) return;

  const base = clipBaseOf(doc, n);
  let clipBaseShapeCanvas: HTMLCanvasElement | null = null;
  let roi: { x: number; y: number; w: number; h: number } | undefined;

  if (base) {
    clipBaseShapeCanvas = clipBaseShape(r, base);
    if (!clipBaseShapeCanvas) return;
    const bPose = r.poseOf(base);
    const bBounds = poseBounds(bPose, doc.width, doc.height);
    if (bBounds) roi = bBounds;
  }

  applyAdjustmentToCanvas(g.canvas as HTMLCanvasElement, adj, {
    docW: doc.width,
    docH: doc.height,
    opacity,
    mask: n.src.mask,
    clipBaseShape: clipBaseShapeCanvas,
    roi,
  });

  if (hasClippedLayerAbove(doc, n)) {
    if (clipBaseShapeCanvas) {
      r.bases.set(n.id, clipBaseShapeCanvas);
    } else {
      r.bases.set(n.id, adjustmentShape(r, n));
    }
  }
}

function paintLeaf(g: CanvasRenderingContext2D, r: StackRender, n: Node, visible: boolean, opacity: number): void {
  if (r.excluded.has(n.id) || !visible || opacity <= 0.001) return;
  const doc = r.doc;
  const pose = r.poseOf(n);
  const mask = n.src.mask;
  const needsMask = !!mask && !mask.disabled;
  const retainForClip = hasClippedLayerAbove(doc, n) && !n.src.clipping;
  const base = clipBaseOf(doc, n);
  const effects = n.src.effects;
  const hasSimulatedLayerEffect =
    !!activeDropShadow(effects) || !!activeOuterGlow(effects) || !!activeStroke(effects);
  // Unclipped, unmasked layers draw straight into the destination — no document-sized scratch.
  if (
    n.canvas &&
    pose.w > 0 &&
    pose.h > 0 &&
    !needsMask &&
    !base &&
    !retainForClip &&
    !isPixelBlendMode(n.src.blendMode) &&
    !hasSimulatedLayerEffect
  ) {
    g.save();
    g.globalAlpha = opacity;
    g.globalCompositeOperation = psdBlendToCompositeOp(n.src.blendMode);
    drawRotatedLayer(g, n.canvas, pose.x, pose.y, pose.w, pose.h, pose.rotation);
    g.restore();
    return;
  }
  let docLayer = layerPixelsAt(r, n);
  if (!docLayer) {
    if (n.src.adjustment && isSupportedAdjustment(n.src.adjustment)) {
      paintAdjustmentLeaf(g, r, n, opacity);
    }
    return;
  }
 if (retainForClip) r.bases.set(n.id, docLayer);
  if (base) {
    const shape = clipBaseShape(r, base);
    if (!shape) return;
    docLayer = clipLayerToBase(doc.width, doc.height, docLayer, shape);
  }

  const shadow = activeDropShadow(n.src.effects);
  if (shadow) paintDropShadow(g, docLayer, opacity, shadow);

  const glow = activeOuterGlow(n.src.effects);
  if (glow) paintOuterGlow(g, docLayer, opacity, glow);

  const mode = n.src.blendMode;
  if (isPixelBlendMode(mode)) {
    const r = poseBounds(pose, doc.width, doc.height);
    if (r) {
      const backdrop = g.getImageData(r.x, r.y, r.w, r.h);
      const src = docLayer.getContext('2d')!.getImageData(r.x, r.y, r.w, r.h);
      blendPixelsInto(backdrop.data, src.data, mode, opacity);
      g.putImageData(backdrop, r.x, r.y);
    }
  } else {
    g.save();
    g.globalAlpha = opacity;
    g.globalCompositeOperation = psdBlendToCompositeOp(mode);
    g.drawImage(docLayer, 0, 0);
    g.restore();
  }

  const stroke = activeStroke(n.src.effects);
  if (stroke) paintStroke(g, docLayer, opacity, stroke);
}

/** Clipped layers follow their base: when the base is edited they must be redrawn with it. */
function clippedToEditedBase(doc: Doc, n: Node): boolean {
  const base = clipBaseOf(doc, n);
  if (!base) return false;
  if (base.kind === 'group') return [...walkLeaves(base)].some(isLayerPreviewAffecting);
  return isLayerPreviewAffecting(base);
}

function* walkLeaves(n: Node): Generator<Node> {
  if (n.kind !== 'group') {
    yield n;
    return;
  }
  for (const c of n.children) yield* walkLeaves(c);
}

/** Leaves drawn over the embedded composite: edited layers plus layers clipped to an edited base. */
function overlayLeaves(doc: Doc): Node[] {
  return leaves(doc).filter(
    (n) => shouldOverlayDirtyLayer(n) || (clippedToEditedBase(doc, n) && effVisible(n) && !!n.canvas && n.w > 0 && n.h > 0 && effOpacity(n) > 0.001),
  );
}

/** Leaf layers whose import footprint must be removed from the embedded composite (ghost suppression). */
export function layersNeedingFootprintRemoval(doc: Doc): Node[] {
  return leaves(doc).filter((n) => (isLayerPreviewAffecting(n) || clippedToEditedBase(doc, n)) && n.canvas && n.ow > 0 && n.oh > 0);
}

const NO_EXCLUDE: ReadonlySet<string> = new Set();
 
/** How many times the import-pose stack (the slow part) was actually repainted. */
let sansRebuilds = 0;
 
export function psdPreviewCacheStats(): { sansRebuilds: number } {
  return { sansRebuilds };
}
 
const previewCaches = new WeakMap<Doc, PreviewCache>();
 
interface PreviewCache {
  sans: HTMLCanvasElement | null;
  sansKey: string;
  plate: HTMLCanvasElement | null;
  plateKey: string;
  plateSerial: number;
  overlay: HTMLCanvasElement | null;
  overlayKey: string;
  overlaySerial: number;
  blended: HTMLCanvasElement | null;
  composite: HTMLCanvasElement | null;
  flatKey: string;
  full: HTMLCanvasElement | null;
  fullKey: string;
  fullSerial: number;
}
 
function previewCacheFor(doc: Doc): PreviewCache {
  let c = previewCaches.get(doc);
  if (!c) {
    c = {
      sans: null,
      sansKey: '',
      plate: null,
      plateKey: '',
      plateSerial: 0,
      overlay: null,
      overlayKey: '',
      overlaySerial: 0,
      blended: null,
      composite: null,
      flatKey: '',
      full: null,
      fullKey: '',
      fullSerial: 0,
    };
    previewCaches.set(doc, c);
  }
  return c;
}
 
/** Drop cached plates for one document (tests). The next preview rebuilds from scratch. */
export function invalidatePsdPreviewCache(doc: Doc): void {
  previewCaches.delete(doc);
}
 
function maskStamp(mask: LayerMaskData | undefined): string {
  if (!mask) return '';
  return [
    mask.disabled ? 'd' : 'e',
    mask.left ?? '',
    mask.top ?? '',
    mask.right ?? '',
    mask.bottom ?? '',
    mask.defaultColor ?? '',
    mask.fromVectorData ? 'v' : '',
    objectId(mask.canvas as object | undefined),
  ].join(',');
}
 
/**
 * Identity of everything a stack paint depends on. `import` ignores live x/y/w/h/rotation so a drag
 * does not rebuild the adjustment stack. Excluded leaves are omitted from the visual fields because
 * the stack does not draw them.
 */
function stackFingerprint(doc: Doc, pose: 'current' | 'import', exclude: ReadonlySet<string>): string {
  const parts: string[] = [`${doc.width}x${doc.height}`, pose];
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      const skipped = exclude.has(n.id);
      parts.push(n.id, n.kind, skipped ? 'x' : '.', n.src.clipping ? 'c' : 'n', n.src.blendMode ?? '');
      if (!skipped) {
        const geom = pose === 'import'
          ? `${n.ox},${n.oy},${n.ow},${n.oh}`
          : `${n.x},${n.y},${n.w},${n.h},${n.rotation}`;
        parts.push(
          n.visible ? 'v' : 'h',
          String(n.opacity),
          geom,
          String(n.previewContentEpoch ?? 0),
          n.textEdited ? 't' : '',
          String(objectId(n.canvas)),
          String(objectId(n.src.adjustment as object | undefined)),
          maskStamp(n.src.mask),
          n.src.vectorMask ? (n.src.vectorMask.disable ? 'vmd' : 'vm') : '',
        );
      }
      if (n.children.length) visit(n.children);
    }
  };
  visit(doc.roots);
  return parts.join('|');
}
 
function overlayStamp(nodes: Node[]): string {
  return nodes.map((n) => [
    n.id,
    n.x, n.y, n.w, n.h, n.rotation,
    effOpacity(n),
    effVisible(n) ? 1 : 0,
    n.previewContentEpoch ?? 0,
    objectId(n.canvas),
    n.src.blendMode ?? '',
    maskStamp(n.src.mask),
  ].join(',')).join(';');
}
 
function footprintStamp(doc: Doc, removed: Node[]): string {
  return removed.map((n) => {
    const r = importFootprintRect(doc, n);
    return `${n.id}:${r.x},${r.y},${r.w},${r.h}`;
  }).join(';');
}
 
/** Normal blending can be a second texture. Other modes must be painted onto a copy of the plate. */
function overlaySplitsFromPlate(nodes: Node[]): boolean {
  return nodes.every((n) => !isPixelBlendMode(n.src.blendMode) && psdBlendToCompositeOp(n.src.blendMode) === 'source-over');
}
 
function paintStack(
  doc: Doc,
  poseOf: (n: Node) => LayerPose,
  exclude: ReadonlySet<string>,
  target: HTMLCanvasElement,
): void {
  beginCanvasPool();
  const g = target.getContext('2d')!;
  reset2d(g);
  g.clearRect(0, 0, target.width, target.height);
  const stack = stackRender(doc, poseOf, exclude);
  for (const n of leaves(doc)) paintLeaf(g, stack, n, effVisible(n), effOpacity(n));
  reset2d(g);
}
 
function paintNodes(doc: Doc, nodes: Node[], target: HTMLCanvasElement, clear: boolean): void {
  beginCanvasPool();
  const g = target.getContext('2d')!;
  reset2d(g);
  if (clear) g.clearRect(0, 0, target.width, target.height);
  const stack = stackRender(doc, currentPose);
  for (const n of nodes) paintLeaf(g, stack, n, effVisible(n), effOpacity(n));
  reset2d(g);
}
 
function ensureSans(doc: Doc, exclude: ReadonlySet<string>): HTMLCanvasElement {
  const cache = previewCacheFor(doc);
  const key = stackFingerprint(doc, 'import', exclude);
  if (cache.sansKey === key && cache.sans) return cache.sans;
  sansRebuilds++;
  // New canvas so a caller still holding the previous stack does not see this rebuild.
  const next = document.createElement('canvas');
  next.width = doc.width;
  next.height = doc.height;
  paintStack(doc, importPose, exclude, next);
  cache.sans = next;
  cache.sansKey = key;
  return next;
}
 
/**
 * 2D stack at import poses, omitting excluded leaves.
 * Used to fill old bounds after a layer move without punching transparent holes in the file composite.
 * The returned canvas is cached and reused; read it before the next compose of this document.
 */
export function composeDocPreviewExcluding(doc: Doc, excludeIds: ReadonlySet<string>): HTMLCanvasElement {
  return ensureSans(doc, excludeIds);
}

/** Import rectangle; a clipped layer cannot show outside its base, so it is limited to the base's import rectangle. */
function importFootprintRect(doc: Doc, n: Node): { x: number; y: number; w: number; h: number } {
  let x0 = n.ox, y0 = n.oy, x1 = n.ox + n.ow, y1 = n.oy + n.oh;
  const base = clipBaseOf(doc, n);
  if (base && base.kind !== 'group' && base.canvas && base.ow > 0 && base.oh > 0) {
    x0 = Math.max(x0, base.ox);
    y0 = Math.max(y0, base.oy);
    x1 = Math.min(x1, base.ox + base.ow);
    y1 = Math.min(y1, base.oy + base.oh);
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Replace embedded pixels under the removed layers' import footprints with the stack sans those layers.
 * Footprints are filled import rectangles, not per-pixel layer alpha, so sparse glyphs (e.g. raster
 * text) still clear the full baked footprint in the file composite.
 */
function patchEmbeddedFootprints(
  g: CanvasRenderingContext2D,
  doc: Doc,
  removed: Node[],
  sans: HTMLCanvasElement,
): void {
  const rects = removed
    .filter((n) => n.canvas && n.ow > 0 && n.oh > 0)
    .map((n) => importFootprintRect(doc, n))
    .filter((r) => r.w > 0 && r.h > 0);
  if (!rects.length) return;
  g.save();
  g.beginPath();
  for (const r of rects) g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  g.globalCompositeOperation = 'copy';
  g.drawImage(sans, 0, 0);
  g.restore();
}

/** Whether the viewport shows one baked PSD texture (syncDoc calls getDocPreviewCanvas). */
export function docUsesFullDocPreview(doc: Doc): boolean {
  if (doc.format !== 'psd') return false;
  const previewDirty = docHasPreviewDirtyLayers(doc);
  if (doc.psdStaticComposite && doc.fileComposite && !previewDirty) return true;
  if (doc.psdFileCompositeBase && doc.fileComposite) return true;
  return doc.psdPreviewMode === 'composite' || docNeedsCompositePreview(doc);
}

export function docNeedsCompositePreview(doc: Doc): boolean {
  if (doc.format !== 'psd') return false;
  return leaves(doc).some((n) => {
    const l = n.src;
    const mode = l.blendMode ?? 'normal';
    return (
      !!l.clipping ||
      (!!l.adjustment && isSupportedAdjustment(l.adjustment)) ||
      (mode !== 'normal' && mode !== 'pass through') ||
      (!!l.mask?.canvas && !l.mask.disabled) ||
      !!activeDropShadow(l.effects) ||
      !!activeOuterGlow(l.effects) ||
      !!activeStroke(l.effects)
    );
  });
}

export function countAdjustmentLayers(doc: Doc): number {
  return leaves(doc).filter((n) => !!n.src.adjustment).length;
}

export function composeDocPreview(doc: Doc): HTMLCanvasElement {
  const cache = previewCacheFor(doc);
  const key = stackFingerprint(doc, 'current', NO_EXCLUDE);
  if (cache.fullKey === key && cache.full) return cache.full;
  // New canvas when the picture changes, so an earlier result stays put (callers compare them).
  const next = document.createElement('canvas');
  next.width = doc.width;
  next.height = doc.height;
  paintStack(doc, currentPose, NO_EXCLUDE, next);
  cache.full = next;
  cache.fullKey = key;
  cache.fullSerial++;
  return next;
}
 
/** What the viewport draws for a PSD that uses one baked preview instead of a mesh per layer. */
export interface PsdLivePreview {
  /** Complete image, or the static plate when `overlay` is set. */
  base: HTMLCanvasElement;
  /** Normal-blended dirty layers above `base`. Null when `base` is already the full preview. */
  overlay: HTMLCanvasElement | null;
  baseSerial: number;
  overlaySerial: number;
}
 
function staticLive(canvas: HTMLCanvasElement): PsdLivePreview {
  return { base: canvas, overlay: null, baseSerial: 0, overlaySerial: 0 };
}
 
/**
 * Embedded composite + cached footprint patches, then only the dirty layers at their current pose.
 * The footprint stack does not depend on live x/y, so dragging reuses it.
 */
function buildFileBaseLive(doc: Doc): PsdLivePreview | null {
  const file = doc.fileComposite;
  if (!file) return null;
 
  const removed = layersNeedingFootprintRemoval(doc);
  const overlayNodes = overlayLeaves(doc);
  if (!removed.length && !overlayNodes.length) return staticLive(file);
 
  const cache = previewCacheFor(doc);
  const exclude = new Set(removed.map((n) => n.id));
  const sans = ensureSans(doc, exclude);
  const plateKey = `${objectId(file)}|${cache.sansKey}|${footprintStamp(doc, removed)}`;
  if (cache.plateKey !== plateKey || !cache.plate) {
    cache.plate = ensureCanvas(cache.plate, doc.width, doc.height);
    const g = cache.plate.getContext('2d')!;
    reset2d(g);
    g.clearRect(0, 0, doc.width, doc.height);
    g.drawImage(file, 0, 0);
    if (removed.length) patchEmbeddedFootprints(g, doc, removed, sans);
    cache.plateKey = plateKey;
    cache.plateSerial++;
  }
 
  if (!overlayNodes.length) {
    return { base: cache.plate, overlay: null, baseSerial: cache.plateSerial, overlaySerial: 0 };
  }
 
  const split = overlaySplitsFromPlate(overlayNodes);
  const oKey = `${split ? 's' : 'f'}|${overlayStamp(overlayNodes)}`;
  if (cache.overlayKey !== oKey) {
    if (split) {
      cache.overlay = ensureCanvas(cache.overlay, doc.width, doc.height);
      paintNodes(doc, overlayNodes, cache.overlay, true);
    } else {
      cache.blended = ensureCanvas(cache.blended, doc.width, doc.height);
      const g = cache.blended.getContext('2d')!;
      reset2d(g);
      g.clearRect(0, 0, doc.width, doc.height);
      g.drawImage(cache.plate, 0, 0);
      paintNodes(doc, overlayNodes, cache.blended, false);
    }
    cache.overlayKey = oKey;
    cache.overlaySerial++;
    cache.flatKey = '';
  }
 
  if (split && cache.overlay) {
    return {
      base: cache.plate,
      overlay: cache.overlay,
      baseSerial: cache.plateSerial,
      overlaySerial: cache.overlaySerial,
    };
  }
  return {
    base: cache.blended ?? cache.plate,
    overlay: null,
    baseSerial: cache.overlaySerial,
    overlaySerial: 0,
  };
}
 
function flattenLive(doc: Doc, live: PsdLivePreview): HTMLCanvasElement {
  if (!live.overlay) return live.base;
  const cache = previewCacheFor(doc);
  const key = `${live.baseSerial}:${live.overlaySerial}:${objectId(live.base)}:${objectId(live.overlay)}`;
  if (cache.flatKey === key && cache.composite) return cache.composite;
  const next = document.createElement('canvas');
  next.width = doc.width;
  next.height = doc.height;
  const g = next.getContext('2d')!;
  reset2d(g);
  g.drawImage(live.base, 0, 0);
  g.drawImage(live.overlay, 0, 0);
  cache.composite = next;
  cache.flatKey = key;
  return next;
}
 
/**
 * Immutable embedded composite + footprint patches + overlay of edited layers at current bounds.
 * Footprint patches swap old layer pixels for a 2D re-stack that omits edited leaves (no alpha holes).
 */
export function composeDocPreviewWithFileBase(doc: Doc): HTMLCanvasElement | null {
  if (!doc.fileComposite) return composeDocPreview(doc);
  const live = buildFileBaseLive(doc);
  if (!live) return composeDocPreview(doc);
  return flattenLive(doc, live);
}

/** Sync preview mode with whether any layer differs from import state. */
export function reconcilePsdPreviewMode(doc: Doc): void {
  if (doc.format !== 'psd') return;
  const leafCount = leaves(doc).length;
  const dirty = docHasPreviewDirtyLayers(doc);
  const structural = docPsdStructureChanged(doc);
  const hasDirtyAdjustment = leaves(doc).some((n) => !!n.src.adjustment && isLayerPreviewAffecting(n));
  if (leafCount === 0 && !docPsdFlattenedAtImport(doc)) {
    doc.psdStaticComposite = false;
    doc.psdPreviewMode = 'composite';
    return;
  }
  if (doc.psdFileCompositeBase && doc.fileComposite && !hasDirtyAdjustment && !structural) {
    if (!dirty) {
      doc.psdStaticComposite = true;
      doc.psdPreviewMode = 'file-composite';
      return;
    }
    doc.psdStaticComposite = false;
    doc.psdPreviewMode = 'file-base-overlay';
    return;
  }
  doc.psdStaticComposite = false;
  if (docNeedsCompositePreview(doc)) doc.psdPreviewMode = 'composite';
  else doc.psdPreviewMode = 'layers';
}

/** Copy of the embedded Photoshop composite (includes adjustments/effects). */
export function copyFileComposite(doc: Doc): HTMLCanvasElement | null {
  const src = doc.psd?.canvas;
  if (!src) return null;
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  c.getContext('2d')!.drawImage(src as CanvasImageSource, 0, 0);
  return c;
}

export type PsdPreviewMode = 'layers' | 'composite' | 'file-composite' | 'file-base-overlay';

export interface PsdPreviewChoice {
  mode: PsdPreviewMode;
  /** Metadata features the 2D compositor cannot reproduce exactly. */
  features: string[];
  /** Only evaluated when `features` is non-empty. */
  composite?: EmbeddedCompositeStatus;
}

/**
 * Prefer the embedded Photoshop composite whenever the file uses something the 2D compositor cannot
 * reproduce, provided the composite is real and not blank. Stale composites are not detected here.
 */
export function analyzePsdPreview(doc: Doc): PsdPreviewChoice {
  const features = unsimulatedFeatures(doc);
  const fallback: PsdPreviewMode = docNeedsCompositePreview(doc) ? 'composite' : 'layers';
  if (!features.length) {
    if (countAdjustmentLayers(doc) > 0) {
      const compStatus = embeddedCompositeStatus(doc, () => composeDocPreview(doc));
      if (compStatus === 'usable') {
        return { mode: 'file-composite', features, composite: compStatus };
      }
    }
    return { mode: fallback, features };
  }
  const composite = embeddedCompositeStatus(doc, () => composeDocPreview(doc));
  return { mode: composite === 'usable' ? 'file-composite' : fallback, features, composite };
}

export function choosePsdPreviewMode(doc: Doc): PsdPreviewMode {
  return analyzePsdPreview(doc).mode;
}
/**
 * Plate plus a normal-blended overlay when a PSD is shown as one preview.
 * Null when the document is drawn as one mesh per layer.
 * `base` stays put while a layer is only translated; `overlay` is the moving pixels.
 */
export function getPsdLivePreview(doc: Doc): PsdLivePreview | null {
  if (doc.format !== 'psd') return null;
  const leafCount = leaves(doc).length;
  if (leafCount === 0 && !docPsdFlattenedAtImport(doc)) {
    composeDocPreview(doc);
    const cache = previewCacheFor(doc);
    return { base: cache.full!, overlay: null, baseSerial: cache.fullSerial, overlaySerial: 0 };
  }
  if (docPsdStructureChanged(doc)) {
    composeDocPreview(doc);
    const cache = previewCacheFor(doc);
    return { base: cache.full!, overlay: null, baseSerial: cache.fullSerial, overlaySerial: 0 };
  }
  const previewDirty = docHasPreviewDirtyLayers(doc);
  if (doc.psdStaticComposite && doc.fileComposite && !previewDirty) return staticLive(doc.fileComposite);
  if (doc.psdFileCompositeBase && doc.fileComposite) {
    if (doc.psdPreviewMode === 'file-base-overlay' || previewDirty) return buildFileBaseLive(doc);
    return staticLive(doc.fileComposite);
  }
  if (doc.psdPreviewMode === 'file-base-overlay' && doc.fileComposite) return buildFileBaseLive(doc);
  if (doc.psdPreviewMode === 'composite' || docNeedsCompositePreview(doc)) {
    const cache = previewCacheFor(doc);
    composeDocPreview(doc);
    return { base: cache.full!, overlay: null, baseSerial: cache.fullSerial, overlaySerial: 0 };
  }
  return null;
}
export function getDocPreviewCanvas(doc: Doc): HTMLCanvasElement | null {
  // const previewDirty = doc.format === 'psd' && docHasPreviewDirtyLayers(doc);
  
  // if (doc.psdStaticComposite && doc.fileComposite && !previewDirty) return doc.fileComposite;
  // if (doc.psdFileCompositeBase && doc.fileComposite) {
  //   if (doc.psdPreviewMode === 'file-base-overlay' || docHasPreviewDirtyLayers(doc)) {
  //     return composeDocPreviewWithFileBase(doc);
  //   }
  //   return doc.fileComposite;
  // }
  // if (doc.psdPreviewMode === 'file-base-overlay' && doc.fileComposite) {
  //   return composeDocPreviewWithFileBase(doc);
  // }
  // if (doc.psdPreviewMode === 'composite' || docNeedsCompositePreview(doc)) return composeDocPreview(doc);
  // return null;
  const live = getPsdLivePreview(doc);
  if (!live) return null;
  return flattenLive(doc, live);
}

/** Layer names that would paint into the dynamic 2D composite (respects opacity/visibility). */
export function composePaintedLayerNames(doc: Doc): string[] {
  const names: string[] = [];
  for (const n of leaves(doc)) {
    if (!effVisible(n) || effOpacity(n) <= 0.001) continue;
    if (n.src.adjustment && isSupportedAdjustment(n.src.adjustment)) {
      names.push(n.name);
      continue;
    }
    if (!n.canvas || n.w <= 0 || n.h <= 0) continue;
    names.push(n.name);
  }
  return names;
}

export function isShowingEmbeddedFileComposite(doc: Doc): boolean {
  if (doc.format !== 'psd' || !doc.fileComposite) return false;
  return getDocPreviewCanvas(doc) === doc.fileComposite;
}

export function isUsingFileBaseOverlayPreview(doc: Doc): boolean {
  return doc.format === 'psd' && doc.psdPreviewMode === 'file-base-overlay' && !doc.psdStaticComposite;
}

import type { LayerMaskData } from 'ag-psd';
import { type Doc, type Node, effOpacity, effVisible, leaves } from './model';
import { blendPixelsInto, isPixelBlendMode } from './psdBlend';
import { type EmbeddedCompositeStatus, embeddedCompositeStatus, unsimulatedFeatures } from './psdCompositeRule';
import { applyAdjustmentToCanvas, isSupportedAdjustment } from './psdAdjustment';

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
  const out = document.createElement('canvas');
  out.width = docW;
  out.height = docH;
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
  const scratch = document.createElement('canvas');
  scratch.width = docW;
  scratch.height = docH;
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

function nodeToDocCanvas(n: Node, docW: number, docH: number): HTMLCanvasElement | null {
  return nodeToDocCanvasAt(n, docW, docH, n.x, n.y, n.w, n.h, n.rotation);
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
  const c = document.createElement('canvas');
  c.width = r.doc.width;
  c.height = r.doc.height;
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
  const c = document.createElement('canvas');
  c.width = r.doc.width;
  c.height = r.doc.height;
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
  let docLayer = layerPixelsAt(r, n);
  if (!docLayer) {
    if (n.src.adjustment && isSupportedAdjustment(n.src.adjustment)) {
      paintAdjustmentLeaf(g, r, n, opacity);
    }
    return;
  }
  if (hasClippedLayerAbove(doc, n) && !n.src.clipping) r.bases.set(n.id, docLayer);

  const base = clipBaseOf(doc, n);
  if (base) {
    const shape = clipBaseShape(r, base);
    if (!shape) return;
    docLayer = clipLayerToBase(doc.width, doc.height, docLayer, shape);
  }

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

/**
 * 2D stack at import poses, omitting excluded leaves (adjustments/effects still not simulated).
 * Used to fill old bounds after a layer move without punching transparent holes in the file composite.
 */
export function composeDocPreviewExcluding(doc: Doc, excludeIds: ReadonlySet<string>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const g = c.getContext('2d')!;
  const r = stackRender(doc, importPose, excludeIds);
  for (const n of leaves(doc)) paintLeaf(g, r, n, effVisible(n), effOpacity(n));
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return c;
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

export function docNeedsCompositePreview(doc: Doc): boolean {
  if (doc.format !== 'psd') return false;
  return leaves(doc).some((n) => {
    const l = n.src;
    const mode = l.blendMode ?? 'normal';
    return (
      !!l.clipping ||
      (!!l.adjustment && isSupportedAdjustment(l.adjustment)) ||
      (mode !== 'normal' && mode !== 'pass through') ||
      (!!l.mask?.canvas && !l.mask.disabled)
    );
  });
}

export function countAdjustmentLayers(doc: Doc): number {
  return leaves(doc).filter((n) => !!n.src.adjustment).length;
}

/**
 * Paint visible leaf layers with blend modes, clipping, and raster masks (2D).
 * Does not simulate adjustment layers or layer effects.
 */
export function composeDocPreview(doc: Doc): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const g = c.getContext('2d')!;
  const r = stackRender(doc, currentPose);
  for (const n of leaves(doc)) paintLeaf(g, r, n, effVisible(n), effOpacity(n));
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Immutable embedded composite + footprint patches + overlay of edited layers at current bounds.
 * Footprint patches swap old layer pixels for a 2D re-stack that omits edited leaves (no alpha holes).
 */
export function composeDocPreviewWithFileBase(doc: Doc): HTMLCanvasElement | null {
  const base = doc.fileComposite;
  if (!base) return composeDocPreview(doc);

  const removed = layersNeedingFootprintRemoval(doc);
  const overlay = overlayLeaves(doc);
  if (!removed.length && !overlay.length) return base;

  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const g = c.getContext('2d')!;
  g.drawImage(base, 0, 0);

  if (removed.length) {
    const exclude = new Set(removed.map((n) => n.id));
    const sans = composeDocPreviewExcluding(doc, exclude);
    patchEmbeddedFootprints(g, doc, removed, sans);
  }

  const r = stackRender(doc, currentPose);
  for (const n of overlay) paintLeaf(g, r, n, effVisible(n), effOpacity(n));

  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** Sync preview mode with whether any layer differs from import state. */
export function reconcilePsdPreviewMode(doc: Doc): void {
  if (doc.format !== 'psd') return;
  const dirty = docHasPreviewDirtyLayers(doc);
  if (doc.psdFileCompositeBase && doc.fileComposite) {
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

export function getDocPreviewCanvas(doc: Doc): HTMLCanvasElement | null {
  const previewDirty = doc.format === 'psd' && docHasPreviewDirtyLayers(doc);
  if (doc.psdStaticComposite && doc.fileComposite && !previewDirty) return doc.fileComposite;
  if (doc.psdFileCompositeBase && doc.fileComposite) {
    if (doc.psdPreviewMode === 'file-base-overlay' || docHasPreviewDirtyLayers(doc)) {
      return composeDocPreviewWithFileBase(doc);
    }
    return doc.fileComposite;
  }
  if (doc.psdPreviewMode === 'file-base-overlay' && doc.fileComposite) {
    return composeDocPreviewWithFileBase(doc);
  }
  if (doc.psdPreviewMode === 'composite' || docNeedsCompositePreview(doc)) return composeDocPreview(doc);
  return null;
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

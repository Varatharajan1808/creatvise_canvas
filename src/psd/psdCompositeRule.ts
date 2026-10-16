import type { Layer } from 'ag-psd';
import { type Doc, type Node, effOpacity, effVisible, walk } from '../core/model';
import { isPixelBlendMode } from './psdBlend';
import { isSupportedAdjustment } from './psdAdjustment';
import { hasUnsupportedLayerEffects } from './psdLayerEffects';

/** Canvas modes whose formulas match Photoshop; the rest of the canvas set differs (soft light, HSL modes). */
const EXACT_NATIVE_MODES: ReadonlySet<string> = new Set([
  'normal',
  'pass through',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color dodge',
  'color burn',
  'hard light',
  'difference',
  'exclusion',
]);

const isExactBlend = (mode: string | undefined) => !mode || EXACT_NATIVE_MODES.has(mode) || isPixelBlendMode(mode);


function hasNonDefaultBlendIf(l: Layer): boolean {
  const b = l.blendingRanges;
  if (!b) return false;
  const all = [b.compositeGrayBlendSource, b.compositeGraphBlendDestinationRange, ...b.ranges.flatMap((r) => [r.sourceRange, r.destRange])];
  return all.some((r) => r.join() !== '0,0,255,255');
}

/** Contributes to the rendered image: visible, not fully transparent. */
const renders = (n: Node) => effVisible(n) && effOpacity(n) > 0.001;

/**
 * Features present in the file that the 2D compositor cannot reproduce exactly, derived only from
 * layer metadata. Any entry means the embedded Photoshop composite is the better unedited preview.
 */
export function unsimulatedFeatures(doc: Doc): string[] {
  const found = new Set<string>();
  const psd = doc.psd;
  if (psd?.colorMode !== undefined && psd.colorMode !== 3) found.add('non-RGB color mode');
  if ((psd?.bitsPerChannel ?? 8) > 8) found.add('16/32-bit color');

  for (const n of walk(doc.roots)) {
    if (!renders(n)) continue;
    const l = n.src;
    if (n.kind === 'group') {
      const mode = l.blendMode ?? 'pass through';
      if (mode !== 'pass through') {
        const nonNormalInside = [...walk(n.children)].some((c) => c.kind !== 'group' && (c.src.blendMode ?? 'normal') !== 'normal');
        if (mode !== 'normal' || nonNormalInside || n.opacity < 1) found.add('isolated group blending');
      }
      if (l.mask && !l.mask.disabled) found.add('group masks');
      if (l.clipping) found.add('clipped groups');
      if (n.opacity < 1 && n.children.filter((c) => c.kind !== 'group' || c.children.length).length > 1) found.add('group opacity');
    } else {
      if (l.adjustment && !isSupportedAdjustment(l.adjustment)) found.add('adjustment layers');
      if (!isExactBlend(l.blendMode)) found.add(`${l.blendMode} blend mode`);
      if (l.fillOpacity !== undefined && l.fillOpacity < 1) found.add('fill opacity');
      if (l.clipping && l.blendClippendElements === false) found.add('clipped layers blended individually');
    }
    if (hasUnsupportedLayerEffects(l.effects)) found.add('layer effects');
    if (l.knockout) found.add('knockout');
    if (hasNonDefaultBlendIf(l)) found.add('Blend If');
    const m = l.mask;
    if (m && !m.disabled && ((m.userMaskDensity ?? 1) < 1 || (m.userMaskFeather ?? 0) > 0)) found.add('mask density/feather');
    if (l.realMask) found.add('combined pixel and vector masks');
    // A shape layer's vector mask is its outline, already rendered into its pixels.
    if (l.vectorMask && !l.vectorMask.disable && !l.vectorFill) found.add('vector masks');
  }

  for (const n of walk(doc.roots)) {
    if (n.kind === 'group' || !n.src.clipping || !renders(n)) continue;
    const sibs = n.parent ? n.parent.children : doc.roots;
    let base: Node | undefined;
    for (let i = sibs.indexOf(n) - 1; i >= 0; i--) if (!sibs[i].src.clipping) { base = sibs[i]; break; }
    if (base && (base.opacity < 1 || !['normal', 'pass through'].includes(base.src.blendMode ?? 'normal'))) {
      found.add('clipping group opacity/blend');
    }
  }
  return [...found];
}

export type EmbeddedCompositeStatus = 'usable' | 'missing' | 'not-real' | 'blank';

/** Downscaled RGBA of a canvas (cheap enough to run at import). */
function thumbnailPixels(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

function thumbSize(doc: Doc) {
  const s = Math.min(1, 128 / Math.max(doc.width, doc.height));
  return { w: Math.max(1, Math.round(doc.width * s)), h: Math.max(1, Math.round(doc.height * s)) };
}

function isUniform(d: Uint8ClampedArray): boolean {
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i] - d[0]) > 1 || Math.abs(d[i + 1] - d[1]) > 1 || Math.abs(d[i + 2] - d[2]) > 1 || Math.abs(d[i + 3] - d[3]) > 1) return false;
  }
  return true;
}

const allTransparent = (d: Uint8ClampedArray) => {
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
};

/**
 * Whether the embedded composite can stand in for Photoshop's render. `layersPreview` renders the layer
 * stack and is only called when the composite is a single flat colour, to tell a flat design from a
 * placeholder composite. Stale (out-of-date but non-blank) composites are not detected here.
 */
export function embeddedCompositeStatus(doc: Doc, layersPreview: () => HTMLCanvasElement): EmbeddedCompositeStatus {
  const composite = doc.psd?.canvas as CanvasImageSource | undefined;
  if (!composite) return 'missing';
  if (doc.psd?.imageResources?.versionInfo?.hasRealMergedData === false) return 'not-real';
  const { w, h } = thumbSize(doc);
  const comp = thumbnailPixels(composite, w, h);
  if (allTransparent(comp)) return 'blank';
  if (isUniform(comp) && !isUniform(thumbnailPixels(layersPreview(), w, h))) return 'blank';
  return 'usable';
}

/** Luminance of a canvas downscaled by `scale`, composited over white. */
function luminance(c: CanvasImageSource, w: number, h: number): Float64Array {
  const s = document.createElement('canvas');
  s.width = w;
  s.height = h;
  const g = s.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

function correlation(a: Float64Array, b: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const p = a[i], q = b[i];
      n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
    }
  }
  if (!n) return NaN;
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  if (va < 1e-6 || vb < 1e-6) return NaN;
  return (sab / n - (sa / n) * (sb / n)) / Math.sqrt(va * vb);
}

export interface CompositeAgreement {
  whole: number;
  minTile: number;
}

/**
 * Structural agreement between the embedded composite and a layer render (luminance correlation at
 * 1/`scale`, whole image and the weakest of 4×4 tiles). Diagnostic only: not used to switch previews.
 */
export function compositeAgreement(composite: CanvasImageSource, rendered: CanvasImageSource, docW: number, docH: number, scale = 8): CompositeAgreement {
  const w = Math.max(4, Math.floor(docW / scale));
  const h = Math.max(4, Math.floor(docH / scale));
  const a = luminance(rendered, w, h);
  const b = luminance(composite, w, h);
  const tiles: number[] = [];
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) {
      const v = correlation(a, b, w, Math.floor((k * w) / 4), Math.floor((r * h) / 4), Math.floor(((k + 1) * w) / 4), Math.floor(((r + 1) * h) / 4));
      if (!isNaN(v)) tiles.push(v);
    }
  }
  return { whole: correlation(a, b, w, 0, 0, w, h), minTile: tiles.length ? Math.min(...tiles) : NaN };
}

/** Provisional thresholds from two Photoshop fixtures and synthetic stale cases; not yet trusted for switching. */
export const AGREEMENT_THRESHOLDS = { whole: 0.85, minTile: 0.3 } as const;

export function agreementLooksStale(a: CompositeAgreement): boolean {
  if (isNaN(a.whole)) return true;
  return a.whole < AGREEMENT_THRESHOLDS.whole || (!isNaN(a.minTile) && a.minTile < AGREEMENT_THRESHOLDS.minTile);
}

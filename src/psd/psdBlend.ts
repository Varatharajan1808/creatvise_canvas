import type { BlendMode } from 'ag-psd';

/** Photoshop blend modes with no canvas composite operation; blended per pixel instead. */
export type PixelBlendMode =
  | 'linear burn'
  | 'linear dodge'
  | 'vivid light'
  | 'linear light'
  | 'pin light'
  | 'hard mix'
  | 'subtract'
  | 'divide'
  | 'darker color'
  | 'lighter color';

const PIXEL_MODES: ReadonlySet<string> = new Set<PixelBlendMode>([
  'linear burn',
  'linear dodge',
  'vivid light',
  'linear light',
  'pin light',
  'hard mix',
  'subtract',
  'divide',
  'darker color',
  'lighter color',
]);

export function isPixelBlendMode(mode: BlendMode | string | undefined): mode is PixelBlendMode {
  return !!mode && PIXEL_MODES.has(mode);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Separable blend function B(backdrop, source), channels in 0..1. */
export function blendChannel(mode: Exclude<PixelBlendMode, 'darker color' | 'lighter color'>, b: number, s: number): number {
  switch (mode) {
    case 'linear burn':
      return clamp01(b + s - 1);
    case 'linear dodge':
      return clamp01(b + s);
    case 'linear light':
      return clamp01(b + 2 * s - 1);
    case 'subtract':
      return clamp01(b - s);
    case 'divide':
      if (s <= 0) return b <= 0 ? 0 : 1;
      return clamp01(b / s);
    case 'pin light':
      return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case 'hard mix':
      // 8-bit inputs: compare the integer sum so 127 + 128 lands on white like Photoshop.
      return Math.round(b * 255) + Math.round(s * 255) >= 255 ? 1 : 0;
    case 'vivid light':
      if (s <= 0.5) {
        if (s <= 0) return b >= 1 ? 1 : 0;
        return clamp01(1 - (1 - b) / (2 * s));
      }
      if (s >= 1) return b <= 0 ? 0 : 1;
      return clamp01(b / (2 * (1 - s)));
  }
}

/**
 * Blend `src` onto `dst` in place (straight-alpha RGBA bytes, same length), W3C compositing:
 * co = αs(1-αb)Cs + αsαb·B(Cb,Cs) + (1-αs)αbCb, αo = αs + αb(1-αs).
 */
export function blendPixelsInto(dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: PixelBlendMode, opacity: number): void {
  const op = clamp01(opacity);
  const nonSeparable = mode === 'darker color' || mode === 'lighter color';
  const blended = [0, 0, 0];
  for (let i = 0; i < dst.length; i += 4) {
    const as = (src[i + 3] / 255) * op;
    if (as <= 0) continue;
    const ab = dst[i + 3] / 255;
    const sr = src[i] / 255, sg = src[i + 1] / 255, sb = src[i + 2] / 255;
    const br = dst[i] / 255, bg = dst[i + 1] / 255, bb = dst[i + 2] / 255;
    if (nonSeparable) {
      const sSum = src[i] + src[i + 1] + src[i + 2];
      const bSum = dst[i] + dst[i + 1] + dst[i + 2];
      const useSrc = mode === 'darker color' ? sSum < bSum : sSum > bSum;
      blended[0] = useSrc ? sr : br;
      blended[1] = useSrc ? sg : bg;
      blended[2] = useSrc ? sb : bb;
    } else {
      blended[0] = blendChannel(mode, br, sr);
      blended[1] = blendChannel(mode, bg, sg);
      blended[2] = blendChannel(mode, bb, sb);
    }
    const ao = as + ab * (1 - as);
    const ws = as * (1 - ab);
    const wm = as * ab;
    const wb = (1 - as) * ab;
    dst[i] = ((ws * sr + wm * blended[0] + wb * br) / ao) * 255;
    dst[i + 1] = ((ws * sg + wm * blended[1] + wb * bg) / ao) * 255;
    dst[i + 2] = ((ws * sb + wm * blended[2] + wb * bb) / ao) * 255;
    dst[i + 3] = ao * 255;
  }
}

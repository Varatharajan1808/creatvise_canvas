import type { BlackAndWhiteAdjustment, Color } from 'ag-psd';
import { labToRgb } from './psdAdjustmentPhotoFilter';

export interface BlackAndWhiteParams {
  reds: number; // Reds weight normalized (e.g. 0.40)
  yellows: number; // Yellows weight normalized (e.g. 0.60)
  greens: number; // Greens weight normalized (e.g. 0.40)
  cyans: number; // Cyans weight normalized (e.g. 0.60)
  blues: number; // Blues weight normalized (e.g. 0.20)
  magentas: number; // Magentas weight normalized (e.g. 0.80)
  useTint: boolean;
  tintH: number; // Tint hue in [0, 360)
  tintS: number; // Tint saturation in [0, 1]
  tintHx: number; // Precomputed 1 - |(tintH / 60) % 2 - 1|
  tintSector: number; // Math.floor(tintH / 60) in [0, 5]
}

/**
 * Extracts normalized [hue, saturation] from an ag-psd Color object.
 * Defaults to classic Sepia tint (Hue ~35°, Saturation ~0.25).
 */
export function extractTintHueSat(color?: Color): [number, number] {
  if (!color) {
    return [35, 0.25];
  }

  const c = color as Record<string, number | undefined>;

  // 1. Direct HSB / HSL representation
  if (typeof c.h === 'number') {
    const h = ((c.h % 360) + 360) % 360;
    const sRaw = typeof c.s === 'number' ? c.s : 0.25;
    const s = sRaw > 1.0 ? Math.min(1, Math.max(0, sRaw / 100)) : Math.min(1, Math.max(0, sRaw));
    return [h, s];
  }

  // 2. RGB byte representation
  let rByte = 225;
  let gByte = 211;
  let bByte = 179;

  if (typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number') {
    rByte = c.r;
    gByte = c.g;
    bByte = c.b;
  } else if (typeof c.fr === 'number' && typeof c.fg === 'number' && typeof c.fb === 'number') {
    rByte = c.fr * 255;
    gByte = c.fg * 255;
    bByte = c.fb * 255;
  } else if (typeof c.l === 'number' && typeof c.a === 'number' && typeof c.b === 'number') {
    const rgb = labToRgb(c.l, c.a, c.b);
    rByte = rgb[0];
    gByte = rgb[1];
    bByte = rgb[2];
  } else if (typeof c.k === 'number') {
    // Achromatic tint
    return [0, 0];
  }

  const r0 = Math.max(0, Math.min(255, rByte)) / 255;
  const g0 = Math.max(0, Math.min(255, gByte)) / 255;
  const b0 = Math.max(0, Math.min(255, bByte)) / 255;

  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const d = max - min;
  const L = (max + min) / 2;

  if (d <= 1e-4) {
    return [0, 0];
  }

  const s = L > 0 && L < 1 ? d / (1 - Math.abs(2 * L - 1)) : 0;

  let h = 0;
  if (max === r0) {
    h = ((g0 - b0) / d) % 6;
  } else if (max === g0) {
    h = (b0 - r0) / d + 2;
  } else {
    h = (r0 - g0) / d + 4;
  }
  h = ((h * 60) % 360 + 360) % 360;

  return [h, Math.min(1, Math.max(0, s))];
}

/**
 * Prepares parameters for Black & White adjustment layer before rendering.
 * Uses Photoshop default weights (R:40, Y:60, G:40, C:60, B:20, M:80) when fields are omitted.
 */
export function prepareBlackAndWhiteParams(
  adj: BlackAndWhiteAdjustment,
): BlackAndWhiteParams {
  const reds = (adj.reds ?? 40) / 100;
  const yellows = (adj.yellows ?? 60) / 100;
  const greens = (adj.greens ?? 40) / 100;
  const cyans = (adj.cyans ?? 60) / 100;
  const blues = (adj.blues ?? 20) / 100;
  const magentas = (adj.magentas ?? 80) / 100;

  const useTint = !!adj.useTint;
  const [tintH, tintS] = extractTintHueSat(adj.tintColor);

  const tintSector = Math.floor(tintH / 60) % 6;
  const hNorm = (tintH / 60) % 2;
  const tintHx = 1 - Math.abs(hNorm - 1);

  return {
    reds,
    yellows,
    greens,
    cyans,
    blues,
    magentas,
    useTint,
    tintH,
    tintS,
    tintHx,
    tintSector,
  };
}

/**
 * Evaluates Black & White adjustment directly into out triplet buffer without per-pixel allocations.
 */
export function evaluateBlackAndWhiteFastInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  params: BlackAndWhiteParams,
): void {
  // 1. Calculate monochrome luminance Y via hexcone decomposition
  let Y = 0;

  if (r >= g && g >= b) {
    // Sector 1: Red -> Yellow (r >= g >= b)
    Y = b + (r - g) * params.reds + (g - b) * params.yellows;
  } else if (g >= r && r >= b) {
    // Sector 2: Yellow -> Green (g >= r >= b)
    Y = b + (g - r) * params.greens + (r - b) * params.yellows;
  } else if (g >= b && b >= r) {
    // Sector 3: Green -> Cyan (g >= b >= r)
    Y = r + (g - b) * params.greens + (b - r) * params.cyans;
  } else if (b >= g && g >= r) {
    // Sector 4: Cyan -> Blue (b >= g >= r)
    Y = r + (b - g) * params.blues + (g - r) * params.cyans;
  } else if (b >= r && r >= g) {
    // Sector 5: Blue -> Magenta (b >= r >= g)
    Y = g + (b - r) * params.blues + (r - g) * params.magentas;
  } else {
    // Sector 6: Magenta -> Red (r >= b >= g)
    Y = g + (r - b) * params.reds + (b - g) * params.magentas;
  }

  // 2. Pure monochrome output when tinting is disabled
  if (!params.useTint || params.tintS <= 1e-4) {
    const val = Math.min(255, Math.max(0, Math.round(Y)));
    out[0] = val;
    out[1] = val;
    out[2] = val;
    return;
  }

  // 3. Tinted monochrome output via HSL
  const L = Math.min(1, Math.max(0, Y / 255));
  const C = (1 - Math.abs(2 * L - 1)) * params.tintS;
  const X = C * params.tintHx;
  const m = L - C * 0.5;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  switch (params.tintSector) {
    case 0: // [0, 60)
      r1 = C + m;
      g1 = X + m;
      b1 = m;
      break;
    case 1: // [60, 120)
      r1 = X + m;
      g1 = C + m;
      b1 = m;
      break;
    case 2: // [120, 180)
      r1 = m;
      g1 = C + m;
      b1 = X + m;
      break;
    case 3: // [180, 240)
      r1 = m;
      g1 = X + m;
      b1 = C + m;
      break;
    case 4: // [240, 300)
      r1 = X + m;
      g1 = m;
      b1 = C + m;
      break;
    default: // [300, 360)
      r1 = C + m;
      g1 = m;
      b1 = X + m;
      break;
  }

  out[0] = Math.min(255, Math.max(0, Math.round(r1 * 255)));
  out[1] = Math.min(255, Math.max(0, Math.round(g1 * 255)));
  out[2] = Math.min(255, Math.max(0, Math.round(b1 * 255)));
}

/**
 * Evaluates Black & White adjustment for a single pixel (convenience helper for tests).
 */
export function evaluateBlackAndWhitePixel(
  r: number,
  g: number,
  b: number,
  params: BlackAndWhiteParams,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  evaluateBlackAndWhiteFastInto(out, r, g, b, params);
  return out;
}

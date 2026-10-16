import type { Color, PhotoFilterAdjustment } from 'ag-psd';

/**
 * Converts CIE L*a*b* coordinates to sRGB [0, 255].
 * Handles both ag-psd normalized representation (L in [0, 1], a/b in [-1, 1])
 * and standard CIE representation (L in [0, 100], a/b in [-128, 127]).
 */
export function labToRgb(l: number, a: number, b: number): [number, number, number] {
  let L = l;
  let A = a;
  let B = b;

  if (L <= 1.0 && A >= -1.0 && A <= 1.0 && B >= -1.0 && B <= 1.0) {
    L = L * 100;
    A = A * 128;
    B = B * 128;
  }

  // CIE Lab to XYZ (D65 standard illuminant)
  const fy = (L + 16) / 116;
  const fx = A / 500 + fy;
  const fz = fy - B / 200;

  const delta = 6 / 29;
  const delta2 = delta * delta;

  const x = fx > delta ? fx * fx * fx : 3 * delta2 * (fx - 4 / 29);
  const y = fy > delta ? fy * fy * fy : 3 * delta2 * (fy - 4 / 29);
  const z = fz > delta ? fz * fz * fz : 3 * delta2 * (fz - 4 / 29);

  const X = x * 0.95047;
  const Y = y * 1.00000;
  const Z = z * 1.08883;

  // XYZ to linear sRGB
  const rLin = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const gLin = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const bLin = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;

  function gammaCorrect(c: number): number {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  }

  const outR = Math.min(255, Math.max(0, Math.round(gammaCorrect(rLin) * 255)));
  const outG = Math.min(255, Math.max(0, Math.round(gammaCorrect(gLin) * 255)));
  const outB = Math.min(255, Math.max(0, Math.round(gammaCorrect(bLin) * 255)));

  return [outR, outG, outB];
}

/**
 * Extracts RGB byte triplet [0, 255] from ag-psd Color structure.
 * Defaults to Warming Filter (85) [236, 138, 0] if unspecified.
 */
export function extractFilterColorRgb(color?: Color): [number, number, number] {
  if (!color) {
    // Default Warming Filter 85
    return [236, 138, 0];
  }

  const c = color as Record<string, number | undefined>;
  if (typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number') {
    return [
      Math.min(255, Math.max(0, Math.round(c.r))),
      Math.min(255, Math.max(0, Math.round(c.g))),
      Math.min(255, Math.max(0, Math.round(c.b))),
    ];
  }

  if (typeof c.fr === 'number' && typeof c.fg === 'number' && typeof c.fb === 'number') {
    return [
      Math.min(255, Math.max(0, Math.round(c.fr * 255))),
      Math.min(255, Math.max(0, Math.round(c.fg * 255))),
      Math.min(255, Math.max(0, Math.round(c.fb * 255))),
    ];
  }

  if (typeof c.l === 'number' && typeof c.a === 'number' && typeof c.b === 'number') {
    return labToRgb(c.l, c.a, c.b);
  }

  return [236, 138, 0];
}

/**
 * Fast pixel evaluator with optical transmission parameters precomputed outside the loop.
 */
export function evaluatePhotoFilterFastInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  tr: number,
  tg: number,
  tb: number,
  preserveLuminosity: boolean,
): void {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;

  let outR = R * tr;
  let outG = G * tg;
  let outB = B * tb;

  if (preserveLuminosity) {
    const origLum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const tintedLum = 0.2126 * outR + 0.7152 * outG + 0.0722 * outB;

    if (tintedLum > 1e-6 && origLum > 1e-6) {
      const k = origLum / tintedLum;
      outR *= k;
      outG *= k;
      outB *= k;
    }
  }

  out[0] = Math.min(255, Math.max(0, Math.round(outR * 255)));
  out[1] = Math.min(255, Math.max(0, Math.round(outG * 255)));
  out[2] = Math.min(255, Math.max(0, Math.round(outB * 255)));
}

/**
 * Evaluates Photo Filter directly into out triplet for a single RGB pixel in [0, 255].
 */
export function evaluatePhotoFilterInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  filterR: number,
  filterG: number,
  filterB: number,
  density: number,
  preserveLuminosity: boolean,
): void {
  if (density <= 1e-4) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return;
  }

  const d = Math.min(1.0, Math.max(0.0, density));
  const Fr = filterR / 255;
  const Fg = filterG / 255;
  const Fb = filterB / 255;

  const tr = 1 - d * (1 - Fr);
  const tg = 1 - d * (1 - Fg);
  const tb = 1 - d * (1 - Fb);

  evaluatePhotoFilterFastInto(out, r, g, b, tr, tg, tb, preserveLuminosity);
}

/**
 * Evaluates Photo Filter for a single RGB pixel in [0, 255].
 */
export function evaluatePhotoFilterPixel(
  r: number,
  g: number,
  b: number,
  filterR: number,
  filterG: number,
  filterB: number,
  density: number,
  preserveLuminosity: boolean,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  evaluatePhotoFilterInto(out, r, g, b, filterR, filterG, filterB, density, preserveLuminosity);
  return out;
}

/**
 * Helper to prepare Photo Filter parameters from PhotoFilterAdjustment.
 */
export function preparePhotoFilterParams(adj: PhotoFilterAdjustment): {
  filterR: number;
  filterG: number;
  filterB: number;
  density: number;
  preserveLuminosity: boolean;
  tr: number;
  tg: number;
  tb: number;
} {
  const [filterR, filterG, filterB] = extractFilterColorRgb(adj.color);
  let density = adj.density ?? 25;
  if (density > 1) {
    density = density / 100;
  }
  const preserveLuminosity = adj.preserveLuminosity !== false;
  const d = Math.min(1.0, Math.max(0.0, density));

  const Fr = filterR / 255;
  const Fg = filterG / 255;
  const Fb = filterB / 255;

  const tr = 1 - d * (1 - Fr);
  const tg = 1 - d * (1 - Fg);
  const tb = 1 - d * (1 - Fb);

  return { filterR, filterG, filterB, density, preserveLuminosity, tr, tg, tb };
}

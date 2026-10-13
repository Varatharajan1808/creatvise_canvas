import type {
  ColorBalanceAdjustment,
  ColorBalanceValues,
} from 'ag-psd';

export interface ColorBalanceParams {
  sCR: number; // Shadows Cyan-Red in [-1, 1]
  sMG: number; // Shadows Magenta-Green in [-1, 1]
  sYB: number; // Shadows Yellow-Blue in [-1, 1]
  mCR: number; // Midtones Cyan-Red in [-1, 1]
  mMG: number; // Midtones Magenta-Green in [-1, 1]
  mYB: number; // Midtones Yellow-Blue in [-1, 1]
  hCR: number; // Highlights Cyan-Red in [-1, 1]
  hMG: number; // Highlights Magenta-Green in [-1, 1]
  hYB: number; // Highlights Yellow-Blue in [-1, 1]
  preserveLuminosity: boolean;
  isIdentity: boolean;
}

/**
 * Prepares and validates parameters for a Color Balance adjustment layer before rendering.
 * All sliders are in [-100, 100] and normalized to [-1, 1].
 */
export function prepareColorBalanceParams(
  adj: ColorBalanceAdjustment,
): ColorBalanceParams {
  const s = adj.shadows;
  const m = adj.midtones;
  const h = adj.highlights;

  const sCR = Math.max(-1, Math.min(1, (s?.cyanRed ?? 0) / 100));
  const sMG = Math.max(-1, Math.min(1, (s?.magentaGreen ?? 0) / 100));
  const sYB = Math.max(-1, Math.min(1, (s?.yellowBlue ?? 0) / 100));

  const mCR = Math.max(-1, Math.min(1, (m?.cyanRed ?? 0) / 100));
  const mMG = Math.max(-1, Math.min(1, (m?.magentaGreen ?? 0) / 100));
  const mYB = Math.max(-1, Math.min(1, (m?.yellowBlue ?? 0) / 100));

  const hCR = Math.max(-1, Math.min(1, (h?.cyanRed ?? 0) / 100));
  const hMG = Math.max(-1, Math.min(1, (h?.magentaGreen ?? 0) / 100));
  const hYB = Math.max(-1, Math.min(1, (h?.yellowBlue ?? 0) / 100));

  const preserveLuminosity = !!adj.preserveLuminosity;

  const isIdentity =
    Math.abs(sCR) < 1e-4 &&
    Math.abs(sMG) < 1e-4 &&
    Math.abs(sYB) < 1e-4 &&
    Math.abs(mCR) < 1e-4 &&
    Math.abs(mMG) < 1e-4 &&
    Math.abs(mYB) < 1e-4 &&
    Math.abs(hCR) < 1e-4 &&
    Math.abs(hMG) < 1e-4 &&
    Math.abs(hYB) < 1e-4;

  return {
    sCR,
    sMG,
    sYB,
    mCR,
    mMG,
    mYB,
    hCR,
    hMG,
    hYB,
    preserveLuminosity,
    isIdentity,
  };
}

/**
 * Computes smooth partition-of-unity weights for shadows, midtones, and highlights
 * for a normalized luminance value L in [0, 1].
 * Guarantees w_s + w_m + w_h === 1.0 everywhere.
 */
export function getColorBalanceWeights(
  L: number,
): [number, number, number] {
  let ws = 0;
  let wm = 0;
  let wh = 0;

  if (L <= 0.5) {
    const t = 1 - 2 * L;
    ws = t * t;
    wm = 1 - ws;
    wh = 0;
  } else {
    const t = 2 * L - 1;
    wh = t * t;
    wm = 1 - wh;
    ws = 0;
  }

  return [ws, wm, wh];
}

/**
 * Evaluates Color Balance adjustment directly into the target triplet buffer without allocations.
 */
export function evaluateColorBalanceFastInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  params: ColorBalanceParams,
): void {
  if (params.isIdentity) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return;
  }

  const R0 = r / 255;
  const G0 = g / 255;
  const B0 = b / 255;

  // Rec. 709 luminance (consistent with Photo Filter)
  let L = 0.2126 * R0 + 0.7152 * G0 + 0.0722 * B0;
  if (L < 0) L = 0;
  else if (L > 1) L = 1;

  let ws = 0;
  let wm = 0;
  let wh = 0;

  if (L <= 0.5) {
    const t = 1 - 2 * L;
    ws = t * t;
    wm = 1 - ws;
  } else {
    const t = 2 * L - 1;
    wh = t * t;
    wm = 1 - wh;
  }

  const dR = ws * params.sCR + wm * params.mCR + wh * params.hCR;
  const dG = ws * params.sMG + wm * params.mMG + wh * params.hMG;
  const dB = ws * params.sYB + wm * params.mYB + wh * params.hYB;

  let R1 = R0 + dR;
  let G1 = G0 + dG;
  let B1 = B0 + dB;

  if (params.preserveLuminosity) {
    let L1 = 0.2126 * R1 + 0.7152 * G1 + 0.0722 * B1;
    if (L <= 1e-6) {
      // Pure black stays pure black when preserving luminosity
      R1 = 0;
      G1 = 0;
      B1 = 0;
    } else if (L1 > 1e-6) {
      const k = L / L1;
      R1 *= k;
      G1 *= k;
      B1 *= k;
    }
  }

  out[0] = Math.min(255, Math.max(0, Math.round(R1 * 255)));
  out[1] = Math.min(255, Math.max(0, Math.round(G1 * 255)));
  out[2] = Math.min(255, Math.max(0, Math.round(B1 * 255)));
}

/**
 * Evaluates Color Balance adjustment for a single pixel (convenience helper for tests).
 */
export function evaluateColorBalancePixel(
  r: number,
  g: number,
  b: number,
  params: ColorBalanceParams,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  evaluateColorBalanceFastInto(out, r, g, b, params);
  return out;
}

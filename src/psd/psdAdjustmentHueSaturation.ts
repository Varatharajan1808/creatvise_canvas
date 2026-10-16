import type {
  HueSaturationAdjustment,
  HueSaturationAdjustmentChannel,
} from 'ag-psd';

export interface HueRange {
  a: number;
  b: number;
  c: number;
  d: number;
  B: number;
  C: number;
  D: number;
  hue: number;
  saturation: number;
  lightness: number;
}

export interface HueSaturationParams {
  masterHue: number;
  masterSat: number;
  masterLight: number;
  ranges: HueRange[];
  isIdentity: boolean;
}

const DEFAULT_SECTORS: Record<
  string,
  { a: number; b: number; c: number; d: number }
> = {
  reds: { a: 315, b: 345, c: 15, d: 45 },
  yellows: { a: 15, b: 45, c: 75, d: 105 },
  greens: { a: 75, b: 105, c: 135, d: 165 },
  cyans: { a: 135, b: 165, c: 195, d: 225 },
  blues: { a: 195, b: 225, c: 255, d: 285 },
  magentas: { a: 255, b: 285, c: 315, d: 345 },
};

/**
 * Calculates the trapezoidal falloff weight W in [0, 1] for a given hue angle h in [0, 360).
 * Handles angular wraparound cleanly by normalizing relative to border a.
 */
export function getTrapezoidWeight(h: number, range: HueRange): number {
  const hRel = (h - range.a + 360) % 360;
  if (hRel < 0 || hRel > range.D) return 0;
  if (hRel >= range.B && hRel <= range.C) return 1;
  if (hRel < range.B) return range.B > 0 ? hRel / range.B : 1;
  return range.D > range.C ? (range.D - hRel) / (range.D - range.C) : 0;
}

function buildHueRange(
  ch: HueSaturationAdjustmentChannel,
  defaultSector?: { a: number; b: number; c: number; d: number },
): HueRange | null {
  const hue = ch.hue ?? 0;
  const saturation = ch.saturation ?? 0;
  const lightness = ch.lightness ?? 0;

  if (hue === 0 && saturation === 0 && lightness === 0) return null;

  let a = ch.a ?? 0;
  let b = ch.b ?? 0;
  let c = ch.c ?? 0;
  let d = ch.d ?? 0;

  if (a === 0 && b === 0 && c === 0 && d === 0 && defaultSector) {
    a = defaultSector.a;
    b = defaultSector.b;
    c = defaultSector.c;
    d = defaultSector.d;
  }

  const B = (b - a + 360) % 360;
  const C = (c - a + 360) % 360;
  const D = (d - a + 360) % 360;

  return { a, b, c, d, B, C, D, hue, saturation, lightness };
}

/**
 * Prepares and validates parameters for a Hue/Saturation adjustment layer before rendering.
 */
export function prepareHueSaturationParams(
  adj: HueSaturationAdjustment,
): HueSaturationParams {
  const masterHue = adj.master?.hue ?? 0;
  const masterSat = adj.master?.saturation ?? 0;
  const masterLight = adj.master?.lightness ?? 0;

  const ranges: HueRange[] = [];

  const checkChannel = (
    ch: HueSaturationAdjustmentChannel | undefined,
    key: string,
  ) => {
    if (!ch) return;
    const r = buildHueRange(ch, DEFAULT_SECTORS[key]);
    if (r) ranges.push(r);
  };

  checkChannel(adj.reds, 'reds');
  checkChannel(adj.yellows, 'yellows');
  checkChannel(adj.greens, 'greens');
  checkChannel(adj.cyans, 'cyans');
  checkChannel(adj.blues, 'blues');
  checkChannel(adj.magentas, 'magentas');

  const isIdentity =
    masterHue === 0 &&
    masterSat === 0 &&
    masterLight === 0 &&
    ranges.length === 0;

  return {
    masterHue,
    masterSat,
    masterLight,
    ranges,
    isIdentity,
  };
}

/**
 * Evaluates Hue/Saturation adjustment directly into the target triplet buffer without allocations.
 */
export function evaluateHueSaturationFastInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  params: HueSaturationParams,
): void {
  if (params.isIdentity) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return;
  }

  // 1. Convert normalized RGB to HSL
  const r0 = r / 255;
  const g0 = g / 255;
  const b0 = b / 255;

  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  let l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;

  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r0) {
      h = (g0 - b0) / d + (g0 < b0 ? 6 : 0);
    } else if (max === g0) {
      h = (b0 - r0) / d + 2;
    } else {
      h = (r0 - g0) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
    else if (h >= 360) h -= 360;
  }

  // 2. Accumulate shifts from master and color range channels
  let dH = params.masterHue;
  let dS = params.masterSat;
  let dL = params.masterLight;

  if (params.ranges.length > 0 && d > 1e-6) {
    for (let i = 0; i < params.ranges.length; i++) {
      const rng = params.ranges[i];
      const w = getTrapezoidWeight(h, rng);
      if (w > 0) {
        dH += w * rng.hue;
        dS += w * rng.saturation;
        dL += w * rng.lightness;
      }
    }
  }

  if (dH === 0 && dS === 0 && dL === 0) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return;
  }

  // 3. Apply Hue shift (only affects chromatic pixels with s > 0)
  if (s > 0) {
    h = (h + dH) % 360;
    if (h < 0) h += 360;
  }

  // 4. Apply Saturation shift (achromatic pixels with s === 0 have no hue and remain neutral)
  if (s > 0) {
    if (dS > 0) {
      s = s + (1 - s) * (dS / 100);
    } else if (dS < 0) {
      s = s * (1 + dS / 100);
    }
    if (s < 0) s = 0;
    else if (s > 1) s = 1;
  }

  // 5. Apply Lightness shift
  if (dL > 0) {
    l = l + (1 - l) * (dL / 100);
  } else if (dL < 0) {
    l = l * (1 + dL / 100);
  }
  if (l < 0) l = 0;
  else if (l > 1) l = 1;

  // 6. Convert HSL back to RGB
  if (s === 0) {
    const v = Math.min(255, Math.max(0, Math.round(l * 255)));
    out[0] = v;
    out[1] = v;
    out[2] = v;
    return;
  }

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const sector = Math.floor(hPrime) % 6;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (sector === 0) {
    r1 = c;
    g1 = x;
  } else if (sector === 1) {
    r1 = x;
    g1 = c;
  } else if (sector === 2) {
    g1 = c;
    b1 = x;
  } else if (sector === 3) {
    g1 = x;
    b1 = c;
  } else if (sector === 4) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = l - c / 2;
  out[0] = Math.min(255, Math.max(0, Math.round((r1 + m) * 255)));
  out[1] = Math.min(255, Math.max(0, Math.round((g1 + m) * 255)));
  out[2] = Math.min(255, Math.max(0, Math.round((b1 + m) * 255)));
}

/**
 * Evaluates Hue/Saturation adjustment for a single pixel (convenience helper for tests).
 */
export function evaluateHueSaturationPixel(
  r: number,
  g: number,
  b: number,
  params: HueSaturationParams,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  evaluateHueSaturationFastInto(out, r, g, b, params);
  return out;
}

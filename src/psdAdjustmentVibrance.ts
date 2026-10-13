import type { VibranceAdjustment } from 'ag-psd';

const inv255 = 1 / 255;

/**
 * Fast pixel evaluator with saturation factors precomputed outside the loop.
 */
export function evaluateVibranceFastInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  kSat: number,
  vibScale: number,
  hasVibrance: boolean,
  isVibPos: boolean,
): void {
  const maxInt = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const minInt = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const chromaInt = maxInt - minInt;

  if (chromaInt === 0) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return;
  }

  const R = r * inv255;
  const G = g * inv255;
  const B = b * inv255;
  const chroma = chromaInt * inv255;
  const mx = maxInt * inv255;

  // Standard luminance
  const lum = 0.299 * R + 0.587 * G + 0.114 * B;
  const sat = chroma / mx;

  // Vibrance adaptive adjustment
  let kVib = 0;
  if (hasVibrance) {
    if (isVibPos) {
      // Calculate hue angle to protect warm skin tones (approx 15° to 45°)
      let hue = 0;
      if (maxInt === r) {
        hue = ((G - B) / chroma) % 6;
      } else if (maxInt === g) {
        hue = (B - R) / chroma + 2;
      } else {
        hue = (R - G) / chroma + 4;
      }
      let deg = hue * 60;
      if (deg < 0) deg += 360;

      // Skin tone damping factor
      let skinDamp = 1.0;
      if (deg >= 10 && deg <= 50) {
        const dist = Math.abs(deg - 30);
        skinDamp = 0.4 + 0.6 * (dist / 20); // 0.4 at 30°, up to 1.0 at 10° and 50°
      }

      // Less-saturated colors receive proportionally larger boost
      kVib = (1 - sat) * vibScale * skinDamp;
    } else {
      // Negative vibrance reduces already-saturated colors
      kVib = sat * vibScale;
    }
  }

  // Total saturation multiplier
  const totalFactor = Math.max(0, 1 + kSat + kVib);

  out[0] = Math.min(255, Math.max(0, Math.round((lum + (R - lum) * totalFactor) * 255)));
  out[1] = Math.min(255, Math.max(0, Math.round((lum + (G - lum) * totalFactor) * 255)));
  out[2] = Math.min(255, Math.max(0, Math.round((lum + (B - lum) * totalFactor) * 255)));
}

/**
 * Evaluates Vibrance and Saturation for a single RGB pixel in [0, 255] directly into out triplet.
 * - saturation: uniform saturation scaling (-100..100)
 * - vibrance: non-linear adaptive saturation with skin-tone damping (-100..100)
 */
export function evaluateVibranceInto(
  out: [number, number, number],
  r: number,
  g: number,
  b: number,
  vibrance: number,
  saturation: number,
): void {
  if (vibrance === 0 && saturation === 0) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return;
  }

  const kSat = saturation / 100;
  const vibScale = vibrance / 100;
  const hasVibrance = vibrance !== 0;
  const isVibPos = vibrance > 0;

  evaluateVibranceFastInto(out, r, g, b, kSat, vibScale, hasVibrance, isVibPos);
}

export function evaluateVibrancePixel(
  r: number,
  g: number,
  b: number,
  vibrance: number,
  saturation: number,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  evaluateVibranceInto(out, r, g, b, vibrance, saturation);
  return out;
}

export function prepareVibranceParams(adj: VibranceAdjustment): {
  vibrance: number;
  saturation: number;
  kSat: number;
  vibScale: number;
  hasVibrance: boolean;
  isVibPos: boolean;
} {
  const vibrance = adj.vibrance ?? 0;
  const saturation = adj.saturation ?? 0;
  return {
    vibrance,
    saturation,
    kSat: saturation / 100,
    vibScale: vibrance / 100,
    hasVibrance: vibrance !== 0,
    isVibPos: vibrance > 0,
  };
}

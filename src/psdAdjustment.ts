import type {
  AdjustmentLayer,
  BrightnessAdjustment,
  BlackAndWhiteAdjustment,
  ColorBalanceAdjustment,
  ColorBalanceValues,
  ColorLookupAdjustment,
  CurvesAdjustment,
  CurvesAdjustmentChannel,
  HueSaturationAdjustment,
  HueSaturationAdjustmentChannel,
  LayerMaskData,
  LevelsAdjustment,
  LevelsAdjustmentChannel,
  PhotoFilterAdjustment,
  VibranceAdjustment,
} from 'ag-psd';
import { maskAlphaCanvas } from './psdComposite';
import {
  evaluateVibranceFastInto,
  evaluateVibranceInto,
  prepareVibranceParams,
} from './psdAdjustmentVibrance';
import {
  evaluatePhotoFilterFastInto,
  evaluatePhotoFilterInto,
  preparePhotoFilterParams,
} from './psdAdjustmentPhotoFilter';
import {
  getFastLutSampler,
  resolveColorLookupLut,
  sample3dLutInto,
  type FastLutSampler,
  type Lut3D,
} from './psdAdjustmentColorLookup';
import {
  buildCurvesLut,
  evaluateCurveChannel,
  solveNaturalCubicSpline,
} from './psdAdjustmentCurves';
import {
  evaluateHueSaturationFastInto,
  evaluateHueSaturationPixel,
  prepareHueSaturationParams,
  type HueRange,
  type HueSaturationParams,
} from './psdAdjustmentHueSaturation';
import {
  evaluateColorBalanceFastInto,
  evaluateColorBalancePixel,
  prepareColorBalanceParams,
  getColorBalanceWeights,
  type ColorBalanceParams,
} from './psdAdjustmentColorBalance';
import {
  evaluateBlackAndWhiteFastInto,
  evaluateBlackAndWhitePixel,
  prepareBlackAndWhiteParams,
  type BlackAndWhiteParams,
} from './psdAdjustmentBlackAndWhite';

export {
  buildCurvesLut,
  evaluateCurveChannel,
  solveNaturalCubicSpline,
  evaluateHueSaturationFastInto,
  evaluateHueSaturationPixel,
  prepareHueSaturationParams,
  evaluateColorBalanceFastInto,
  evaluateColorBalancePixel,
  prepareColorBalanceParams,
  getColorBalanceWeights,
  evaluateBlackAndWhiteFastInto,
  evaluateBlackAndWhitePixel,
  prepareBlackAndWhiteParams,
  type HueRange,
  type HueSaturationParams,
  type ColorBalanceParams,
  type BlackAndWhiteParams,
};

/** Supported adjustment types in Milestone 2A, 2B, 2C, 2D, 2E, and 2F. */
export type SupportedAdjustmentType =
  | 'levels'
  | 'brightness/contrast'
  | 'curves'
  | 'vibrance'
  | 'photo filter'
  | 'color lookup'
  | 'hue/saturation'
  | 'color balance'
  | 'black & white';

export function isSupportedAdjustment(
  adj: AdjustmentLayer | undefined,
): adj is
  | LevelsAdjustment
  | BrightnessAdjustment
  | CurvesAdjustment
  | VibranceAdjustment
  | PhotoFilterAdjustment
  | ColorLookupAdjustment
  | HueSaturationAdjustment
  | ColorBalanceAdjustment
  | BlackAndWhiteAdjustment {
  if (!adj) return false;
  return (
    adj.type === 'levels' ||
    adj.type === 'brightness/contrast' ||
    adj.type === 'curves' ||
    adj.type === 'vibrance' ||
    adj.type === 'photo filter' ||
    adj.type === 'color lookup' ||
    adj.type === 'hue/saturation' ||
    adj.type === 'color balance' ||
    adj.type === 'black & white'
  );
}

/** Evaluates a single Levels channel transfer curve for a byte value in [0, 255]. */
export function evaluateLevelsChannel(
  v: number,
  ch: LevelsAdjustmentChannel | undefined,
): number {
  if (!ch) return v;
  const inMin = ch.shadowInput ?? 0;
  const inMax = ch.highlightInput ?? 255;
  const gamma = ch.midtoneInput ?? 1.0;
  const outMin = ch.shadowOutput ?? 0;
  const outMax = ch.highlightOutput ?? 255;

  if (inMax <= inMin) return outMin;

  // 1. Clamp input to [inMin, inMax] and normalize to [0, 1]
  let norm = (v - inMin) / (inMax - inMin);
  if (norm <= 0) norm = 0;
  else if (norm >= 1) norm = 1;

  // 2. Midtone gamma curve (Photoshop gamma: gamma > 1 brightens midtones)
  if (gamma > 0 && Math.abs(gamma - 1.0) > 1e-4) {
    norm = Math.pow(norm, 1.0 / gamma);
  }

  // 3. Map to output levels and clamp
  const out = outMin + norm * (outMax - outMin);
  return Math.min(255, Math.max(0, Math.round(out)));
}

/** Precomputes 256-entry lookup tables for a Levels adjustment. */
export function buildLevelsLut(adj: LevelsAdjustment): {
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
} {
  const lutR = new Uint8Array(256);
  const lutG = new Uint8Array(256);
  const lutB = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    const rCh = evaluateLevelsChannel(i, adj.red);
    lutR[i] = evaluateLevelsChannel(rCh, adj.rgb);

    const gCh = evaluateLevelsChannel(i, adj.green);
    lutG[i] = evaluateLevelsChannel(gCh, adj.rgb);

    const bCh = evaluateLevelsChannel(i, adj.blue);
    lutB[i] = evaluateLevelsChannel(bCh, adj.rgb);
  }

  return { lutR, lutG, lutB };
}

/** Legacy (Photoshop CS2 and earlier) linear contrast and additive brightness. */
export function evaluateLegacyBrightnessContrast(
  v: number,
  brightness: number,
  contrast: number,
  mean: number,
): number {
  let val = v;
  if (contrast !== 0) {
    if (contrast > 0) {
      const c = contrast >= 100 ? 99.99 : contrast;
      const factor = 127 / (127 - c);
      val = mean + (val - mean) * factor;
    } else {
      const factor = (127 + contrast) / 127;
      val = mean + (val - mean) * factor;
    }
  }
  if (brightness !== 0) {
    val += brightness;
  }
  return Math.min(255, Math.max(0, Math.round(val)));
}

/** Modern (Photoshop CS3+) non-linear S-curve preserving highlight/shadow headroom. */
export function evaluateModernBrightnessContrast(
  v: number,
  brightness: number,
  contrast: number,
): number {
  let x = v / 255;

  // 1. Non-linear brightness curve
  if (brightness !== 0) {
    const b = brightness / 150;
    if (b > 0) {
      x = x + b * (1 - x) * Math.sin(x * Math.PI);
    } else {
      x = x + b * x * Math.sin((1 - x) * Math.PI);
    }
    x = Math.min(1, Math.max(0, x));
  }

  // 2. Contrast S-curve centered around midpoint 0.5
  if (contrast !== 0) {
    const c = contrast / 100;
    if (c > 0) {
      const factor = 1 + c;
      const diff = x - 0.5;
      x = 0.5 + diff * factor * (1 - Math.abs(diff) * (c * 0.5));
    } else {
      x = 0.5 + (x - 0.5) * (1 + c);
    }
    x = Math.min(1, Math.max(0, x));
  }

  return Math.min(255, Math.max(0, Math.round(x * 255)));
}

/** Precomputes 256-entry lookup tables for Brightness/Contrast. */
export function buildBrightnessContrastLut(adj: BrightnessAdjustment): {
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
} {
  const lut = new Uint8Array(256);
  const brightness = adj.brightness ?? 0;
  const contrast = adj.contrast ?? 0;
  const useLegacy = !!adj.useLegacy;
  const mean = adj.meanValue ?? 127;

  for (let i = 0; i < 256; i++) {
    if (useLegacy) {
      lut[i] = evaluateLegacyBrightnessContrast(i, brightness, contrast, mean);
    } else {
      lut[i] = evaluateModernBrightnessContrast(i, brightness, contrast);
    }
  }

  return { lutR: lut, lutG: lut, lutB: lut };
}

export interface AdjustmentLut {
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
}

export function getAdjustmentLut(adj: AdjustmentLayer): AdjustmentLut | null {
  if (adj.type === 'levels') {
    return buildLevelsLut(adj as LevelsAdjustment);
  }
  if (adj.type === 'brightness/contrast') {
    return buildBrightnessContrastLut(adj as BrightnessAdjustment);
  }
  if (adj.type === 'curves') {
    return buildCurvesLut(adj as CurvesAdjustment);
  }
  return null;
}

export interface ApplyAdjustmentOptions {
  docW: number;
  docH: number;
  opacity: number;
  mask?: LayerMaskData;
  clipBaseShape?: HTMLCanvasElement | null;
  roi?: { x: number; y: number; w: number; h: number };
}

/**
 * Applies a supported adjustment directly to the target canvas, respecting
 * clipping isolation, raster mask, layer opacity, and bounds.
 */
export function applyAdjustmentToCanvas(
  targetCanvas: HTMLCanvasElement,
  adj: AdjustmentLayer,
  options: ApplyAdjustmentOptions,
): boolean {
  if (options.opacity <= 0.001) return false;

  // Prepare engine-specific parameters before pixel loop
  let lutR: Uint8Array | null = null;
  let lutG: Uint8Array | null = null;
  let lutB: Uint8Array | null = null;

  let vibKSat = 0;
  let vibScale = 0;
  let hasVib = false;
  let isVibPos = false;
  let isVibrance = false;

  let pfTr = 1;
  let pfTg = 1;
  let pfTb = 1;
  let pfPreserveLum = true;
  let isPhotoFilter = false;

  let clSampler: FastLutSampler | null = null;
  let isColorLookup = false;

  let isHueSat = false;
  let hsParams: HueSaturationParams | null = null;

  let isColorBalance = false;
  let cbParams: ColorBalanceParams | null = null;

  let isBlackAndWhite = false;
  let bwParams: BlackAndWhiteParams | null = null;

  if (
    adj.type === 'levels' ||
    adj.type === 'brightness/contrast' ||
    adj.type === 'curves'
  ) {
    const lut = getAdjustmentLut(adj);
    if (!lut) return false;
    lutR = lut.lutR;
    lutG = lut.lutG;
    lutB = lut.lutB;
  } else if (adj.type === 'vibrance') {
    const p = prepareVibranceParams(adj as VibranceAdjustment);
    vibKSat = p.kSat;
    vibScale = p.vibScale;
    hasVib = p.hasVibrance;
    isVibPos = p.isVibPos;
    isVibrance = true;
  } else if (adj.type === 'photo filter') {
    const p = preparePhotoFilterParams(adj as PhotoFilterAdjustment);
    pfTr = p.tr;
    pfTg = p.tg;
    pfTb = p.tb;
    pfPreserveLum = p.preserveLuminosity;
    isPhotoFilter = true;
  } else if (adj.type === 'color lookup') {
    const clLut = resolveColorLookupLut(adj as ColorLookupAdjustment);
    if (!clLut) return false;
    clSampler = getFastLutSampler(clLut);
    isColorLookup = true;
  } else if (adj.type === 'hue/saturation') {
    hsParams = prepareHueSaturationParams(adj as HueSaturationAdjustment);
    if (hsParams.isIdentity) return false;
    isHueSat = true;
  } else if (adj.type === 'color balance') {
    cbParams = prepareColorBalanceParams(adj as ColorBalanceAdjustment);
    if (cbParams.isIdentity) return false;
    isColorBalance = true;
  } else if (adj.type === 'black & white') {
    bwParams = prepareBlackAndWhiteParams(adj as BlackAndWhiteAdjustment);
    isBlackAndWhite = true;
  } else {
    return false;
  }

  const docW = options.docW;
  const docH = options.docH;
  if (docW <= 0 || docH <= 0) return false;

  // Determine ROI (Region of Interest)
  let rx = 0;
  let ry = 0;
  let rw = docW;
  let rh = docH;

  const mask = options.mask;
  const maskEnabled = mask && !mask.disabled && !!mask.canvas;
  const defaultOutsideVisible = (mask?.defaultColor ?? 0) >= 128;

  // If a mask exists and outside is hidden (defaultColor 0), limit ROI to mask rect
  if (mask && !mask.disabled && !defaultOutsideVisible) {
    const ml = Math.max(0, mask.left ?? 0);
    const mt = Math.max(0, mask.top ?? 0);
    const mr = Math.min(docW, mask.right ?? ml);
    const mb = Math.min(docH, mask.bottom ?? mt);
    rx = Math.max(rx, ml);
    ry = Math.max(ry, mt);
    rw = Math.min(rw, mr - rx);
    rh = Math.min(rh, mb - ry);
  }

  if (options.roi) {
    const ox0 = Math.max(0, options.roi.x);
    const oy0 = Math.max(0, options.roi.y);
    const ox1 = Math.min(docW, options.roi.x + options.roi.w);
    const oy1 = Math.min(docH, options.roi.y + options.roi.h);
    rx = Math.max(rx, ox0);
    ry = Math.max(ry, oy0);
    rw = Math.min(rw, ox1 - rx);
    rh = Math.min(rh, oy1 - ry);
  }

  if (rw <= 0 || rh <= 0) return false;

  const ctx = targetCanvas.getContext('2d')!;
  const imgData = ctx.getImageData(rx, ry, rw, rh);
  const data = imgData.data;

  // Optional clip base pixels in ROI
  let clipData: Uint8ClampedArray | null = null;
  if (options.clipBaseShape) {
    const cctx = options.clipBaseShape.getContext('2d');
    if (cctx) {
      clipData = cctx.getImageData(rx, ry, rw, rh).data;
    }
  }

  // Optional mask alpha pixels in ROI
  let maskData: Uint8ClampedArray | null = null;
  let maskLeft = 0;
  let maskTop = 0;
  let maskW = 0;
  let maskH = 0;
  if (maskEnabled && mask.canvas) {
    const mAlpha = maskAlphaCanvas(mask.canvas as HTMLCanvasElement);
    const mctx = mAlpha.getContext('2d');
    if (mctx) {
      maskLeft = mask.left ?? 0;
      maskTop = mask.top ?? 0;
      maskW = mAlpha.width;
      maskH = mAlpha.height;
      maskData = mctx.getImageData(0, 0, maskW, maskH).data;
    }
  }

  const effOp = options.opacity;
  const outTriplet: [number, number, number] = [0, 0, 0];
  const totalPixels = data.length;

  // Fast path: full-opacity layer without clipping base shape or raster mask
  const isFullSimple = !clipData && (!mask || mask.disabled) && effOp >= 0.999;

  if (isFullSimple) {
    if (lutR) {
      const gLut = lutG!;
      const bLut = lutB!;
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        data[idx] = lutR[data[idx]];
        data[idx + 1] = gLut[data[idx + 1]];
        data[idx + 2] = bLut[data[idx + 2]];
      }
    } else if (isColorLookup && clSampler) {
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        clSampler.sample(outTriplet, data[idx], data[idx + 1], data[idx + 2]);
        data[idx] = outTriplet[0];
        data[idx + 1] = outTriplet[1];
        data[idx + 2] = outTriplet[2];
      }
    } else if (isPhotoFilter) {
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        evaluatePhotoFilterFastInto(
          outTriplet,
          data[idx],
          data[idx + 1],
          data[idx + 2],
          pfTr,
          pfTg,
          pfTb,
          pfPreserveLum,
        );
        data[idx] = outTriplet[0];
        data[idx + 1] = outTriplet[1];
        data[idx + 2] = outTriplet[2];
      }
    } else if (isVibrance) {
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        evaluateVibranceFastInto(
          outTriplet,
          data[idx],
          data[idx + 1],
          data[idx + 2],
          vibKSat,
          vibScale,
          hasVib,
          isVibPos,
        );
        data[idx] = outTriplet[0];
        data[idx + 1] = outTriplet[1];
        data[idx + 2] = outTriplet[2];
      }
    } else if (isHueSat && hsParams) {
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        evaluateHueSaturationFastInto(
          outTriplet,
          data[idx],
          data[idx + 1],
          data[idx + 2],
          hsParams,
        );
        data[idx] = outTriplet[0];
        data[idx + 1] = outTriplet[1];
        data[idx + 2] = outTriplet[2];
      }
    } else if (isColorBalance && cbParams) {
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        evaluateColorBalanceFastInto(
          outTriplet,
          data[idx],
          data[idx + 1],
          data[idx + 2],
          cbParams,
        );
        data[idx] = outTriplet[0];
        data[idx + 1] = outTriplet[1];
        data[idx + 2] = outTriplet[2];
      }
    } else if (isBlackAndWhite && bwParams) {
      for (let idx = 0; idx < totalPixels; idx += 4) {
        if (data[idx + 3] === 0) continue;
        evaluateBlackAndWhiteFastInto(
          outTriplet,
          data[idx],
          data[idx + 1],
          data[idx + 2],
          bwParams,
        );
        data[idx] = outTriplet[0];
        data[idx + 1] = outTriplet[1];
        data[idx + 2] = outTriplet[2];
      }
    }

    ctx.putImageData(imgData, rx, ry);
    return true;
  }

  // General path: handles clipping base alpha, raster masks, and partial opacity blending
  for (let y = 0; y < rh; y++) {
    const docY = ry + y;
    for (let x = 0; x < rw; x++) {
      const docX = rx + x;
      const idx = (y * rw + x) * 4;
      const a = data[idx + 3];
      if (a === 0) continue;

      let weight = effOp;

      // 1. Clipping base alpha
      if (clipData) {
        const baseAlpha = clipData[idx + 3] / 255;
        if (baseAlpha <= 0.001) continue;
        weight *= baseAlpha;
      }

      // 2. Raster mask alpha
      if (mask && !mask.disabled) {
        if (maskData) {
          const mx = docX - maskLeft;
          const my = docY - maskTop;
          if (mx >= 0 && mx < maskW && my >= 0 && my < maskH) {
            const mIdx = (my * maskW + mx) * 4 + 3;
            weight *= maskData[mIdx] / 255;
          } else {
            weight *= defaultOutsideVisible ? 1.0 : 0.0;
          }
        } else {
          weight *= defaultOutsideVisible ? 1.0 : 0.0;
        }
      }

      if (weight <= 0.001) continue;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      let adjR = r;
      let adjG = g;
      let adjB = b;

      if (lutR) {
        adjR = lutR[r];
        adjG = lutG![g];
        adjB = lutB![b];
      } else if (isVibrance) {
        evaluateVibranceFastInto(
          outTriplet,
          r,
          g,
          b,
          vibKSat,
          vibScale,
          hasVib,
          isVibPos,
        );
        adjR = outTriplet[0];
        adjG = outTriplet[1];
        adjB = outTriplet[2];
      } else if (isPhotoFilter) {
        evaluatePhotoFilterFastInto(
          outTriplet,
          r,
          g,
          b,
          pfTr,
          pfTg,
          pfTb,
          pfPreserveLum,
        );
        adjR = outTriplet[0];
        adjG = outTriplet[1];
        adjB = outTriplet[2];
      } else if (isColorLookup && clSampler) {
        clSampler.sample(outTriplet, r, g, b);
        adjR = outTriplet[0];
        adjG = outTriplet[1];
        adjB = outTriplet[2];
      } else if (isHueSat && hsParams) {
        evaluateHueSaturationFastInto(
          outTriplet,
          r,
          g,
          b,
          hsParams,
        );
        adjR = outTriplet[0];
        adjG = outTriplet[1];
        adjB = outTriplet[2];
      } else if (isColorBalance && cbParams) {
        evaluateColorBalanceFastInto(
          outTriplet,
          r,
          g,
          b,
          cbParams,
        );
        adjR = outTriplet[0];
        adjG = outTriplet[1];
        adjB = outTriplet[2];
      } else if (isBlackAndWhite && bwParams) {
        evaluateBlackAndWhiteFastInto(
          outTriplet,
          r,
          g,
          b,
          bwParams,
        );
        adjR = outTriplet[0];
        adjG = outTriplet[1];
        adjB = outTriplet[2];
      }

      if (weight >= 0.999) {
        data[idx] = adjR;
        data[idx + 1] = adjG;
        data[idx + 2] = adjB;
      } else {
        const inv = 1 - weight;
        data[idx] = (r * inv + adjR * weight + 0.5) | 0;
        data[idx + 1] = (g * inv + adjG * weight + 0.5) | 0;
        data[idx + 2] = (b * inv + adjB * weight + 0.5) | 0;
      }
    }
  }

  ctx.putImageData(imgData, rx, ry);
  return true;
}

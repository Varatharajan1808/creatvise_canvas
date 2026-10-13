import type { ColorLookupAdjustment } from 'ag-psd';

export interface Lut3D {
  size: number;
  data: Float32Array; // size * size * size * 3 entries in [0, 1]
  tableOrder: 'rgb' | 'bgr';
  fastSampler?: FastLutSampler;
}

/**
 * Precomputes coordinate indices and weights for instant 3D lattice trilinear interpolation.
 * Avoids per-pixel division, rounding, coordinate clamping, and closure allocation.
 */
export class FastLutSampler {
  private data: Float32Array;
  private strideX: number;
  private strideY: number;
  private strideZ: number;

  private x0 = new Int32Array(256);
  private x1 = new Int32Array(256);
  private fx = new Float64Array(256);

  private y0 = new Int32Array(256);
  private y1 = new Int32Array(256);
  private fy = new Float64Array(256);

  private z0 = new Int32Array(256);
  private z1 = new Int32Array(256);
  private fz = new Float64Array(256);

  constructor(lut: Lut3D) {
    const N = lut.size;
    this.data = lut.data;
    const isRgb = lut.tableOrder === 'rgb';

    if (isRgb) {
      this.strideX = 3;
      this.strideY = 3 * N;
      this.strideZ = 3 * N * N;
    } else {
      this.strideZ = 3;
      this.strideY = 3 * N;
      this.strideX = 3 * N * N;
    }

    const maxIdx = N - 1;
    for (let c = 0; c < 256; c++) {
      const coord = (c / 255) * maxIdx;
      const idx0 = Math.floor(coord);
      const idx1 = Math.min(maxIdx, idx0 + 1);
      const frac = coord - idx0;

      this.x0[c] = idx0 * this.strideX;
      this.x1[c] = idx1 * this.strideX;
      this.fx[c] = frac;

      this.y0[c] = idx0 * this.strideY;
      this.y1[c] = idx1 * this.strideY;
      this.fy[c] = frac;

      this.z0[c] = idx0 * this.strideZ;
      this.z1[c] = idx1 * this.strideZ;
      this.fz[c] = frac;
    }
  }

  sample(out: [number, number, number], r: number, g: number, b: number): void {
    const x0 = this.x0[r], x1 = this.x1[r], fx = this.fx[r];
    const y0 = this.y0[g], y1 = this.y1[g], fy = this.fy[g];
    const z0 = this.z0[b], z1 = this.z1[b], fz = this.fz[b];

    const data = this.data;
    const invFx = 1 - fx;
    const invFy = 1 - fy;
    const invFz = 1 - fz;

    const o000 = z0 + y0 + x0;
    const o100 = z0 + y0 + x1;
    const o010 = z0 + y1 + x0;
    const o110 = z0 + y1 + x1;
    const o001 = z1 + y0 + x0;
    const o101 = z1 + y0 + x1;
    const o011 = z1 + y1 + x0;
    const o111 = z1 + y1 + x1;

    // R channel
    const r00 = data[o000] * invFx + data[o100] * fx;
    const r10 = data[o010] * invFx + data[o110] * fx;
    const r01 = data[o001] * invFx + data[o101] * fx;
    const r11 = data[o011] * invFx + data[o111] * fx;
    const r0 = r00 * invFy + r10 * fy;
    const r1 = r01 * invFy + r11 * fy;
    const outR = r0 * invFz + r1 * fz;

    // G channel
    const g00 = data[o000 + 1] * invFx + data[o100 + 1] * fx;
    const g10 = data[o010 + 1] * invFx + data[o110 + 1] * fx;
    const g01 = data[o001 + 1] * invFx + data[o101 + 1] * fx;
    const g11 = data[o011 + 1] * invFx + data[o111 + 1] * fx;
    const g0 = g00 * invFy + g10 * fy;
    const g1 = g01 * invFy + g11 * fy;
    const outG = g0 * invFz + g1 * fz;

    // B channel
    const b00 = data[o000 + 2] * invFx + data[o100 + 2] * fx;
    const b10 = data[o010 + 2] * invFx + data[o110 + 2] * fx;
    const b01 = data[o001 + 2] * invFx + data[o101 + 2] * fx;
    const b11 = data[o011 + 2] * invFx + data[o111 + 2] * fx;
    const b0 = b00 * invFy + b10 * fy;
    const b1 = b01 * invFy + b11 * fy;
    const outB = b0 * invFz + b1 * fz;

    out[0] = Math.min(255, Math.max(0, Math.round(outR * 255)));
    out[1] = Math.min(255, Math.max(0, Math.round(outG * 255)));
    out[2] = Math.min(255, Math.max(0, Math.round(outB * 255)));
  }
}

export function getFastLutSampler(lut: Lut3D): FastLutSampler {
  if (!lut.fastSampler) {
    lut.fastSampler = new FastLutSampler(lut);
  }
  return lut.fastSampler;
}

/** Cache parsed Lut3D from raw Uint8Array buffers to eliminate redundant parsing. */
const lutCache = new WeakMap<Uint8Array, Lut3D>();

/**
 * Parses an Adobe .cube 3D LUT (from text string or raw bytes).
 */
export function parseCubeLut(content: string | Uint8Array): Lut3D | null {
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  const lines = text.split(/\r?\n/);

  let size = 0;
  const values: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#')) {
      continue;
    }

    const upper = rawLine.toUpperCase();
    if (upper.startsWith('LUT_3D_SIZE')) {
      const parts = rawLine.split(/\s+/);
      if (parts.length >= 2) {
        size = parseInt(parts[1], 10);
      }
      continue;
    }

    if (
      upper.startsWith('TITLE') ||
      upper.startsWith('DOMAIN_MIN') ||
      upper.startsWith('DOMAIN_MAX') ||
      upper.startsWith('LUT_1D_SIZE')
    ) {
      continue;
    }

    const tokens = rawLine.split(/\s+/);
    if (tokens.length >= 3) {
      const r = parseFloat(tokens[0]);
      const g = parseFloat(tokens[1]);
      const b = parseFloat(tokens[2]);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        values.push(r, g, b);
      }
    }
  }

  if (size <= 1) {
    const triplets = Math.floor(values.length / 3);
    const inferred = Math.round(Math.cbrt(triplets));
    if (inferred * inferred * inferred === triplets && inferred > 1) {
      size = inferred;
    } else {
      return null;
    }
  }

  const expectedLength = size * size * size * 3;
  if (values.length < expectedLength) {
    return null;
  }

  const data = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    data[i] = Math.min(1.0, Math.max(0.0, values[i]));
  }

  return {
    size,
    data,
    tableOrder: 'rgb', // Standard .cube order: R changes fastest
  };
}

/**
 * Parses an Autodesk .3dl 3D LUT (from text string or raw bytes).
 */
export function parse3dlLut(content: string | Uint8Array): Lut3D | null {
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  const lines = text.split(/\r?\n/);

  let size = 0;
  let maxVal = 0;
  let inMesh = false;
  const values: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#')) {
      continue;
    }

    const upper = rawLine.toUpperCase();
    if (upper === '3DMESH') {
      inMesh = true;
      continue;
    }

    if (upper.startsWith('MESH')) {
      inMesh = true;
      const parts = rawLine.split(/\s+/);
      if (parts.length >= 3) {
        const inBits = parseInt(parts[1], 10);
        const outBits = parseInt(parts[2], 10);
        if (!Number.isNaN(inBits)) {
          size = Math.pow(2, inBits) + 1;
        }
        if (!Number.isNaN(outBits)) {
          maxVal = Math.pow(2, outBits) - 1;
        }
      }
      continue;
    }

    const tokens = rawLine.split(/\s+/);
    if (
      tokens.length !== 3 &&
      tokens.length >= 2 &&
      tokens.every((t) => !Number.isNaN(parseFloat(t)))
    ) {
      size = tokens.length;
      continue;
    }

    if (tokens.length >= 3) {
      const r = parseFloat(tokens[0]);
      const g = parseFloat(tokens[1]);
      const b = parseFloat(tokens[2]);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        values.push(r, g, b);
      }
    }
  }

  const triplets = Math.floor(values.length / 3);
  const inferred = Math.round(Math.cbrt(triplets));
  if (
    inferred * inferred * inferred === triplets &&
    (size <= 1 || (inferred !== size && triplets < size * size * size))
  ) {
    size = inferred;
  }

  const expectedLength = size * size * size * 3;
  if (values.length < expectedLength) {
    return null;
  }

  if (maxVal <= 0) {
    let peak = 1.0;
    for (let i = 0; i < expectedLength; i++) {
      if (values[i] > peak) {
        peak = values[i];
      }
    }
    if (peak <= 1.0) maxVal = 1.0;
    else if (peak <= 255.0) maxVal = 255.0;
    else if (peak <= 1023.0) maxVal = 1023.0;
    else if (peak <= 4095.0) maxVal = 4095.0;
    else maxVal = peak;
  }

  const data = new Float32Array(expectedLength);
  const invMax = 1.0 / maxVal;
  for (let i = 0; i < expectedLength; i++) {
    data[i] = Math.min(1.0, Math.max(0.0, values[i] * invMax));
  }

  return {
    size,
    data,
    tableOrder: 'bgr', // Standard .3dl order: B changes fastest
  };
}

/**
 * Trilinear interpolation of a normalized RGB coordinate directly into out triplet.
 */
export function sample3dLutInto(
  out: [number, number, number],
  lut: Lut3D,
  r: number,
  g: number,
  b: number,
): void {
  getFastLutSampler(lut).sample(out, r, g, b);
}

/**
 * Trilinear interpolation of a normalized RGB coordinate within a 3D LUT lattice.
 */
export function sample3dLut(
  lut: Lut3D,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  sample3dLutInto(out, lut, r, g, b);
  return out;
}

/**
 * Resolves and parses a 3D LUT from ColorLookupAdjustment metadata with caching.
 */
export function resolveColorLookupLut(adj: ColorLookupAdjustment): Lut3D | null {
  if (!adj.lut3DFileData || adj.lut3DFileData.length === 0) {
    return null;
  }

  const cached = lutCache.get(adj.lut3DFileData);
  if (cached) {
    if (adj.tableOrder && cached.tableOrder !== adj.tableOrder) {
      cached.tableOrder = adj.tableOrder;
      cached.fastSampler = undefined;
    }
    return cached;
  }

  const fileName = (adj.lut3DFileName ?? '').toLowerCase();
  const format = adj.lutFormat;
  let resolved: Lut3D | null = null;

  if (format === 'cube' || fileName.endsWith('.cube')) {
    resolved = parseCubeLut(adj.lut3DFileData);
  } else if (format === '3dl' || fileName.endsWith('.3dl')) {
    resolved = parse3dlLut(adj.lut3DFileData);
  }

  if (!resolved) {
    resolved = parseCubeLut(adj.lut3DFileData) || parse3dlLut(adj.lut3DFileData);
  }

  if (resolved) {
    if (adj.tableOrder) {
      resolved.tableOrder = adj.tableOrder;
    }
    // Pre-initialize sampler for zero-cost first frame
    getFastLutSampler(resolved);
    lutCache.set(adj.lut3DFileData, resolved);
  }

  return resolved;
}

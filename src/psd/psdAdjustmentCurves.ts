import type { CurvesAdjustment, CurvesAdjustmentChannel } from 'ag-psd';

/**
 * Fits a natural cubic spline through an array of control points ({ input, output }).
 * Enforces C2 continuity (matching first and second derivatives at knots) and
 * natural boundary conditions (second derivative S''(x) = 0 at endpoints).
 */
export function solveNaturalCubicSpline(
  channel: CurvesAdjustmentChannel | undefined,
): (x: number) => number {
  if (!channel || channel.length === 0) {
    return (x: number) => Math.min(255, Math.max(0, Math.round(x)));
  }

  // 1. Sort points by input coordinate ascending
  const pts = channel.slice().sort((a, b) => a.input - b.input);

  // 2. Deduplicate points with identical input values (keep last)
  const unique: CurvesAdjustmentChannel = [];
  for (const p of pts) {
    if (unique.length > 0 && unique[unique.length - 1].input === p.input) {
      unique[unique.length - 1] = p;
    } else {
      unique.push(p);
    }
  }

  const n = unique.length;
  if (n === 0) {
    return (x: number) => Math.min(255, Math.max(0, Math.round(x)));
  }

  // 1-point fallback: constant shift
  if (n === 1) {
    const diff = unique[0].output - unique[0].input;
    return (x: number) => Math.min(255, Math.max(0, Math.round(x + diff)));
  }

  // 2-point fallback: linear interpolation clamped outside range
  if (n === 2) {
    const x0 = unique[0].input;
    const y0 = unique[0].output;
    const x1 = unique[1].input;
    const y1 = unique[1].output;

    if (x1 <= x0) {
      return () => Math.min(255, Math.max(0, Math.round(y0)));
    }

    return (x: number) => {
      if (x <= x0) return Math.min(255, Math.max(0, Math.round(y0)));
      if (x >= x1) return Math.min(255, Math.max(0, Math.round(y1)));
      const t = (x - x0) / (x1 - x0);
      return Math.min(255, Math.max(0, Math.round(y0 + t * (y1 - y0))));
    };
  }

  // 3. Natural cubic spline solver (n >= 3)
  const x = unique.map((p) => p.input);
  const a = unique.map((p) => p.output);
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    if (h[i] <= 0) h[i] = 1e-6; // guard against numerical degeneracy
  }

  const alpha = new Float64Array(n - 1);
  for (let i = 1; i < n - 1; i++) {
    alpha[i] =
      (3 / h[i]) * (a[i + 1] - a[i]) - (3 / h[i - 1]) * (a[i] - a[i - 1]);
  }

  // Tridiagonal system solve (Thomas algorithm)
  const l = new Float64Array(n);
  const mu = new Float64Array(n);
  const z = new Float64Array(n);
  l[0] = 1;
  mu[0] = 0;
  z[0] = 0;

  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
    if (Math.abs(l[i]) < 1e-12) l[i] = 1e-12;
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }

  l[n - 1] = 1;
  z[n - 1] = 0;

  const c = new Float64Array(n);
  const b = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  c[n - 1] = 0;

  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] =
      (a[j + 1] - a[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }

  return (v: number) => {
    if (v <= x[0]) return Math.min(255, Math.max(0, Math.round(a[0])));
    if (v >= x[n - 1]) return Math.min(255, Math.max(0, Math.round(a[n - 1])));

    // Find active piece [x_i, x_{i+1}]
    let i = 0;
    for (let j = 0; j < n - 1; j++) {
      if (v <= x[j + 1]) {
        i = j;
        break;
      }
    }

    const dx = v - x[i];
    const yVal = a[i] + b[i] * dx + c[i] * dx * dx + d[i] * dx * dx * dx;
    return Math.min(255, Math.max(0, Math.round(yVal)));
  };
}

/**
 * Evaluates a single byte value through a Curves channel control point list.
 */
export function evaluateCurveChannel(
  v: number,
  channel: CurvesAdjustmentChannel | undefined,
): number {
  const solver = solveNaturalCubicSpline(channel);
  return solver(v);
}

/**
 * Precomputes a 256-entry lookup table for a single curve channel.
 */
export function buildCurveChannelLut(
  channel: CurvesAdjustmentChannel | undefined,
): Uint8Array {
  const lut = new Uint8Array(256);
  const solver = solveNaturalCubicSpline(channel);
  for (let i = 0; i < 256; i++) {
    lut[i] = solver(i);
  }
  return lut;
}

/**
 * Precomputes 256-entry lookup tables for a Curves adjustment.
 * Evaluates channel-specific curves (Red, Green, Blue) first,
 * followed by the master composite RGB curve.
 */
export function buildCurvesLut(adj: CurvesAdjustment): {
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
} {
  const lutR = new Uint8Array(256);
  const lutG = new Uint8Array(256);
  const lutB = new Uint8Array(256);

  const evalR = solveNaturalCubicSpline(adj.red);
  const evalG = solveNaturalCubicSpline(adj.green);
  const evalB = solveNaturalCubicSpline(adj.blue);
  const evalRgb = solveNaturalCubicSpline(adj.rgb);

  for (let i = 0; i < 256; i++) {
    const r1 = evalR(i);
    const g1 = evalG(i);
    const b1 = evalB(i);

    lutR[i] = evalRgb(r1);
    lutG[i] = evalRgb(g1);
    lutB[i] = evalRgb(b1);
  }

  return { lutR, lutG, lutB };
}

export type Matrix2D = [number, number, number, number, number, number];

export function identity6(): Matrix2D {
  return [1, 0, 0, 1, 0, 0];
}

export function multiply6(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, tx1, ty1] = m1;
  const [a2, b2, c2, d2, tx2, ty2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * tx2 + c1 * ty2 + tx1,
    b1 * tx2 + d1 * ty2 + ty1,
  ];
}

export function apply6(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert6(m: Matrix2D): Matrix2D {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return identity6();
  const invDet = 1 / det;
  return [
    d * invDet,
    -b * invDet,
    -c * invDet,
    a * invDet,
    (c * ty - d * tx) * invDet,
    (b * tx - a * ty) * invDet,
  ];
}

export function parseMatrix6(str: string | null | undefined): Matrix2D {
  if (!str) return identity6();
  const nums = str.trim().split(/\s+/).map(Number);
  if (nums.length === 6 && nums.every((n) => Number.isFinite(n))) {
    return nums as Matrix2D;
  }
  return identity6();
}

export function matrix6ToString(m: Matrix2D): string {
  return m.map((n) => Number(n.toFixed(6))).join(' ');
}

export function determinant6(m: Matrix2D): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** Rotation in degrees (Y-down / IDML convention). */
export function rotationDegreesFromMatrix6(m: Matrix2D): number {
  const [a, b] = m;
  if (Math.abs(a) < 1e-12 && Math.abs(b) < 1e-12) return 0;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

export function uniformScaleFromMatrix6(m: Matrix2D): number {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (sx < 1e-12 && sy < 1e-12) return 1;
  return (sx + sy) / 2;
}

import type { Node } from '../core/model';

/**
 * Three.js mesh Z rotation (degrees) for a layer.
 * Selection overlay uses CSS rotate(+node.rotation). Mesh uses -rotation so both match on screen (PSD convention).
 */
export function meshRotationZDegrees(n: Pick<Node, 'rotation'>): number {
  return -n.rotation;
}

/** CSS selection box rotation (degrees). */
export function selectionCssRotationDegrees(n: Pick<Node, 'rotation'>): number {
  return n.rotation;
}

/** Pointer angle (degrees) for rotation-handle drag around doc-space center. */
export function rotationPointerAngleDeg(
  _node: Pick<Node, 'idml' | 'kind'>,
  pointerDocX: number,
  pointerDocY: number,
  centerDocX: number,
  centerDocY: number,
): number {
  const dx = pointerDocX - centerDocX;
  const dy = pointerDocY - centerDocY;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

export function rotationDeltaFromPointerDrag(
  node: Pick<Node, 'idml' | 'kind'>,
  startDoc: { x: number; y: number },
  endDoc: { x: number; y: number },
  centerDoc: { x: number; y: number },
): number {
  const a0 = rotationPointerAngleDeg(node, startDoc.x, startDoc.y, centerDoc.x, centerDoc.y);
  const a1 = rotationPointerAngleDeg(node, endDoc.x, endDoc.y, centerDoc.x, centerDoc.y);
  return a1 - a0;
}

/** CCW math offset (handleAt / Three.js rotation.z). */
export function docLocalToScreenOffset(
  localX: number,
  localY: number,
  rotationDeg: number,
): { x: number; y: number } {
  const th = (rotationDeg * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  return { x: localX * cs - localY * sn, y: localX * sn + localY * cs };
}

/** CSS `rotate(+θ)` (clockwise, Y-down screen). */
export function cssClockwiseOffset(localX: number, localY: number, rotationDeg: number): { x: number; y: number } {
  const th = (rotationDeg * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  return { x: localX * cs + localY * sn, y: -localX * sn + localY * cs };
}

/** Top-right corner: CSS rotate(+θ) matches Three mesh rotation.z = -θ (IDML shapes + text). */
export function shapeSelectionMatchesMeshRotation(
  n: Pick<Node, 'idml' | 'kind' | 'rotation'>,
  w: number,
  h: number,
): boolean {
  if (!n.idml) return true;
  const hw = w / 2;
  const hh = h / 2;
  const css = cssClockwiseOffset(hw, -hh, selectionCssRotationDegrees(n));
  const mesh = docLocalToScreenOffset(hw, -hh, meshRotationZDegrees(n));
  return Math.hypot(css.x - mesh.x, css.y - mesh.y) < 1e-4;
}

import type { Layer } from 'ag-psd';
import type { Doc, Kind, Node } from './model';
import { effOpacity, isLocked, walk } from './model';
import { isSupportedAdjustment } from './psdAdjustment';
import { activeDropShadow, activeOuterGlow, activeStroke, enabledLayerEffectKeys, hasUnsupportedLayerEffects, SIMULATED_LAYER_EFFECT_KEYS } from './psdLayerEffects';

/** Classify PSD layer for the editor model (may differ from raw Photoshop feature tags). */
export function classifyPsdNodeKind(l: Layer, isGroup: boolean): Kind {
  if (isGroup) return 'group';
  if (l.text) return 'text';
  if (l.adjustment) return 'raster';
  if (l.placedLayer) return 'raster';
  if (l.vectorFill || l.vectorStroke) {
    const left = l.left ?? 0;
    const top = l.top ?? 0;
    const w = (l.right ?? left) - left;
    const h = (l.bottom ?? top) - top;
    if (l.canvas && w > 0 && h > 0) return 'raster';
    return 'shape';
  }
  return 'raster';
}

/** Leaf nodes whose position can be changed (move tool / numeric position). */
export function leavesForPositionEdit(n: Node): Node[] {
  if (n.kind === 'group') {
    const out: Node[] = [];
    for (const c of n.children) {
      if (c.kind === 'group') out.push(...leavesForPositionEdit(c));
      else if (canEditPsdLayerPosition(c)) out.push(c);
    }
    return out;
  }
  return canEditPsdLayerPosition(n) ? [n] : [];
}

export function canEditPsdLayerPosition(n: Node): boolean {
  if (isLocked(n)) return false;
  if (n.kind === 'shape') return false;
  if (n.src.adjustment && !n.canvas) return false;
  return n.kind === 'raster' || n.kind === 'text';
}

/** Canvas hit-test: skip layers that are not meaningful pick targets. */
export function isPsdCanvasPickTarget(n: Node, doc?: Pick<Doc, 'width' | 'height'>): boolean {
  if (effOpacity(n) <= 0) return false;
  if (!n.canvas || n.w <= 0 || n.h <= 0) return false;
  if (n.kind === 'shape') return false;
  if (n.src.adjustment && !n.canvas) return false;
  // Full-document fills (common solid backgrounds) should not steal clicks from upper layers.
  if (doc && n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1) return false;
  return true;
}

export interface LayerInspection {
  name: string;
  key: string;
  kind: Kind;
  psdType: string;
  hidden: boolean;
  opacity: number;
  blendMode: string;
  clipping: boolean;
  hasCanvas: boolean;
  drawnInLayerMode: boolean;
  adjustmentType?: string;
  unsupported: string[];
}

export function psdLayerType(l: Layer): string {
  if (l.children?.length) return 'group';
  if (l.adjustment) return `adjustment:${(l.adjustment as { type?: string }).type ?? 'unknown'}`;
  if (l.text) return 'text';
  if (l.placedLayer) return `smart-object:${l.placedLayer.type ?? 'unknown'}`;
  if (l.vectorFill || l.vectorStroke) return 'shape/vector';
  return 'raster';
}

export function describeUnsupportedLayer(l: Layer): string[] {
  const u: string[] = [];
  if (l.effects) {
    const unsupported = enabledLayerEffectKeys(l.effects).filter((k) => !SIMULATED_LAYER_EFFECT_KEYS.has(k));
    const unsupportedStroke = l.effects.stroke?.find(
      (s) => s.enabled !== false && ((s.fillType && s.fillType !== 'color') || s.gradient || s.pattern),
    );
    if (unsupportedStroke) {
      unsupported.push(`stroke: ${unsupportedStroke.fillType ?? 'gradient/pattern'}`);
    }
    if (hasUnsupportedLayerEffects(l.effects)) {
      u.push(`Layer effects (${unsupported.join(', ') || 'other'}): kept in the file, not shown on canvas`);
    }
    if (activeDropShadow(l.effects)) {
      u.push('Drop shadow: drawn in the 2D layer preview (approximate; not baked into layer pixels)');
    }
    if (activeOuterGlow(l.effects)) {
      u.push('Outer glow: drawn in the 2D layer preview (approximate; not baked into layer pixels)');
    }
    if (activeStroke(l.effects)) {
      u.push('Stroke: drawn in the 2D layer preview (approximate; not baked into layer pixels)');
    }
  }
  if (l.mask) {
    if (l.mask.canvas) u.push('Raster mask: applied in composite preview when enabled; kept in the file on export');
    else u.push('Raster mask: metadata kept in the file, not applied (mask pixels unavailable)');
  }
  if (l.vectorMask && !l.vectorFill && !l.vectorStroke && !l.children) {
    u.push('Vector mask: kept in the file, not editable');
  }
  if (l.adjustment) {
    const t = (l.adjustment as { type?: string }).type ?? 'unknown';
    if (isSupportedAdjustment(l.adjustment)) {
      u.push(`Adjustment layer (${t}): applied in composite preview; kept in the file on export`);
    } else {
      u.push(`Adjustment layer (${t}): kept in the file, not simulated (use file composite preview or Photoshop)`);
    }
  }
  if (l.placedLayer) u.push('Smart object: shown as embedded raster preview, kept in the file');
  if ((l.vectorFill || l.vectorStroke) && l.canvas) {
    u.push('Vector fill/stroke: drawn as baked pixels; path editing is read-only');
  }
  if (l.clipping) u.push('Clipping mask: applied in composite preview; kept in the file on export');
  if (l.blendMode && l.blendMode !== 'normal' && l.blendMode !== 'pass through') {
    u.push(`Blend mode "${l.blendMode}": applied in composite preview; kept in the file on export`);
  }
  return u;
}

export function inspectDocLayers(doc: Doc): LayerInspection[] {
  return [...walk(doc.roots)].map((n) => ({
    name: n.name,
    key: n.key,
    kind: n.kind,
    psdType: psdLayerType(n.src),
    hidden: !!n.src.hidden,
    opacity: n.opacity,
    blendMode: n.src.blendMode ?? 'normal',
    clipping: !!n.src.clipping,
    hasCanvas: !!n.canvas,
    drawnInLayerMode: !!(n.canvas && n.w > 0 && n.h > 0 && n.visible),
    adjustmentType: n.src.adjustment ? (n.src.adjustment as { type?: string }).type : undefined,
    unsupported: [...n.unsupported],
  }));
}

export function countUnsupportedLayers(doc: Doc): number {
  return [...walk(doc.roots)].filter((n) => n.unsupported.length > 0).length;
}

import type { LayerEffectsInfo, LayerEffectsOuterGlow, LayerEffectStroke } from 'ag-psd';

export function effectBlendOp(mode: string): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
      return 'darken';
    case 'lighten':
      return 'lighten';
    case 'color dodge':
    case 'color-dodge':
      return 'color-dodge';
    case 'color burn':
    case 'color-burn':
      return 'color-burn';
    case 'hard light':
    case 'hard-light':
      return 'hard-light';
    case 'soft light':
    case 'soft-light':
      return 'soft-light';
    case 'difference':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    case 'hue':
      return 'hue';
    case 'saturation':
      return 'saturation';
    case 'color':
      return 'color';
    case 'luminosity':
      return 'luminosity';
    default:
      return 'source-over';
  }
}

/** Phase 3: drop shadow, outer glow, and solid-color stroke; other effect keys stay unsupported for preview. */
export const SIMULATED_LAYER_EFFECT_KEYS = new Set(['dropShadow', 'outerGlow', 'stroke']);

export interface DropShadowPaint {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: { r: number; g: number; b: number };
  opacity: number;
  blendMode: string;
}

export interface OuterGlowPaint {
  size: number;
  color: { r: number; g: number; b: number };
  opacity: number;
  blendMode: string;
  spread: number;
  range?: number;
  noise?: number;
}

export interface StrokePaint {
  size: number;
  position: 'inside' | 'center' | 'outside';
  color: { r: number; g: number; b: number };
  opacity: number;
  blendMode: string;
}

function effectEntries(effects: LayerEffectsInfo | undefined): [string, unknown][] {
  if (!effects || effects.disabled) return [];
  return Object.entries(effects).filter(([k]) => k !== 'disabled' && k !== 'scale');
}

/** Enabled effect resource keys (e.g. dropShadow, outerGlow, stroke). */
export function enabledLayerEffectKeys(effects: LayerEffectsInfo | undefined): string[] {
  const keys: string[] = [];
  for (const [key, val] of effectEntries(effects)) {
    const list = ([] as Array<{ enabled?: boolean }>).concat(val as never);
    if (list.some((fx) => fx && fx.enabled !== false)) keys.push(key);
  }
  return keys;
}

export function hasUnsupportedLayerEffects(effects: LayerEffectsInfo | undefined): boolean {
  if (!effects || effects.disabled) return false;
  if (enabledLayerEffectKeys(effects).some((k) => !SIMULATED_LAYER_EFFECT_KEYS.has(k))) {
    return true;
  }
  if (effects.stroke) {
    const list = ([] as Array<LayerEffectStroke>).concat(effects.stroke as never);
    for (const s of list) {
      if (s && s.enabled !== false) {
        if (s.fillType && s.fillType !== 'color') return true;
        if (s.gradient || s.pattern) return true;
      }
    }
  }
  return false;
}

/** First enabled drop shadow in Photoshop layer effects, or null. */
export function activeDropShadow(effects: LayerEffectsInfo | undefined): DropShadowPaint | null {
  if (!effects || effects.disabled) return null;
  const list = effects.dropShadow;
  if (!list?.length) return null;
  const fx = list.find((d) => d.enabled !== false);
  if (!fx) return null;

  const dist = fx.distance?.value ?? 0;
  const angleDeg = fx.angle ?? 120;
  // Shadow falls opposite the light (Photoshop angle: 0 deg = right, clockwise).
  const rad = ((angleDeg + 180) * Math.PI) / 180;
  const offsetX = dist * Math.cos(rad);
  const offsetY = dist * Math.sin(rad);
  const blur = Math.max(0, fx.size?.value ?? 0);
  const raw = fx.color;
  const rgb =
    raw && typeof raw === 'object' && 'r' in raw
      ? { r: raw.r ?? 0, g: raw.g ?? 0, b: raw.b ?? 0 }
      : { r: 0, g: 0, b: 0 };
  const opacity = fx.opacity ?? 1;
  return {
    offsetX,
    offsetY,
    blur,
    color: rgb,
    opacity: Math.max(0, Math.min(1, opacity)),
    blendMode: fx.blendMode ?? 'multiply',
  };
}

/** First enabled outer glow in Photoshop layer effects, or null. */
export function activeOuterGlow(effects: LayerEffectsInfo | undefined): OuterGlowPaint | null {
  if (!effects || effects.disabled) return null;
  const rawFx = effects.outerGlow;
  if (!rawFx) return null;
  const list = ([] as Array<LayerEffectsOuterGlow>).concat(rawFx as never);
  const fx = list.find((g) => g && g.enabled !== false);
  if (!fx) return null;

  const sizeVal = typeof fx.size === 'number' ? fx.size : (fx.size?.value ?? 0);
  const size = Math.max(0, sizeVal);
  const chokeVal = typeof fx.choke === 'number' ? fx.choke : (fx.choke?.value ?? 0);
  let spread = 0;
  if (chokeVal > 0) {
    if (chokeVal <= 1) {
      spread = chokeVal;
    } else if (size > 0 && chokeVal <= size) {
      spread = chokeVal / size;
    } else {
      spread = Math.min(1, chokeVal / 100);
    }
  }
  const raw = fx.color;
  const rgb =
    raw && typeof raw === 'object' && 'r' in raw
      ? { r: Math.round(raw.r ?? 0), g: Math.round(raw.g ?? 0), b: Math.round(raw.b ?? 0) }
      : { r: 255, g: 255, b: 255 };
  const opacity = fx.opacity !== undefined ? Math.max(0, Math.min(1, fx.opacity)) : 0.75;
  const blendMode = fx.blendMode ?? 'screen';
  const range = fx.range !== undefined ? Math.max(0, Math.min(1, fx.range > 1 ? fx.range / 100 : fx.range)) : 0.5;
  const noise = fx.noise !== undefined ? Math.max(0, Math.min(1, fx.noise > 1 ? fx.noise / 100 : fx.noise)) : 0;

  return {
    size,
    color: rgb,
    opacity,
    blendMode,
    spread,
    range,
    noise,
  };
}

/**
 * Paint drop shadow for `docLayer` (full document-sized alpha) beneath the layer content.
 * Does not modify `docLayer` or layer source pixels.
 */
export function paintDropShadow(
  g: CanvasRenderingContext2D,
  docLayer: HTMLCanvasElement,
  layerOpacity: number,
  shadow: DropShadowPaint,
): void {
  const a = shadow.opacity * layerOpacity;
  if (a <= 0.001) return;
  if (shadow.blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0) return;

  const w = docLayer.width;
  const h = docLayer.height;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tg = tmp.getContext('2d');
  if (!tg) return;

  tg.shadowColor = `rgba(${shadow.color.r},${shadow.color.g},${shadow.color.b},${a})`;
  tg.shadowBlur = shadow.blur;
  tg.shadowOffsetX = shadow.offsetX;
  tg.shadowOffsetY = shadow.offsetY;
  tg.drawImage(docLayer, 0, 0);
  tg.shadowColor = 'transparent';
  tg.shadowBlur = 0;
  tg.globalCompositeOperation = 'destination-out';
  tg.drawImage(docLayer, 0, 0);

  g.save();
  g.globalCompositeOperation = effectBlendOp(shadow.blendMode);
  g.drawImage(tmp, 0, 0);
  g.restore();
}

/**
 * Paint outer glow for `docLayer` (full document-sized alpha) beneath the layer content.
 * Does not modify `docLayer` or layer source pixels.
 */
export function paintOuterGlow(
  g: CanvasRenderingContext2D,
  docLayer: HTMLCanvasElement,
  layerOpacity: number,
  glow: OuterGlowPaint,
): void {
  const a = glow.opacity * layerOpacity;
  if (a <= 0.001) return;
  if (glow.size <= 0 && glow.spread <= 0) return;

  const w = docLayer.width;
  const h = docLayer.height;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tg = tmp.getContext('2d');
  if (!tg) return;

  const spreadPx = Math.round(glow.size * glow.spread);
  const blurPx = Math.max(0, glow.size - spreadPx);

  tg.shadowColor = `rgba(${glow.color.r},${glow.color.g},${glow.color.b},${a})`;
  tg.shadowBlur = blurPx;
  tg.shadowOffsetX = 0;
  tg.shadowOffsetY = 0;

  if (spreadPx > 0) {
    const step = Math.max(1, Math.floor(spreadPx / 2));
    for (let dx = -spreadPx; dx <= spreadPx; dx += step) {
      for (let dy = -spreadPx; dy <= spreadPx; dy += step) {
        if (dx * dx + dy * dy <= spreadPx * spreadPx) {
          tg.drawImage(docLayer, dx, dy);
        }
      }
    }
  } else {
    tg.drawImage(docLayer, 0, 0);
  }

  tg.shadowColor = 'transparent';
  tg.shadowBlur = 0;
  tg.globalCompositeOperation = 'destination-out';
  tg.drawImage(docLayer, 0, 0);

  g.save();
  g.globalCompositeOperation = effectBlendOp(glow.blendMode);
  g.drawImage(tmp, 0, 0);
  g.restore();
}

/** First enabled solid-color stroke in Photoshop layer effects, or null. */
export function activeStroke(effects: LayerEffectsInfo | undefined): StrokePaint | null {
  if (!effects || effects.disabled) return null;
  const list = effects.stroke;
  if (!list?.length) return null;
  const fx = list.find((s) => s && s.enabled !== false);
  if (!fx) return null;

  if (fx.fillType && fx.fillType !== 'color') return null;
  if (fx.gradient || fx.pattern) return null;

  const sizeVal = typeof fx.size === 'number' ? fx.size : (fx.size?.value ?? 0);
  const size = Math.max(0, sizeVal);
  if (size <= 0) return null;

  const raw = fx.color;
  const rgb =
    raw && typeof raw === 'object' && 'r' in raw
      ? { r: Math.round(raw.r ?? 0), g: Math.round(raw.g ?? 0), b: Math.round(raw.b ?? 0) }
      : { r: 0, g: 0, b: 0 };
  const opacity = fx.opacity !== undefined ? Math.max(0, Math.min(1, fx.opacity)) : 1;
  const blendMode = fx.blendMode ?? 'normal';
  const position: 'inside' | 'center' | 'outside' =
    fx.position === 'inside' || fx.position === 'center' ? fx.position : 'outside';

  return {
    size,
    position,
    color: rgb,
    opacity,
    blendMode,
  };
}

/**
 * Paint stroke for `docLayer` (full document-sized alpha) supporting inside, center, and outside positions.
 * Does not modify `docLayer` or layer source pixels.
 */
export function paintStroke(
  g: CanvasRenderingContext2D,
  docLayer: HTMLCanvasElement,
  layerOpacity: number,
  stroke: StrokePaint,
): void {
  const a = stroke.opacity * layerOpacity;
  if (a <= 0.001) return;
  if (stroke.size <= 0) return;

  const w = docLayer.width;
  const h = docLayer.height;
  const S = Math.round(stroke.size);
  if (S <= 0) return;

  const strokeCanvas = document.createElement('canvas');
  strokeCanvas.width = w;
  strokeCanvas.height = h;
  const scg = strokeCanvas.getContext('2d');
  if (!scg) return;

  const sil = document.createElement('canvas');
  sil.width = w;
  sil.height = h;
  const silG = sil.getContext('2d');
  if (!silG) return;
  silG.drawImage(docLayer, 0, 0);
  silG.globalCompositeOperation = 'source-in';
  silG.fillStyle = `rgba(${stroke.color.r},${stroke.color.g},${stroke.color.b},${a})`;
  silG.fillRect(0, 0, w, h);

  const dilateCanvas = (src: HTMLCanvasElement, radius: number): HTMLCanvasElement => {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const og = out.getContext('2d')!;
    og.drawImage(src, 0, 0);
    for (let r = 1; r <= radius; r++) {
      const kr = Math.max(8, Math.ceil(Math.PI * 2 * r));
      for (let i = 0; i < kr; i++) {
        const th = (i * 2 * Math.PI) / kr;
        const dx = Math.round(r * Math.cos(th));
        const dy = Math.round(r * Math.sin(th));
        og.drawImage(src, dx, dy);
      }
    }
    return out;
  };

  const makeInverseMask = (): HTMLCanvasElement => {
    const inv = document.createElement('canvas');
    inv.width = w;
    inv.height = h;
    const ig = inv.getContext('2d')!;
    ig.fillStyle = 'black';
    ig.fillRect(0, 0, w, h);
    ig.globalCompositeOperation = 'destination-out';
    ig.drawImage(docLayer, 0, 0);
    return inv;
  };

  if (stroke.position === 'outside') {
    const dilSil = dilateCanvas(sil, S);
    const dg = dilSil.getContext('2d')!;
    dg.globalCompositeOperation = 'destination-out';
    dg.drawImage(docLayer, 0, 0);
    scg.drawImage(dilSil, 0, 0);
  } else if (stroke.position === 'inside') {
    const inv = makeInverseMask();
    const dilInv = dilateCanvas(inv, S);
    const inside = document.createElement('canvas');
    inside.width = w;
    inside.height = h;
    const ig = inside.getContext('2d')!;
    ig.drawImage(sil, 0, 0);
    ig.globalCompositeOperation = 'destination-in';
    ig.drawImage(dilInv, 0, 0);
    scg.drawImage(inside, 0, 0);
  } else {
    const rOut = Math.ceil(S / 2);
    const rIn = Math.floor(S / 2);
    if (rOut > 0) {
      const dilSil = dilateCanvas(sil, rOut);
      const dg = dilSil.getContext('2d')!;
      dg.globalCompositeOperation = 'destination-out';
      dg.drawImage(docLayer, 0, 0);
      scg.drawImage(dilSil, 0, 0);
    }
    if (rIn > 0) {
      const inv = makeInverseMask();
      const dilInv = dilateCanvas(inv, rIn);
      const inside = document.createElement('canvas');
      inside.width = w;
      inside.height = h;
      const ig = inside.getContext('2d')!;
      ig.drawImage(sil, 0, 0);
      ig.globalCompositeOperation = 'destination-in';
      ig.drawImage(dilInv, 0, 0);
      scg.drawImage(inside, 0, 0);
    }
  }

  g.save();
  g.globalCompositeOperation = effectBlendOp(stroke.blendMode);
  g.drawImage(strokeCanvas, 0, 0);
  g.restore();
}


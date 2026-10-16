import type { Color, ParagraphStyleRun, TextStyle, TextStyleRun, VectorContent } from 'ag-psd';
import type { Doc, Node } from '../core/model';
import {
  applyAiLiveTextEdit,
  canEditAiLiveTextOnNode,
  captureAiTextState,
  getAiLiveTextInfo,
  restoreAiTextState,
  type AiTextUndoState,
} from '../ai/aiTextEdit';
import { captureAiImageState, restoreAiImageState, type AiImageUndoState } from '../ai/aiImageEdit';
import {
  getIdmlTextInfo,
  applyIdmlText,
  getIdmlShapeColor,
  applyIdmlShapeColor,
  getIdmlShapeBorderInfo,
  applyIdmlShapeBorder,
  shapeBorderBlockReason,
  serializeIdmlState,
  applyIdmlState,
  type IdmlSavedLayerState,
} from '../indd/idmlEdit';
export { shapeBorderBlockReason };

export interface Rgb { r: number; g: number; b: number }

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export function toRgb(c: Color | undefined): Rgb | null {
  if (!c) return null;
  const a = c as unknown as Record<string, number>;
  if ('r' in a) return { r: Math.round(a.r), g: Math.round(a.g), b: Math.round(a.b) };
  if ('fr' in a) return { r: Math.round(a.fr * 255), g: Math.round(a.fg * 255), b: Math.round(a.fb * 255) };
  return null;
}

export const rgbToHex = (c: Rgb) => '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ---------------------------------------------------------------- text

export interface TextInfo {
  text: string;
  fontSize: number;
  color: Rgb;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  alignment: 'left' | 'center' | 'right';
  reason?: string; // set when this text layer can't be edited yet
}

function baseStyle(n: Node): TextStyle {
  const t = n.src.text!;
  return { ...(t.style ?? {}), ...(t.styleRuns?.[0]?.style ?? {}) };
}

export function getTextInfo(n: Node): TextInfo | null {
  if (n.idml) return getIdmlTextInfo(n);
  if (canEditAiLiveTextOnNode(n)) return getAiLiveTextInfo(n);
  const t = n.src.text;
  if (n.kind !== 'text' || !t) return null;
  const st = baseStyle(n);
  const tf = n.textTransform ?? t.transform;
  let reason: string | undefined;
  if (t.shapeType === 'box') reason = 'Text inside a fixed-size box cannot be edited yet. Point text only.';
  else if (t.orientation && t.orientation !== 'horizontal') reason = 'Vertical text cannot be edited yet.';
  else if (tf && Math.abs(tf[1]) > 1e-3) reason = 'Rotated text cannot be edited yet.';

  const fontName = st.font?.name ?? 'Arial';
  const bold = Boolean(st.fauxBold || /bold|black|heavy/i.test(fontName));
  const italic = Boolean(st.fauxItalic || /italic|oblique/i.test(fontName));
  const just = t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style?.justification;
  const alignment: 'left' | 'center' | 'right' = just === 'center' ? 'center' : just === 'right' ? 'right' : 'left';

  return {
    text: t.text,
    fontSize: st.fontSize ?? 12,
    color: toRgb(st.fillColor) ?? { r: 0, g: 0, b: 0 },
    fontFamily: fontName,
    bold,
    italic,
    alignment,
    reason,
  };
}

function cssFont(st: TextStyle, px: number): string {
  const name = st.font?.name ?? 'Arial';
  const family = name.replace(/(MT|PS)$/i, '').split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2');
  const bold = st.fauxBold || /bold|black|heavy/i.test(name);
  const italic = st.fauxItalic || /italic|oblique/i.test(name);
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${px}px "${name}", "${family}", Arial, Helvetica, sans-serif`;
}

/** Draws the text again (browser fonts, close to Photoshop's but not identical). Photoshop redraws it exactly when the file is opened. */
function rasterizeText(n: Node, tf: number[]): { canvas: HTMLCanvasElement; x: number; y: number } {
  const t = n.src.text!;
  const st = baseStyle(n);
  const scale = Math.hypot(tf[2], tf[3]) || 1;
  const px = Math.max(1, (st.fontSize ?? 12) * scale);
  const lines = t.text.split(/\r\n|\r|\n/);
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = cssFont(st, px);
  if (st.tracking) probe.letterSpacing = `${(st.tracking / 1000) * px}px`;
  const widths = lines.map((l) => probe.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const m = probe.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? px * 0.9;
  const descent = m.fontBoundingBoxDescent ?? px * 0.25;
  const lineH = !st.autoLeading && st.leading ? st.leading * scale : px * 1.2;
  const just = t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style?.justification;
  const align = just === 'center' ? 'center' : just === 'right' ? 'right' : 'left';
  const pad = Math.ceil(px * 0.3);
  const blockLeft = align === 'center' ? tf[4] - maxW / 2 : align === 'right' ? tf[4] - maxW : tf[4];
  const w = Math.max(1, Math.ceil(maxW) + pad * 2);
  const h = Math.max(1, Math.ceil(ascent + descent + lineH * (lines.length - 1)) + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.font = cssFont(st, px);
  if (st.tracking) g.letterSpacing = `${(st.tracking / 1000) * px}px`;
  const c = toRgb(st.fillColor) ?? { r: 0, g: 0, b: 0 };
  g.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
  g.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const off = align === 'center' ? (maxW - widths[i]) / 2 : align === 'right' ? maxW - widths[i] : 0;
    g.fillText(line, pad + off, pad + ascent + i * lineH);
  });
  return { canvas, x: Math.round(blockLeft - pad), y: Math.round(tf[5] - ascent - pad) };
}

export function applyText(n: Node, patch: {
  text?: string;
  fontSize?: number;
  color?: Rgb;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  alignment?: 'left' | 'center' | 'right';
}) {
  if (n.idml) {
    applyIdmlText(n, patch);
    return;
  }
  const t = n.src.text;
  if (!t) return;
  const merged: TextStyle = baseStyle(n);
  if (patch.fontSize !== undefined) merged.fontSize = patch.fontSize;
  if (patch.color) merged.fillColor = { ...patch.color };
  if (patch.fontFamily !== undefined) merged.font = { name: patch.fontFamily };
  if (patch.bold !== undefined) merged.fauxBold = patch.bold;
  if (patch.italic !== undefined) merged.fauxItalic = patch.italic;

  if (patch.alignment !== undefined) {
    t.paragraphStyle = { ...(t.paragraphStyle ?? {}), justification: patch.alignment };
    if (t.paragraphStyleRuns) {
      t.paragraphStyleRuns.forEach((r) => {
        r.style = { ...(r.style ?? {}), justification: patch.alignment };
      });
    }
  }

  if (patch.text !== undefined) {
    const firstPara = t.paragraphStyleRuns?.[0]?.style;
    t.text = patch.text;
    // character counts changed, so every run is rebuilt as one run that covers all the text
    t.styleRuns = [{ length: t.text.length, style: merged }];
    if (t.paragraphStyleRuns) {
      t.paragraphStyleRuns = [{
        length: t.text.length,
        style: { ...(firstPara ?? {}), ...(patch.alignment ? { justification: patch.alignment } : {}) },
      }];
    }
  } else {
    t.styleRuns?.forEach((r) => {
      if (patch.fontSize !== undefined) r.style.fontSize = patch.fontSize;
      if (patch.color) r.style.fillColor = { ...patch.color };
      if (patch.fontFamily !== undefined) r.style.font = { name: patch.fontFamily };
      if (patch.bold !== undefined) r.style.fauxBold = patch.bold;
      if (patch.italic !== undefined) r.style.fauxItalic = patch.italic;
    });
  }

  t.style = {
    ...(t.style ?? {}),
    ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
    ...(patch.color ? { fillColor: { ...patch.color } } : {}),
    ...(patch.fontFamily !== undefined ? { font: { name: patch.fontFamily } } : {}),
    ...(patch.bold !== undefined ? { fauxBold: patch.bold } : {}),
    ...(patch.italic !== undefined ? { fauxItalic: patch.italic } : {}),
  };

  // where the text starts now (it may have been moved since import)
  const base = n.textTransform ?? t.transform ?? [1, 0, 0, 1, n.x, n.y];
  const tf = [base[0], base[1], base[2], base[3], base[4] + (n.x - n.ox), base[5] + (n.y - n.oy)];
  const r = rasterizeText(n, tf);
  n.canvas = r.canvas;
  n.x = n.ox = r.x;
  n.y = n.oy = r.y;
  n.w = n.ow = r.canvas.width;
  n.h = n.oh = r.canvas.height;
  n.textTransform = tf;
  n.textEdited = true;
}

export function applyTextOrAiLiveText(
  n: Node,
  patch: {
    text?: string;
    fontSize?: number;
    color?: Rgb;
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
  },
): void {
  if (canEditAiLiveTextOnNode(n)) {
    applyAiLiveTextEdit(n, patch);
    return;
  }
  applyText(n, patch);
}

// ---------------------------------------------------------------- shapes

export interface ShapeBorderInfo {
  enabled: boolean;
  width: number;
  color: Rgb;
}

/** Shape leaf or PSD vector layer stored as raster preview + vectorFill. */
export function nodeSupportsVectorFillEdit(n: Node): boolean {
  if (n.kind === 'shape') return true;
  return Boolean(n.src.vectorFill && n.src.vectorFill.type === 'color');
}

/** Whether the properties panel should offer shape fill/stroke color controls for this node. */
export function canEditShapeColorOnNode(doc: Doc, n: Node): boolean {
  if (n.idml && n.kind === 'shape') return true;
  if (doc.format === 'ai') return n.kind === 'shape';
  if (doc.format === 'psd') return nodeSupportsVectorFillEdit(n);
  return nodeSupportsVectorFillEdit(n);
}

export function getShapeColor(n: Node): Rgb | null {
  if (n.idml) return getIdmlShapeColor(n);
  const f = n.src.vectorFill;
  if (!f || f.type !== 'color') return null;
  return toRgb(f.color);
}

export function getShapeBorderInfo(n: Node): ShapeBorderInfo | null {
  if (n.idml && n.kind === 'shape') return getIdmlShapeBorderInfo(n);
  if (n.kind !== 'shape') return null;
  const s = n.src.vectorStroke;
  const strokeColor = s?.content?.type === 'color' ? toRgb(s.content.color) : (s as any)?.color ? toRgb((s as any).color) : null;
  const widthVal = typeof s?.lineWidth === 'number' ? s.lineWidth : typeof s?.lineWidth?.value === 'number' ? s.lineWidth.value : 2;
  return {
    enabled: Boolean(s?.strokeEnabled),
    width: Math.max(1, Math.round(widthVal)),
    color: strokeColor ?? { r: 30, g: 30, b: 30 },
  };
}

/**
 * Shared fill-color gate for PSD, AI, and IDML shapes.
 * Solid fills and no-fill shapes can be edited; gradient/pattern fills cannot.
 */
export function shapeColorBlockReason(n: Node): string | null {
  if (!nodeSupportsVectorFillEdit(n)) return null;
  const f = n.src.vectorFill;
  if (f && f.type !== 'color') return 'Gradient and pattern fills cannot be edited yet.';
  return null;
}

export function renderShapeLayerCanvas(n: Node) {
  if (n.kind !== 'shape' || !n.canvas) return;
  const fillRgb = getShapeColor(n) ?? { r: 59, g: 111, b: 216 };
  const border = getShapeBorderInfo(n);

  // Cache base silhouette if not yet saved
  if (!n.baseShapeCanvas) {
    const copy = document.createElement('canvas');
    copy.width = n.canvas.width;
    copy.height = n.canvas.height;
    copy.getContext('2d')?.drawImage(n.canvas, 0, 0);
    n.baseShapeCanvas = copy;
  }

  const out = document.createElement('canvas');
  out.width = n.canvas.width;
  out.height = n.canvas.height;
  const g = out.getContext('2d')!;

  // Path-based stroke & fill if vectorMask has paths
  const paths = n.src.vectorMask?.paths;
  if (paths && paths.length > 0 && paths[0].knots?.length) {
    g.beginPath();
    for (const path of paths) {
      const knots = path.knots;
      if (!knots || knots.length === 0) continue;
      const k0 = knots[0];
      g.moveTo(k0.points[2] - n.x, k0.points[3] - n.y);
      for (let i = 0; i < knots.length; i++) {
        const nextIdx = (i + 1) % knots.length;
        if (nextIdx === 0 && path.open) break;
        const curr = knots[i];
        const next = knots[nextIdx];
        g.bezierCurveTo(
          curr.points[4] - n.x, curr.points[5] - n.y,
          next.points[0] - n.x, next.points[1] - n.y,
          next.points[2] - n.x, next.points[3] - n.y,
        );
      }
      if (!path.open) g.closePath();
    }
    // Fill
    g.fillStyle = `rgb(${fillRgb.r},${fillRgb.g},${fillRgb.b})`;
    g.fill(paths[0].fillRule === 'even-odd' ? 'evenodd' : 'nonzero');

    // Stroke
    if (border && border.enabled && border.width > 0) {
      g.lineWidth = border.width;
      g.strokeStyle = `rgb(${border.color.r},${border.color.g},${border.color.b})`;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke();
    }
    n.canvas = out;
    return;
  }

  // Fallback silhouette contour for raster/custom shapes
  const base = n.baseShapeCanvas;
  if (base) {
    if (border && border.enabled && border.width > 0) {
      const w = border.width;
      const strokeHex = `rgb(${border.color.r},${border.color.g},${border.color.b})`;

      const strokeCanvas = document.createElement('canvas');
      strokeCanvas.width = out.width;
      strokeCanvas.height = out.height;
      const sg = strokeCanvas.getContext('2d')!;

      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = out.width;
      maskCanvas.height = out.height;
      const mg = maskCanvas.getContext('2d')!;
      mg.drawImage(base, 0, 0);
      mg.globalCompositeOperation = 'source-in';
      mg.fillStyle = strokeHex;
      mg.fillRect(0, 0, out.width, out.height);

      const steps = Math.max(8, Math.min(32, Math.ceil(w * 4)));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const ox = Math.round(Math.cos(angle) * w);
        const oy = Math.round(Math.sin(angle) * w);
        sg.drawImage(maskCanvas, ox, oy);
      }
      for (let r = 1; r < w; r += 2) {
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          sg.drawImage(maskCanvas, Math.round(Math.cos(angle) * r), Math.round(Math.sin(angle) * r));
        }
      }
      g.drawImage(strokeCanvas, 0, 0);
    }

    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = out.width;
    fillCanvas.height = out.height;
    const fg = fillCanvas.getContext('2d')!;
    fg.drawImage(base, 0, 0);
    fg.globalCompositeOperation = 'source-in';
    fg.fillStyle = `rgb(${fillRgb.r},${fillRgb.g},${fillRgb.b})`;
    fg.fillRect(0, 0, out.width, out.height);

    g.drawImage(fillCanvas, 0, 0);
    n.canvas = out;
  }
}

function recolorVectorFillOnCanvas(n: Node, hex: string): void {
  if (!n.canvas) return;
  const ctx = n.canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, n.canvas.width, n.canvas.height);
  ctx.restore();
}

export function applyShapeColor(n: Node, c: Rgb) {
  if (n.idml) {
    applyIdmlShapeColor(n, c);
    return;
  }
  n.src.vectorFill = { type: 'color', color: { ...c } };
  if (n.kind === 'shape') {
    renderShapeLayerCanvas(n);
  } else if (n.src.vectorFill) {
    recolorVectorFillOnCanvas(n, rgbToHex(c));
  }
}

export function applyShapeBorder(n: Node, patch: { enabled?: boolean; width?: number; color?: Rgb }) {
  if (n.idml && n.kind === 'shape') {
    applyIdmlShapeBorder(n, patch);
    return;
  }
  if (n.kind !== 'shape') return;
  const curr = getShapeBorderInfo(n) ?? { enabled: false, width: 2, color: { r: 30, g: 30, b: 30 } };
  const enabled = patch.enabled !== undefined ? patch.enabled : curr.enabled;
  const width = patch.width !== undefined ? patch.width : curr.width;
  const color = patch.color ? { ...patch.color } : curr.color;

  n.src.vectorStroke = {
    ...(n.src.vectorStroke ?? {}),
    strokeEnabled: enabled,
    lineWidth: { value: width, units: 'Pixels' },
    content: { type: 'color', color: { ...color } },
    fillEnabled: true,
  };

  renderShapeLayerCanvas(n);
}

// ---------------------------------------------------------------- raster image replacement

export function replaceImage(n: Node, newCanvas: HTMLCanvasElement) {
  if (n.kind !== 'raster') return;
  n.canvas = newCanvas;
  n.src.canvas = newCanvas;
}

// ---------------------------------------------------------------- undo support

export interface LayerState {
  text?: { text: string; style?: TextStyle; styleRuns?: TextStyleRun[]; paragraphStyleRuns?: ParagraphStyleRun[] };
  vectorFill?: VectorContent;
  vectorStroke?: any;
  adjustment?: any;
  canvas: HTMLCanvasElement | null;
  baseShapeCanvas?: HTMLCanvasElement | null;
  x: number; y: number; w: number; h: number;
  rotation: number;
  ox: number; oy: number; ow: number; oh: number;
  textTransform?: number[];
  textEdited?: boolean;
  aiText?: AiTextUndoState;
  aiTextEdited?: boolean;
  aiImage?: AiImageUndoState;
  aiImageEdited?: boolean;
  previewContentEpoch?: number;
  idml?: IdmlSavedLayerState;
}

export function captureState(n: Node): LayerState {
  const t = n.src.text;
  return {
    text: t ? { text: t.text, style: clone(t.style), styleRuns: clone(t.styleRuns), paragraphStyleRuns: clone(t.paragraphStyleRuns) } : undefined,
    vectorFill: clone(n.src.vectorFill),
    vectorStroke: clone(n.src.vectorStroke),
    adjustment: clone(n.src.adjustment),
    canvas: n.canvas,
    baseShapeCanvas: n.baseShapeCanvas,
    x: n.x, y: n.y, w: n.w, h: n.h,
    rotation: n.rotation,
    ox: n.ox, oy: n.oy, ow: n.ow, oh: n.oh,
    textTransform: n.textTransform ? [...n.textTransform] : undefined,
    textEdited: n.textEdited,
    aiText: captureAiTextState(n),
    aiTextEdited: n.aiTextEdited,
    aiImage: captureAiImageState(n),
    aiImageEdited: n.aiImageEdited,
    previewContentEpoch: n.previewContentEpoch,
    idml: n.idml ? serializeIdmlState(n).idml : undefined,
  };
}

export function restoreState(n: Node, s: LayerState) {
  const t = n.src.text;
  if (t && s.text) {
    t.text = s.text.text;
    t.style = clone(s.text.style);
    t.styleRuns = clone(s.text.styleRuns);
    t.paragraphStyleRuns = clone(s.text.paragraphStyleRuns);
  }
  n.src.vectorFill = clone(s.vectorFill);
  n.src.vectorStroke = clone(s.vectorStroke);
  if (s.adjustment !== undefined) n.src.adjustment = clone(s.adjustment);
  n.canvas = s.canvas;
  n.baseShapeCanvas = s.baseShapeCanvas;
  n.x = s.x; n.y = s.y; n.w = s.w; n.h = s.h;
  n.rotation = s.rotation ?? 0;
  n.ox = s.ox; n.oy = s.oy; n.ow = s.ow; n.oh = s.oh;
  n.textTransform = s.textTransform ? [...s.textTransform] : undefined;
  n.textEdited = s.textEdited;
  if (s.aiText) restoreAiTextState(n, s.aiText);
  n.aiTextEdited = s.aiTextEdited;
  if (s.aiImage) restoreAiImageState(n, s.aiImage);
  n.aiImageEdited = s.aiImageEdited;
  n.previewContentEpoch = s.previewContentEpoch;
}

// ---------------------------------------------------------------- brightness/contrast adjustment

export interface BrightnessContrastInfo {
  brightness: number;
  contrast: number;
  useLegacy: boolean;
}

export function getBrightnessContrastInfo(n: Node): BrightnessContrastInfo | null {
  if (n.src.adjustment?.type !== 'brightness/contrast') return null;
  const adj = n.src.adjustment;
  return {
    brightness: adj.brightness ?? 0,
    contrast: adj.contrast ?? 0,
    useLegacy: !!adj.useLegacy,
  };
}

export function applyBrightnessContrast(n: Node, patch: Partial<BrightnessContrastInfo>) {
  if (!n.src.adjustment || n.src.adjustment.type !== 'brightness/contrast') {
    n.src.adjustment = { type: 'brightness/contrast', brightness: 0, contrast: 0, useLegacy: false };
  }
  const adj = n.src.adjustment;
  if (patch.brightness !== undefined) adj.brightness = Math.round(patch.brightness);
  if (patch.contrast !== undefined) adj.contrast = Math.round(patch.contrast);
  if (patch.useLegacy !== undefined) adj.useLegacy = !!patch.useLegacy;
}

// ---------------------------------------------------------------- saving to the browser

export type SavedLayerState = Omit<LayerState, 'canvas' | 'baseShapeCanvas'>;

/** Everything about a layer's edits that can be stored. Canvases can't be stored, they are rebuilt on restore. */
export function serializeState(n: Node): SavedLayerState {
  if (n.idml) return serializeIdmlState(n) as SavedLayerState;
  const s = captureState(n);
  return {
    text: s.text,
    vectorFill: s.vectorFill,
    vectorStroke: s.vectorStroke,
    adjustment: s.adjustment,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    rotation: s.rotation,
    ox: s.ox,
    oy: s.oy,
    ow: s.ow,
    oh: s.oh,
    textTransform: s.textTransform,
    textEdited: s.textEdited,
    previewContentEpoch: s.previewContentEpoch,
  };
}

export function applySavedState(n: Node, s: SavedLayerState) {
  if (n.idml) {
    applyIdmlState(n, s);
    return;
  }
  restoreState(n, { ...s, canvas: n.canvas, baseShapeCanvas: n.baseShapeCanvas });
  if (n.textEdited && n.src.text) {
    // edited text: draw it again from the saved text and style
    n.canvas = rasterizeText(n, n.textTransform ?? [1, 0, 0, 1, n.x, n.y]).canvas;
  } else if (n.kind === 'shape') {
    renderShapeLayerCanvas(n);
  }
}

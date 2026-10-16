import type { Node, Doc } from './model';
import { leaves } from './model';
import type { TextInfo, Rgb, SavedLayerState, ShapeBorderInfo } from './edit';
import { hexToRgb, rgbToHex } from './edit';
import { rasterizeIdmlTextNode as rasterizeIdmlTextImpl } from './idml/rasterText';
import { plotPathInItemLocalCanvas } from './idml';
import {
  canvasAlignmentToIdmlJustification,
  idmlJustificationToCanvasAlignment,
} from './idml/storyExport';

export function canTransformIdml(n: Node): boolean {
  return Boolean(n.idml && n.idml.itemTransform);
}

export function canEditIdmlPosition(n: Node): boolean {
  return canTransformIdml(n);
}

export function leavesForIdmlPositionEdit(doc: Doc): Node[] {
  return leaves(doc).filter((n) => canTransformIdml(n));
}

export function getTextInfo(n: Node): TextInfo | null {
  if (!n.idml || n.kind !== 'text') return null;
  const t = n.src?.text;
  const textStr = t?.text ?? n.name;
  const fontSize = t?.style?.fontSize ?? 12;
  const col = t?.style?.fillColor
    ? { r: (t.style.fillColor as any).r ?? 0, g: (t.style.fillColor as any).g ?? 0, b: (t.style.fillColor as any).b ?? 0 }
    : { r: 30, g: 30, b: 30 };

  return {
    text: textStr,
    fontSize,
    color: col,
    fontFamily: t?.style?.font?.name ?? 'sans-serif',
    bold: Boolean(t?.style?.fauxBold),
    italic: Boolean(t?.style?.fauxItalic),
    alignment: idmlJustificationToCanvasAlignment(n.idml?.storyJustification),
  };
}

export const getIdmlTextInfo = getTextInfo;

export function rasterizeIdmlTextNode(n: Node): void {
  rasterizeIdmlTextImpl(n);
}

export function applyText(
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
  if (!n.idml || n.kind !== 'text') return;
  if (!n.src.text) {
    n.src.text = { text: n.name, transform: n.idml.itemTransform || [1, 0, 0, 1, n.x, n.y] };
  }
  const t = n.src.text;
  if (patch.text !== undefined) {
    t.text = patch.text;
    n.name = patch.text.slice(0, 32);
  }
  if (!t.style) t.style = {};
  if (patch.fontSize !== undefined) t.style.fontSize = patch.fontSize;
  if (patch.color) {
    t.style.fillColor = { ...patch.color } as any;
    n.idml.fillColor = rgbToHex(patch.color);
  }

  if (patch.fontFamily !== undefined) t.style.font = { name: patch.fontFamily } as any;
  if (patch.bold !== undefined) t.style.fauxBold = patch.bold;
  if (patch.italic !== undefined) t.style.fauxItalic = patch.italic;
  if (patch.alignment !== undefined && n.idml) {
    n.idml.storyJustification = canvasAlignmentToIdmlJustification(patch.alignment);
  }

  n.textEdited = true;
  rasterizeIdmlTextImpl(n);
}

export const applyIdmlText = applyText;

export function getShapeColor(n: Node): Rgb | null {
  if (!n.idml || n.kind !== 'shape') return null;
  if (n.src.vectorFill && n.src.vectorFill.type === 'color') {
    return n.src.vectorFill.color as unknown as Rgb;
  }
  if (n.idml.fillColor) {
    return hexToRgb(n.idml.fillColor);
  }
  return null;
}

export const getIdmlShapeColor = getShapeColor;

function idmlShapeLineWidthPx(n: Node, pixW: number): number {
  const lb = n.idml?.localBounds;
  const weight = n.idml?.strokeWeight ?? 1;
  if (!lb) return Math.max(1, weight);
  const localW = Math.max(1e-6, lb.maxX - lb.minX);
  return Math.max(1, (weight / localW) * pixW);
}

export function repaintIdmlShapeCanvas(n: Node): void {
  if (!n.canvas || !n.idml || n.kind !== 'shape') return;
  const ctx = n.canvas.getContext('2d');
  if (!ctx) return;
  const pixW = n.canvas.width;
  const pixH = n.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixW, pixH);

  const fillHex = n.idml.fillColor ?? (n.src.vectorFill?.type === 'color' ? rgbToHex(n.src.vectorFill.color as Rgb) : null);
  const lb = n.idml.localBounds;
  const pts = n.idml.pathPoints;
  const open = n.idml.pathOpen ?? false;

  if (fillHex) {
    ctx.fillStyle = fillHex;
    if (pts?.length && lb) {
      plotPathInItemLocalCanvas(ctx, pts, open, lb, pixW, pixH);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, pixW, pixH);
    }
  }

  if (n.idml.strokeEnabled && n.idml.strokeColor && pts?.length && lb) {
    ctx.strokeStyle = n.idml.strokeColor;
    ctx.lineWidth = idmlShapeLineWidthPx(n, pixW);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    plotPathInItemLocalCanvas(ctx, pts, open, lb, pixW, pixH);
    ctx.stroke();
  }

  n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
}

export function getIdmlShapeBorderInfo(n: Node): ShapeBorderInfo | null {
  if (!n.idml || n.kind !== 'shape') return null;
  const ref = n.idml.importStrokeSwatchRef ?? n.idml.strokeSwatchRef;
  if (ref && ref !== 'n' && !n.idml.strokeColor && !n.idml.exportStrokeDirty) {
    return null;
  }
  const color = n.idml.strokeColor ? hexToRgb(n.idml.strokeColor) : { r: 30, g: 30, b: 30 };
  return {
    enabled: Boolean(n.idml.strokeEnabled),
    width: Math.max(1, Math.round(n.idml.strokeWeight ?? 1)),
    color,
  };
}

export function shapeBorderBlockReason(n: Node): string | null {
  if (!n.idml || n.kind !== 'shape') return null;
  const ref = n.idml.importStrokeSwatchRef ?? n.idml.strokeSwatchRef;
  if (ref && ref !== 'n' && !n.idml.strokeColor && !n.idml.exportStrokeDirty) {
    return 'Gradient, pattern, and unsupported stroke types cannot be edited yet.';
  }
  return null;
}

export function applyIdmlShapeBorder(
  n: Node,
  patch: { enabled?: boolean; width?: number; color?: Rgb },
): void {
  if (!n.idml || n.kind !== 'shape') return;
  const curr = getIdmlShapeBorderInfo(n) ?? { enabled: false, width: 1, color: { r: 30, g: 30, b: 30 } };
  const enabled = patch.enabled !== undefined ? patch.enabled : curr.enabled;
  const width = patch.width !== undefined ? patch.width : curr.width;
  const color = patch.color ? { ...patch.color } : curr.color;

  if (patch.color) {
    n.idml.strokeColor = rgbToHex(color);
    n.idml.exportStrokeDirty = true;
  }
  if (patch.enabled !== undefined || patch.width !== undefined) {
    n.idml.strokeEnabled = enabled;
    n.idml.strokeWeight = width;
    n.idml.exportStrokeSettingsDirty = true;
    if (enabled && !n.idml.strokeColor) {
      n.idml.strokeColor = rgbToHex(color);
      n.idml.exportStrokeDirty = true;
    }
  }

  n.src.vectorStroke = {
    strokeEnabled: enabled,
    lineWidth: { value: width, units: 'Pixels' },
    content: { type: 'color', color: { ...color } },
    fillEnabled: true,
  };

  repaintIdmlShapeCanvas(n);
}

export function applyShapeColor(n: Node, c: Rgb): void {
  if (!n.idml || n.kind !== 'shape') return;
  const hex = rgbToHex(c);
  n.idml.fillColor = hex;
  n.idml.exportFillDirty = true;
  n.src.vectorFill = { type: 'color', color: { ...c } };
  repaintIdmlShapeCanvas(n);
}

export const applyIdmlShapeColor = applyShapeColor;

export function serializeIdmlState(n: Node): SavedLayerState {
  return {
    text: n.src?.text ? { text: n.src.text.text, style: n.src.text.style } : undefined,
    vectorFill: n.src?.vectorFill,
    vectorStroke: n.src?.vectorStroke,
    adjustment: undefined,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    rotation: n.rotation,
    ox: n.ox,
    oy: n.oy,
    ow: n.ow,
    oh: n.oh,
    textTransform: n.textTransform,
    textEdited: n.textEdited,
    previewContentEpoch: n.previewContentEpoch,
  };
}

export function applyIdmlState(n: Node, s: SavedLayerState): void {
  n.x = s.x;
  n.y = s.y;
  n.w = s.w;
  n.h = s.h;
  n.rotation = s.rotation ?? 0;
  n.ox = s.ox;
  n.oy = s.oy;
  n.ow = s.ow;
  n.oh = s.oh;
  n.textEdited = s.textEdited;
  if (s.text && n.src?.text) {
    n.src.text.text = s.text.text;
    n.src.text.style = s.text.style;
    applyText(n, { text: s.text.text });
  }
  if (s.vectorFill && s.vectorFill.type === 'color') {
    applyShapeColor(n, s.vectorFill.color as unknown as Rgb);
  }
  if (s.vectorStroke && n.idml) {
    const vs = s.vectorStroke as {
      strokeEnabled?: boolean;
      lineWidth?: { value?: number };
      content?: { type?: string; color?: Rgb };
    };
    applyIdmlShapeBorder(n, {
      enabled: vs.strokeEnabled,
      width: typeof vs.lineWidth?.value === 'number' ? vs.lineWidth.value : undefined,
      color: vs.content?.type === 'color' ? vs.content.color : undefined,
    });
  }
}

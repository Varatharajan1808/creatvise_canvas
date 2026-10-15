import type { Node, Doc } from './model';
import { leaves } from './model';
import type { TextInfo, Rgb, SavedLayerState } from './edit';
import { hexToRgb, rgbToHex } from './edit';

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
  const fontSize = t?.style?.fontSize ?? 14;
  const col = t?.style?.fillColor
    ? { r: (t.style.fillColor as any).r ?? 0, g: (t.style.fillColor as any).g ?? 0, b: (t.style.fillColor as any).b ?? 0 }
    : n.idml.fillColor
      ? hexToRgb(n.idml.fillColor)
      : { r: 30, g: 30, b: 30 };

  return {
    text: textStr,
    fontSize,
    color: col,
    fontFamily: t?.style?.font?.name ?? 'sans-serif',
    bold: false,
    italic: false,
    alignment: 'left',
  };
}

export const getIdmlTextInfo = getTextInfo;

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

  n.textEdited = true;

  if (n.canvas) {
    const ctx = n.canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, n.canvas.width, n.canvas.height);
      const fs = patch.fontSize ?? t.style?.fontSize ?? 14;
      ctx.font = `${patch.italic ? 'italic ' : ''}${patch.bold ? 'bold ' : ''}${fs}px ${patch.fontFamily ?? 'sans-serif'}`;
      const c = patch.color ? rgbToHex(patch.color) : n.idml.fillColor || '#222222';
      ctx.fillStyle = c;
      ctx.textBaseline = 'top';
      const lines = (t.text || '').split(/\r?\n/);
      let curY = 0;
      for (const line of lines) {
        ctx.fillText(line, 4, curY + 2);
        curY += fs * 1.25;
      }
    }
  }
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

export function applyShapeColor(n: Node, c: Rgb): void {
  if (!n.idml || n.kind !== 'shape') return;
  n.idml.fillColor = rgbToHex(c);
  n.src.vectorFill = { type: 'color', color: { ...c } };

  if (n.canvas) {
    const ctx = n.canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = rgbToHex(c);
      ctx.fillRect(0, 0, n.canvas.width, n.canvas.height);
      ctx.restore();
    }
  }
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
}

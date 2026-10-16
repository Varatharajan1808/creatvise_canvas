import type { Node, Doc } from '../core/model';
import { leaves } from '../core/model';
import type { TextInfo, Rgb, SavedLayerState, ShapeBorderInfo } from '../operations/edit';
import { hexToRgb, rgbToHex, toRgb } from '../operations/edit';
import { rasterizeIdmlTextNode as rasterizeIdmlTextImpl } from './rasterText';
import { plotPathInItemLocalCanvas } from './idml';
import { renderPlacedImagePreview } from './placedImage';
import type { IdmlSavedLayerState, IdmlLinkImageFormat } from './types';
import {
  canvasAlignmentToIdmlJustification,
  idmlJustificationToCanvasAlignment,
} from './storyExport';

export type { IdmlSavedLayerState };

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
  const pi = n.idml?.placedImage;
  return {
    text: n.src?.text
      ? {
          text: n.src.text.text,
          style: n.src.text.style ? { ...n.src.text.style } : undefined,
        }
      : undefined,
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
    textTransform: n.textTransform ? [...n.textTransform] : undefined,
    textEdited: n.textEdited,
    previewContentEpoch: n.previewContentEpoch,
    idml: n.idml
      ? {
          fillColor: n.idml.fillColor,
          exportFillDirty: n.idml.exportFillDirty,
          strokeColor: n.idml.strokeColor,
          strokeSwatchRef: n.idml.strokeSwatchRef,
          strokeWeight: n.idml.strokeWeight,
          strokeEnabled: n.idml.strokeEnabled,
          exportStrokeDirty: n.idml.exportStrokeDirty,
          exportStrokeSettingsDirty: n.idml.exportStrokeSettingsDirty,
          storyJustification: n.idml.storyJustification,
          exportRotation: n.idml.exportRotation,
          placedImage: pi?.replacementBytes
            ? {
                replacementBytes: pi.replacementBytes,
                replacementFormat: pi.replacementFormat,
                exportLinkDirty: pi.exportLinkDirty,
                pendingPackagePath: pi.pendingPackagePath,
                pendingLinkResourceUri: pi.pendingLinkResourceUri,
                exportLinkUriDirty: pi.exportLinkUriDirty,
                missingLink: pi.missingLink,
              }
            : undefined,
        }
      : undefined,
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

  if (n.idml && s.idml) {
    if (s.idml.fillColor !== undefined) n.idml.fillColor = s.idml.fillColor;
    if (s.idml.exportFillDirty !== undefined) n.idml.exportFillDirty = s.idml.exportFillDirty;
    if (s.idml.strokeColor !== undefined) n.idml.strokeColor = s.idml.strokeColor;
    if (s.idml.strokeSwatchRef !== undefined) n.idml.strokeSwatchRef = s.idml.strokeSwatchRef;
    if (s.idml.strokeWeight !== undefined) n.idml.strokeWeight = s.idml.strokeWeight;
    if (s.idml.strokeEnabled !== undefined) n.idml.strokeEnabled = s.idml.strokeEnabled;
    if (s.idml.exportStrokeDirty !== undefined) n.idml.exportStrokeDirty = s.idml.exportStrokeDirty;
    if (s.idml.exportStrokeSettingsDirty !== undefined) {
      n.idml.exportStrokeSettingsDirty = s.idml.exportStrokeSettingsDirty;
    }
    if (s.idml.storyJustification !== undefined) n.idml.storyJustification = s.idml.storyJustification;
    if (s.idml.exportRotation !== undefined) n.idml.exportRotation = s.idml.exportRotation;

    if (n.idml.placedImage && s.idml.placedImage) {
      const spi = s.idml.placedImage;
      const pi = n.idml.placedImage;
      if (spi.replacementBytes) {
        pi.replacementBytes = spi.replacementBytes;
        pi.replacementFormat = spi.replacementFormat;
        pi.exportLinkDirty = spi.exportLinkDirty ?? true;
        pi.pendingPackagePath = spi.pendingPackagePath;
        pi.pendingLinkResourceUri = spi.pendingLinkResourceUri;
        pi.exportLinkUriDirty = spi.exportLinkUriDirty;
        pi.missingLink = spi.missingLink ?? false;
      }
    }
  }

  if (s.text && n.src?.text) {
    n.src.text.text = s.text.text;
    if (s.text.style) n.src.text.style = { ...s.text.style };
    const patch: Parameters<typeof applyText>[1] = { text: s.text.text };
    if (s.text.style) {
      if (s.text.style.fontSize) patch.fontSize = s.text.style.fontSize;
      if (s.text.style.font?.name) patch.fontFamily = s.text.style.font.name;
      if (s.text.style.fauxBold !== undefined) patch.bold = s.text.style.fauxBold;
      if (s.text.style.fauxItalic !== undefined) patch.italic = s.text.style.fauxItalic;
      if (s.text.style.fillColor) {
        const rgb = toRgb(s.text.style.fillColor);
        if (rgb) patch.color = rgb;
      }
    }
    if (s.idml?.storyJustification) {
      patch.alignment = idmlJustificationToCanvasAlignment(s.idml.storyJustification);
    }
    applyText(n, patch);
    n.textEdited = s.textEdited;
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

  if (n.idml?.placedImage?.replacementBytes && n.kind === 'raster') {
    void renderPlacedImagePreview(n, n.idml.placedImage.replacementBytes);
  }
}

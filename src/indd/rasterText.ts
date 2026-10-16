import type { Node } from '../core/model';
import { layoutIdmlTextLines } from './textLayout';

function rgbToHex(c: { r: number; g: number; b: number }): string {
  return (
    '#' +
    [c.r, c.g, c.b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function canvasFontFamily(name: string | undefined): string {
  const base = (name ?? 'sans-serif').trim() || 'sans-serif';
  if (/^(sans-serif|serif|monospace|Arial|Helvetica)$/i.test(base)) return base;
  return `"${base.replace(/"/g, '')}", sans-serif`;
}

/** IDML points map 1:1 to doc units; match device DPR for sharp GPU sampling (cap for memory). */
export function idmlTextRasterScale(): number {
  const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  return Math.max(1, Math.min(3, dpr));
}

function syncTextCanvasPixelSize(n: Node, scale: number): void {
  if (!n.canvas) return;
  const pixW = Math.max(1, Math.round(n.w * scale));
  const pixH = Math.max(1, Math.round(n.h * scale));
  if (n.canvas.width !== pixW || n.canvas.height !== pixH) {
    n.canvas.width = pixW;
    n.canvas.height = pixH;
  }
}

/** Paint IDML story text onto the layer canvas (import + edits). Layout is in local frame space. */
export function rasterizeIdmlTextNode(n: Node): void {
  if (!n.idml || n.kind !== 'text' || !n.canvas) return;
  const scale = idmlTextRasterScale();
  syncTextCanvasPixelSize(n, scale);
  const ctx = n.canvas.getContext('2d');
  if (!ctx) return;

  const docW = n.w;
  const docH = n.h;
  if (docW <= 0 || docH <= 0) return;

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, docW, docH);
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = false;

  const frameFill = n.idml.frameFillColor;
  if (frameFill) {
    ctx.fillStyle = frameFill;
    ctx.fillRect(0, 0, docW, docH);
  }

  const t = n.src?.text;
  const textStr = t?.text ?? n.name;
  if (!textStr?.trim()) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
    return;
  }

  const fontSizePt = Math.max(1, t?.style?.fontSize ?? 12);
  const fontFamily = canvasFontFamily(t?.style?.font?.name);
  const fill = t?.style?.fillColor as { r?: number; g?: number; b?: number } | undefined;
  const color = fill
    ? { r: fill.r ?? 30, g: fill.g ?? 30, b: fill.b ?? 30 }
    : { r: 30, g: 30, b: 30 };
  const bold = Boolean(t?.style?.fauxBold);
  const italic = Boolean(t?.style?.fauxItalic);

  const layout = n.idml.textFrameLayout;
  const layoutW = layout?.columnWidth ?? n.idml.localFrameW ?? docW;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, docW, docH);
  ctx.clip();

  ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSizePt}px ${fontFamily}`;
  ctx.fillStyle = rgbToHex(color);
  ctx.textBaseline = 'top';
  ctx.globalAlpha = typeof n.opacity === 'number' ? n.opacity : 1;

  const lines = layoutIdmlTextLines(ctx, textStr, {
    maxWidth: Math.min(docW, layoutW),
    maxHeight: docH,
    fontSizePt,
    leadingPt: n.idml.storyLeading,
    tracking: n.idml.storyTracking,
    insetTop: layout?.insetTop,
    insetLeft: layout?.insetLeft,
    insetBottom: layout?.insetBottom,
    insetRight: layout?.insetRight,
    justification: n.idml.storyJustification,
  });

  for (const line of lines) {
    ctx.textAlign = 'left';
    ctx.fillText(line.text, line.x, line.y);
  }

  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
}

/** Re-rasterize every IDML text leaf (call after import when document/canvas is live). */
export function rasterizeAllIdmlTextNodes(doc: { roots: Node[] }): void {
  const stack = [...doc.roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.children?.length) stack.push(...n.children);
    if (n.kind === 'text' && n.idml) rasterizeIdmlTextNode(n);
  }
}

export function countTextGlyphPixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 10 && data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) count++;
  }
  return count;
}

/** Count pixels with visible alpha (any text color). */
export function countVisibleTextPixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 20) count++;
  }
  return count;
}

/** Mean row index of dark glyph pixels (0 = top). Used to detect upside-down GPU upload. */
export function textGlyphCentroidRow(canvas: HTMLCanvasElement): number | null {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.height <= 0) return null;
  const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 10 && data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) {
        sum += y;
        count++;
      }
    }
  }
  if (count === 0) return null;
  return sum / count;
}

export function textGlyphsUprightInCanvas(canvas: HTMLCanvasElement): boolean {
  const cy = textGlyphCentroidRow(canvas);
  if (cy === null) return false;
  return cy < canvas.height * 0.55;
}

/** Count non-empty laid-out lines after raster (for tests). */
export function countRasterizedTextLines(canvas: HTMLCanvasElement, minRowDensity = 8): number {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.height <= 0) return 0;
  const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lines = 0;
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 20) row++;
    }
    if (row >= minRowDensity) {
      lines++;
      while (y + 1 < height) {
        let next = 0;
        for (let x = 0; x < width; x++) {
          const i = ((y + 1) * width + x) * 4;
          if (data[i + 3] > 20) next++;
        }
        if (next < minRowDensity) break;
        y++;
      }
    }
  }
  return lines;
}

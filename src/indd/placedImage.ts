/** IDML placed (linked) images: frame vs link asset, preview, replace, export. */

import type JSZip from 'jszip';
import type { Node } from '../core/model';
import { matrix6ToString, parseMatrix6, type Matrix2D } from './matrix';
import type { IdmlLinkImageFormat, IdmlPlacedImageMeta } from './types';
import {
  encodeCanvasToFormat,
  formatFromPackagePath,
  linkUriFromPackagePath,
  packagePathForFormat,
  resolveReplacementFormat,
  sniffImageFormat,
} from './linkImageFormat';

function childByLocal(el: Element, localName: string): Element | null {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.localName === localName || c.nodeName.endsWith(`:${localName}`)) return c;
  }
  return null;
}

function elementsLocalCI(root: Element, localName: string): Element[] {
  const out: Element[] = [];
  const target = localName.toLowerCase();
  function walk(el: Element) {
    if (el.localName?.toLowerCase() === target || el.nodeName?.toLowerCase().endsWith(`:${target}`)) {
      out.push(el);
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
  }
  walk(root);
  return out;
}

function parseGraphicBounds(props: Element): IdmlPlacedImageMeta['graphicBounds'] | undefined {
  const gbEl = childByLocal(props, 'GraphicBounds') ?? elementsLocalCI(props, 'GraphicBounds')[0];
  if (!gbEl) return undefined;
  const left = Number(gbEl.getAttribute('Left') ?? gbEl.getAttribute('left'));
  const top = Number(gbEl.getAttribute('Top') ?? gbEl.getAttribute('top'));
  const right = Number(gbEl.getAttribute('Right') ?? gbEl.getAttribute('right'));
  const bottom = Number(gbEl.getAttribute('Bottom') ?? gbEl.getAttribute('bottom'));
  if (![left, top, right, bottom].every((n) => Number.isFinite(n))) return undefined;
  return { left, top, right, bottom };
}

export function linkUriToPackagePath(uri: string | null | undefined): string | null {
  if (!uri) return null;
  let s = uri.trim();
  if (s.startsWith('file://')) s = s.slice(7);
  else if (s.startsWith('file:')) s = s.slice(5);
  s = s.replace(/^\/+/, '');
  if (s.startsWith('Links/')) return s;
  const idx = s.indexOf('Links/');
  if (idx >= 0) return s.slice(idx);
  return null;
}

export function parsePlacedImageFromFrame(frameEl: Element): Omit<
  IdmlPlacedImageMeta,
  'importBytesLength' | 'missingLink'
> | null {
  const imageEl =
    childByLocal(frameEl, 'Image') ??
    elementsLocalCI(frameEl, 'Image').find((el) => el.parentElement === frameEl) ??
    elementsLocalCI(frameEl, 'Image')[0];
  if (!imageEl) return null;

  const imageSelf = imageEl.getAttribute('Self') || 'image';
  const imageItemTransformStr = imageEl.getAttribute('ItemTransform');
  const imageItemTransform = imageItemTransformStr ? [...parseMatrix6(imageItemTransformStr)] : undefined;

  const props = childByLocal(imageEl, 'Properties') ?? imageEl;
  const linkEl = childByLocal(props, 'Link') ?? elementsLocalCI(props, 'Link')[0];
  const linkResourceUri = linkEl?.getAttribute('LinkResourceURI') ?? '';
  const packagePath = linkUriToPackagePath(linkResourceUri);
  if (!packagePath) return null;

  const contentType = frameEl.getAttribute('ContentType') ?? undefined;
  const graphicBounds = parseGraphicBounds(props);
  const fitContentToFrame = imageEl.getAttribute('FitContentToFrame') ?? undefined;
  const fittingOnEmptyFrame = imageEl.getAttribute('FittingOnEmptyFrame') ?? undefined;

  return {
    frameSelf: frameEl.getAttribute('Self') || 'frame',
    imageSelf,
    linkResourceUri,
    packagePath,
    imageItemTransform,
    graphicBounds,
    fitContentToFrame,
    fittingOnEmptyFrame,
    contentType,
  };
}

export function drawPlacedImagePlaceholder(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  message: string,
): void {
  g.fillStyle = '#e8e8ec';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#9090a0';
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  g.fillStyle = '#505060';
  g.font = '12px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(message, w / 2, h / 2, Math.max(10, w - 8));
}

/**
 * Draw using nested `<Image ItemTransform>` + optional `GraphicBounds` crop metadata.
 * `FitContentToFrame` / `FittingOnEmptyFrame` are preserved in XML on export; preview uses
 * ItemTransform + GraphicBounds (not CSS cover). Exotic fitting (ContentAwareFit, etc.) is
 * not recomputed in Canvas — original attributes stay in the spread unless the frame is resized.
 */
export function drawPlacedImageWithMetadata(
  g: CanvasRenderingContext2D,
  image: CanvasImageSource,
  fw: number,
  fh: number,
  pi: IdmlPlacedImageMeta,
  localBounds: { minX: number; minY: number; maxX: number; maxY: number },
): void {
  const iw = 'width' in image ? (image as { width: number }).width : 0;
  const ih = 'height' in image ? (image as { height: number }).height : 0;
  if (iw <= 0 || ih <= 0) return;

  const localW = Math.max(1e-6, localBounds.maxX - localBounds.minX);
  const localH = Math.max(1e-6, localBounds.maxY - localBounds.minY);
  const pxScale = fw / localW;

  const gb = pi.graphicBounds;
  const srcL = gb?.left ?? 0;
  const srcT = gb?.top ?? 0;
  const srcR = gb?.right ?? iw;
  const srcB = gb?.bottom ?? ih;
  const srcW = Math.max(1e-6, srcR - srcL);
  const srcH = Math.max(1e-6, srcB - srcT);

  const m = pi.imageItemTransform ?? [1, 0, 0, 1, 0, 0];

  g.save();
  g.scale(pxScale, pxScale);
  g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  g.drawImage(image, srcL, srcT, srcW, srcH, 0, 0, srcW, srcH);
  g.restore();
}

type ImageDecodeHook = (bytes: Uint8Array, mimeHint?: string) => Promise<CanvasImageSource | null>;
let testImageDecodeHook: ImageDecodeHook | null = null;

/** Node tests only — avoids bundling `@napi-rs/canvas` in the browser build. */
export function setPlacedImageDecodeHookForTests(hook: ImageDecodeHook | null): void {
  testImageDecodeHook = hook;
}

function mimeFromFormat(format: IdmlLinkImageFormat): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

async function loadImageFromBytes(bytes: Uint8Array, format?: IdmlLinkImageFormat): Promise<CanvasImageSource | null> {
  const mime = mimeFromFormat(format ?? sniffImageFormat(bytes));
  if (testImageDecodeHook) return testImageDecodeHook(bytes, mime);
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof Image === 'undefined') {
    return null;
  }
  return await new Promise((resolve) => {
    const blob = new Blob([Uint8Array.from(bytes)], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export async function renderPlacedImagePreview(
  n: Node,
  linkBytes: Uint8Array | undefined,
): Promise<void> {
  if (!n.canvas || !n.idml?.placedImage) return;
  const g = n.canvas.getContext('2d');
  if (!g) return;
  const w = n.canvas.width;
  const h = n.canvas.height;
  g.clearRect(0, 0, w, h);

  const pi = n.idml.placedImage;
  if (!linkBytes?.length || pi.missingLink) {
    pi.missingLink = !linkBytes?.length;
    drawPlacedImagePlaceholder(g, w, h, pi.missingLink ? 'Missing link' : 'No image');
    n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
    return;
  }

  pi.linkMediaFormat = sniffImageFormat(linkBytes);
  const img = await loadImageFromBytes(linkBytes, pi.linkMediaFormat);
  if (!img) {
    pi.missingLink = true;
    drawPlacedImagePlaceholder(g, w, h, 'Unsupported image');
    n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
    return;
  }
  pi.missingLink = false;
  const lb = n.idml.localBounds ?? { minX: 0, minY: 0, maxX: w, maxY: h };
  drawPlacedImageWithMetadata(g, img, w, h, pi, lb);
  n.previewContentEpoch = (n.previewContentEpoch ?? 0) + 1;
}

export async function hydrateIdmlPlacedImagePreviews(
  nodes: Node[],
  linkAssets: Map<string, Uint8Array>,
): Promise<void> {
  for (const n of nodes) {
    const pi = n.idml?.placedImage;
    if (!pi) continue;
    const bytes = linkAssets.get(pi.packagePath);
    if (bytes) {
      pi.importBytesLength = bytes.length;
      pi.linkMediaFormat = sniffImageFormat(bytes);
    }
    if (pi.imageItemTransform) {
      pi.importImageItemTransform = [...pi.imageItemTransform];
    }
    pi.importFrameOw = n.ow;
    pi.importFrameOh = n.oh;
    await renderPlacedImagePreview(n, bytes);
  }
}

export function canReplaceIdmlPlacedImage(n: Node): boolean {
  return n.kind === 'raster' && Boolean(n.idml?.placedImage);
}

export async function applyIdmlPlacedImageReplace(
  n: Node,
  previewCanvas: HTMLCanvasElement,
  opts?: { sourceMime?: string },
): Promise<void> {
  const pi = n.idml?.placedImage;
  if (!pi) return;

  const targetFormat = resolveReplacementFormat(pi.packagePath, pi.linkMediaFormat, opts?.sourceMime);
  if (targetFormat === 'gif' || targetFormat === 'webp') {
    throw new Error(`Replacing IDML links as ${targetFormat.toUpperCase()} is not supported in the browser.`);
  }

  const encoded = await encodeCanvasToFormat(previewCanvas, targetFormat);
  const encodedFormat = sniffImageFormat(encoded);
  const pathFormat = formatFromPackagePath(pi.packagePath);

  n.canvas = previewCanvas;
  n.src.canvas = previewCanvas;

  pi.replacementBytes = encoded;
  pi.replacementFormat = encodedFormat;
  pi.exportLinkDirty = true;
  pi.missingLink = false;

  if (pathFormat !== 'unknown' && encodedFormat !== 'unknown' && pathFormat !== encodedFormat) {
    const base = pi.packagePath.split('/').pop() ?? 'link';
    pi.pendingPackagePath = packagePathForFormat(base.replace(/\.[^.]+$/, ''), encodedFormat);
    pi.pendingLinkResourceUri = linkUriFromPackagePath(pi.pendingPackagePath);
    pi.exportLinkUriDirty = true;
  } else {
    pi.pendingPackagePath = undefined;
    pi.pendingLinkResourceUri = undefined;
    pi.exportLinkUriDirty = false;
  }
}

export function scaleImageTransformForFrameResize(
  baseM: number[],
  sx: number,
  sy: number,
  fitMode?: string,
): number[] {
  const proportional =
    !fitMode ||
    /Proportional|CenterContent|ContentAwareFit|FillProportionally/i.test(fitMode);
  const ux = proportional ? Math.min(sx, sy) : sx;
  const uy = proportional ? Math.min(sx, sy) : sy;
  return [
    baseM[0] * ux,
    baseM[1] * ux,
    baseM[2] * uy,
    baseM[3] * uy,
    baseM[4] * sx,
    baseM[5] * sy,
  ];
}

export function placedImageTransformDirty(node: Node): boolean {
  const pi = node.idml?.placedImage;
  if (!pi?.importImageItemTransform) return false;
  return Math.abs(node.w - node.ow) > 1e-3 || Math.abs(node.h - node.oh) > 1e-3;
}

export function exportImageItemTransformForPlacedFrame(node: Node): Matrix2D | null {
  const pi = node.idml?.placedImage;
  if (!pi?.importImageItemTransform || pi.importFrameOw === undefined || pi.importFrameOh === undefined) {
    return pi?.imageItemTransform ? (parseMatrix6(pi.imageItemTransform.join(' ')) as Matrix2D) : null;
  }
  const sx = node.w / pi.importFrameOw;
  const sy = node.h / pi.importFrameOh;
  const fit = pi.fitContentToFrame ?? pi.fittingOnEmptyFrame;
  return scaleImageTransformForFrameResize(pi.importImageItemTransform, sx, sy, fit) as Matrix2D;
}

export function commitPlacedImageTransformBaselines(node: Node): void {
  const pi = node.idml?.placedImage;
  if (!pi) return;
  const next = pi.imageItemTransform;
  if (next) pi.importImageItemTransform = [...next];
  pi.importFrameOw = node.w;
  pi.importFrameOh = node.h;
}

export function syncIdmlPlacedImageExportBytes(nodes: Node[], zip: JSZip): void {
  const pathOwners = new Map<string, string>();
  for (const n of nodes) {
    const p = n.idml?.placedImage?.packagePath;
    if (p) pathOwners.set(p, n.idml!.placedImage!.frameSelf);
  }

  for (const n of nodes) {
    const pi = n.idml?.placedImage;
    if (!pi?.exportLinkDirty || !pi.replacementBytes?.length) continue;

    const writePath = pi.pendingPackagePath ?? pi.packagePath;
    zip.file(writePath, pi.replacementBytes, { createFolders: false });

    if (pi.pendingPackagePath && pi.pendingPackagePath !== pi.packagePath) {
      const oldPath = pi.packagePath;
      const stillUsed = [...pathOwners.entries()].some(
        ([path, self]) => path === oldPath && self !== pi.frameSelf,
      );
      if (!stillUsed && zip.file(oldPath)) {
        zip.remove(oldPath);
      }
      pi.packagePath = pi.pendingPackagePath;
      if (pi.pendingLinkResourceUri) pi.linkResourceUri = pi.pendingLinkResourceUri;
    }

    pi.exportLinkDirty = false;
    pi.importBytesLength = pi.replacementBytes.length;
    pi.linkMediaFormat = pi.replacementFormat ?? sniffImageFormat(pi.replacementBytes);
    pi.replacementBytes = undefined;
    pi.replacementFormat = undefined;
    pi.pendingPackagePath = undefined;
    pi.pendingLinkResourceUri = undefined;
  }
}

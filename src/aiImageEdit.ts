import type { Doc, Node } from './model';
import { walk } from './model';
import { asAiLayerStub, resolveAiMcIndex } from './aiLayerMeta';
import {
  clonePlacedImageRun,
  decodeSupportedImageXObjectBytes,
  docBoundsForPlacedImage,
  parseAiPlacedImagesFromOriginal,
  rgbBytesToCanvas,
  supportedPlacedImageRuns,
  supportedPlacedImagesOnNode,
  type AiPlacedImageRun,
} from './aiPdfImages';

function copyCanvas(src: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!src) return null;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

export function canReplaceAiPlacedImageOnNode(n: Node): boolean {
  if (n.kind !== 'raster') return false;
  const stub = asAiLayerStub(n.src);
  if (stub.aiLiveTextRuns?.some((r) => r.supported)) return false;
  if (stub.aiPlacedImageUnsupported) return false;
  return supportedPlacedImagesOnNode(n).length > 0;
}

/** Explain why this AI raster layer cannot use Replace Image (null when replace is allowed). */
export function getAiPlacedImageReplaceBlockedReason(doc: Doc, n: Node): string {
  if (doc.format !== 'ai') {
    return 'Replace image is only supported for .ai documents in this build.';
  }
  if (n.kind !== 'raster') {
    return 'Replace image applies to raster preview layers only.';
  }
  const stub = asAiLayerStub(n.src);
  if (stub.aiLiveTextRuns?.some((r) => r.supported)) {
    return 'This layer has editable live PDF text; embedded image replace is not available on the same layer.';
  }
  if (stub.aiPlacedImageUnsupported) {
    return stub.aiPlacedImageUnsupported;
  }
  const unsupported = stub.aiPlacedImages?.find((r) => !r.supported);
  if (unsupported?.unsupportedReason) {
    return unsupported.unsupportedReason;
  }
  if (!stub.aiPlacedImages?.length) {
    return 'This .ai preview layer has no single supported embedded PDF image to replace (whole-layer swap is not supported).';
  }
  return 'Embedded image on this layer cannot be replaced with the current PDF configuration.';
}

/** Rebuild `n.canvas` from the import raster and any preview image replacements. */
export function compositeAiPlacedImageLayerPreview(n: Node): void {
  const base = n.aiImportRasterCanvas ?? n.canvas;
  if (!base) return;
  const runs = supportedPlacedImagesOnNode(n);
  if (!runs.length) return;

  const out = copyCanvas(base);
  if (!out) return;
  const g = out.getContext('2d')!;

  for (const run of runs) {
    const b = run.importBounds;
    if (!b) continue;
    const lx = b.docX - n.x;
    const ly = b.docY - n.y;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0,0,0,1)';
    g.fillRect(lx, ly, b.docW, b.docH);
    g.restore();

    const rep = run.edit?.replacementCanvas;
    if (rep) {
      g.drawImage(rep, 0, 0, rep.width, rep.height, lx, ly, b.docW, b.docH);
    }
  }

  n.canvas = out;
}

async function hydrateImportImagePayload(doc: Doc, n: Node, run: AiPlacedImageRun): Promise<void> {
  if (!doc.original?.byteLength) return;
  const bytes = await decodeSupportedImageXObjectBytes(doc.original, run);
  if (!bytes) return;
  run.importImageBytes = bytes;
  run.importImageCanvas = rgbBytesToCanvas(run.width, run.height, bytes);
}

/** After import: snapshot layer raster, doc bounds, and original XObject RGB bytes. */
export async function prepareAiPlacedImageEditing(
  doc: Doc,
  n: Node,
  pageHeight = doc.height,
): Promise<void> {
  const runs = supportedPlacedImagesOnNode(n);
  if (!runs.length || !n.canvas) return;

  if (!n.aiImportRasterCanvas) {
    n.aiImportRasterCanvas = copyCanvas(n.canvas);
  }

  for (const run of runs) {
    run.importBounds = docBoundsForPlacedImage(run, pageHeight);
    await hydrateImportImagePayload(doc, n, run);
  }

  replacePlacedImagePreviewNote(n);
}

function replacePlacedImagePreviewNote(n: Node): void {
  const runs = supportedPlacedImagesOnNode(n).length;
  if (!runs) return;
  const note =
    `${runs} embedded PDF image(s): canvas preview replaces detected image pixels; supported replacements export to the PDF XObject stream.`;
  if (!n.unsupported.includes(note)) n.unsupported.push(note);
}

/**
 * Replace the supported embedded image in the canvas preview only.
 * Layer geometry and opacity are unchanged; import patch tokens and XObject bytes stay on the run.
 */
export function applyAiPlacedImagePreviewReplace(n: Node, newCanvas: HTMLCanvasElement): void {
  if (!canReplaceAiPlacedImageOnNode(n) || !n.aiImportRasterCanvas) {
    throw new Error('This layer does not have a supported embedded PDF image to replace.');
  }

  const runs = supportedPlacedImagesOnNode(n);
  const run = runs[0];
  if (!run) return;

  const c = document.createElement('canvas');
  c.width = newCanvas.width;
  c.height = newCanvas.height;
  c.getContext('2d')!.drawImage(newCanvas, 0, 0);

  run.edit = { ...(run.edit ?? {}), replacementCanvas: c };
  n.aiImageEdited = true;
  compositeAiPlacedImageLayerPreview(n);
}

export interface AiImageUndoState {
  runs: AiPlacedImageRun[];
  aiImageEdited?: boolean;
  canvas: HTMLCanvasElement | null;
  aiImportRasterCanvas: HTMLCanvasElement | null;
}

export function captureAiImageState(n: Node): AiImageUndoState | undefined {
  if (!canReplaceAiPlacedImageOnNode(n) && !n.aiImageEdited) return undefined;
  const stub = asAiLayerStub(n.src);
  return {
    runs: (stub.aiPlacedImages ?? []).map(clonePlacedImageRun),
    aiImageEdited: n.aiImageEdited,
    canvas: n.canvas,
    aiImportRasterCanvas: n.aiImportRasterCanvas ?? null,
  };
}

export function restoreAiImageState(n: Node, s: AiImageUndoState): void {
  const stub = asAiLayerStub(n.src);
  stub.aiPlacedImages = s.runs.map(clonePlacedImageRun);
  n.aiImageEdited = s.aiImageEdited;
  n.aiImportRasterCanvas = s.aiImportRasterCanvas ? copyCanvas(s.aiImportRasterCanvas) : null;
  n.canvas = s.canvas;
}

/**
 * Attach parsed placed-image metadata to AI layer stubs. Does not enable replace UI or PDF export.
 */
export async function applyAiPlacedImageImport(doc: Doc): Promise<void> {
  if (doc.format !== 'ai' || !doc.original?.byteLength) return;

  const parsed = await parseAiPlacedImagesFromOriginal(doc.original);
  if (!parsed) return;

  const imagesByMc = new Map<number, AiPlacedImageRun[]>();
  const mixedByMc = new Map<number, string>();
  const unsupportedByMc = new Map<number, string>();

  for (const block of parsed.blocks) {
    if (block.mixed) {
      mixedByMc.set(block.mcIndex, block.mixedReason ?? 'Mixed marked-content block.');
      continue;
    }
    if (block.images.length === 1 && !block.images[0].supported) {
      unsupportedByMc.set(
        block.mcIndex,
        block.images[0].unsupportedReason ?? 'Embedded image is not supported for replacement.',
      );
      continue;
    }
    const supported = block.images.filter((r) => r.supported);
    if (supported.length) imagesByMc.set(block.mcIndex, supported);
  }

  const supportedCount = supportedPlacedImageRuns(parsed.blocks).length;
  if (supportedCount === 0 && mixedByMc.size === 0 && unsupportedByMc.size === 0) return;

  for (const node of walk(doc.roots)) {
    if (node.kind === 'group') continue;
    const mc = resolveAiMcIndex(node);
    const stub = asAiLayerStub(node.src);

    const mixed = mixedByMc.get(mc);
    if (mixed) {
      stub.aiPlacedImageUnsupported = mixed;
      if (!node.unsupported.includes(mixed)) node.unsupported.push(mixed);
      continue;
    }

    const unsupported = unsupportedByMc.get(mc);
    if (unsupported) {
      stub.aiPlacedImageUnsupported = unsupported;
      if (!node.unsupported.includes(unsupported)) node.unsupported.push(unsupported);
      continue;
    }

    const runs = imagesByMc.get(mc);
    if (!runs?.length) continue;

    stub.aiPlacedImages = runs.map(clonePlacedImageRun);
    await prepareAiPlacedImageEditing(doc, node, parsed.pageHeight);
  }

  if (supportedCount > 0) {
    doc.warnings.push(
      `Detected ${supportedCount} embedded PDF image(s) eligible for canvas preview replacement and PDF XObject export (DeviceRGB FlateDecode only).`,
    );
  }
}

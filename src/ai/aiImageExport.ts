import { PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import type { Doc, Node } from '../core/model';
import { walk } from '../core/model';
import {
  decodeSupportedImageXObjectBytes,
  supportedPlacedImagesOnNode,
  type AiPlacedImageRun,
} from './aiPdfImages';

export class AiImageStreamExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiImageStreamExportError';
  }
}

function parseRefObjectNumber(xobjectRef: string): number | null {
  const m = /^(\d+)\s+\d+\s+R$/.exec(xobjectRef.trim());
  return m ? parseInt(m[1], 10) : null;
}

/** True when at least one supported embedded image has a preview replacement to write into the PDF. */
export function docHasAiImageStreamEdits(doc: Doc): boolean {
  for (const n of walk(doc.roots)) {
    if (!n.aiImageEdited) continue;
    for (const run of supportedPlacedImagesOnNode(n)) {
      if (run.edit?.replacementCanvas) return true;
    }
  }
  return false;
}

function assertRunExportable(run: AiPlacedImageRun, layerName: string): void {
  if (!run.supported) {
    throw new AiImageStreamExportError(
      `Layer "${layerName}": embedded image /${run.xobjectName} is not supported for export (${run.unsupportedReason ?? 'unsupported'}).`,
    );
  }
  if (!run.xobjectRef) {
    throw new AiImageStreamExportError(
      `Layer "${layerName}": missing PDF object reference for image /${run.xobjectName}.`,
    );
  }
  if (run.hasSoftMask) {
    throw new AiImageStreamExportError(
      `Layer "${layerName}": images with soft masks (/SMask) cannot be exported yet.`,
    );
  }
  if (run.colorSpace !== 'DeviceRGB' || run.bitsPerComponent !== 8) {
    throw new AiImageStreamExportError(
      `Layer "${layerName}": only DeviceRGB 8-bit images can be exported (got ${run.colorSpace} ${run.bitsPerComponent}-bit).`,
    );
  }
  if (run.filters.length !== 1 || run.filters[0] !== 'FlateDecode') {
    throw new AiImageStreamExportError(
      `Layer "${layerName}": only FlateDecode-compressed images can be exported.`,
    );
  }
  if (!run.edit?.replacementCanvas) {
    throw new AiImageStreamExportError(
      `Layer "${layerName}": image replacement canvas is missing; re-apply the replacement before export.`,
    );
  }
}

/** Fail fast before writing PDF bytes when any edited image cannot be encoded safely. */
export function validateAiImageExportOrThrow(doc: Doc): void {
  if (!docHasAiImageStreamEdits(doc)) return;
  for (const n of walk(doc.roots)) {
    if (!n.aiImageEdited) continue;
    for (const run of supportedPlacedImagesOnNode(n)) {
      if (!run.edit?.replacementCanvas) continue;
      assertRunExportable(run, n.name);
    }
  }
}

/** Resample replacement pixels to intrinsic XObject width × height (DeviceRGB, unpremultiplied). */
export function canvasToDeviceRgbBytes(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Uint8Array {
  if (width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new AiImageStreamExportError(`Invalid export image size ${width}×${height}.`);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (!g) throw new AiImageStreamExportError('Could not create a canvas for image export encoding.');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, width, height);
  const data = g.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    out[i * 3] = data[i * 4];
    out[i * 3 + 1] = data[i * 4 + 1];
    out[i * 3 + 2] = data[i * 4 + 2];
  }
  return out;
}

function replaceImageXObjectStream(
  pdfDoc: PDFDocument,
  run: AiPlacedImageRun,
  rgbUncompressed: Uint8Array,
): void {
  const objNum = parseRefObjectNumber(run.xobjectRef);
  if (objNum == null) {
    throw new AiImageStreamExportError(`Invalid PDF image object reference "${run.xobjectRef}".`);
  }
  const ref = PDFRef.of(objNum, 0);
  const existing = pdfDoc.context.lookup(ref);
  if (!(existing instanceof PDFStream)) {
    throw new AiImageStreamExportError(
      `PDF image object ${run.xobjectRef} is missing or not a stream.`,
    );
  }

  const expected = run.width * run.height * 3;
  if (rgbUncompressed.length !== expected) {
    throw new AiImageStreamExportError(
      `Encoded image size mismatch for /${run.xobjectName} (expected ${expected} bytes, got ${rgbUncompressed.length}).`,
    );
  }

  const newStream = pdfDoc.context.flateStream(rgbUncompressed);
  const dict = newStream.dict;
  dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
  dict.set(PDFName.of('Width'), PDFNumber.of(run.width));
  dict.set(PDFName.of('Height'), PDFNumber.of(run.height));
  dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.delete(PDFName.of('SMask'));
  dict.delete(PDFName.of('Mask'));

  pdfDoc.context.assign(ref, newStream);
}

/**
 * Replace supported Image XObject streams in `pdfDoc` from preview edits.
 * Does not modify page content streams (`cm`, `Do`) or layer metadata.
 */
export async function patchAiImageXObjectsInPdf(
  pdfDoc: PDFDocument,
  doc: Doc,
): Promise<{ notes: string[]; replaced: number }> {
  const notes: string[] = [];
  let replaced = 0;

  if (!docHasAiImageStreamEdits(doc)) {
    return { notes, replaced };
  }

  validateAiImageExportOrThrow(doc);

  for (const n of walk(doc.roots)) {
    if (!n.aiImageEdited) continue;
    for (const run of supportedPlacedImagesOnNode(n)) {
      const rep = run.edit?.replacementCanvas;
      if (!rep) continue;

      assertRunExportable(run, n.name);
      const rgb = canvasToDeviceRgbBytes(rep, run.width, run.height);
      replaceImageXObjectStream(pdfDoc, run, rgb);
      replaced++;
      notes.push(
        `Layer "${n.name}": wrote ${run.width}×${run.height} DeviceRGB image into PDF XObject ${run.xobjectRef} (/ ${run.xobjectName}).`,
      );
    }
  }

  if (replaced > 0) {
    notes.push(
      `${replaced} embedded PDF image XObject stream(s) updated. Placement operators and marked-content blocks were not modified.`,
    );
  }

  return { notes, replaced };
}

/** After export, verify the XObject stream decodes to non-import bytes when a replacement was applied. */
export async function verifyExportedImageXObjectBytes(
  exported: ArrayBuffer,
  run: AiPlacedImageRun,
  importBytes: Uint8Array,
): Promise<boolean> {
  const decoded = await decodeSupportedImageXObjectBytes(exported, run);
  if (!decoded || decoded.length !== importBytes.length) return false;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] !== importBytes[i]) return true;
  }
  return false;
}

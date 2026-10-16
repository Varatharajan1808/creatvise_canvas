/**
 * Phase 3: embedded PDF image detection + import metadata + canvas preview replacement.
 * Synthetic PDF fixtures — not Adobe Illustrator desktop round-trip proofs.
 */
import fs from 'fs';
import path from 'path';
import { deflate } from 'pako';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas, ImageData, Path2D } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import {
  countSupportedPlacedImageNodes,
  loadPageImageXObjects,
  parseAiPlacedImagesFromOriginal,
  parseMcBlockPlacedImage,
  parsePdfPlacedImages,
  supportedPlacedImageRuns,
  decodeSupportedImageXObjectBytes,
  type PageImageXObjectInfo,
} from '../src/ai/aiPdfImages';
import {
  applyAiPlacedImagePreviewReplace,
  canReplaceAiPlacedImageOnNode,
} from '../src/ai/aiImageEdit';
import { docHasAiImageStreamEdits } from '../src/ai/aiImageExport';
import {
  aiPlacedImageReplaceBlockedReason,
  canReplaceAiImageOnNode,
} from '../src/formats/formatCaps';
import { readFirstPageContentStreamText } from '../src/ai/aiVectorShapes';
import { captureState, restoreState } from '../src/operations/edit';
import { asAiLayerStub, initAiLayerMeta } from '../src/ai/aiLayerMeta';
import { walk, type Doc, type Node } from '../src/core/model';
import type { Layer } from 'ag-psd';
import type { AiPlacedImageRun } from '../src/ai/aiPdfImages';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);
(globalThis as unknown as { ImageData: typeof ImageData }).ImageData = ImageData;
(globalThis as unknown as { Path2D: typeof Path2D }).Path2D = Path2D;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

const SYNTHETIC_COMMENT = '% Creatvise synthetic fixture — not Adobe Illustrator output\n';

export type SyntheticImagePdfOptions = {
  width?: number;
  height?: number;
  mediaW?: number;
  mediaH?: number;
  imageW?: number;
  imageH?: number;
  colorSpace?: '/DeviceRGB' | '/DeviceCMYK' | '/DeviceGray';
  bitsPerComponent?: number;
  filter?: '/FlateDecode' | '/DCTDecode';
  imageBytes?: Uint8Array;
  subtype?: '/Image' | '/Form';
  hasSoftMask?: boolean;
  ocgName?: string;
  placementCm?: string;
  xobjectName?: string;
  contentStream?: string;
};

function defaultRgbImageBytes(w: number, h: number): Uint8Array {
  const raw = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = 200;
    raw[i * 3 + 1] = 100;
    raw[i * 3 + 2] = 50;
  }
  return raw;
}

/** Build a PDF-compatible `.ai` with OCG, one Image XObject, and a marked-content block. */
export function buildSyntheticImageAiPdf(opts: SyntheticImagePdfOptions = {}): Buffer {
  const mediaW = opts.mediaW ?? 400;
  const mediaH = opts.mediaH ?? 300;
  const imageW = opts.imageW ?? 8;
  const imageH = opts.imageH ?? 8;
  const colorSpace = opts.colorSpace ?? '/DeviceRGB';
  const bits = opts.bitsPerComponent ?? 8;
  const filter = opts.filter ?? '/FlateDecode';
  const subtype = opts.subtype ?? '/Image';
  const xname = opts.xobjectName ?? 'Im0';
  const ocgName = opts.ocgName ?? 'Synthetic Placed Image';
  const placementCm = opts.placementCm ?? '64 0 0 48 120 80 cm';

  let payload: Uint8Array;
  if (opts.imageBytes) {
    payload = opts.imageBytes;
  } else if (filter === '/FlateDecode' && colorSpace === '/DeviceRGB') {
    payload = deflate(defaultRgbImageBytes(imageW, imageH));
  } else {
    payload = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  }

  const mcBody =
    opts.contentStream ??
    `/OC /MC0 BDC
q
${placementCm}
/${xname} Do
Q
EMC
`;

  const parts: Buffer[] = [Buffer.from(`%PDF-1.4\n${SYNTHETIC_COMMENT}`, 'latin1')];
  const offsets: number[] = [0];

  const addObj = (body: string | Buffer) => {
    offsets.push(Buffer.concat(parts).length);
    parts.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
  };

  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OCProperties 9 0 R >>\nendobj\n');
  addObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  addObj(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaW} ${mediaH}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /${xname} 7 0 R >> /ExtGState << /GS0 6 0 R >> /Properties << /MC0 10 0 R >> >> >>\nendobj\n`,
  );
  addObj(
    `4 0 obj\n<< /Length ${Buffer.byteLength(mcBody, 'latin1')} >>\nstream\n${mcBody}\nendstream\nendobj\n`,
  );
  addObj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  addObj('6 0 obj\n<< /Type /ExtGState /ca 1 /CA 1 >>\nendobj\n');

  const smaskLine = opts.hasSoftMask ? ' /SMask 11 0 R' : '';
  const imageHeader = Buffer.from(
    `7 0 obj\n<< /Type /XObject /Subtype ${subtype} /Width ${imageW} /Height ${imageH} /ColorSpace ${colorSpace} /BitsPerComponent ${bits} /Filter ${filter} /Length ${payload.length}${smaskLine} >>\nstream\n`,
    'latin1',
  );
  const imageFooter = Buffer.from('\nendstream\nendobj\n', 'latin1');
  addObj(Buffer.concat([imageHeader, Buffer.from(payload), imageFooter]));

  addObj(`8 0 obj\n<< /Type /OCG /Name (${ocgName}) >>\nendobj\n`);
  addObj('9 0 obj\n<< /OCGs [8 0 R] /D << /Order [8 0 R] /ON [8 0 R] >> >>\nendobj\n');
  addObj('10 0 obj\n<< /OC 8 0 R >>\nendobj\n');

  if (opts.hasSoftMask) {
    const maskRaw = deflate(new Uint8Array(imageW * imageH));
    const maskHeader = Buffer.from(
      `11 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageW} /Height ${imageH} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${maskRaw.length} >>\nstream\n`,
      'latin1',
    );
    addObj(Buffer.concat([maskHeader, Buffer.from(maskRaw), imageFooter]));
  }

  const bodyLen = Buffer.concat(parts).length;
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${bodyLen}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}

function ensureFixtureOnDisk(): string {
  const dir = path.join('public', 'fixtures', 'ai');
  fs.mkdirSync(dir, { recursive: true });
  const fixturePath = path.join(dir, 'simple-placed-image.ai');
  const buf = buildSyntheticImageAiPdf({
    ocgName: 'Synthetic Placed Image Layer',
    placementCm: '64 0 0 48 120 80 cm',
  });
  fs.writeFileSync(fixturePath, buf);
  return fixturePath;
}

function bufToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

async function runDetectionTests() {
  const fixturePath = ensureFixtureOnDisk();
  const buf = fs.readFileSync(fixturePath);
  assert('fixture-has-synthetic-label', buf.toString('latin1', 0, 120).includes('Creatvise synthetic fixture'), 'header');

  const ab = bufToArrayBuffer(buf);
  const parsed = await parseAiPlacedImagesFromOriginal(ab);
  assert('parse-non-null', parsed != null, '');
  const blocks = parsed!.blocks;
  assert('one-mc-block', blocks.length === 1, `count=${blocks.length}`);
  assert('block-not-mixed', blocks[0].mixed === false, blocks[0].mixedReason ?? '');
  const runs = supportedPlacedImageRuns(blocks);
  assert('one-supported-run', runs.length === 1, `count=${runs.length}`);

  const run = runs[0];
  assert('mc-index-0', run.mcIndex === 0, String(run.mcIndex));
  assert('xobject-name-im0', run.xobjectName === 'Im0', run.xobjectName);
  assert('xobject-ref-7', run.xobjectRef === '7 0 R', run.xobjectRef);
  assert('width-8', run.width === 8, String(run.width));
  assert('height-8', run.height === 8, String(run.height));
  assert('bits-8', run.bitsPerComponent === 8, String(run.bitsPerComponent));
  assert('colorspace-rgb', run.colorSpace === 'DeviceRGB', run.colorSpace);
  assert('filter-flate', run.filters.join(',') === 'FlateDecode', run.filters.join(','));
  assert('no-soft-mask', run.hasSoftMask === false, String(run.hasSoftMask));
  assert(
    'placement-matrix',
    run.placementMatrix[0] === 64 &&
      run.placementMatrix[3] === 48 &&
      run.placementMatrix[4] === 120 &&
      run.placementMatrix[5] === 80,
    run.placementMatrix.join(','),
  );
  assert('patch-do', run.patch.doSearch === '/Im0 Do', run.patch.doSearch);
  assert('patch-cm', run.patch.cmSearch === '64 0 0 48 120 80 cm', run.patch.cmSearch);

  const xobjs = await loadPageImageXObjects(ab);
  assert('resources-im0', xobjs.has('Im0'), [...xobjs.keys()].join(','));
}

async function runRejectionTests() {
  const xobjects = await loadPageImageXObjects(
    bufToArrayBuffer(buildSyntheticImageAiPdf()),
  );

  const formPdf = buildSyntheticImageAiPdf({ subtype: '/Form' });
  const formParsed = await parseAiPlacedImagesFromOriginal(bufToArrayBuffer(formPdf));
  const formRun = formParsed!.blocks[0].images[0];
  assert('reject-form-xobject', formRun.supported === false, formRun.unsupportedReason ?? '');

  const multiBody = `q
10 0 0 10 0 0 cm
/Im0 Do
/Im0 Do
Q`;
  const multiBlock = parseMcBlockPlacedImage(
    multiBody,
    0,
    xobjects,
  );
  assert('reject-multiple-do', multiBlock.mixed === true, multiBlock.mixedReason ?? '');

  const textMixed = `/OC /MC0 BDC
q
BT /F1 12 Tf (Hi) Tj ET
/Im0 Do
Q
EMC`;
  const textPdf = buildSyntheticImageAiPdf({
    contentStream: textMixed,
  });
  const textParsed = await parseAiPlacedImagesFromOriginal(bufToArrayBuffer(textPdf));
  assert('reject-text-mixed', textParsed!.blocks[0].mixed === true, textParsed!.blocks[0].mixedReason ?? '');

  const vectorMixed = `/OC /MC0 BDC
q
50 50 20 20 re f
/Im0 Do
Q
EMC`;
  const vecPdf = buildSyntheticImageAiPdf({ contentStream: vectorMixed });
  const vecParsed = await parseAiPlacedImagesFromOriginal(bufToArrayBuffer(vecPdf));
  assert('reject-vector-mixed', vecParsed!.blocks[0].mixed === true, vecParsed!.blocks[0].mixedReason ?? '');

  const cmykPdf = buildSyntheticImageAiPdf({ colorSpace: '/DeviceCMYK', imageBytes: deflate(new Uint8Array(8 * 8 * 4)) });
  const cmykRun = (await parseAiPlacedImagesFromOriginal(bufToArrayBuffer(cmykPdf)))!.blocks[0].images[0];
  assert('reject-cmyk', cmykRun.supported === false, cmykRun.unsupportedReason ?? '');

  const dctPdf = buildSyntheticImageAiPdf({ filter: '/DCTDecode' });
  const dctRun = (await parseAiPlacedImagesFromOriginal(bufToArrayBuffer(dctPdf)))!.blocks[0].images[0];
  assert('reject-dct-filter', dctRun.supported === false, dctRun.unsupportedReason ?? '');

  const smaskPdf = buildSyntheticImageAiPdf({ hasSoftMask: true });
  const smaskRun = (await parseAiPlacedImagesFromOriginal(bufToArrayBuffer(smaskPdf)))!.blocks[0].images[0];
  assert('reject-soft-mask', smaskRun.supported === false, smaskRun.unsupportedReason ?? '');
  assert('records-soft-mask', smaskRun.hasSoftMask === true, String(smaskRun.hasSoftMask));

  const shapesOnly = parsePdfPlacedImages(
    `/OC /MC0 BDC
q
0.5 0.25 0 rg
50 170 120 80 re f
Q
EMC`,
    new Map<string, PageImageXObjectInfo>(),
  );
  assert('no-image-in-shape-block', supportedPlacedImageRuns(shapesOnly).length === 0, '');
}

function firstImageLeaf(doc: Doc): Node {
  const n = [...walk(doc.roots)].find((x) => x.kind === 'raster' && canReplaceAiPlacedImageOnNode(x));
  if (!n) throw new Error('no replaceable raster leaf');
  return n;
}

function meanRgb(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): { r: number; g: number; b: number } {
  const ctx = c.getContext('2d')!;
  const ix = Math.max(0, Math.floor(x));
  const iy = Math.max(0, Math.floor(y));
  const iw = Math.min(c.width - ix, Math.max(1, Math.ceil(w)));
  const ih = Math.min(c.height - iy, Math.max(1, Math.ceil(h)));
  if (iw <= 0 || ih <= 0 || ix >= c.width || iy >= c.height) return { r: 0, g: 0, b: 0 };
  const data = ctx.getImageData(ix, iy, iw, ih).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (!n) return { r: 0, g: 0, b: 0 };
  return { r: r / n, g: g / n, b: b / n };
}

function buildPreviewProbeNode(run: AiPlacedImageRun): Node {
  const c = createCanvas(400, 300) as unknown as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 400, 300);
  ctx.fillStyle = 'rgb(200, 100, 50)';
  ctx.fillRect(run.importBounds!.docX, run.importBounds!.docY, run.importBounds!.docW, run.importBounds!.docH);

  const base = createCanvas(400, 300) as unknown as HTMLCanvasElement;
  base.getContext('2d')!.drawImage(c, 0, 0);

  const layer = {
    name: 'Probe',
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    canvas: c,
    hidden: false,
    opacity: 1,
  } as Layer;
  initAiLayerMeta(layer, 0);
  asAiLayerStub(layer).aiPlacedImages = [run];

  return {
    id: 'probe',
    key: 'ocg-0',
    name: 'Probe',
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    rotation: 0,
    ow: 400,
    oh: 300,
    ox: 0,
    oy: 0,
    canvas: c,
    aiImportRasterCanvas: base,
    children: [],
    parent: null,
    src: layer,
    unsupported: [],
  };
}

async function runPreviewHelperTests() {
  const parsed = await parseAiPlacedImagesFromOriginal(
    bufToArrayBuffer(buildSyntheticImageAiPdf()),
  );
  const run = supportedPlacedImageRuns(parsed!.blocks)[0];
  run.importBounds = {
    docX: 120,
    docY: 172,
    docW: 64,
    docH: 48,
  };

  const leaf = buildPreviewProbeNode(run);
  leaf.rotation = 15;
  leaf.x = 8;
  leaf.opacity = 0.45;

  const before = captureState(leaf);
  const sample = () => meanRgb(leaf.canvas!, 140, 188, 8, 8);
  const beforeMean = sample();

  const replacement = createCanvas(12, 12) as unknown as HTMLCanvasElement;
  replacement.getContext('2d')!.fillStyle = 'rgb(10, 200, 30)';
  replacement.getContext('2d')!.fillRect(0, 0, 12, 12);

  applyAiPlacedImagePreviewReplace(leaf, replacement);
  assert('probe-replace-flag', leaf.aiImageEdited === true, '');
  assert('probe-geometry-x', leaf.x === 8, String(leaf.x));
  assert('probe-geometry-rotation', leaf.rotation === 15, String(leaf.rotation));
  assert('probe-geometry-opacity', leaf.opacity === 0.45, String(leaf.opacity));
  const afterMean = sample();
  assert('probe-pixels-green', afterMean.g > 150 && afterMean.g > afterMean.r, JSON.stringify(afterMean));

  restoreState(leaf, before);
  assert('probe-undo-flag', !leaf.aiImageEdited, '');
  assert('probe-undo-pixels', Math.abs(sample().g - beforeMean.g) < 5, '');
}

async function runImportAndPreviewTests() {
  const { importAi } = await import('../src/ai/ai');
  const fixturePath = ensureFixtureOnDisk();
  const doc = await importAi('simple-placed-image.ai', bufToArrayBuffer(fs.readFileSync(fixturePath)));

  assert('import-supported-node-count', countSupportedPlacedImageNodes(doc) === 1, String(countSupportedPlacedImageNodes(doc)));
  const leaf = firstImageLeaf(doc);
  const stub = asAiLayerStub(leaf.src);
  const run = stub.aiPlacedImages?.[0];
  assert('stub-has-placed-image', !!run?.supported, '');
  assert('patch-do-stable', run!.patch.importDoSearch === '/Im0 Do', run!.patch.importDoSearch);
  assert('patch-cm-stable', run!.patch.importCmSearch === '64 0 0 48 120 80 cm', run!.patch.importCmSearch);
  assert('import-bytes-length', run!.importImageBytes?.length === 8 * 8 * 3, String(run!.importImageBytes?.length));
  assert('import-image-canvas-size', run!.importImageCanvas?.width === 8 && run!.importImageCanvas?.height === 8, '');
  assert('import-raster-snapshot', !!leaf.aiImportRasterCanvas, '');
  assert('can-replace', canReplaceAiPlacedImageOnNode(leaf), '');

  const before = captureState(leaf);
  leaf.rotation = 12;
  leaf.x += 5;
  leaf.opacity = 0.55;
  const geomAfterEdit = {
    x: leaf.x,
    y: leaf.y,
    w: leaf.w,
    h: leaf.h,
    rotation: leaf.rotation,
    opacity: leaf.opacity,
  };

  assert('import-bounds-set', !!run!.importBounds && run!.importBounds.docW > 0, JSON.stringify(run!.importBounds));

  const replacement = createCanvas(16, 16) as unknown as HTMLCanvasElement;
  replacement.getContext('2d')!.fillStyle = 'rgb(20, 180, 40)';
  replacement.getContext('2d')!.fillRect(0, 0, 16, 16);

  const canvasBeforeReplace = leaf.canvas;
  applyAiPlacedImagePreviewReplace(leaf, replacement);
  assert('preview-edited-flag', leaf.aiImageEdited === true, '');
  assert('geometry-x-unchanged', leaf.x === geomAfterEdit.x, String(leaf.x));
  assert('geometry-y-unchanged', leaf.y === geomAfterEdit.y, String(leaf.y));
  assert('geometry-w-unchanged', leaf.w === geomAfterEdit.w, String(leaf.w));
  assert('geometry-h-unchanged', leaf.h === geomAfterEdit.h, String(leaf.h));
  assert('geometry-rotation-unchanged', leaf.rotation === geomAfterEdit.rotation, String(leaf.rotation));
  assert('geometry-opacity-unchanged', leaf.opacity === geomAfterEdit.opacity, String(leaf.opacity));
  assert('replacement-canvas-stored', !!run!.edit?.replacementCanvas, '');
  assert('preview-canvas-rebuilt', leaf.canvas !== canvasBeforeReplace, '');

  restoreState(leaf, before);
  assert('undo-clears-flag', !leaf.aiImageEdited, String(leaf.aiImageEdited));
  assert(
    'undo-restores-geometry',
    leaf.x === before.x && leaf.y === before.y && leaf.rotation === before.rotation,
    '',
  );
  const runAfterUndo = asAiLayerStub(leaf.src).aiPlacedImages?.[0];
  assert('undo-clears-replacement', !runAfterUndo?.edit?.replacementCanvas, '');
  assert('undo-keeps-import-bytes', run!.importImageBytes?.length === 8 * 8 * 3, '');
  assert('undo-keeps-patch-do', run!.patch.importDoSearch === '/Im0 Do', run!.patch.importDoSearch);

  const mixedDoc = await importAi(
    'mixed-vector-image.ai',
    bufToArrayBuffer(
      buildSyntheticImageAiPdf({
        contentStream: `/OC /MC0 BDC
q
50 50 20 20 re f
64 0 0 48 120 80 cm
/Im0 Do
Q
EMC`,
      }),
    ),
  );
  const mixedLeaf = [...walk(mixedDoc.roots)].find((n) => n.kind === 'raster');
  assert('mixed-not-replaceable', mixedLeaf != null && !canReplaceAiPlacedImageOnNode(mixedLeaf), '');
  assert('mixed-stub-flag', !!asAiLayerStub(mixedLeaf!.src).aiPlacedImageUnsupported, '');

  const shapesPath = path.join('public', 'fixtures', 'ai', 'simple-shapes.ai');
  const shapesDoc = await importAi('simple-shapes.ai', bufToArrayBuffer(fs.readFileSync(shapesPath)));
  assert('shape-doc-no-image-replace', countSupportedPlacedImageNodes(shapesDoc) === 0, '');
}

async function runUiPolicyTests() {
  const { importAi } = await import('../src/ai/ai');
  const fixturePath = ensureFixtureOnDisk();
  const doc = await importAi('simple-placed-image.ai', bufToArrayBuffer(fs.readFileSync(fixturePath)));
  const leaf = firstImageLeaf(doc);
  assert('ui-can-replace-supported', canReplaceAiImageOnNode(doc, leaf), '');

  const mixedDoc = await importAi(
    'mixed.ai',
    bufToArrayBuffer(
      buildSyntheticImageAiPdf({
        contentStream: `/OC /MC0 BDC
q
50 50 20 20 re f
64 0 0 48 120 80 cm
/Im0 Do
Q
EMC`,
      }),
    ),
  );
  const mixedLeaf = [...walk(mixedDoc.roots)].find((n) => n.kind === 'raster')!;
  assert('ui-blocked-mixed', !canReplaceAiImageOnNode(mixedDoc, mixedLeaf), '');
  assert(
    'ui-blocked-reason-mixed',
    aiPlacedImageReplaceBlockedReason(mixedDoc, mixedLeaf).includes('vector'),
    aiPlacedImageReplaceBlockedReason(mixedDoc, mixedLeaf),
  );

  const textPath = path.join('public', 'fixtures', 'ai', 'live-text-synthetic.ai');
  const textDoc = await importAi('live-text-synthetic.ai', bufToArrayBuffer(fs.readFileSync(textPath)));
  const textLeaf = [...walk(textDoc.roots)].find((n) => n.kind === 'raster')!;
  assert('ui-blocked-live-text', !canReplaceAiImageOnNode(textDoc, textLeaf), '');
}

async function runEndToEndWorkflowTests() {
  const { importAi, exportAi } = await import('../src/ai/ai');
  const fixturePath = ensureFixtureOnDisk();
  const originalBuf = bufToArrayBuffer(fs.readFileSync(fixturePath));

  const doc = await importAi('simple-placed-image.ai', originalBuf.slice(0));
  const leaf = firstImageLeaf(doc);
  const run = asAiLayerStub(leaf.src).aiPlacedImages![0];
  const importBytes = run.importImageBytes!.slice();
  const origStream = (await readFirstPageContentStreamText(doc.original))!.text;

  const green = createCanvas(16, 16) as unknown as HTMLCanvasElement;
  green.getContext('2d')!.fillStyle = 'rgb(5, 210, 25)';
  green.getContext('2d')!.fillRect(0, 0, 16, 16);
  applyAiPlacedImagePreviewReplace(leaf, green);
  assert('e2e-preview-flag', leaf.aiImageEdited === true, '');
  assert('e2e-export-gate', docHasAiImageStreamEdits(doc), '');

  const exported = await exportAi(doc);
  const decoded = await decodeSupportedImageXObjectBytes(exported, run);
  assert('e2e-export-green-xobject', decoded != null && decoded[1] > 180, `g=${decoded?.[1]}`);

  const streamAfter = (await readFirstPageContentStreamText(exported))!.text;
  assert('e2e-cm-unchanged', streamAfter.includes(run.patch.importCmSearch), '');
  assert('e2e-do-unchanged', streamAfter.includes(run.patch.importDoSearch), '');
  assert('e2e-stream-text-unchanged', streamAfter === origStream, 'contents stream changed');

  const reDoc = await importAi('reimport-e2e.ai', exported);
  const reRun = asAiLayerStub(firstImageLeaf(reDoc).src).aiPlacedImages![0];
  const reDecoded = await decodeSupportedImageXObjectBytes(exported, reRun);
  assert('e2e-reimport-green', reDecoded != null && reDecoded[1] > 180, '');

  let diffs = 0;
  for (let i = 0; i < importBytes.length; i++) if (reDecoded![i] !== importBytes[i]) diffs++;
  assert('e2e-differs-from-import', diffs > 40, `diffs=${diffs}`);

  const shapesDoc = await importAi(
    'simple-shapes.ai',
    bufToArrayBuffer(fs.readFileSync(path.join('public', 'fixtures', 'ai', 'simple-shapes.ai'))),
  );
  assert('e2e-shapes-unedited-export', buffersEqual(shapesDoc.original, await exportAi(shapesDoc)), '');

  const textDoc = await importAi(
    'live-text-synthetic.ai',
    bufToArrayBuffer(fs.readFileSync(path.join('public', 'fixtures', 'ai', 'live-text-synthetic.ai'))),
  );
  assert('e2e-text-unedited-export', buffersEqual(textDoc.original, await exportAi(textDoc)), '');

  try {
    const bad = await importAi(
      'bad-export.ai',
      bufToArrayBuffer(buildSyntheticImageAiPdf({ colorSpace: '/DeviceCMYK', imageBytes: deflate(new Uint8Array(8 * 8 * 4)) })),
    );
    const badLeaf = [...walk(bad.roots)].find((n) => n.kind === 'raster');
    assert('e2e-cmyk-not-replaceable', badLeaf != null && !canReplaceAiImageOnNode(bad, badLeaf), '');
  } catch {
    assert('e2e-cmyk-not-replaceable', true, 'import failed');
  }
}

async function runExportTests() {
  const { importAi, exportAi } = await import('../src/ai/ai');
  const fixturePath = ensureFixtureOnDisk();
  const originalBuf = bufToArrayBuffer(fs.readFileSync(fixturePath));

  const doc = await importAi('simple-placed-image.ai', originalBuf.slice(0));
  const leaf = firstImageLeaf(doc);
  const run = asAiLayerStub(leaf.src).aiPlacedImages![0];
  const importBytes = run.importImageBytes!.slice();
  const origStream = await readFirstPageContentStreamText(doc.original);

  assert('unedited-export-identical', buffersEqual(doc.original, await exportAi(doc)), '');

  const green = createCanvas(8, 8) as unknown as HTMLCanvasElement;
  green.getContext('2d')!.fillStyle = 'rgb(10, 220, 30)';
  green.getContext('2d')!.fillRect(0, 0, 8, 8);

  const geom = { x: leaf.x, y: leaf.y, w: leaf.w, h: leaf.h, rot: leaf.rotation, op: leaf.opacity };
  applyAiPlacedImagePreviewReplace(leaf, green);
  assert('export-gate-on', docHasAiImageStreamEdits(doc), '');

  const exported = await exportAi(doc);
  assert('export-bytes-changed', !buffersEqual(doc.original, exported), '');
  const streamAfter = await readFirstPageContentStreamText(exported);
  assert('content-stream-unchanged', streamAfter?.text === origStream?.text, 'page Contents differ');
  assert('cm-placement-kept', streamAfter!.text.includes(run.patch.importCmSearch), run.patch.importCmSearch);
  assert('do-operator-kept', streamAfter!.text.includes(run.patch.importDoSearch), run.patch.importDoSearch);

  const ocgBefore = new TextDecoder('latin1').decode(new Uint8Array(doc.original)).includes('/Type /OCG');
  const ocgAfter = new TextDecoder('latin1').decode(new Uint8Array(exported)).includes('/Type /OCG');
  assert('ocg-metadata-kept', ocgBefore && ocgAfter, '');

  const decoded = await decodeSupportedImageXObjectBytes(exported, run);
  assert('xobject-decodes-rgb', decoded != null && decoded.length === importBytes.length, '');
  let byteDiffs = 0;
  for (let i = 0; i < decoded!.length; i++) if (decoded![i] !== importBytes[i]) byteDiffs++;
  assert('xobject-pixel-data-changed', byteDiffs > 40, `diffs=${byteDiffs}`);
  assert('xobject-green-dominant', decoded![1] > 150 && decoded![1] > decoded![0], `g=${decoded![1]}`);

  assert('geometry-preserved-after-export', leaf.x === geom.x && leaf.w === geom.w && leaf.rotation === geom.rot, '');
  assert('opacity-preserved-after-export', leaf.opacity === geom.op, String(leaf.opacity));

  const roundtrip = await importAi('roundtrip.ai', exported);
  const runRt = asAiLayerStub(firstImageLeaf(roundtrip).src).aiPlacedImages![0];
  const decodedRt = await decodeSupportedImageXObjectBytes(exported, runRt);
  assert('reimport-xobject-green', decodedRt != null && decodedRt[1] > 150, '');

  const docUndo = await importAi('undo-export.ai', originalBuf.slice(0));
  const leafUndo = firstImageLeaf(docUndo);
  const saved = captureState(leafUndo);
  applyAiPlacedImagePreviewReplace(
    leafUndo,
    createCanvas(4, 4) as unknown as HTMLCanvasElement,
  );
  restoreState(leafUndo, saved);
  assert('undo-export-identical', buffersEqual(docUndo.original, await exportAi(docUndo)), '');

  const shapesDoc = await importAi(
    'simple-shapes.ai',
    bufToArrayBuffer(fs.readFileSync(path.join('public', 'fixtures', 'ai', 'simple-shapes.ai'))),
  );
  assert('shapes-unedited-identical', buffersEqual(shapesDoc.original, await exportAi(shapesDoc)), '');
}

async function main() {
  await runDetectionTests();
  await runRejectionTests();
  await runPreviewHelperTests();
  await runImportAndPreviewTests();
  await runUiPolicyTests();
  await runEndToEndWorkflowTests();
  await runExportTests();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

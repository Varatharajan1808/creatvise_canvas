/**
 * AI export fidelity on public/sample.ai:
 * - unedited export is byte-identical and re-imports to the same pixels
 * - the import preview is transparent (no white page fill)
 * - visibility-only export keeps the content stream and Illustrator private data
 * - move/rotate/scale export keeps every original path, renders like the canvas preview,
 *   and re-import still shows artwork pushed outside the artboard
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflate } from 'pako';
import { walk, type Doc, type Node } from '../src/model';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const PAGE = 680;
const PAD = 300;
const SIZE = PAGE + 2 * PAD;

function latin1(buf: ArrayBuffer): string {
  return new TextDecoder('latin1').decode(new Uint8Array(buf));
}

function countMarker(buf: ArrayBuffer, marker: string): number {
  return latin1(buf).split(marker).length - 1;
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

async function contentStreamText(buf: ArrayBuffer): Promise<string> {
  const doc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const s = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents'))) as unknown as {
    getContents(): Uint8Array;
  };
  const raw = s.getContents();
  let bytes: Uint8Array;
  try {
    bytes = inflate(raw);
  } catch {
    bytes = raw;
  }
  return new TextDecoder('latin1').decode(bytes);
}

/** Path-drawing blocks (`q <cm> ... f Q`) of the original artwork. */
function pathBlocks(stream: string): string[] {
  return stream.match(/q 1 0 0 1 [-\d.]+ [-\d.]+ cm[\s\S]*?\nf\nQ/g) ?? [];
}

/** Draw a layer onto a padded canvas the way the viewport places it (centre, rotation, size). */
function drawNode(n: Node): Canvas {
  const c = createCanvas(SIZE, SIZE);
  const g = c.getContext('2d');
  g.translate(PAD + n.x + n.w / 2, PAD + n.y + n.h / 2);
  g.rotate((n.rotation * Math.PI) / 180);
  g.drawImage(n.canvas as unknown as Canvas, -n.w / 2, -n.h / 2, n.w, n.h);
  return c;
}

async function renderPdfPadded(buf: ArrayBuffer): Promise<Canvas> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1, offsetX: PAD, offsetY: PAD });
  const c = createCanvas(SIZE, SIZE);
  await page.render({
    canvasContext: c.getContext('2d') as unknown as CanvasRenderingContext2D,
    viewport,
    background: 'rgba(0,0,0,0)',
  }).promise;
  await pdf.destroy();
  return c;
}

interface MaskStats {
  inside: number;
  outside: number;
}

function alphaMask(c: Canvas): Uint8Array {
  const d = c.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

function maskStats(m: Uint8Array): MaskStats {
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!m[y * SIZE + x]) continue;
      const px = x - PAD;
      const py = y - PAD;
      if (px >= 0 && py >= 0 && px < PAGE && py < PAGE) inside++;
      else outside++;
    }
  }
  return { inside, outside };
}

/** Pixels covered by exactly one mask, relative to pixels covered by either (0 = identical). */
function maskDifference(a: Uint8Array, b: Uint8Array): number {
  let xor = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) union++;
    if (a[i] !== b[i]) xor++;
  }
  return union ? xor / union : 0;
}

function artworkLeaf(doc: Doc): Node {
  return [...walk(doc.roots)].find((n) => n.kind !== 'group' && n.canvas)!;
}

async function runTests() {
  const { importAi, exportAi } = await import('../src/ai');

  const sampleBuf = fs.readFileSync('public/sample.ai');
  const sampleAb = sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength);
  const origAip = countMarker(sampleAb, 'AIPrivateData');
  const origStream = await contentStreamText(sampleAb);
  const origBlocks = pathBlocks(origStream);
  const origRender = alphaMask(await renderPdfPadded(sampleAb));
  assert('sample-original-path-blocks', origBlocks.length === 5, `blocks=${origBlocks.length}`);

  // 1. Unedited import -> export -> re-import.
  const imported = await importAi('sample.ai', sampleAb.slice(0));
  const leaf0 = artworkLeaf(imported);
  const corner = leaf0.canvas!.getContext('2d')!.getImageData(0, 0, 1, 1).data;
  assert('import-preview-transparent-background', corner[3] === 0, `corner RGBA=${[...corner].join(',')}`);
  assert(
    'import-layer-box-is-artboard',
    leaf0.x === 0 && leaf0.y === 0 && leaf0.w === PAGE && leaf0.h === PAGE,
    `${leaf0.x},${leaf0.y} ${leaf0.w}x${leaf0.h}`,
  );
  const importMask = alphaMask(drawNode(leaf0));
  const importVsPdf = maskDifference(importMask, origRender);
  assert('import-preview-matches-pdf-render', importVsPdf < 0.01, `mask difference=${importVsPdf.toFixed(4)}`);

  const uneditedOut = await exportAi(imported);
  assert('unedited-byte-identical', buffersEqual(sampleAb, uneditedOut), `len ${sampleAb.byteLength} vs ${uneditedOut.byteLength}`);
  assert('unedited-aiprivate', countMarker(uneditedOut, 'AIPrivateData') === origAip, `count=${countMarker(uneditedOut, 'AIPrivateData')}`);
  const reUnedited = artworkLeaf(await importAi('sample-roundtrip.ai', uneditedOut));
  const reUneditedDiff = maskDifference(importMask, alphaMask(drawNode(reUnedited)));
  assert('unedited-reimport-pixels', reUneditedDiff === 0, `mask difference=${reUneditedDiff}`);

  // 2. Visibility-only edit -> export -> re-import.
  const visDoc = await importAi('sample-vis.ai', sampleAb.slice(0));
  artworkLeaf(visDoc).visible = false;
  const visOut = await exportAi(visDoc);
  assert('visibility-aiprivate-kept', countMarker(visOut, 'AIPrivateData') === origAip, `count=${countMarker(visOut, 'AIPrivateData')}`);
  assert('visibility-ocg-off', /\/OFF\[5 0 R\]/.test(latin1(visOut)), 'OCProperties /OFF lists the layer');
  const visStream = await contentStreamText(visOut);
  assert('visibility-content-stream-unchanged', visStream === origStream, `len ${visStream.length} vs ${origStream.length}`);
  const visRe = await importAi('sample-vis-re.ai', visOut);
  const visReLeaf = artworkLeaf(visRe);
  assert('visibility-reimport-hidden', !visReLeaf.visible && !visReLeaf.importVisible, `visible=${visReLeaf.visible}`);
  const visReDiff = maskDifference(alphaMask(drawNode(visReLeaf)), importMask);
  assert('visibility-reimport-keeps-layer-pixels', visReDiff === 0, `mask difference=${visReDiff}`);
  visReLeaf.visible = true;
  const visBack = await exportAi(visRe);
  const visBackRender = maskDifference(alphaMask(await renderPdfPadded(visBack)), origRender);
  assert('visibility-toggle-back-restores-artwork', visBackRender === 0, `mask difference=${visBackRender}`);

  // 3. Move + rotate + scale so part of the brim leaves the artboard.
  const geomDoc = await importAi('sample-geom.ai', sampleAb.slice(0));
  const g = artworkLeaf(geomDoc);
  g.w = g.h = 455;
  g.x = -60;
  g.y = 200;
  g.rotation = 56;
  const previewMask = alphaMask(drawNode(g));
  const previewStats = maskStats(previewMask);
  assert('geometry-preview-has-off-artboard-art', previewStats.outside > 1000, `outside px=${previewStats.outside}`);

  const geomOut = await exportAi(geomDoc);
  const geomStream = await contentStreamText(geomOut);
  const missingBlocks = origBlocks.filter((b) => !geomStream.includes(b));
  assert('geometry-all-original-paths-kept', missingBlocks.length === 0, `missing=${missingBlocks.length}/${origBlocks.length}`);
  assert('geometry-artboard-clip-kept', geomStream.includes('0 0 680 680 re\nW n'), 'artboard clip present');
  assert('geometry-colorspace-and-gs-kept', geomStream.includes('/CS0 cs') && geomStream.includes('/GS0 gs'), 'resource refs');

  const exportMask = alphaMask(await renderPdfPadded(geomOut));
  const exportStats = maskStats(exportMask);
  const exportVsPreview = maskDifference(exportMask, previewMask);
  assert('geometry-export-matches-preview', exportVsPreview < 0.02, `mask difference=${exportVsPreview.toFixed(4)}`);
  assert(
    'geometry-off-artboard-art-in-file',
    Math.abs(exportStats.outside - previewStats.outside) / previewStats.outside < 0.05,
    `outside px export=${exportStats.outside} preview=${previewStats.outside}`,
  );

  const geomRe = await importAi('sample-geom-re.ai', geomOut);
  const reLeaf = artworkLeaf(geomRe);
  assert(
    'geometry-reimport-recovers-transform',
    Math.abs(reLeaf.x - g.x) < 1 &&
      Math.abs(reLeaf.y - g.y) < 1 &&
      Math.abs(reLeaf.w - g.w) < 1 &&
      Math.abs(reLeaf.h - g.h) < 1 &&
      Math.abs(reLeaf.rotation - g.rotation) < 0.05,
    `box ${reLeaf.x},${reLeaf.y} ${reLeaf.w}x${reLeaf.h} rot=${reLeaf.rotation}`,
  );
  const reMask = alphaMask(drawNode(reLeaf));
  const reStats = maskStats(reMask);
  const reVsPreview = maskDifference(reMask, previewMask);
  assert('geometry-reimport-matches-preview', reVsPreview < 0.02, `mask difference=${reVsPreview.toFixed(4)}`);
  assert(
    'geometry-reimport-keeps-off-artboard-art',
    Math.abs(reStats.outside - previewStats.outside) / previewStats.outside < 0.05,
    `outside px reimport=${reStats.outside} preview=${previewStats.outside}`,
  );
  assert(
    'geometry-reimport-dimensions',
    geomRe.width === PAGE && geomRe.height === PAGE,
    `${geomRe.width}x${geomRe.height}`,
  );

  // 4. Simple rectangle fixture: unedited export stays byte-identical.
  const shapesBuf = fs.readFileSync('public/fixtures/ai/simple-shapes.ai');
  const shapesAb = shapesBuf.buffer.slice(shapesBuf.byteOffset, shapesBuf.byteOffset + shapesBuf.byteLength);
  const shapesUnedited = await exportAi(await importAi('simple-shapes.ai', shapesAb.slice(0)));
  assert('simple-shapes-unedited-identical', buffersEqual(shapesAb, shapesUnedited), `len ${shapesAb.byteLength} vs ${shapesUnedited.byteLength}`);

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} AI fidelity tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} AI fidelity tests passed`);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

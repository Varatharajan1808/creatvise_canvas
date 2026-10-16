/**
 * AI layer duplication: model identity, independent preview placement, PDF MC/OCG export, re-import.
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflate } from 'pako';
import { walk, type Doc, type Node } from '../src/core/model';
import {
  applyAiDuplicateMetadata,
  isAiDuplicateLayer,
  resolveAiMcIndex,
} from '../src/ai/aiLayerMeta';
import { readContentStreamMcStats } from '../src/ai/aiPdfLib';

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

function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height) as unknown as HTMLCanvasElement;
  c.getContext('2d')!.drawImage(src as unknown as Canvas, 0, 0);
  return c;
}

function cloneNodeLikeApp(original: Node, parent: Node | null, dx = 20, dy = 20): Node {
  const clonedCanvas = copyCanvas(original.canvas!);
  const newName = `${original.name} copy`;
  const clonedSrc = {
    ...original.src,
    name: newName,
    canvas: clonedCanvas,
    left: (original.src.left ?? 0) + dx,
    top: (original.src.top ?? 0) + dy,
  };
  return {
    ...original,
    id: `dup_${original.id}`,
    key: `${original.key}_copy_test`,
    name: newName,
    x: original.x + dx,
    y: original.y + dy,
    ox: original.ox + dx,
    oy: original.oy + dy,
    canvas: clonedCanvas,
    parent,
    src: clonedSrc as Node['src'],
    children: [],
  };
}

function drawNode(n: Node): Canvas {
  const c = createCanvas(SIZE, SIZE);
  const g = c.getContext('2d')!;
  g.translate(PAD + n.x + n.w / 2, PAD + n.y + n.h / 2);
  g.rotate((n.rotation * Math.PI) / 180);
  g.drawImage(n.canvas as unknown as Canvas, -n.w / 2, -n.h / 2, n.w, n.h);
  return c;
}

function maskUnion(a: Uint8Array, b: Uint8Array): number {
  let u = 0;
  for (let i = 0; i < a.length; i++) if (a[i] || b[i]) u++;
  return u;
}

function alphaMask(c: Canvas): Uint8Array {
  const d = c.getContext('2d')!.getImageData(0, 0, SIZE, SIZE).data;
  const m = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

async function contentStreamText(buf: ArrayBuffer): Promise<string> {
  const doc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const s = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents'))) as {
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

function insertDuplicateInTree(doc: Doc, original: Node, clone: Node): void {
  const list = original.parent ? original.parent.children : doc.roots;
  const idx = list.indexOf(original);
  list.splice(idx >= 0 ? idx + 1 : list.length, 0, clone);
}

async function runTests() {
  const { importAi, exportAi } = await import('../src/ai/ai');

  const sampleBuf = fs.readFileSync('public/sample.ai');
  const sampleAb = sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength);

  const imported = await importAi('sample.ai', sampleAb.slice(0));
  assert('import-can-duplicate-flag', imported.ai?.canDuplicateMarkedContent === true, String(imported.ai?.canDuplicateMarkedContent));
  assert('import-next-mc-index', imported.ai?.nextMcIndex === 1, `nextMc=${imported.ai?.nextMcIndex}`);

  const original = [...walk(imported.roots)].find((n) => n.kind !== 'group')!;
  const clone = cloneNodeLikeApp(original, original.parent, 20, 20);
  applyAiDuplicateMetadata(imported, original, clone);
  insertDuplicateInTree(imported, original, clone);

  assert('duplicate-distinct-id', clone.id !== original.id, `${clone.id} vs ${original.id}`);
  assert('duplicate-marked-as-copy', isAiDuplicateLayer(clone), 'aiDuplicate');
  assert('duplicate-mc-index-1', resolveAiMcIndex(clone) === 1, `mc=${resolveAiMcIndex(clone)}`);
  assert('duplicate-source-mc-0', resolveAiMcIndex(original) === 0, `orig mc=${resolveAiMcIndex(original)}`);
  assert('two-roots', imported.roots.length === 2, `roots=${imported.roots.length}`);
  assert('duplicate-offset', clone.x === original.x + 20 && clone.y === original.y + 20, `${clone.x},${clone.y}`);

  const m0 = alphaMask(drawNode(original));
  const m1 = alphaMask(drawNode(clone));
  const overlap = m0.reduce((acc, v, i) => acc + (v && m1[i] ? 1 : 0), 0);
  assert('duplicate-renders-offset', overlap < maskUnion(m0, m1) * 0.95, `overlap=${overlap}`);

  const dupOut = await exportAi(imported);
  const dupStream = await contentStreamText(dupOut);
  const mcStats = readContentStreamMcStats(dupStream);
  assert('export-two-mc-blocks', mcStats.blockCount >= 2, `blocks=${mcStats.blockCount}`);
  assert('export-has-mc0-and-mc1', dupStream.includes('/MC0 BDC') && dupStream.includes('/MC1 BDC'), 'BDC tags');

  const { readOcgNamesAndRefsFromPdf } = await import('../src/ai/aiPdfLib');
  const exportedOcgs = await readOcgNamesAndRefsFromPdf(dupOut);
  assert('export-two-ocg-refs', exportedOcgs.refs.length >= 2, `refs=${exportedOcgs.refs.join(',')}`);
  assert('export-two-ocg-names', exportedOcgs.names.length >= 2, exportedOcgs.names.join('|'));

  const reDoc = await importAi('sample-dup-re.ai', dupOut);
  const reLeaves = [...walk(reDoc.roots)].filter((n) => n.kind !== 'group');
  assert('reimport-two-layers', reLeaves.length === 2, `layers=${reLeaves.length}`);

  const names = reLeaves.map((n) => n.name).sort();
  assert('reimport-has-copy-name', names.some((n) => n.includes('copy')), names.join('|'));

  assert('reimport-both-have-artwork', reLeaves.every((n) => n.canvas && alphaMask(drawNode(n)).some(Boolean)), `layers=${reLeaves.length}`);

  // Regression: unedited single-layer export still byte-identical.
  const fresh = await importAi('sample-fresh.ai', sampleAb.slice(0));
  const uneditedOut = await exportAi(fresh);
  assert(
    'regression-unedited-byte-identical',
    uneditedOut.byteLength === sampleAb.byteLength && Buffer.from(uneditedOut).equals(Buffer.from(sampleAb)),
    `len ${uneditedOut.byteLength} vs ${sampleAb.byteLength}`,
  );

  // Regression: move on single layer still works (exportAiWithPdfLib path).
  const geom = await importAi('sample-geom-reg.ai', sampleAb.slice(0));
  const g = [...walk(geom.roots)].find((n) => n.kind !== 'group')!;
  g.x += 40;
  g.y += 10;
  const geomOut = await exportAi(geom);
  assert('regression-geometry-export-bytes', geomOut.byteLength > 0, `bytes=${geomOut.byteLength}`);
  const geomRe = await importAi('sample-geom-re2.ai', geomOut);
  const g2 = [...walk(geomRe.roots)].find((n) => n.kind !== 'group')!;
  assert('regression-geometry-reimport-x', Math.abs(g2.x - g.x) < 2, `x=${g2.x} expected~${g.x}`);

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} AI duplicate export tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} AI duplicate export tests passed`);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

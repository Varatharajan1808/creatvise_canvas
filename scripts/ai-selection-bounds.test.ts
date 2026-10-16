/**
 * AI selection geometry survives export → re-import: the re-imported layer keeps the edited
 * box + rotation (selection outline, transform handles, hit-testing) instead of becoming an
 * axis-aligned box around the whole rendered preview.
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflate } from 'pako';
import { walk, nodeBounds, type Doc, type Node } from '../src/core/model';
import { isPointInLayer } from '../src/canvas/canvasHitTest';
import { aiArtFrame } from '../src/ai/aiPdfLib';

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

type Pt = { x: number; y: number };

/** Same geometry as the `#selbox` overlay and `handleAt` in main.ts: box centre, size, clockwise rotation. */
function handlePoints(n: Node): Pt[] {
  const b = nodeBounds(n)!;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const th = (n.rotation * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const pts: Pt[] = [];
  for (const [hx, hy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
    const lx = (hx * b.w) / 2;
    const ly = (hy * b.h) / 2;
    pts.push({ x: cx + lx * cs - ly * sn, y: cy + lx * sn + ly * cs });
  }
  const rl = -b.h / 2 - 22;
  pts.push({ x: cx - rl * sn, y: cy + rl * cs });
  return pts;
}

function maxPointDistance(a: Pt[], b: Pt[]): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

/** Fraction of grid points (incl. off-artboard) where two layers disagree on hit/miss. */
function hitDisagreement(a: Node, b: Node): { rate: number; hitsA: number; hitsB: number } {
  let diff = 0, total = 0, hitsA = 0, hitsB = 0;
  for (let y = -300; y < 980; y += 4) {
    for (let x = -300; x < 980; x += 4) {
      const ha = isPointInLayer(a, x, y);
      const hb = isPointInLayer(b, x, y);
      if (ha) hitsA++;
      if (hb) hitsB++;
      if (ha !== hb) diff++;
      total++;
    }
  }
  return { rate: diff / Math.max(1, hitsA), hitsA, hitsB };
}

function leaf(doc: Doc): Node {
  return [...walk(doc.roots)].find((n) => n.kind !== 'group' && n.canvas)!;
}

function geom(n: Node): string {
  return `x=${n.x.toFixed(2)} y=${n.y.toFixed(2)} w=${n.w.toFixed(2)} h=${n.h.toFixed(2)} rot=${n.rotation.toFixed(3)}`;
}

function sameGeometry(a: Node, b: Node, tolPx = 0.5, tolDeg = 0.01): boolean {
  return (
    Math.abs(a.x - b.x) <= tolPx &&
    Math.abs(a.y - b.y) <= tolPx &&
    Math.abs(a.w - b.w) <= tolPx &&
    Math.abs(a.h - b.h) <= tolPx &&
    Math.abs(a.rotation - b.rotation) <= tolDeg
  );
}

async function contentStream(buf: ArrayBuffer): Promise<string> {
  const doc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const s = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents'))) as unknown as {
    getContents(): Uint8Array;
  };
  const raw = s.getContents();
  try {
    return new TextDecoder('latin1').decode(inflate(raw));
  } catch {
    return new TextDecoder('latin1').decode(raw);
  }
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

function alphaMask(n: Node, pad = 300, size = 1280): Uint8Array {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  g.translate(pad + n.x + n.w / 2, pad + n.y + n.h / 2);
  g.rotate((n.rotation * Math.PI) / 180);
  g.drawImage(n.canvas as unknown as Canvas, -n.w / 2, -n.h / 2, n.w, n.h);
  const d = g.getImageData(0, 0, size, size).data;
  const m = new Uint8Array(size * size);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

function maskDifference(a: Uint8Array, b: Uint8Array): number {
  let xor = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) union++;
    if (a[i] !== b[i]) xor++;
  }
  return union ? xor / union : 0;
}

async function runTests() {
  const { importAi, exportAi } = await import('../src/ai/ai');
  const buf = fs.readFileSync('public/sample.ai');
  const sampleAb = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const origStream = await contentStream(sampleAb);

  // Original artwork: selection is the untransformed layer box.
  const doc = await importAi('sample.ai', sampleAb.slice(0));
  const n = leaf(doc);
  assert('original-selection-box', n.x === 0 && n.y === 0 && n.w === 680 && n.h === 680 && n.rotation === 0, geom(n));
  assert('original-no-art-frame', aiArtFrame(n) === undefined, 'untransformed layer');

  // Move + scale + rotate (part of the brim leaves the artboard).
  n.w = n.h = 455;
  n.x = -60;
  n.y = 200;
  n.rotation = 56;
  const editedHandles = handlePoints(n);
  const editedMask = alphaMask(n);

  const out = await exportAi(doc);
  const re = await importAi('sample.edited.ai', out);
  const r = leaf(re);
  assert('reimport-selection-geometry', sameGeometry(n, r), `before ${geom(n)} | after ${geom(r)}`);
  const handleDist = maxPointDistance(editedHandles, handlePoints(r));
  assert('reimport-transform-handles', handleDist < 0.75, `max handle offset=${handleDist.toFixed(3)}px`);
  const frame = aiArtFrame(r);
  assert(
    'reimport-art-frame-is-original-layer-box',
    !!frame && frame.x === 0 && frame.y === 0 && frame.w === 680 && frame.h === 680,
    JSON.stringify(frame),
  );
  assert('reimport-import-rotation-baseline', Math.abs((r.importRotation ?? 0) - 56) < 0.01, `importRotation=${r.importRotation}`);
  assert(
    'reimport-raster-in-artwork-frame',
    r.canvas!.width === n.canvas!.width && r.canvas!.height === n.canvas!.height,
    `${r.canvas!.width}x${r.canvas!.height} vs ${n.canvas!.width}x${n.canvas!.height}`,
  );
  const visual = maskDifference(editedMask, alphaMask(r));
  assert('reimport-visible-artwork-matches', visual < 0.02, `mask difference=${visual.toFixed(4)}`);
  const hits = hitDisagreement(n, r);
  assert(
    'reimport-hit-testing-matches',
    hits.rate < 0.02 && hits.hitsB > 0,
    `disagreement=${(hits.rate * 100).toFixed(2)}% hits ${hits.hitsA}/${hits.hitsB}`,
  );
  const offArtboardHit = isPointInLayer(r, -20, 380) === isPointInLayer(n, -20, 380);
  assert('reimport-off-artboard-hit-consistent', offArtboardHit, `hit at (-20,380)=${isPointInLayer(r, -20, 380)}`);
  const cornerHit = isPointInLayer(r, r.x + 2, r.y + 2);
  assert('reimport-empty-corner-not-hit', !cornerHit, 'transparent preview area does not select the layer');

  // Re-imported file exported untouched stays byte-identical (no double transform).
  const reOut = await exportAi(re);
  assert('reimport-unedited-export-identical', buffersEqual(out, reOut), `len ${out.byteLength} vs ${reOut.byteLength}`);

  // Second edit on the re-imported layer replaces the transform instead of nesting another one.
  r.x += 30;
  r.rotation = 20;
  const second = await exportAi(re);
  const secondStream = await contentStream(second);
  const cmCount = (secondStream.match(/^-?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ cm$/gm) ?? []).length;
  assert('second-edit-single-layer-transform', cmCount === 1, `layer-level cm count=${cmCount}`);
  const re2 = await importAi('sample.edited2.ai', second);
  assert('second-edit-reimport-geometry', sameGeometry(r, leaf(re2)), `before ${geom(r)} | after ${geom(leaf(re2))}`);

  // Putting the layer back on its artwork frame removes the transform: stream equals the original.
  const r2 = leaf(re2);
  const f2 = aiArtFrame(r2)!;
  r2.x = f2.x;
  r2.y = f2.y;
  r2.w = f2.w;
  r2.h = f2.h;
  r2.rotation = 0;
  const reset = await exportAi(re2);
  assert('reset-restores-original-stream', (await contentStream(reset)) === origStream, 'content stream identical to sample.ai');
  const re3 = leaf(await importAi('sample.reset.ai', reset));
  assert('reset-reimport-selection', re3.x === 0 && re3.y === 0 && re3.w === 680 && re3.h === 680 && re3.rotation === 0, geom(re3));

  // Move-only edit (no rotation) also round-trips.
  const mDoc = await importAi('sample.ai', sampleAb.slice(0));
  const m = leaf(mDoc);
  m.x = 120;
  m.y = -40;
  const mRe = leaf(await importAi('sample.moved.ai', await exportAi(mDoc)));
  assert('move-only-reimport-geometry', sameGeometry(m, mRe), `before ${geom(m)} | after ${geom(mRe)}`);

  console.log('--- Summary ---');
  const failures = results.filter((x) => !x.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} AI selection tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} AI selection tests passed`);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

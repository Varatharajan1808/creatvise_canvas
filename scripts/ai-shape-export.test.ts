/**
 * AI PDF rectangle shapes: import detects editable rects; export patches rg/RG/w in content stream.
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { applyShapeColor, applyShapeBorder } from '../src/edit';
import {
  applyAiVectorShapeImport,
  parsePdfRectShapes,
  readFirstPageContentStreamText,
  pdfRgbFillToken,
} from '../src/aiVectorShapes';
import type { Doc } from '../src/model';

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
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

async function runTests() {
  const fixturePath = 'public/fixtures/ai/simple-shapes.ai';
  const buf = fs.readFileSync(fixturePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const stream = await readFirstPageContentStreamText(ab);
  assert('fixture-stream', !!stream, stream ? `h=${stream.pageHeight}` : 'missing');
  const parsed = stream ? parsePdfRectShapes(stream.text, stream.pageHeight) : [];
  assert('fixture-parse-count', parsed.length === 1, `count=${parsed.length}`);
  assert(
    'fixture-bounds',
    parsed[0]?.x === 50 && parsed[0]?.y === 50 && parsed[0]?.w === 120 && parsed[0]?.h === 80,
    JSON.stringify(parsed[0] ? { x: parsed[0].x, y: parsed[0].y, w: parsed[0].w, h: parsed[0].h } : null),
  );

  const { exportAi } = await import('../src/ai');
  const doc: Doc = {
    id: 'shape-fixture',
    name: 'simple-shapes.ai',
    format: 'ai',
    width: 400,
    height: 300,
    offsetX: 0,
    offsetY: 0,
    roots: [],
    original: ab.slice(0),
    warnings: [],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: false,
      ocgNames: [],
      ocgRefs: [],
      hasExtGStateOpacity: true,
      extGStateCaAtImport: 1,
    },
  };
  await applyAiVectorShapeImport(doc);
  const shapes = [...doc.roots].filter((n) => n.kind === 'shape');
  assert('import-shape-nodes', shapes.length === 1, `roots=${doc.roots.length} kind=${doc.roots[0]?.kind}`);
  const shape = shapes[0]!;
  applyShapeColor(shape, { r: 255, g: 0, b: 0 });
  applyShapeBorder(shape, { enabled: true, width: 4, color: { r: 0, g: 255, b: 0 } });

  const exported = await exportAi(doc);
  const expStream = await readFirstPageContentStreamText(exported);
  assert('export-stream', !!expStream, expStream ? `len=${expStream.text.length}` : '');
  const fillToken = pdfRgbFillToken(255, 0, 0);
  assert(
    'export-fill-patched',
    !!expStream?.text.includes(fillToken),
    `want ${fillToken} in stream`,
  );
  assert(
    'export-stroke-patched',
    !!expStream?.text.includes('0.000 1.000 0.000 RG') || !!expStream?.text.includes('0.000 1.000 0.000 RG'.replace(/0\.000/g, '0.000')),
    expStream?.text.match(/[\d.]+\s+[\d.]+\s+[\d.]+\s+RG/)?.[0] ?? 'no RG',
  );
  assert(
    'export-stroke-width',
    !!expStream?.text.includes('4 w'),
    expStream?.text.match(/[\d.]+\s+w/)?.[0] ?? '',
  );
  assert('export-still-pdf', new TextDecoder('latin1').decode(new Uint8Array(exported).slice(0, 5)) === '%PDF-', 'header');

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} AI shape tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} AI shape tests passed`);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

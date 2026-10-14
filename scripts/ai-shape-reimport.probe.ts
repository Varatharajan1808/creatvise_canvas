import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { applyShapeColor, applyShapeBorder, getShapeColor, getShapeBorderInfo } from '../src/edit';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
window.document.createElement = ((tag: string) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return window.document.createElement(tag);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

async function main() {
  const { GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;

  const { importAi, exportAi } = await import('../src/ai');

  const buf = fs.readFileSync('public/fixtures/ai/simple-shapes.ai');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let doc = await importAi('simple-shapes.ai', ab.slice(0));
  console.log('import1 roots', doc.roots.map((r) => [r.kind, r.key, getShapeColor(r)]));
  const shape = doc.roots.find((n) => n.kind === 'shape') ?? doc.roots[0];
  applyShapeColor(shape, { r: 255, g: 0, b: 0 });
  applyShapeBorder(shape, { enabled: true, width: 4, color: { r: 0, g: 255, b: 0 } });

  const exported = await exportAi(doc);
  doc = await importAi('simple-shapes.edited.ai', exported);
  console.log('import2 roots', doc.roots.map((r) => [r.kind, r.key, getShapeColor(r), getShapeBorderInfo(r)]));

  // DarkTech move roundtrip
  const dt = fs.readFileSync('public/DarkTech_Screen.ai');
  const dtAb = dt.buffer.slice(dt.byteOffset, dt.byteOffset + dt.byteLength);
  let dtDoc = await importAi('DarkTech_Screen.ai', dtAb.slice(0));
  const leaf = dtDoc.roots[0];
  console.log('darktech import kind', leaf?.kind, leaf?.key, leaf?.x, leaf?.y);
  leaf.x += 40;
  leaf.y += 30;
  const dtOut = await exportAi(dtDoc);
  const dtDoc2 = await importAi('DarkTech.edited.ai', dtOut);
  const leaf2 = dtDoc2.roots[0];
  console.log('darktech reimport pos', leaf2?.x, leaf2?.y, 'same as import', leaf2?.x === 0 && leaf2?.y === 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import fs from 'node:fs';
import { Window } from 'happy-dom';
import { importIdml } from '../src/idml';
import { leaves } from '../src/model';

const window = new Window();
(globalThis as any).DOMParser = window.DOMParser;
(globalThis as any).document = window.document;

const path = process.argv[2] ?? 'artifacts/poc/poc-b/step1-exported.idml';
const buf = fs.readFileSync(path);
const doc = await importIdml('debug.idml', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log('roots', doc.roots.length);
for (const n of leaves(doc)) {
  console.log(
    JSON.stringify({
      kind: n.kind,
      name: n.name,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      text: n.src?.text?.text,
      epoch: n.previewContentEpoch,
      canvas: n.canvas ? [n.canvas.width, n.canvas.height] : null,
      ctx2d: Boolean(n.canvas?.getContext('2d')),
    }),
  );
}

/**
 * Flatten imported magazine doc to PNG for manual comparison with InDesign (dev aid).
 * Output: artifacts/fixtures/free_317277841/canvas-import-preview.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';

const window = new Window();
globalThis.DOMParser = window.DOMParser;
globalThis.document = window.document;

const { importIdml } = await import('../src/idml.ts');
const { leaves } = await import('../src/model.ts');

const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
const outPath = path.join('artifacts', 'fixtures', 'free_317277841', 'canvas-import-preview.png');

const buf = fs.readFileSync(idmlPath);
const doc = await importIdml(
  'magazine.idml',
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  'indd',
);

const W = Math.round(doc.width);
const H = Math.round(doc.height);
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, W, H);

function blitNode(targetCtx, n) {
  const src = n.canvas;
  const sctx = src.getContext('2d');
  if (!sctx) return;
  const { data, width, height } = sctx.getImageData(0, 0, src.width, src.height);
  const layer = createCanvas(width, height);
  layer.getContext('2d').putImageData({ data, width, height }, 0, 0);
  targetCtx.save();
  targetCtx.translate(n.x + n.w / 2, n.y + n.h / 2);
  targetCtx.rotate((-n.rotation * Math.PI) / 180);
  targetCtx.drawImage(layer, -n.w / 2, -n.h / 2, n.w, n.h);
  targetCtx.restore();
}

for (const n of leaves(doc)) {
  if (!n.canvas || !n.visible) continue;
  blitNode(ctx, n);
}

fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log('Wrote', outPath, W + 'x' + H);

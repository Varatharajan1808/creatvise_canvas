/**
 * Composite magazine import and sample layout pixels (proxy for visual regression).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { importIdml } from '../src/indd/idml';
import { leaves } from '../src/core/model';
import type { Node } from '../src/core/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');

function blitNode(targetCtx: CanvasRenderingContext2D, n: Node) {
  const src = n.canvas;
  if (!src) return;
  const sctx = src.getContext('2d');
  if (!sctx) return;
  const { data, width, height } = sctx.getImageData(0, 0, src.width, src.height);
  const layer = createCanvas(width, height);
  layer.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
  targetCtx.save();
  targetCtx.translate(n.x + n.w / 2, n.y + n.h / 2);
  targetCtx.rotate((-n.rotation * Math.PI) / 180);
  targetCtx.drawImage(layer as unknown as CanvasImageSource, -n.w / 2, -n.h / 2, n.w, n.h);
  targetCtx.restore();
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  if (!fs.existsSync(idmlPath)) {
    log('fixture', false, 'missing idml');
    process.exit(1);
  }
  const buf = fs.readFileSync(idmlPath);
  const doc = await importIdml(
    'magazine.idml',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    'indd',
  );
  const W = Math.round(doc.width);
  const H = Math.round(doc.height);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  for (const n of leaves(doc)) blitNode(ctx, n);

  const outPath = path.join('artifacts', 'fixtures', 'free_317277841', 'canvas-import-preview.png');
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  log('preview-written', fs.existsSync(outPath), outPath);

  log('five-page-doc', doc.idml?.pages?.length === 5, String(doc.idml?.pages?.length));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * IDML text raster: DPR-scaled backing store + high-contrast glyph pixels (magazine title).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Window } from 'happy-dom';
import { importIdml } from '../src/indd/idml';
import { idmlTextRasterScale, rasterizeIdmlTextNode, countVisibleTextPixels } from '../src/indd/rasterText';
import { leaves } from '../src/core/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (!fs.existsSync(idmlPath)) {
    log('fixture', false, 'missing');
    process.exit(1);
  }
  const buf = fs.readFileSync(idmlPath);
  const doc = await importIdml(
    'magazine.idml',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    'indd',
  );
  const u1fd = leaves(doc).find((n) => n.idml?.self === 'u1fd');
  if (!u1fd) {
    log('u1fd', false, 'missing');
    process.exit(1);
  }

  const prevDpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
  const scale = idmlTextRasterScale();
  log('raster-scale-dpr2', scale === 2, String(scale));

  u1fd.canvas = createCanvas(Math.max(1, u1fd.w), Math.max(1, u1fd.h)) as unknown as HTMLCanvasElement;
  rasterizeIdmlTextNode(u1fd);
  log(
    'canvas-backing-2x',
    u1fd.canvas.width === Math.round(u1fd.w * 2) && u1fd.canvas.height === Math.round(u1fd.h * 2),
    `${u1fd.canvas.width}x${u1fd.canvas.height} w=${u1fd.w} h=${u1fd.h}`,
  );

  const visible = countVisibleTextPixels(u1fd.canvas);
  log('title-visible-pixels', visible > 3000, String(visible));
  log('title-font-60', u1fd.src?.text?.style?.fontSize === 60, String(u1fd.src?.text?.style?.fontSize));

  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = prevDpr;

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

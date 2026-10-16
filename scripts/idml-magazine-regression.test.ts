/**
 * Real magazine IDML (from free_317277841.indd): no renderer fallback blue, object-style fills resolved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { importIdml } from '../src/idml';
import { cmykToRgbHex } from '../src/idml/swatches';
import { leaves } from '../src/model';

const FALLBACK_BLUE = '#4f6bff';
const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function countBluePixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 10) continue;
      if (data[i] === 0x4f && data[i + 1] === 0x6b && data[i + 2] === 0xff) n++;
    }
  }
  return n;
}

async function main() {
  if (!fs.existsSync(idmlPath)) {
    log('fixture-present', false, `missing ${idmlPath} — run scripts/_convert-magazine-idml.mjs`);
    process.exit(1);
  }
  const buf = fs.readFileSync(idmlPath);
  const doc = await importIdml('magazine.idml', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'indd');
  const all = leaves(doc);
  log('five-pages', doc.idml?.pages?.length === 5, String(doc.idml?.pages?.length));
  log('layer-count', all.length >= 35, `leaves=${all.length}`);
  log('uad5-on-page5', all.some((n) => n.idml?.self === 'uad5' && n.idml?.pageIndex === 5), 'page 5 item present');

  const blueMeta = all.filter((n) => n.idml?.fillColor?.toLowerCase() === FALLBACK_BLUE);
  log('no-fallback-blue-meta', blueMeta.length === 0, `count=${blueMeta.length}`);

  let bluePixels = 0;
  for (const n of all) {
    if (n.canvas) bluePixels += countBluePixels(n.canvas);
  }
  log('no-fallback-blue-pixels', bluePixels === 0, `bluePixels=${bluePixels}`);

  const color1 = cmykToRgbHex(60, 14, 11, 84).toLowerCase();
  const withColor1 = all.filter((n) => n.idml?.fillColor?.toLowerCase() === color1);
  log('color-1-fill-present', withColor1.length > 0, `layers=${withColor1.length} hex=${color1}`);

  const largest = [...all].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  log('largest-teal-on-later-page', largest?.idml?.pageIndex !== 1, `self=${largest?.idml?.self} page=${largest?.idml?.pageIndex}`);
  log(
    'largest-not-blue',
    largest?.idml?.fillColor?.toLowerCase() !== FALLBACK_BLUE,
    `self=${largest?.idml?.self} fill=${largest?.idml?.fillColor} ${largest?.w}x${largest?.h}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

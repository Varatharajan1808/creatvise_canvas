/**
 * Magazine IDML typography: paragraph/character styles from Styles.xml (not 12pt defaults).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Window } from 'happy-dom';
import { importIdml } from '../src/idml';
import { cmykToRgbHex } from '../src/idml/swatches';
import { rasterizeIdmlTextNode, countTextGlyphPixels } from '../src/idml/rasterText';
import { leaves } from '../src/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
const color1 = cmykToRgbHex(60, 14, 11, 84).toLowerCase();

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};
const near = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps;

function countVisibleTextPixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 20) n++;
  }
  return n;
}

async function main() {
  if (!fs.existsSync(idmlPath)) {
    log('fixture', false, 'missing');
    process.exit(1);
  }
  const buf = fs.readFileSync(idmlPath);
  const doc = await importIdml('magazine.idml', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'indd');
  const bySelf = (self: string) => leaves(doc).find((n) => n.idml?.self === self);

  const u1fd = bySelf('u1fd');
  log('u1fd-font-60', u1fd?.src?.text?.style?.fontSize === 60, String(u1fd?.src?.text?.style?.fontSize));
  log(
    'u1fd-color-1',
    (u1fd?.src?.text?.style?.fillColor as { r?: number }) !== undefined &&
      u1fd?.src?.text?.style?.fillColor &&
      color1.startsWith('#'),
    `hex meta fill=${u1fd?.idml?.fillColor}`,
  );
  const u1fdHex = u1fd?.src?.text?.style?.fillColor
    ? `#${[u1fd.src.text.style.fillColor.r, u1fd.src.text.style.fillColor.g, u1fd.src.text.style.fillColor.b]
        .map((v) => Math.round(v!).toString(16).padStart(2, '0'))
        .join('')}`
    : '';
  log('u1fd-text-color', u1fdHex.toLowerCase() === color1, u1fdHex);

  const u222 = bySelf('u222');
  log('u222-font-9', u222?.src?.text?.style?.fontSize === 9, String(u222?.src?.text?.style?.fontSize));

  const u251 = bySelf('u251');
  log('u251-font-10', u251?.src?.text?.style?.fontSize === 10, String(u251?.src?.text?.style?.fontSize));
  log(
    'u251-white-text',
    u251?.src?.text?.style?.fillColor?.r === 255,
    `r=${u251?.src?.text?.style?.fillColor?.r}`,
  );

  if (u1fd) {
    u1fd.canvas = createCanvas(Math.max(1, u1fd.w), Math.max(1, u1fd.h)) as unknown as HTMLCanvasElement;
    rasterizeIdmlTextNode(u1fd);
    const darkGlyphs = countTextGlyphPixels(u1fd.canvas!);
    const anyGlyphs = countVisibleTextPixels(u1fd.canvas!);
    log('u1fd-glyphs-visible', darkGlyphs > 80 || anyGlyphs > 200, `dark=${darkGlyphs} any=${anyGlyphs}`);
  }

  const perPage = [1, 2, 3, 4, 5].map((p) => leaves(doc).filter((n) => n.idml?.pageIndex === p).length);
  log('per-page-counts', perPage.join(',') === '10,9,9,8,6', perPage.join(','));

  log('u1fd-pos', near(u1fd?.x ?? 0, 74, 3) && near(u1fd?.y ?? 0, 223, 3), `x=${u1fd?.x} y=${u1fd?.y}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

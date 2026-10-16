/**
 * IDML text: mesh rotation + page stack (Magazine fixture page 1 frames).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { importIdml } from '../src/indd/idml';
import { leaves } from '../src/core/model';
import { rasterizeIdmlTextNode, countTextGlyphPixels } from '../src/indd/rasterText';
import { isPointInLayer } from '../src/canvas/canvasHitTest';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const near = (a: number, b: number, eps = 2) => Math.abs(a - b) <= eps;
const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
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
  const bySelf = new Map(leaves(doc).map((n) => [n.idml?.self, n]));

  const magazine = bySelf.get('u1fd');
  const monthly = bySelf.get('u222');
  const side = bySelf.get('u239');
  const body = bySelf.get('u251');

  log('magazine-u1fd', magazine?.w! > magazine?.h! && magazine?.rotation === 0, `${magazine?.w}x${magazine?.h} rot=${magazine?.rotation}`);
  log('magazine-u1fd-y', near(magazine?.y ?? 0, 223), String(magazine?.y));
  log('monthly-u222-rot', near(monthly?.rotation ?? 0, -90, 0.5), String(monthly?.rotation));
  log('monthly-u222-wide-local', monthly?.w! > monthly?.h!, `${monthly?.w}x${monthly?.h}`);
  log('side-u239-page1', side?.idml?.pageIndex === 1, String(side?.idml?.pageIndex));
  log('body-u251-page1', body?.idml?.pageIndex === 1, String(body?.idml?.pageIndex));

  if (monthly?.canvas) {
    monthly.canvas = createCanvas(monthly.w, monthly.h) as unknown as HTMLCanvasElement;
    rasterizeIdmlTextNode(monthly);
    log('monthly-glyphs', countTextGlyphPixels(monthly.canvas) > 5, 'ok');
    const cx = (monthly.x ?? 0) + monthly.w / 2;
    const cy = (monthly.y ?? 0) + monthly.h / 2;
    log('monthly-hit-center', isPointInLayer(monthly, cx, cy), `${cx},${cy}`);
  }

  if (magazine?.canvas) {
    magazine.canvas = createCanvas(magazine.w, magazine.h) as unknown as HTMLCanvasElement;
    rasterizeIdmlTextNode(magazine);
    log(
      'magazine-glyphs-visible',
      countTextGlyphPixels(magazine.canvas) > 500 && magazine.src?.text?.style?.fontSize === 60,
      `glyphs=${countTextGlyphPixels(magazine.canvas)} pt=${magazine.src?.text?.style?.fontSize}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * IDML text frame: hit-test uses document bounds, not glyph alpha (sparse raster).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Window } from 'happy-dom';
import {
  hitTestCanvasLayer,
  idmlTextUsesBoundsHitTest,
  isPointInLayer,
  readCanvasAlpha,
} from '../src/canvasHitTest';
import { importIdml } from '../src/idml';
import { rasterizeIdmlTextNode } from '../src/idml/rasterText';
import type { Doc, Node } from '../src/model';
import { leaves } from '../src/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function viewportScreenToDoc(
  doc: Doc,
  sx: number,
  sy: number,
  vp: { width: number; height: number; cx: number; cy: number; zoom: number },
) {
  const w = {
    x: vp.cx + (sx - vp.width / 2) / vp.zoom,
    y: vp.cy - (sy - vp.height / 2) / vp.zoom,
  };
  return { x: w.x - doc.offsetX, y: -w.y - doc.offsetY };
}

function docToScreen(
  doc: Doc,
  px: number,
  py: number,
  vp: { width: number; height: number; cx: number; cy: number; zoom: number },
) {
  const wx = doc.offsetX + px;
  const wy = -(doc.offsetY + py);
  return {
    sx: (wx - vp.cx) * vp.zoom + vp.width / 2,
    sy: -(wy - vp.cy) * vp.zoom + vp.height / 2,
  };
}

function hitAtScreen(
  doc: Doc,
  sx: number,
  sy: number,
  vp: { width: number; height: number; cx: number; cy: number; zoom: number },
) {
  return hitTestCanvasLayer({
    docs: [doc],
    screenToDoc: (d, x, y) => viewportScreenToDoc(d, x, y, vp),
  }, sx, sy);
}

async function main() {
  const pocCandidate = path.join('artifacts', 'poc', 'poc-b', 'step1-exported.idml');
  const sampleCandidate = path.join('artifacts', 'fixtures', 'sample-creatvise.idml');
  const pocPath = fs.existsSync(pocCandidate) ? pocCandidate : sampleCandidate;
  if (!fs.existsSync(pocPath)) {
    log('poc-fixture', false, `missing ${pocPath}`);
    process.exit(1);
  }
  log('fixture-loaded', true, pocPath);
  const buf = fs.readFileSync(pocPath);
  const doc = await importIdml(
    'hit.idml',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  const text = leaves(doc).find((n) => n.kind === 'text');
  if (!text?.canvas) {
    log('text-node', false, 'no text layer');
    process.exit(1);
  }

  text.canvas = createCanvas(text.w * 2, text.h * 2) as unknown as HTMLCanvasElement;
  rasterizeIdmlTextNode(text);

  log('bounds-hit-flag', idmlTextUsesBoundsHitTest(text), 'idml text uses bounds');
  const centerAlpha = readCanvasAlpha(text.canvas, text.canvas.width / 2, text.canvas.height / 2);
  log('center-alpha-sparse', centerAlpha <= 8, `alpha=${centerAlpha}`);

  const { x, y, w, h } = text;
  log('corner-tl', isPointInLayer(text, x + 1, y + 1), `(${x + 1},${y + 1})`);
  log('corner-br', isPointInLayer(text, x + w - 2, y + h - 2), `(${x + w - 2},${y + h - 2})`);
  log('center-empty', isPointInLayer(text, x + w / 2, y + h / 2), 'frame center');
  log('on-glyph', isPointInLayer(text, x + 4, y + 4), 'near top-left inset');
  log('outside', !isPointInLayer(text, x - 5, y - 5), 'off frame');
  log('outside-right', !isPointInLayer(text, x + w + 10, y + h / 2), 'right of frame');

  text.rotation = 90;
  log('rotated-center', isPointInLayer(text, x + w / 2, y + h / 2), 'rotated frame center');
  text.rotation = 0;

  const vpBase = {
    width: 800,
    height: 600,
    cx: x + w / 2,
    cy: -(y + h / 2),
    zoom: 1,
  };
  const centerPx = x + w / 2;
  const centerPy = y + h / 2;
  const screenCenter = docToScreen(doc, centerPx, centerPy, vpBase);
  const hit1 = hitAtScreen(doc, screenCenter.sx, screenCenter.sy, vpBase);
  log('screen-hit-zoom-1', hit1 === text, hit1?.name ?? 'null');

  for (const zoom of [0.5, 2, 4]) {
    const vp = { ...vpBase, zoom };
    const scr = docToScreen(doc, centerPx, centerPy, vp);
    const hit = hitAtScreen(doc, scr.sx, scr.sy, vp);
    log(`screen-hit-zoom-${zoom}`, hit === text, hit?.name ?? 'null');
  }

  const beforeX = text.x;
  const beforeY = text.y;
  text.x += 40;
  text.y += 25;
  log('move-preserved-bounds', text.x === beforeX + 40 && text.y === beforeY + 25, `${beforeX},${beforeY} -> ${text.x},${text.y}`);
  log('hit-after-move', isPointInLayer(text, text.x + text.w / 2, text.y + text.h / 2), 'center after move');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

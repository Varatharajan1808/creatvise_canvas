/**
 * IDML imported rectangles: selectable hit-test + movable via leavesForPositionEdit (not PSD shape block).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Window } from 'happy-dom';
import { importIdml } from '../src/indd/idml';
import { isPointInLayer, hitTestCanvasLayer } from '../src/canvas/canvasHitTest';
import { canEditLayerPosition, canEditPsdLayerPosition, leavesForPositionEdit } from '../src/psd/psdLayerInfo';
import { moveLeavesBy } from '../src/canvas/selection';
import { leaves } from '../src/core/model';
import type { Doc } from '../src/core/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function identityScreenToDoc(_d: Doc, sx: number, sy: number) {
  return { x: sx, y: sy };
}

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
  const bySelf = new Map(leaves(doc).map((n) => [n.idml?.self, n]));
  const teal = bySelf.get('u202');
  const grey = bySelf.get('u204');

  log('teal-is-shape', teal?.kind === 'shape', String(teal?.kind));
  log('teal-not-locked', teal?.locked !== true, String(teal?.locked));
  log('teal-idml-movable', canEditLayerPosition(teal!), `psdOnly=${canEditPsdLayerPosition(teal!)}`);
  log('teal-leaves-for-move', leavesForPositionEdit(teal!).length === 1, String(leavesForPositionEdit(teal!).length));

  if (teal) {
    const probeX = teal.x + Math.min(24, teal.w * 0.15);
    const probeY = teal.y + teal.h - Math.min(24, teal.h * 0.15);
    log('teal-hit-probe', isPointInLayer(teal, probeX, probeY), `${probeX},${probeY}`);
    const hit = hitTestCanvasLayer({ docs: [doc], screenToDoc: identityScreenToDoc }, probeX, probeY);
    log('teal-canvas-hit-probe', hit?.idml?.self === 'u202', hit?.idml?.self ?? 'null');
    const stackCx = teal.x + teal.w / 2;
    const stackCy = teal.y + teal.h / 2;
    const topAtCenter = hitTestCanvasLayer({ docs: [doc], screenToDoc: identityScreenToDoc }, stackCx, stackCy);
    log(
      'overlap-center-top-layer',
      topAtCenter?.idml?.self === 'u204' || topAtCenter?.idml?.self === 'u202',
      `top=${topAtCenter?.idml?.self}`,
    );

    const x0 = teal.x;
    const y0 = teal.y;
    moveLeavesBy(leavesForPositionEdit(teal), 12, -8);
    log('teal-drag-delta', teal.x === x0 + 12 && teal.y === y0 - 8, `${x0},${y0} -> ${teal.x},${teal.y}`);
  }

  if (grey) {
    log('grey-movable', canEditLayerPosition(grey), String(grey.kind));
    const gx = grey.x + grey.w / 2;
    const gy = grey.y + grey.h / 2;
    log('grey-hit-center', isPointInLayer(grey, gx, gy), `${gx},${gy}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

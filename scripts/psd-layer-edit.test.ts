/**
 * PSD layer editing policy (10960916 double-exposure template).
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd } from '../src/psd/psd';
import { walk } from '../src/core/model';
import {
  canEditPsdLayerPosition,
  classifyPsdNodeKind,
  isPsdCanvasPickTarget,
  leavesForPositionEdit,
} from '../src/psd/psdLayerInfo';

const fixturePath =
  process.argv[2] ?? process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

if (!fs.existsSync(fixturePath)) {
  console.log(`SKIP: fixture not found (${fixturePath})`);
  process.exit(0);
}

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const buf = fs.readFileSync(fixturePath);
const doc = importPsd(path.basename(fixturePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const byName = (name: string) => [...walk(doc.roots)].find((n) => n.name === name)!;
const leafByName = (name: string) => [...walk(doc.roots)].find((n) => n.name === name && n.kind !== 'group')!;

const bgChild = leafByName('Background');
log('background-not-shape', bgChild.kind === 'raster', bgChild.kind);
log('background-movable', canEditPsdLayerPosition(bgChild), String(canEditPsdLayerPosition(bgChild)));
log(
  'background-not-pick-stealer',
  !isPsdCanvasPickTarget(bgChild, doc),
  'full-canvas fill excluded from hit test',
);

const layer1 = byName('Layer 1');
log('layer1-raster', layer1.kind === 'raster', layer1.kind);
log('layer1-movable', canEditPsdLayerPosition(layer1), 'true');
log('layer1-pickable', isPsdCanvasPickTarget(layer1), 'true');

const image2 = byName('Image 2');
log('image2-smart-object-movable', canEditPsdLayerPosition(image2), 'smart object preview');
log('image2-unsupported', image2.unsupported.some((u) => u.includes('Smart object')), image2.unsupported.join(';'));

const levels = byName('Levels 1');
log('adjustment-not-movable', !canEditPsdLayerPosition(levels), 'adjustment');
log('adjustment-not-pickable', !isPsdCanvasPickTarget(levels), 'no canvas');

const bgGroup = doc.roots.find((n) => n.name === 'Background' && n.kind === 'group')!;
log('background-group-move-leaves', leavesForPositionEdit(bgGroup).length === 1, String(leavesForPositionEdit(bgGroup).length));

log('static-composite-until-edit', doc.psdStaticComposite === true && doc.psdPreviewMode === 'file-composite', String(doc.psdPreviewMode));

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

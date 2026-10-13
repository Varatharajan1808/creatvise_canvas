/**
 * Phase 3 — ghost-removal experiment (NOT production).
 * Clones embedded composite, alpha-shaped destination-out at import pose for one moved layer,
 * reports pixel deltas in old bounds, ring, and doc-wide samples.
 *
 * Run: tsx scripts/psd-ghost-erase-experiment.ts [psd-path]
 * Exit 0 always (informational); inspect JSON for acceptability.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd } from '../src/psd';
import { effOpacity, leaves } from '../src/model';
import { canEditPsdLayerPosition } from '../src/psdLayerInfo';
import { composeDocPreviewWithFileBase, countAdjustmentLayers } from '../src/psdComposite';

const fixture =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');

if (!fs.existsSync(fixture)) {
  console.log(JSON.stringify({ skip: true, reason: 'fixture missing', path: fixture }));
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

function sample(c: HTMLCanvasElement, x: number, y: number) {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]] as const;
}

function meanAbsDiff(a: HTMLCanvasElement, b: HTMLCanvasElement, step: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const pa = sample(a, x, y);
      const pb = sample(b, x, y);
      sum += Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]) + Math.abs(pa[3] - pb[3]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

function eraseLayerFootprint(
  base: HTMLCanvasElement,
  layerCanvas: HTMLCanvasElement,
  ox: number,
  oy: number,
  ow: number,
  oh: number,
): HTMLCanvasElement {
  const out = createCanvas(base.width, base.height) as unknown as HTMLCanvasElement;
  const g = out.getContext('2d')!;
  g.drawImage(base, 0, 0);
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(layerCanvas, ox, oy, ow, oh);
  g.restore();
  return out;
}

const buf = fs.readFileSync(fixture);
const doc = importPsd(path.basename(fixture), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const embedded = doc.fileComposite!;
const leaf = leaves(doc).find(
  (n) =>
    canEditPsdLayerPosition(n) &&
    n.canvas &&
    n.w > 0 &&
    n.h > 0 &&
    effOpacity(n) > 0.01 &&
    !(n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1),
)!;
if (!leaf) {
  console.log(JSON.stringify({ skip: true, reason: 'no suitable editable leaf' }));
  process.exit(0);
}

const dx = 80;
const dy = 40;
leaf.x += dx;
leaf.y += dy;

const step = Math.max(1, Math.floor(Math.min(doc.width, doc.height) / 60));

const baselineOverlay = composeDocPreviewWithFileBase(doc)!;
const working = eraseLayerFootprint(embedded, leaf.canvas!, leaf.ox, leaf.oy, leaf.ow, leaf.oh);

const experimental = createCanvas(doc.width, doc.height) as unknown as HTMLCanvasElement;
const eg = experimental.getContext('2d')!;
eg.drawImage(working, 0, 0);
eg.globalAlpha = effOpacity(leaf);
eg.drawImage(leaf.canvas!, leaf.x, leaf.y, leaf.w, leaf.h);

const x0 = Math.floor(leaf.ox);
const y0 = Math.floor(leaf.oy);
const x1 = Math.ceil(leaf.ox + leaf.ow);
const y1 = Math.ceil(leaf.oy + leaf.oh);

let transparentInOldBounds = 0;
let oldBoundSamples = 0;
for (let y = y0; y < y1; y += step) {
  for (let x = x0; x < x1; x += step) {
    oldBoundSamples++;
    if (sample(working, x, y)[3] < 8) transparentInOldBounds++;
  }
}

const report = {
  fixture: path.basename(fixture),
  docSize: [doc.width, doc.height],
  adjustmentLayers: countAdjustmentLayers(doc),
  movedLayer: { ox: leaf.ox, oy: leaf.oy, ow: leaf.ow, oh: leaf.oh, dx, dy },
  transparentFractionInOldBounds: oldBoundSamples ? transparentInOldBounds / oldBoundSamples : 0,
  meanAbsDiff: {
    embedded_vs_baselineOverlay: meanAbsDiff(embedded, baselineOverlay, step),
    embedded_vs_experimental: meanAbsDiff(embedded, experimental, step),
    baselineOverlay_vs_experimental: meanAbsDiff(baselineOverlay, experimental, step),
  },
  productionEnabled: false,
  recommendation:
    'Do not enable alpha-shaped erasure in production unless transparentFractionInOldBounds is acceptable and baselineOverlay_vs_experimental improves ghost without large doc-wide drift.',
};

console.log(JSON.stringify(report, null, 2));

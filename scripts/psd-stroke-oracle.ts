/**
 * Node oracle for stroke fixture (2D composeDocPreview pixels + preview mode).
 */
import { buildStrokeFixturePsd, STROKE_FIXTURE } from './write-stroke-fixture';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd } = await import('../src/psd/psd');
const { composeDocPreview, docUsesFullDocPreview } = await import('../src/psd/psdComposite');
const { leaves } = await import('../src/core/model');

const doc = importPsd('stroke.psd', buildStrokeFixturePsd());
const leaf = leaves(doc)[0]!;
const before = leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data;
const preview = composeDocPreview(doc);
const ctx = preview.getContext('2d')!;

const strokeProbeColors: number[][] = [];
for (const [x, y] of STROKE_FIXTURE.strokeProbes) {
  const p = ctx.getImageData(x, y, 1, 1).data;
  strokeProbeColors.push([...p]);
}

const [lx, ly] = STROKE_FIXTURE.layerProbe;
const layerPx = [...ctx.getImageData(lx, ly, 1, 1).data];

const [ox, oy] = STROKE_FIXTURE.outsideProbe;
const outsidePx = [...ctx.getImageData(ox, oy, 1, 1).data];

console.log(
  JSON.stringify({
    psdPreviewMode: doc.psdPreviewMode,
    usesFullDocPreview: docUsesFullDocPreview(doc),
    layerSourceAlpha: before[3],
    strokeProbeColors,
    layerProbe: layerPx,
    outsideProbe: outsidePx,
    fitCenter: { cx: STROKE_FIXTURE.docW / 2, cy: -STROKE_FIXTURE.docH / 2 },
  }),
);

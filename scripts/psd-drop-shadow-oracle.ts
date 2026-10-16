/**
 * Node oracle for drop-shadow fixture (2D composeDocPreview pixels + preview mode).
 */
import { buildDropShadowFixturePsd, DROP_SHADOW_FIXTURE } from './write-drop-shadow-fixture';
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

const doc = importPsd('drop-shadow.psd', buildDropShadowFixturePsd());
const leaf = leaves(doc)[0]!;
const before = leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data;
const preview = composeDocPreview(doc);
const ctx = preview.getContext('2d')!;
let minShadowGray = 255;
for (const [x, y] of DROP_SHADOW_FIXTURE.shadowProbes) {
  const g = ctx.getImageData(x, y, 1, 1).data[0]!;
  if (g < minShadowGray) minShadowGray = g;
}
const [lx, ly] = DROP_SHADOW_FIXTURE.layerProbe;
const layerPx = [...ctx.getImageData(lx, ly, 1, 1).data];

console.log(
  JSON.stringify({
    psdPreviewMode: doc.psdPreviewMode,
    usesFullDocPreview: docUsesFullDocPreview(doc),
    layerSourceAlpha: before[3],
    minShadowGray,
    layerProbe: layerPx,
    fitCenter: { cx: DROP_SHADOW_FIXTURE.docW / 2, cy: -DROP_SHADOW_FIXTURE.docH / 2 },
  }),
);

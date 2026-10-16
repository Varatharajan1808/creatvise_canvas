/**
 * Gray-aware layer masks (defaultColor, no mutation of the source mask) and per-pixel blend modes.
 * Synthetic PSDs only; no fixtures required.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd, exportPsd } = await import('../src/psd/psd');
const { leaves } = await import('../src/core/model');
const { composeDocPreview, psdBlendToCompositeOp } = await import('../src/psd/psdComposite');
const { blendChannel, blendPixelsInto, isPixelBlendMode } = await import('../src/psd/psdBlend');
const { History } = await import('../src/core/history');

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

// ---------- blend formulas ----------
function blend1(mode: Parameters<typeof blendPixelsInto>[2], b: number[], s: number[], opacity = 1) {
  const dst = new Uint8ClampedArray(b);
  blendPixelsInto(dst, new Uint8ClampedArray(s), mode, opacity);
  return [...dst];
}
const ch = (mode: Parameters<typeof blendChannel>[0], b: number, s: number) => Math.round(blendChannel(mode, b / 255, s / 255) * 255);

log('linear-burn', ch('linear burn', 200, 100) === 45 && ch('linear burn', 50, 100) === 0, `${ch('linear burn', 200, 100)},${ch('linear burn', 50, 100)}`);
log('linear-dodge', ch('linear dodge', 100, 100) === 200 && ch('linear dodge', 200, 100) === 255, `${ch('linear dodge', 100, 100)},${ch('linear dodge', 200, 100)}`);
log('subtract', ch('subtract', 200, 50) === 150 && ch('subtract', 50, 200) === 0, `${ch('subtract', 200, 50)},${ch('subtract', 50, 200)}`);
log('divide', ch('divide', 51, 204) === 64 && ch('divide', 10, 0) === 255 && ch('divide', 0, 0) === 0, `${ch('divide', 51, 204)},${ch('divide', 10, 0)},${ch('divide', 0, 0)}`);
log('linear-light', ch('linear light', 100, 200) === 245 && ch('linear light', 100, 20) === 0, `${ch('linear light', 100, 200)},${ch('linear light', 100, 20)}`);
log('pin-light', ch('pin light', 150, 50) === 100 && ch('pin light', 100, 230) === 205, `${ch('pin light', 150, 50)},${ch('pin light', 100, 230)}`);
log('hard-mix', ch('hard mix', 127, 128) === 255 && ch('hard mix', 127, 127) === 0, `${ch('hard mix', 127, 128)},${ch('hard mix', 127, 127)}`);
log(
  'vivid-light',
  ch('vivid light', 0, 255) === 0 && ch('vivid light', 255, 0) === 255 && ch('vivid light', 64, 128) === 64 && ch('vivid light', 255, 64) === 255,
  `${ch('vivid light', 0, 255)},${ch('vivid light', 255, 0)},${ch('vivid light', 64, 128)},${ch('vivid light', 255, 64)}`,
);
const darker = blend1('darker color', [100, 100, 100, 255], [10, 200, 10, 255]);
const lighter = blend1('lighter color', [100, 100, 100, 255], [10, 200, 10, 255]);
log('darker-color-picks-lower-sum', darker.join() === '10,200,10,255', darker.join());
log('lighter-color-picks-higher-sum', lighter.join() === '100,100,100,255', lighter.join());
const halfDodge = blend1('linear dodge', [100, 100, 100, 255], [100, 100, 100, 255], 0.5);
log('opacity-mixes-result', near(halfDodge[0], 150) && halfDodge[3] === 255, halfDodge.join());
const overClear = blend1('linear burn', [0, 0, 0, 0], [30, 60, 90, 255]);
log('transparent-backdrop-shows-source', overClear.join() === '30,60,90,255', overClear.join());
const clearSrc = blend1('subtract', [1, 2, 3, 200], [255, 255, 255, 0]);
log('transparent-source-no-op', clearSrc.join() === '1,2,3,200', clearSrc.join());
log(
  'mapping-no-longer-color-dodge-burn',
  psdBlendToCompositeOp('linear burn') !== 'color-burn' && psdBlendToCompositeOp('linear dodge') !== 'color-dodge' && isPixelBlendMode('linear burn') && isPixelBlendMode('linear dodge'),
  `${psdBlendToCompositeOp('linear burn')},${psdBlendToCompositeOp('linear dodge')}`,
);
log('native-modes-unchanged', psdBlendToCompositeOp('multiply') === 'multiply' && !isPixelBlendMode('multiply') && !isPixelBlendMode('normal'), 'multiply');

// ---------- synthetic PSDs ----------
function mk(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return c;
}
const fill = (w: number, h: number, css: string) => mk(w, h, (g) => { g.fillStyle = css; g.fillRect(0, 0, w, h); });
/** 60×60 mask: x 0–19 gray 0, 20–39 gray 128, 40–59 gray 255. */
const zoneMask = () => mk(60, 60, (g) => {
  g.fillStyle = 'rgb(0,0,0)'; g.fillRect(0, 0, 20, 60);
  g.fillStyle = 'rgb(128,128,128)'; g.fillRect(20, 0, 20, 60);
  g.fillStyle = 'rgb(255,255,255)'; g.fillRect(40, 0, 20, 60);
});

function maskedDoc(defaultColor: number) {
  const W = 100, H = 100;
  const red: Layer = {
    name: 'Red', left: 0, top: 0, right: W, bottom: H, canvas: fill(W, H, '#ff0000'),
    mask: { left: 20, top: 20, right: 80, bottom: 80, defaultColor, canvas: zoneMask() },
  };
  const psd: Psd = { width: W, height: H, children: [{ name: 'BG', left: 0, top: 0, right: W, bottom: H, canvas: fill(W, H, '#ffffff') }, red] };
  psd.canvas = fill(W, H, '#ffffff');
  return importPsd(`mask-${defaultColor}.psd`, writePsd(psd));
}
const px = (c: HTMLCanvasElement, x: number, y: number) => [...c.getContext('2d')!.getImageData(x, y, 1, 1).data];
const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
const sum = (d: ArrayLike<number>) => { let s = 0; for (let i = 0; i < d.length; i++) s = (s + d[i] * (i % 251 + 1)) % 2147483647; return s; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

for (const dc of [0, 255]) {
  const doc = maskedDoc(dc);
  const red = leaves(doc).find((n) => n.name === 'Red')!;
  const maskCanvas = red.src.mask!.canvas!;
  const before = sum(pixels(maskCanvas));
  const maskGray = px(maskCanvas, 30, 30);
  log(`dc${dc}-mask-decoded-gray`, near(maskGray[0], 128) && maskGray[3] === 255, maskGray.join());

  const out = composeDocPreview(doc);
  const z0 = px(out, 25, 50), z1 = px(out, 45, 50), z2 = px(out, 65, 50), outside = px(out, 10, 10);
  log(`dc${dc}-gray0-hidden`, z0.join() === '255,255,255,255', z0.join());
  log(`dc${dc}-gray128-half`, near(z1[0], 255) && near(z1[1], 127, 2) && near(z1[2], 127, 2), z1.join());
  log(`dc${dc}-gray255-full`, z2.join() === '255,0,0,255', z2.join());
  const expectOutside = dc === 255 ? '255,0,0,255' : '255,255,255,255';
  log(`dc${dc}-outside-rect-follows-defaultColor`, outside.join() === expectOutside, outside.join());

  log(`dc${dc}-source-mask-untouched`, red.src.mask!.canvas === maskCanvas && sum(pixels(maskCanvas)) === before, `checksum ${before}`);
  log(`dc${dc}-compose-pure`, same(pixels(out), pixels(composeDocPreview(doc))), 'two composes identical');

  const reread = readPsd(exportPsd(doc), { skipThumbnail: true });
  const exported = reread.children!.find((l) => l.name === 'Red')!.mask!;
  log(
    `dc${dc}-export-keeps-mask-pixels`,
    !!exported.canvas && sum(pixels(exported.canvas as HTMLCanvasElement)) === before && exported.defaultColor === dc,
    `defaultColor=${exported.defaultColor}`,
  );
}

{
  const doc = maskedDoc(0);
  const red = leaves(doc).find((n) => n.name === 'Red')!;
  red.src.mask = { left: 0, top: 0, right: 0, bottom: 0, defaultColor: 0 };
  log('hide-all-empty-mask-hides-layer', px(composeDocPreview(doc), 50, 50).join() === '255,255,255,255', px(composeDocPreview(doc), 50, 50).join());
  red.src.mask = { left: 0, top: 0, right: 0, bottom: 0, defaultColor: 255 };
  log('reveal-all-empty-mask-shows-layer', px(composeDocPreview(doc), 50, 50).join() === '255,0,0,255', px(composeDocPreview(doc), 50, 50).join());
  red.src.mask = { left: 0, top: 0, right: 0, bottom: 0, defaultColor: 0, fromVectorData: true };
  log('vector-only-mask-record-not-hide-all', px(composeDocPreview(doc), 50, 50).join() === '255,0,0,255', px(composeDocPreview(doc), 50, 50).join());
  red.src.mask = { left: 20, top: 20, right: 80, bottom: 80, defaultColor: 0, canvas: zoneMask(), disabled: true };
  log('disabled-mask-ignored', px(composeDocPreview(doc), 25, 50).join() === '255,0,0,255', px(composeDocPreview(doc), 25, 50).join());
}

{
  const doc = maskedDoc(0);
  const red = leaves(doc).find((n) => n.name === 'Red')!;
  const original = pixels(composeDocPreview(doc));
  const hist = new History();
  const ox = red.x;
  hist.exec({ label: 'Move', do: () => { red.x = ox - 30; }, undo: () => { red.x = ox; } });
  const moved = pixels(composeDocPreview(doc));
  hist.undo();
  const undone = pixels(composeDocPreview(doc));
  hist.redo();
  const redone = pixels(composeDocPreview(doc));
  const changed = !same(original, moved), restored = same(original, undone), reapplied = same(moved, redone);
  log('undo-restores-masked-compose', changed && restored && reapplied, `changed=${changed} undo=${restored} redo=${reapplied}`);
}

{
  const W = 60, H = 20;
  const gray = (v: number) => `rgb(${v},${v},${v})`;
  const psd: Psd = {
    width: W, height: H,
    children: [
      { name: 'BG', left: 0, top: 0, right: W, bottom: H, canvas: fill(W, H, gray(200)) },
      { name: 'Burn', left: 0, top: 0, right: 20, bottom: H, canvas: fill(20, H, gray(100)), blendMode: 'linear burn' },
      { name: 'Dodge', left: 20, top: 0, right: 40, bottom: H, canvas: fill(20, H, gray(40)), blendMode: 'linear dodge' },
      { name: 'Sub', left: 40, top: 0, right: 60, bottom: H, canvas: fill(20, H, gray(50)), blendMode: 'subtract', opacity: 0.5 },
    ],
  };
  psd.canvas = fill(W, H, gray(200));
  const doc = importPsd('blend.psd', writePsd(psd));
  const out = composeDocPreview(doc);
  const burn = px(out, 10, 10), dodge = px(out, 30, 10), sub = px(out, 50, 10);
  log('compose-linear-burn', near(burn[0], 45), burn.join());
  log('compose-linear-dodge', near(dodge[0], 240), dodge.join());
  log('compose-subtract-half-opacity', near(sub[0], 175), sub.join());
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log('JSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

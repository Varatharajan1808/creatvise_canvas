/**
 * Minimal PSD fixture with a Brightness/Contrast adjustment layer over background and card.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';

export const BRIGHTNESS_FIXTURE = {
  docW: 400,
  docH: 400,
  initialBrightness: 30,
  initialContrast: 20,
  initialLegacy: false,
  cardProbe: [200, 200] as const, // inside 100..300 card
  bgProbe: [50, 50] as const,     // outside card (on background)
};

function bootCanvas() {
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
}

let canvasReady = false;
function ensureCanvas() {
  if (!canvasReady) {
    bootCanvas();
    canvasReady = true;
  }
}

function fillCanvas(w: number, h: number, css: string): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, w, h);
  return c as unknown as HTMLCanvasElement;
}

export function buildBrightnessFixturePsd(
  overrides?: Partial<NonNullable<Layer['adjustment']>>,
): ArrayBuffer {
  ensureCanvas();
  const bg: Layer = {
    name: 'Background',
    left: 0,
    top: 0,
    right: BRIGHTNESS_FIXTURE.docW,
    bottom: BRIGHTNESS_FIXTURE.docH,
    canvas: fillCanvas(BRIGHTNESS_FIXTURE.docW, BRIGHTNESS_FIXTURE.docH, '#808080'),
  };
  const card: Layer = {
    name: 'Card',
    left: 100,
    top: 100,
    right: 300,
    bottom: 300,
    canvas: fillCanvas(200, 200, '#3366cc'),
  };
  const adj: Layer = {
    name: 'Brightness 1',
    adjustment: {
      type: 'brightness/contrast',
      brightness: BRIGHTNESS_FIXTURE.initialBrightness,
      contrast: BRIGHTNESS_FIXTURE.initialContrast,
      useLegacy: BRIGHTNESS_FIXTURE.initialLegacy,
      ...overrides,
    },
  };
  const psd: Psd = {
    width: BRIGHTNESS_FIXTURE.docW,
    height: BRIGHTNESS_FIXTURE.docH,
    children: [bg, card, adj],
  };
  psd.canvas = createCanvas(BRIGHTNESS_FIXTURE.docW, BRIGHTNESS_FIXTURE.docH) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = path.join(__dirname, '..');
  const outPaths = [
    path.join(root, 'public', 'fixtures', 'psd', 'brightness-contrast.psd'),
    path.join(root, 'artifacts', 'fixture-brightness-contrast.psd'),
  ];
  const buf = buildBrightnessFixturePsd();
  for (const p of outPaths) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(buf));
    console.log('wrote', p);
  }
}

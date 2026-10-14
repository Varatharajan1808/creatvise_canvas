/**
 * Minimal PSD: one blue box + enabled drop shadow only (no stroke/glow/etc.).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';

export const DROP_SHADOW_FIXTURE = {
  docW: 400,
  docH: 400,
  layerName: 'Box',
  shadowProbes: [
    [108, 118],
    [112, 122],
    [105, 125],
  ] as const,
  layerProbe: [140, 140] as const,
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

export function buildDropShadowFixturePsd(): ArrayBuffer {
  ensureCanvas();
  const c = createCanvas(80, 80);
  const g = c.getContext('2d')!;
  g.fillStyle = '#3366cc';
  g.fillRect(10, 10, 60, 60);
  const layer: Layer = {
    name: DROP_SHADOW_FIXTURE.layerName,
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: c as unknown as HTMLCanvasElement,
    effects: {
      dropShadow: [
        {
          enabled: true,
          blendMode: 'multiply',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.8,
          angle: 120,
          distance: { value: 10, units: 'Pixels' },
          size: { value: 8, units: 'Pixels' },
        },
      ],
    },
  };
  const psd: Psd = {
    width: DROP_SHADOW_FIXTURE.docW,
    height: DROP_SHADOW_FIXTURE.docH,
    children: [layer],
  };
  psd.canvas = createCanvas(DROP_SHADOW_FIXTURE.docW, DROP_SHADOW_FIXTURE.docH) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = path.join(__dirname, '..');
  const outPaths = [
    path.join(root, 'public', 'fixtures', 'psd', 'drop-shadow.psd'),
    path.join(root, 'artifacts', 'fixture-drop-shadow.psd'),
  ];
  const buf = buildDropShadowFixturePsd();
  for (const p of outPaths) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(buf));
    console.log('wrote', p);
  }
}

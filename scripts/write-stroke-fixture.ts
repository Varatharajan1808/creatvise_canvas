/**
 * Minimal PSD: one blue box + enabled Stroke only (no drop shadow/outer glow/etc.).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';

export const STROKE_FIXTURE = {
  docW: 400,
  docH: 400,
  layerName: 'Box',
  strokeColor: { r: 255, g: 51, b: 51 },
  strokeOpacity: 1.0,
  strokeSize: 6,
  strokePosition: 'outside' as const,
  // Probes in the stroke halo outside the 110..170 box
  strokeProbes: [
    [106, 140],
    [174, 140],
    [140, 106],
    [140, 174],
  ] as const,
  layerProbe: [140, 140] as const,
  outsideProbe: [40, 40] as const,
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

export function buildStrokeFixturePsd(
  overrides?: Partial<NonNullable<Layer['effects']>['stroke'] extends (infer E)[] ? E : never>,
): ArrayBuffer {
  ensureCanvas();
  const c = createCanvas(80, 80);
  const g = c.getContext('2d')!;
  g.fillStyle = '#3366cc';
  g.fillRect(10, 10, 60, 60);
  const strokeEffect = {
    enabled: true,
    blendMode: 'normal' as const,
    color: { ...STROKE_FIXTURE.strokeColor },
    opacity: STROKE_FIXTURE.strokeOpacity,
    size: { value: STROKE_FIXTURE.strokeSize, units: 'Pixels' as const },
    position: STROKE_FIXTURE.strokePosition,
    fillType: 'color' as const,
    ...overrides,
  };
  const layer: Layer = {
    name: STROKE_FIXTURE.layerName,
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: c as unknown as HTMLCanvasElement,
    effects: {
      stroke: [strokeEffect],
    },
  };
  const psd: Psd = {
    width: STROKE_FIXTURE.docW,
    height: STROKE_FIXTURE.docH,
    children: [layer],
  };
  psd.canvas = createCanvas(STROKE_FIXTURE.docW, STROKE_FIXTURE.docH) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

export function buildStrokeComboPsd(): ArrayBuffer {
  ensureCanvas();
  const c = createCanvas(80, 80);
  const g = c.getContext('2d')!;
  g.fillStyle = '#3366cc';
  g.fillRect(10, 10, 60, 60);
  const layer: Layer = {
    name: STROKE_FIXTURE.layerName,
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: c as unknown as HTMLCanvasElement,
    effects: {
      stroke: [
        {
          enabled: true,
          blendMode: 'normal' as const,
          color: { ...STROKE_FIXTURE.strokeColor },
          opacity: STROKE_FIXTURE.strokeOpacity,
          size: { value: STROKE_FIXTURE.strokeSize, units: 'Pixels' as const },
          position: STROKE_FIXTURE.strokePosition,
          fillType: 'color' as const,
        },
      ],
      dropShadow: [
        {
          enabled: true,
          blendMode: 'multiply' as const,
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.8,
          angle: 120,
          distance: { value: 10, units: 'Pixels' as const },
          size: { value: 8, units: 'Pixels' as const },
        },
      ],
    },
  };
  const psd: Psd = {
    width: STROKE_FIXTURE.docW,
    height: STROKE_FIXTURE.docH,
    children: [layer],
  };
  psd.canvas = createCanvas(STROKE_FIXTURE.docW, STROKE_FIXTURE.docH) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = path.join(__dirname, '..');
  const outPaths = [
    path.join(root, 'public', 'fixtures', 'psd', 'stroke.psd'),
    path.join(root, 'artifacts', 'fixture-stroke.psd'),
  ];
  const buf = buildStrokeFixturePsd();
  for (const p of outPaths) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(buf));
    console.log('wrote', p);
  }
  const comboPaths = [
    path.join(root, 'public', 'fixtures', 'psd', 'stroke-combo.psd'),
    path.join(root, 'artifacts', 'fixture-stroke-combo.psd'),
  ];
  const comboBuf = buildStrokeComboPsd();
  for (const p of comboPaths) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(comboBuf));
    console.log('wrote', p);
  }
}

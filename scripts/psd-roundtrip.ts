/**
 * Reproduces PSD export round-trip (move / rotate / effects) outside the browser.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';
import type { Doc, Node } from '../src/model';

const window = new Window();
(globalThis as unknown as { window: Window; document: Document }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;

initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd, exportPsd, createSamplePsd } = await import('../src/psd');
const { leaves } = await import('../src/model');

function flatLayers(psd: Psd): Layer[] {
  const out: Layer[] = [];
  const walk = (ls: Layer[] | undefined) => {
    for (const l of ls ?? []) {
      out.push(l);
      walk(l.children);
    }
  };
  walk(psd.children);
  return out;
}

function findNode(doc: Doc, name: string): Node | undefined {
  return [...leaves(doc)].find((n) => n.name === name);
}

function mkShadowLayer(): ArrayBuffer {
  const c = createCanvas(100, 100);
  const g = c.getContext('2d')!;
  g.fillStyle = '#3366cc';
  g.fillRect(20, 20, 60, 60);
  const layer: Layer = {
    name: 'With shadow',
    left: 100,
    top: 100,
    right: 200,
    bottom: 200,
    canvas: c as unknown as HTMLCanvasElement,
    effects: {
      dropShadow: [
        {
          present: true,
          showInDialog: true,
          enabled: true,
          blendMode: 'multiply',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.75,
          useGlobalLight: false,
          angle: 120,
          distance: { value: 8, units: 'Pixels' },
          choke: { value: 0, units: 'Pixels' },
          size: { value: 12, units: 'Pixels' },
        },
      ],
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function hasLfx2(buf: ArrayBuffer): boolean {
  const t = new TextDecoder('latin1').decode(new Uint8Array(buf));
  return t.includes('lfx2') || t.includes('lrFX') || t.includes('lmfx');
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

// --- move ---
{
  const doc = importPsd('move.psd', createSamplePsd());
  const n = findNode(doc, 'Green circle');
  if (!n) throw new Error('Green circle missing');
  const dx = 50;
  const dy = 30;
  n.x += dx;
  n.y += dy;
  const out = exportPsd(doc);
  const psd = readPsd(out, { skipThumbnail: true });
  const green = flatLayers(psd).find((l) => l.name === 'Green circle');
  const expectLeft = 520 + dx;
  const expectTop = 200 + dy;
  log(
    'move-roundtrip-bounds',
    green?.left === expectLeft && green?.top === expectTop,
    JSON.stringify({ left: green?.left, top: green?.top, expectLeft, expectTop }),
  );
  const doc2 = importPsd('move2.psd', out);
  const n2 = findNode(doc2, 'Green circle');
  log(
    'move-reimport-model',
    n2?.x === expectLeft && n2?.y === expectTop,
    JSON.stringify({ x: n2?.x, y: n2?.y }),
  );
}

// --- rotate ---
{
  const doc = importPsd('rot.psd', createSamplePsd());
  const n = findNode(doc, 'Green circle');
  if (!n) throw new Error('Green circle missing');
  n.rotation = 45;
  const canvasBefore = n.canvas;
  const out = exportPsd(doc);
  const psd = readPsd(out, { skipThumbnail: true });
  const green = flatLayers(psd).find((l) => l.name === 'Green circle');
  const w = (green?.right ?? 0) - (green?.left ?? 0);
  const h = (green?.bottom ?? 0) - (green?.top ?? 0);
  const expectMin = 270; // ~200*sqrt(2)
  log(
    'rotate-export-aabb',
    w >= expectMin && h >= expectMin,
    JSON.stringify({ left: green?.left, top: green?.top, w, h }),
  );
  const doc2 = importPsd('rot2.psd', out);
  const n2 = findNode(doc2, 'Green circle');
  log(
    'rotate-reimport-model',
    n2?.rotation === 0 && (n2?.w ?? 0) >= expectMin,
    JSON.stringify({ x: n2?.x, y: n2?.y, w: n2?.w, h: n2?.h, rotation: n2?.rotation }),
  );
  log(
    'rotate-export-keeps-model',
    n.canvas === canvasBefore && n.rotation === 45 && n.w === 200 && n.src.canvas !== n.canvas,
    JSON.stringify({ canvasKept: n.canvas === canvasBefore, rotation: n.rotation, w: n.w, srcBaked: n.src.canvas !== n.canvas }),
  );
}

// --- effects ---
{
  const original = mkShadowLayer();
  log('effects-create-has-lfx', hasLfx2(original), 'original bytes');
  const doc = importPsd('fx.psd', original.slice(0));
  const n = findNode(doc, 'With shadow');
  log('effects-import-parsed', !!n?.src.effects?.dropShadow?.length, JSON.stringify(!!n?.src.effects));
  const out = exportPsd(doc);
  log('effects-after-export-bytes', hasLfx2(out), 'exported bytes');
  const psd = readPsd(out, { skipThumbnail: true });
  const layer = flatLayers(psd)[0];
  log(
    'effects-after-export-parsed',
    !!layer.effects?.dropShadow?.length,
    JSON.stringify(layer.effects?.dropShadow?.[0]?.enabled),
  );
  n!.x += 25;
  const out2 = exportPsd(doc);
  log('effects-after-move-bytes', hasLfx2(out2), 'exported after move');
  const psd2 = readPsd(out2, { skipThumbnail: true });
  const layer2 = flatLayers(psd2)[0];
  log(
    'effects-after-move-parsed',
    !!layer2.effects?.dropShadow?.length,
    JSON.stringify({ left: layer2.left, effects: !!layer2.effects }),
  );
}

console.log('\nJSON:' + JSON.stringify(results));
process.exit(results.some((r) => !r.ok) ? 1 : 0);

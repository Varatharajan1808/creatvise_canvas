/**
 * Canvas hit-test rules (shared with hover hint + click select).
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import type { Layer } from 'ag-psd';
import { hitTestCanvasLayer, isCanvasPickTarget } from '../src/canvas/canvasHitTest';
import { importPsd } from '../src/psd/psd';
import type { Doc, Node } from '../src/core/model';
import { canEditPsdLayerPosition } from '../src/psd/psdLayerInfo';
import { leaves } from '../src/core/model';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

function setupDom() {
  const window = new Window();
  (globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = ((tag: string, options?: unknown) => {
    if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
    return origCreate(tag, options as never);
  }) as typeof window.document.createElement;
  initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);
}

function identityScreenToDoc(_d: Doc, sx: number, sy: number) {
  return { x: sx, y: sy };
}

function hit(doc: Doc, x: number, y: number) {
  return hitTestCanvasLayer({ docs: [doc], screenToDoc: identityScreenToDoc }, x, y);
}

function makeRasterLeaf(
  doc: Doc,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D) => void,
  opacity = 1,
): Node {
  const c = createCanvas(w, h) as unknown as HTMLCanvasElement;
  draw(c.getContext('2d')!);
  return {
    id: name,
    key: name,
    name,
    kind: 'raster',
    visible: true,
    locked: false,
    opacity,
    importOpacity: opacity,
    importVisible: true,
    x,
    y,
    w,
    h,
    ox: x,
    oy: y,
    ow: w,
    oh: h,
    rotation: 0,
    canvas: c,
    children: [],
    parent: null,
    src: {} as Layer,
    unsupported: [],
  };
}

function syntheticDoc(width: number, height: number, layers: Node[]): Doc {
  return {
    id: 'test',
    name: 'test.psd',
    format: 'psd',
    width,
    height,
    offsetX: 0,
    offsetY: 0,
    roots: layers,
    original: new ArrayBuffer(0),
    warnings: [],
  };
}

setupDom();

// Overlapping: topmost opaque small layer wins
{
  const large = makeRasterLeaf(
    { width: 400, height: 400 } as Doc,
    'large',
    0,
    0,
    400,
    400,
    (g) => {
      g.fillStyle = '#f00';
      g.fillRect(0, 0, 400, 400);
    },
  );
  const small = makeRasterLeaf(
    { width: 400, height: 400 } as Doc,
    'small',
    150,
    150,
    80,
    80,
    (g) => {
      g.fillStyle = '#0f0';
      g.fillRect(0, 0, 80, 80);
    },
  );
  const doc = syntheticDoc(400, 400, [large, small]);
  const atOverlap = hit(doc, 190, 190);
  log('overlap-topmost-small', atOverlap?.name === 'small', atOverlap?.name ?? 'null');
}

// Transparent / outside bounds on upper layer → hits layer below
{
  const bottom = makeRasterLeaf(
    { width: 400, height: 400 } as Doc,
    'bottom',
    20,
    20,
    360,
    360,
    (g) => {
      g.fillStyle = '#00f';
      g.fillRect(0, 0, 360, 360);
    },
  );
  const top = makeRasterLeaf(
    { width: 400, height: 400 } as Doc,
    'top',
    200,
    200,
    50,
    50,
    (g) => {
      g.fillStyle = 'rgba(0,0,0,0.8)';
      g.fillRect(0, 0, 50, 50);
    },
  );
  const doc = syntheticDoc(400, 400, [bottom, top]);
  log('transparent-top-miss-center', hit(doc, 50, 50)?.name === 'bottom', hit(doc, 50, 50)?.name ?? 'null');
  log('transparent-top-hit-opaque', hit(doc, 220, 220)?.name === 'top', hit(doc, 220, 220)?.name ?? 'null');
}

// Full-document fill excluded from pick
{
  const bg = makeRasterLeaf(
    { width: 300, height: 300 } as Doc,
    'full-bg',
    0,
    0,
    300,
    300,
    (g) => g.fillRect(0, 0, 300, 300),
  );
  const badge = makeRasterLeaf(
    { width: 300, height: 300 } as Doc,
    'badge',
    120,
    120,
    60,
    60,
    (g) => {
      g.fillStyle = '#ff0';
      g.fillRect(0, 0, 60, 60);
    },
  );
  const doc = syntheticDoc(300, 300, [bg, badge]);
  log('full-doc-not-pick-target', !isCanvasPickTarget(doc, bg), String(isCanvasPickTarget(doc, badge)));
  log('full-doc-skip-to-upper', hit(doc, 150, 150)?.name === 'badge', hit(doc, 150, 150)?.name ?? 'null');
}

// 0% opacity not hit
{
  const ghost = makeRasterLeaf(
    { width: 100, height: 100 } as Doc,
    'ghost',
    0,
    0,
    100,
    100,
    (g) => g.fillRect(0, 0, 100, 100),
    0,
  );
  const doc = syntheticDoc(100, 100, [ghost]);
  log('zero-opacity-skipped', hit(doc, 50, 50) === null, 'null');
}

// Real fixture: large partial-doc vs small leaf (metadata probes)
const fixture =
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
if (fs.existsSync(fixture)) {
  const buf = fs.readFileSync(fixture);
  const doc = importPsd(
    'f.psd',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  const editable = leaves(doc).filter(
    (n) =>
      canEditPsdLayerPosition(n) &&
      n.canvas &&
      n.w > 0 &&
      n.h > 0 &&
      n.opacity > 0 &&
      !(n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1),
  );
  const sorted = [...editable].sort((a, b) => a.w * a.h - b.w * b.h);
  const small = sorted[0];
  const large = sorted[sorted.length - 1];
  if (small && large && small.id !== large.id) {
    const puzzleX = Math.round(doc.width * 0.5);
    const puzzleY = Math.round(doc.height * 0.45);
    const puzzleHit = hit(doc, puzzleX, puzzleY);
    log(
      'fixture-large-partial-at-puzzle-center',
      puzzleHit === large,
      `${puzzleHit?.name ?? 'null'} area=${Math.round((large.w * large.h) / (doc.width * doc.height) * 100)}%`,
    );
    let smallHitFound = false;
    let smallHitDetail = 'none';
    for (const fx of [0.3, 0.5, 0.7]) {
      for (const fy of [0.35, 0.5, 0.65]) {
        const x = Math.round(small.x + small.w * fx);
        const y = Math.round(small.y + small.h * fy);
        const h = hit(doc, x, y);
        if (h === small) {
          smallHitFound = true;
          smallHitDetail = `${x},${y}`;
          break;
        }
      }
      if (smallHitFound) break;
    }
    log('fixture-small-hit-in-bounds', smallHitFound, smallHitDetail);
  } else {
    log('fixture-skip', true, 'no large/small pair');
  }
} else {
  log('fixture-skip', true, 'missing psd');
}

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

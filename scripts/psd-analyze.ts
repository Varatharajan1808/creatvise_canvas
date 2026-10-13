import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, type Layer } from 'ag-psd';
import { importPsd } from '../src/psd';
import { walk, leaves } from '../src/model';

const fixturePath =
  process.argv[2] ??
  process.env.PSD_FIXTURE ??
  path.join(process.cwd(), 'fixtures', 'double-exposure.psd');

if (!fs.existsSync(fixturePath)) {
  console.error('PSD not found:', fixturePath);
  process.exit(2);
}

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const buf = fs.readFileSync(fixturePath).buffer.slice(
  fs.readFileSync(fixturePath).byteOffset,
  fs.readFileSync(fixturePath).byteOffset + fs.readFileSync(fixturePath).byteLength,
);

const psd = readPsd(buf, { skipThumbnail: true });
const doc = importPsd(path.basename(fixturePath), buf);

function layerType(l: Layer): string {
  if (l.children?.length) return 'group';
  if (l.adjustment) return `adjustment:${(l.adjustment as { type?: string }).type ?? 'unknown'}`;
  if (l.text) return 'text';
  if (l.placedLayer) return `smart-object:${l.placedLayer.type ?? 'unknown'}`;
  if (l.vectorFill || l.vectorStroke) return 'shape/vector';
  return 'raster';
}

function flat(layers: Layer[] | undefined, depth = 0): Array<{ l: Layer; depth: number }> {
  const out: Array<{ l: Layer; depth: number }> = [];
  for (const l of layers ?? []) {
    out.push({ l, depth });
    out.push(...flat(l.children, depth + 1));
  }
  return out;
}

const allLayers = flat(psd.children);
const allNodes = [...walk(doc.roots)];
const leafNodes = leaves(doc);

console.log('File:', fixturePath);
console.log('Doc size:', psd.width, 'x', psd.height);
console.log('Layer records (tree):', allLayers.length);
console.log('Nodes (walk):', allNodes.length);
console.log('Leaf nodes (paint list):', leafNodes.length);
console.log('Has composite canvas:', !!psd.canvas);
console.log('');

const unsupported = allNodes.filter((n) => n.unsupported.length);
console.log('Unsupported/read-only count:', unsupported.length);
console.log('---');

for (const n of allNodes) {
  const l = n.src;
  const w = (l.right ?? 0) - (l.left ?? 0);
  const h = (l.bottom ?? 0) - (l.top ?? 0);
  const meta = {
    kind: n.kind,
    psdType: layerType(l),
    hidden: !!l.hidden,
    opacity: l.opacity,
    blendMode: l.blendMode ?? 'normal',
    clipping: !!l.clipping,
    hasCanvas: !!l.canvas,
    canvasPx: l.canvas ? `${l.canvas.width}x${l.canvas.height}` : null,
    bounds: { left: l.left, top: l.top, w, h },
    nodeFrame: { x: n.x, y: n.y, w: n.w, h: n.h },
    drawn: !!(n.canvas && n.w > 0 && n.h > 0 && n.visible),
    adjustment: l.adjustment ? (l.adjustment as { type?: string }).type : undefined,
    effects: l.effects ? Object.keys(l.effects).filter((k) => k !== 'disabled' && k !== 'scale') : [],
    mask: !!l.mask,
    vectorMask: !!l.vectorMask,
  };
  console.log(`${n.name}`);
  console.log('  ', JSON.stringify(meta));
  if (n.unsupported.length) console.log('   unsupported:', n.unsupported.join(' | '));
}

console.log('\n--- Not drawn (leaf) ---');
for (const n of leafNodes) {
  const drawn = n.canvas && n.w > 0 && n.h > 0 && n.visible;
  if (!drawn) {
    console.log(`- ${n.name}: canvas=${!!n.canvas} w=${n.w} h=${n.h} visible=${n.visible}`);
  }
}

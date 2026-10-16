import assert from 'node:assert/strict';
import type { Doc, Node } from '../src/model';
import {
  MARQUEE_DRAG_THRESHOLD_PX,
  nodesInMarqueeRect,
  normalizeScreenRect,
  screenRectsIntersect,
  selectionFromMarqueeHits,
  emptySelection,
  type ScreenProjection,
} from '../src/selection';
 
function leaf(id: string, x: number, y: number, w: number, h: number): Node {
  return {
    id,
    key: id,
    name: id,
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x,
    y,
    w,
    h,
    rotation: 0,
    ow: w,
    oh: h,
    ox: x,
    oy: y,
    canvas: { width: w, height: h } as HTMLCanvasElement,
    children: [],
    parent: null,
    src: {} as Node['src'],
    unsupported: [],
    importPreviewContentEpoch: 0,
    previewContentEpoch: 0,
  };
}
 
function docWithLeaves(...nodes: Node[]): Doc {
  for (const n of nodes) n.parent = null;
  return {
    id: 'd1',
    name: 'test.ai',
    format: 'ai',
    width: 400,
    height: 400,
    offsetX: 0,
    offsetY: 0,
    original: new ArrayBuffer(0),
    roots: nodes,
  } as Doc;
}
 
const identityProj: ScreenProjection = {
  docToScreen: (_d, x, y) => ({ x, y }),
  screenToDoc: (_d, sx, sy) => ({ x: sx, y: sy }),
};
 
assert.equal(MARQUEE_DRAG_THRESHOLD_PX, 4);
 
const r = normalizeScreenRect(10, 20, 30, 50);
assert.equal(r.sx, 10);
assert.equal(r.sy, 20);
assert.equal(r.sw, 20);
assert.equal(r.sh, 30);
 
assert.ok(screenRectsIntersect({ sx: 0, sy: 0, sw: 10, sh: 10 }, { sx: 5, sy: 5, sw: 10, sh: 10 }));
assert.ok(!screenRectsIntersect({ sx: 0, sy: 0, sw: 10, sh: 10 }, { sx: 20, sy: 0, sw: 10, sh: 10 }));
 
const a = leaf('a', 0, 0, 50, 50);
const b = leaf('b', 100, 100, 40, 40);
const d = docWithLeaves(a, b);
const hits = nodesInMarqueeRect([d], { sx: 5, sy: 5, sw: 60, sh: 60 }, identityProj);
assert.equal(hits.length, 1);
assert.equal(hits[0]!.id, 'a');
 
const hitsBoth = nodesInMarqueeRect([d], { sx: 0, sy: 0, sw: 200, sh: 200 }, identityProj);
assert.equal(hitsBoth.length, 2);
assert.equal(hitsBoth[0]!.id, 'b');
assert.equal(hitsBoth[1]!.id, 'a');
 
const sel = selectionFromMarqueeHits(hitsBoth, emptySelection(), false);
assert.equal(sel.nodes.length, 2);
assert.equal(sel.primary?.id, 'b');
assert.equal(sel.nodes[0]!.id, 'a');
 
const additive = selectionFromMarqueeHits([a], { primary: b, nodes: [b] }, true);
assert.equal(additive.nodes.length, 2);
assert.equal(additive.primary?.id, 'a');
 
console.log('marquee-select.test.ts: ok');

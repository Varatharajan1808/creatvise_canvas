/**
 * IDML rasterizer: fillText invocation (mock 2D context).
 */
import type { Node } from '../src/model';
import { rasterizeIdmlTextNode } from '../src/idml/rasterText';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

let fillTextCalls = 0;
const mockCtx = {
  clearRect: () => {},
  fillRect: () => {},
  setTransform: () => {},
  save: () => {},
  restore: () => {},
  beginPath: () => {},
  rect: () => {},
  clip: () => {},
  measureText: (s: string) => ({ width: s.length * 7 }),
  fillText: () => {
    fillTextCalls++;
  },
  get textAlign() {
    return 'left';
  },
  set textAlign(_: string) {},
  get letterSpacing() {
    return '0px';
  },
  set letterSpacing(_: string) {},
  get font() {
    return '';
  },
  set font(_: string) {},
  get fillStyle() {
    return '';
  },
  set fillStyle(_: string) {},
  get globalAlpha() {
    return 1;
  },
  set globalAlpha(_: number) {},
  get textBaseline() {
    return 'top';
  },
  set textBaseline(_: string) {},
  get globalCompositeOperation() {
    return 'source-over';
  },
  set globalCompositeOperation(_: string) {},
};

const canvas = {
  width: 200,
  height: 80,
  getContext: (type: string) => (type === '2d' ? mockCtx : null),
} as unknown as HTMLCanvasElement;

const node: Node = {
  id: 't',
  kind: 'text',
  name: 'Hello',
  opacity: 1,
  w: 200,
  h: 80,
  canvas,
  idml: { self: 'uf1', tag: 'TextFrame', spreadPath: 'Spreads/Spread_1.xml' },
  src: {
    text: {
      text: 'Hello',
      style: {
        fontSize: 14,
        font: { name: 'Arial' },
        fillColor: { r: 30, g: 30, b: 30 },
      },
    },
  },
} as unknown as Node;

fillTextCalls = 0;
rasterizeIdmlTextNode(node);
log('fillText-called', fillTextCalls > 0, `calls=${fillTextCalls}`);
log('epoch-bumped', (node.previewContentEpoch ?? 0) > 0, String(node.previewContentEpoch));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exit(1);

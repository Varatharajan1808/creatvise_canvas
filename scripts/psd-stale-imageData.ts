import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd } from 'ag-psd';
import type { Doc, Node } from '../src/model';

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd, exportPsd, createSamplePsd } = await import('../src/psd');
const { leaves } = await import('../src/model');

function findNode(doc: Doc, name: string): Node | undefined {
  return [...leaves(doc)].find((n) => n.name === name);
}

const doc = importPsd('stale.psd', createSamplePsd());
const n = findNode(doc, 'Green circle')!;
const s = n.src;
// Simulate stale imageData alongside updated canvas (ag-psd write prefers imageData)
const ctx = s.canvas!.getContext('2d')!;
s.imageData = ctx.getImageData(0, 0, s.canvas!.width, s.canvas!.height);
n.rotation = 45;
const out = exportPsd(doc);
const psd = readPsd(out, { skipThumbnail: true });
const walk = (ls: typeof psd.children) => {
  for (const l of ls ?? []) {
    if (l.name === 'Green circle') {
      const w = (l.right ?? 0) - (l.left ?? 0);
      console.log('stale-imageData test', { w, left: l.left, top: l.top, expectW: 284 });
      console.log(w >= 270 ? 'OK baked export uses canvas not stale imageData' : 'FAIL still using stale pixels');
    }
    walk(l.children);
  }
};
walk(psd.children);

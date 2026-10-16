import fs from 'fs';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd } from 'ag-psd';

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const orig = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, o?: unknown) =>
  tag === 'canvas' ? createCanvas(1, 1) : orig(tag, o as never)) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const psd = readPsd(fs.readFileSync('C:/Users/Dwinzo/Downloads/10960916.psd'), { skipThumbnail: true });

function walk(ls: typeof psd.children) {
  for (const l of ls ?? []) {
    console.log(
      JSON.stringify({
        name: l.name,
        mask: !!l.mask,
        maskCanvas: !!l.mask?.canvas,
        maskDisabled: l.mask?.disabled,
        maskSize: l.mask?.canvas ? `${l.mask.canvas.width}x${l.mask.canvas.height}` : null,
      }),
    );
    walk(l.children);
  }
}
walk(psd.children);

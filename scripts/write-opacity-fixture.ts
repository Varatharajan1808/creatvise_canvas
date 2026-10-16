import fs from 'fs';
import path from 'path';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';

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

const { createSamplePsd } = await import('../src/psd');
const dir = path.join('artifacts');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'fixture-opacity.psd'), Buffer.from(createSamplePsd()));
console.log('wrote artifacts/fixture-opacity.psd');

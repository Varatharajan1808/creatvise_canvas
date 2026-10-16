/**
 * PSD layer opacity survives import ? edit ? export ? re-import (ag-psd tree sync).
 */
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd } from 'ag-psd';
import { walk, type Doc, type Node, leaves } from '../src/model';

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

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

function find(doc: Doc, name: string): Node {
  return [...walk(doc.roots)].find((n) => n.name === name)!;
}

function flatOpacity(buf: ArrayBuffer, name: string): number | undefined {
  const psd = readPsd(buf, { skipThumbnail: true });
  const stack: typeof psd.children = [...(psd.children ?? [])];
  while (stack.length) {
    const l = stack.pop()!;
    if (l.name === name) return l.opacity ?? 1;
    stack.push(...(l.children ?? []));
  }
  return undefined;
}

async function run() {
  const { importPsd, exportPsd, createSamplePsd } = await import('../src/psd');
  const { isPointInLayer } = await import('../src/canvasHitTest');

  const sampleAb = createSamplePsd();

  const orig = importPsd('sample.psd', sampleAb.slice(0));
  const green = find(orig, 'Green circle');
  assert('import-green-opacity-100', green.opacity === 1 && green.importOpacity === 1, `opacity=${green.opacity}`);
  const orange = find(orig, 'Orange bar');
  assert('import-orange-preset', Math.abs(orange.opacity - 0.85) < 0.01, `opacity=${orange.opacity}`);

  const unedited = exportPsd(orig);
  assert('unedited-export-changes-bytes', unedited.byteLength > 0, `len=${unedited.byteLength}`);

  green.opacity = 0.6;
  const out60 = exportPsd(orig);
  assert('file-opacity-60', Math.abs((flatOpacity(out60, 'Green circle') ?? 0) - 0.6) < 0.02, `read=${flatOpacity(out60, 'Green circle')}`);
  const re60 = importPsd('re60.psd', out60);
  const g60 = find(re60, 'Green circle');
  assert('reimport-60-value', Math.abs(g60.opacity - 0.6) < 0.02 && Math.abs(g60.importOpacity - 0.6) < 0.02, `opacity=${g60.opacity}`);
  assert(
    'reimport-60-hit',
    isPointInLayer(g60, g60.x + g60.w / 2, g60.y + g60.h / 2),
    `center hit at ${g60.x + g60.w / 2},${g60.y + g60.h / 2}`,
  );

  const d30 = importPsd('fresh.psd', sampleAb.slice(0));
  find(d30, 'Green circle').opacity = 0.3;
  const out30 = exportPsd(d30);
  const g30 = find(importPsd('re30.psd', out30), 'Green circle');
  assert('reimport-30-value', Math.abs(g30.opacity - 0.3) < 0.02, `opacity=${g30.opacity}`);

  g60.opacity = 0.3;
  const outChain = exportPsd(re60);
  const gChain = find(importPsd('chain.psd', outChain), 'Green circle');
  assert('chain-60-to-30', Math.abs(gChain.opacity - 0.3) < 0.02, `opacity=${gChain.opacity}`);

  const multi = importPsd('multi.psd', sampleAb.slice(0));
  find(multi, 'Green circle').opacity = 0.6;
  find(multi, 'Orange bar').opacity = 0.4;
  const outMulti = exportPsd(multi);
  const reMulti = importPsd('multi-re.psd', outMulti);
  assert('multi-green', Math.abs(find(reMulti, 'Green circle').opacity - 0.6) < 0.02, `green=${find(reMulti, 'Green circle').opacity}`);
  assert('multi-orange', Math.abs(find(reMulti, 'Orange bar').opacity - 0.4) < 0.02, `orange=${find(reMulti, 'Orange bar').opacity}`);

  const vis = importPsd('vis.psd', sampleAb.slice(0));
  const vn = find(vis, 'Green circle');
  vn.opacity = 0.6;
  vn.visible = false;
  const visRe = importPsd('vis-re.psd', exportPsd(vis));
  const vr = find(visRe, 'Green circle');
  assert('opacity-hidden', !vr.visible && Math.abs(vr.opacity - 0.6) < 0.02, `visible=${vr.visible} opacity=${vr.opacity}`);

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} PSD opacity tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} PSD opacity tests passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

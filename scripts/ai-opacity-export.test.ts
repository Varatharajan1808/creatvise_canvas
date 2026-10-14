/**
 * AI layer opacity survives import → edit → export → re-import.
 * Raster previews stay fully opaque; Node.opacity carries the ExtGState /ca value.
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { walk, type Doc, type Node } from '../src/model';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

function leaf(doc: Doc): Node {
  return [...walk(doc.roots)].find((n) => n.kind !== 'group' && n.canvas)!;
}

function meanOpaqueAlpha(n: Node): number {
  const c = n.canvas!;
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let s = 0;
  let k = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i]! > 8) {
      s += d[i]!;
      k++;
    }
  }
  return k ? s / k : 0;
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/** Mirrors `src/ai.ts` — browser TextDecoder('latin1') must not be used for PDF byte round-trips. */
function bytesToLatin1String(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

async function runTests() {
  const {
    importAi,
    exportAi,
    parseExtGStateOpacity,
    verifyExportedExtGStateOpacity,
  } = await import('../src/ai');

  const sampleBuf = fs.readFileSync('public/sample.ai');
  const sampleAb = sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength);

  const latin1Rt = latin1Encode(bytesToLatin1String(new Uint8Array(sampleAb)));
  assert(
    'pdf-latin1-roundtrip-lossless',
    buffersEqual(sampleAb, latin1Rt.buffer.slice(latin1Rt.byteOffset, latin1Rt.byteOffset + latin1Rt.byteLength)),
    `sample.ai ${sampleAb.byteLength} bytes`,
  );

  const original = await importAi('sample.ai', sampleAb.slice(0));
  const origLeaf = leaf(original);
  const origMean = meanOpaqueAlpha(origLeaf);
  assert('import-opacity-100', origLeaf.opacity === 1 && origLeaf.importOpacity === 1, `opacity=${origLeaf.opacity}`);
  assert('import-raster-not-premultiplied', origMean > 240, `mean opaque alpha=${origMean.toFixed(1)}`);

  const unedited = await exportAi(original);
  assert('unedited-export-identical', buffersEqual(sampleAb, unedited), `len ${sampleAb.byteLength} vs ${unedited.byteLength}`);

  // 100% → 60% → export → re-import
  origLeaf.opacity = 0.6;
  const out60 = await exportAi(original);
  const v60 = await verifyExportedExtGStateOpacity(out60, 0.6);
  assert('export-60-ca', v60.ok, `read=${v60.read}`);
  const re60 = await importAi('sample-60.ai', out60);
  const n60 = leaf(re60);
  assert('reimport-60-value', Math.abs(n60.opacity - 0.6) < 0.015 && Math.abs(n60.importOpacity - 0.6) < 0.015, `opacity=${n60.opacity} import=${n60.importOpacity}`);
  assert('reimport-60-raster-full', meanOpaqueAlpha(n60) > 240, `mean opaque alpha=${meanOpaqueAlpha(n60).toFixed(1)}`);
  assert('reimport-60-unedited-identical', buffersEqual(out60, await exportAi(re60)), 'second export of untouched re-import');

  // 100% → 30%
  const d30 = await importAi('sample-30.ai', sampleAb.slice(0));
  leaf(d30).opacity = 0.3;
  const out30 = await exportAi(d30);
  assert('export-30-ca', (await verifyExportedExtGStateOpacity(out30, 0.3)).ok, `read=${await parseExtGStateOpacity(out30)}`);
  const n30 = leaf(await importAi('sample-30-re.ai', out30));
  assert('reimport-30-value', Math.abs(n30.opacity - 0.3) < 0.015, `opacity=${n30.opacity}`);
  assert('reimport-30-raster-full', meanOpaqueAlpha(n30) > 240, `mean opaque alpha=${meanOpaqueAlpha(n30).toFixed(1)}`);

  // 60% → re-import → 30% → export again
  n60.opacity = 0.3;
  const out60to30 = await exportAi(re60);
  assert('second-edit-30-ca', (await verifyExportedExtGStateOpacity(out60to30, 0.3)).ok, `read=${await parseExtGStateOpacity(out60to30)}`);
  const n60to30 = leaf(await importAi('sample-60-30.ai', out60to30));
  assert('second-edit-reimport-30', Math.abs(n60to30.opacity - 0.3) < 0.015, `opacity=${n60to30.opacity}`);

  // Opacity + visibility (not confused)
  const vis = await importAi('sample-vis-op.ai', sampleAb.slice(0));
  const vn = leaf(vis);
  vn.opacity = 0.6;
  vn.visible = false;
  const visOut = await exportAi(vis);
  const visRe = await importAi('sample-vis-op-re.ai', visOut);
  const vr = leaf(visRe);
  assert('opacity-plus-hidden', !vr.visible && !vr.importVisible, `visible=${vr.visible}`);
  assert('opacity-plus-hidden-value', Math.abs(vr.opacity - 0.6) < 0.015, `opacity=${vr.opacity}`);
  vr.visible = true;
  assert('opacity-plus-hidden-raster-full', meanOpaqueAlpha(vr) > 240, `mean opaque alpha=${meanOpaqueAlpha(vr).toFixed(1)}`);

  // Opacity + move/rotate (pdf-lib path)
  const geom = await importAi('sample-geom-op.ai', sampleAb.slice(0));
  const gn = leaf(geom);
  gn.opacity = 0.6;
  gn.x = 40;
  gn.rotation = 15;
  const geomOut = await exportAi(geom);
  assert('opacity-plus-transform-ca', (await verifyExportedExtGStateOpacity(geomOut, 0.6)).ok, `read=${await parseExtGStateOpacity(geomOut)}`);
  const gr = leaf(await importAi('sample-geom-op-re.ai', geomOut));
  assert('opacity-plus-transform-value', Math.abs(gr.opacity - 0.6) < 0.015 && Math.abs(gr.importOpacity - 0.6) < 0.015, `opacity=${gr.opacity}`);
  assert('opacity-plus-transform-rotation', Math.abs(gr.rotation - 15) < 0.05, `rot=${gr.rotation}`);
  assert('opacity-plus-transform-raster-full', meanOpaqueAlpha(gr) > 240, `mean opaque alpha=${meanOpaqueAlpha(gr).toFixed(1)}`);
  assert('opacity-plus-transform-unedited-identical', buffersEqual(geomOut, await exportAi(await importAi('sample-geom-op-re2.ai', geomOut))), 'no double write');

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} AI opacity tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} AI opacity tests passed`);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

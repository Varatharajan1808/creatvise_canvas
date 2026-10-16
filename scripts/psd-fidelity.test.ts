/**
 * Regression tests for real PSD import fidelity (10960916 / double-exposure template).
 * Set PSD_FIXTURE or pass path as argv[2]. Skips when file missing.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import {
  importPsd,
  inspectDocLayers,
  countUnsupportedLayers,
  composeDocPreview,
} from '../src/psd/psd';
import { walk, leaves } from '../src/core/model';
import { getDocPreviewCanvas } from '../src/psd/psdComposite';

const fixturePath =
  process.argv[2] ??
  process.env.PSD_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

if (!fs.existsSync(fixturePath)) {
  console.log(`SKIP: fixture not found (${fixturePath})`);
  process.exit(0);
}

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const buf = fs.readFileSync(fixturePath);
const doc = importPsd(path.basename(fixturePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

log('layer-walk-count', [...walk(doc.roots)].length === 17, String([...walk(doc.roots)].length));
log('leaf-count', leaves(doc).length === 11, String(leaves(doc).length));
log('unsupported-count', countUnsupportedLayers(doc) === 10, String(countUnsupportedLayers(doc)));
log('preview-mode-file-composite', doc.psdPreviewMode === 'file-composite', String(doc.psdPreviewMode));
log('has-file-composite', !!doc.fileComposite, String(!!doc.fileComposite));
log('doc-size', doc.width === 3000 && doc.height === 4000, `${doc.width}x${doc.height}`);

const unsupportedNames = inspectDocLayers(doc)
  .filter((l) => l.unsupported.length > 0)
  .map((l) => l.name);
log(
  'unsupported-names',
  unsupportedNames.length === 10 &&
    unsupportedNames.includes('Background') &&
    unsupportedNames.includes('Image 2') &&
    unsupportedNames.includes('Color Lookup 1'),
  JSON.stringify(unsupportedNames),
);

const composed = composeDocPreview(doc);
const preview = getDocPreviewCanvas(doc);
log('compose-non-empty', composed.width === 3000, `composed ${composed.width}x${composed.height}`);
log('file-preview-non-empty', preview?.width === 3000, `preview ${preview?.width}x${preview?.height}`);

// Composite preview should differ from naive stack (lighten + clip on Image 2)
const ctx = composed.getContext('2d')!;
const sample = ctx.getImageData(1500, 2000, 1, 1).data;
log('compose-has-opaque-pixels', sample[3] > 0, `alpha@${sample[3]}`);

console.log('\nJSON:' + JSON.stringify(results));
process.exit(results.some((r) => !r.ok) ? 1 : 0);

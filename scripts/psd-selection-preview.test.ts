/**
 * Selecting a layer must not leave embedded file-composite preview (9015560.psd).
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { walk, effOpacity } from '../src/model';
import {
  composePaintedLayerNames,
  getDocPreviewCanvas,
  isShowingEmbeddedFileComposite,
} from '../src/psdComposite';

const fixture9015560 =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

if (!fs.existsSync(fixture9015560)) {
  console.log(`SKIP: fixture not found (${fixture9015560})`);
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

const buf = fs.readFileSync(fixture9015560);
const doc = importPsd(path.basename(fixture9015560), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const portrait = [...walk(doc.roots)].find((n) => n.name === 'Place your portrait here')!;

log('import-file-composite', doc.psdStaticComposite === true && isShowingEmbeddedFileComposite(doc), doc.psdPreviewMode ?? '');

// Selection alone: no refreshPsdPreviewModeAfterEdit (panel select / click without edit)
log(
  'select-only-keeps-embedded',
  isShowingEmbeddedFileComposite(doc),
  `preview=${getDocPreviewCanvas(doc) === doc.fileComposite}`,
);

log('portrait-opacity-zero', portrait.opacity === 0 && effOpacity(portrait) === 0, String(portrait.opacity));

const painted = composePaintedLayerNames(doc);
log(
  'portrait-excluded-from-compose',
  !painted.includes('Place your portrait here'),
  painted.filter((n) => n.includes('portrait') || n.includes('Portrait')).join(',') || 'none',
);

// Actual edit: move a layer → live composite
const text = [...walk(doc.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
text.x += 50;
refreshPsdPreviewModeAfterEdit(doc);
log(
  'after-edit-uses-overlay-not-flat',
  doc.psdStaticComposite === false && doc.psdPreviewMode === 'file-base-overlay',
  doc.psdPreviewMode ?? '',
);

// Click-select without move should keep embedded on a fresh doc
const doc2 = importPsd('9015560.psd', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const portrait2 = [...walk(doc2.roots)].find((n) => n.name === 'Place your portrait here')!;
void portrait2;
log('fresh-doc-still-embedded-after-no-edit', isShowingEmbeddedFileComposite(doc2), String(doc2.psdStaticComposite));

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

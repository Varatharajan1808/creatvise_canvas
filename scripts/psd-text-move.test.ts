/**
 * Text / raster text layer move must leave file-composite and update live preview (9015560.psd).
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit, exportPsd } from '../src/psd/psd';
import { History } from '../src/core/history';
import { walk } from '../src/core/model';
import {
  composeDocPreview,
  docHasPreviewDirtyLayers,
  getDocPreviewCanvas,
  isShowingEmbeddedFileComposite,
  isUsingFileBaseOverlayPreview,
} from '../src/psd/psdComposite';

const fixture9015560 =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');

const fixture10960916 =
  process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

function setupDom() {
  const window = new Window();
  (globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = ((tag: string, options?: unknown) => {
    if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
    return origCreate(tag, options as never);
  }) as typeof window.document.createElement;
  initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);
}

function loadDoc(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return importPsd(path.basename(filePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

if (!fs.existsSync(fixture9015560)) {
  console.log(`SKIP: 9015560 fixture not found (${fixture9015560})`);
  process.exit(0);
}

setupDom();
const doc = loadDoc(fixture9015560);
const text = [...walk(doc.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
const origX = text.x;
const origY = text.y;
const filePreview = doc.fileComposite!;

log('9015560-static-composite', doc.psdStaticComposite === true, String(doc.psdStaticComposite));
log('9015560-text-is-raster', text.kind === 'raster' && !!text.canvas, `${text.kind} canvas=${!!text.canvas}`);

const stalePreview = getDocPreviewCanvas(doc);
text.x += 100;
text.y += 60;
const stillStale = getDocPreviewCanvas(doc);
log(
  '9015560-live-preview-without-reconcile',
  stalePreview === filePreview &&
    docHasPreviewDirtyLayers(doc) &&
    stillStale !== filePreview,
  `dirty=${docHasPreviewDirtyLayers(doc)}`,
);

refreshPsdPreviewModeAfterEdit(doc);
const livePreview = getDocPreviewCanvas(doc)!;
log(
  '9015560-live-after-refresh',
  doc.psdStaticComposite === false && isUsingFileBaseOverlayPreview(doc),
  doc.psdPreviewMode ?? '',
);
log('9015560-file-base-overlay', isUsingFileBaseOverlayPreview(doc), String(livePreview !== filePreview));

const composed = composeDocPreview(doc);
log(
  '9015560-compose-updated',
  composed !== filePreview && text.x === origX + 100 && text.y === origY + 60,
  `pos=${text.x},${text.y}`,
);

const exported = exportPsd(doc);
const docRt = importPsd('exported.psd', exported);
const textRt = [...walk(docRt.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
log('9015560-export-position', textRt.x === text.x && textRt.y === text.y, `${textRt.x},${textRt.y} vs ${text.x},${text.y}`);

// Undo/redo style command on 9015560
const docU = loadDoc(fixture9015560);
const tU = [...walk(docU.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
const before: [typeof tU, number, number] = [tU, tU.x, tU.y];
tU.x += 40;
tU.y += 30;
refreshPsdPreviewModeAfterEdit(docU);
const after: [typeof tU, number, number] = [tU, tU.x, tU.y];
const hist = new History();
hist.exec({
  label: 'Move',
  do: () => {
    tU.x = after[1];
    tU.y = after[2];
    refreshPsdPreviewModeAfterEdit(docU);
  },
  undo: () => {
    tU.x = before[1];
    tU.y = before[2];
    refreshPsdPreviewModeAfterEdit(docU);
  },
});
hist.undo();
log('9015560-undo-position', tU.x === before[1] && tU.y === before[2], `${tU.x},${tU.y}`);
log(
  '9015560-undo-preview-embedded',
  docU.psdStaticComposite === true &&
    isShowingEmbeddedFileComposite(docU) &&
    getDocPreviewCanvas(docU) === docU.fileComposite,
  docU.psdPreviewMode ?? '',
);
hist.redo();
log('9015560-redo-position', tU.x === after[1] && tU.y === after[2], `${tU.x},${tU.y}`);
log(
  '9015560-redo-preview-overlay',
  docU.psdStaticComposite === false && isUsingFileBaseOverlayPreview(docU),
  docU.psdPreviewMode ?? '',
);

if (fs.existsSync(fixture10960916)) {
  const d2 = loadDoc(fixture10960916);
  const layer1 = [...walk(d2.roots)].find((n) => n.name === 'Layer 1')!;
  layer1.x += 25;
  refreshPsdPreviewModeAfterEdit(d2);
  const p2 = getDocPreviewCanvas(d2);
  log('10960916-live-after-move', d2.psdStaticComposite === false && p2 !== d2.fileComposite, d2.psdPreviewMode ?? '');
}

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

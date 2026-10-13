/**
 * Drag/edit preview must keep embedded composite base (9015560 puzzle effect).
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { walk } from '../src/model';
import { History } from '../src/history';
import {
  composeDocPreview,
  getDocPreviewCanvas,
  isLayerPreviewDirty,
  isShowingEmbeddedFileComposite,
  isUsingFileBaseOverlayPreview,
} from '../src/psdComposite';

const fixture =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

if (!fs.existsSync(fixture)) {
  console.log(`SKIP: fixture not found (${fixture})`);
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

const buf = fs.readFileSync(fixture);
const doc = importPsd(path.basename(fixture), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const text = [...walk(doc.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;

const sample = (c: HTMLCanvasElement, x: number, y: number) => {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]] as const;
};

// Background puzzle area (avoid text / portrait regions)
const bx = 400;
const by = 400;
const filePx = sample(doc.fileComposite!, bx, by);

text.x += 80;
text.y += 40;
log('text-dirty', isLayerPreviewDirty(text), `${text.x},${text.y}`);

refreshPsdPreviewModeAfterEdit(doc);
log('overlay-mode', isUsingFileBaseOverlayPreview(doc), doc.psdPreviewMode ?? '');

const overlayPreview = getDocPreviewCanvas(doc)!;
const flatCompose = composeDocPreview(doc);
const overlayPx = sample(overlayPreview, bx, by);
const flatPx = sample(flatCompose, bx, by);

log(
  'background-matches-file-composite',
  overlayPx[0] === filePx[0] && overlayPx[1] === filePx[1] && overlayPx[2] === filePx[2],
  `file=${filePx.join(',')} overlay=${overlayPx.join(',')}`,
);

log(
  'flat-compose-differs-from-file-at-bg',
  flatPx[0] !== filePx[0] || flatPx[1] !== filePx[1] || flatPx[2] !== filePx[2],
  `flat=${flatPx.join(',')}`,
);

log('overlay-not-flat-compose', overlayPreview !== flatCompose, 'refs');

log(
  'bg-alpha-not-transparent-after-move',
  overlayPx[3] === filePx[3] && overlayPx[3] > 200,
  `alpha overlay=${overlayPx[3]} file=${filePx[3]}`,
);

// Undo restores embedded composite preview (no overlay mode while model is clean)
const docUndo = importPsd(path.basename(fixture), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const tUndo = [...walk(docUndo.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
const beforeU: [typeof tUndo, number, number] = [tUndo, tUndo.x, tUndo.y];
tUndo.x += 80;
tUndo.y += 40;
refreshPsdPreviewModeAfterEdit(docUndo);
const afterU: [typeof tUndo, number, number] = [tUndo, tUndo.x, tUndo.y];
const hist = new History();
hist.exec({
  label: 'Move',
  do: () => {
    tUndo.x = afterU[1];
    tUndo.y = afterU[2];
    refreshPsdPreviewModeAfterEdit(docUndo);
  },
  undo: () => {
    tUndo.x = beforeU[1];
    tUndo.y = beforeU[2];
    refreshPsdPreviewModeAfterEdit(docUndo);
  },
});
hist.undo();
const undoPreview = getDocPreviewCanvas(docUndo)!;
const undoPx = sample(undoPreview, bx, by);
log(
  'undo-restores-static-embedded',
  docUndo.psdStaticComposite === true &&
    isShowingEmbeddedFileComposite(docUndo) &&
    undoPreview === docUndo.fileComposite,
  `mode=${docUndo.psdPreviewMode}`,
);
log(
  'undo-preview-pixels-match-import',
  undoPx[0] === filePx[0] && undoPx[1] === filePx[1] && undoPx[2] === filePx[2] && undoPx[3] === filePx[3],
  undoPx.join(','),
);
hist.redo();
log(
  'redo-back-to-overlay',
  docUndo.psdStaticComposite === false && isUsingFileBaseOverlayPreview(docUndo),
  docUndo.psdPreviewMode ?? '',
);

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

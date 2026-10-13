/**
 * Opening a file is one undo step: undo removes only the opened document(s), redo restores the same documents
 * (layer tree, preview, state) in the same slots, and other documents are untouched.
 * Uses the production open/close commands (src/docHistory.ts); layer edit commands and the selection rule mirror src/main.ts.
 */
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, exportPsd, createSamplePsd, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { History, type Command } from '../src/history';
import { leaves, walk, docOf, type Doc, type Node } from '../src/model';
import { getDocPreviewCanvas } from '../src/psdComposite';
import { canEditPsdLayerPosition } from '../src/psdLayerInfo';
import { closeDocCommand, openDocsCommand, type DocVisibility } from '../src/docHistory';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

// Native canvases are invisible to V8's heap accounting and are freed by finalizers that only run on the event loop,
// so large fixtures exhaust memory unless each step collects and yields.
v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;
async function settle() {
  collect();
  await new Promise((r) => setImmediate(r));
}

// ---- app stand-ins -------------------------------------------------------------------
const docs: Doc[] = [];
const hist = new History();
const shown = new Map<Doc, boolean>();
const view: DocVisibility = { setDocVisible: (d, v) => { shown.set(d, v); } };
let selected: Node | null = null;

/** main.ts refresh(): drop the selection when its document is no longer open. */
function refresh() {
  if (selected && !docOf(selected, docs)) selected = null;
}
hist.onChange = refresh;

/** main.ts addDoc + recordOpened: files are placed first, then one step is recorded for the whole action. */
function open(...added: Doc[]) {
  for (const d of added) { docs.push(d); shown.set(d, true); }
  if (added.length) hist.exec(openDocsCommand(docs, added, view), true);
}

function move(doc: Doc, n: Node, dx: number, dy: number) {
  const [x0, y0] = [n.x, n.y];
  n.x += dx;
  n.y += dy;
  const [x1, y1] = [n.x, n.y];
  hist.exec({
    label: 'Move',
    do: () => { n.x = x1; n.y = y1; refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { n.x = x0; n.y = y0; refreshPsdPreviewModeAfterEdit(doc); },
  }, true);
  refreshPsdPreviewModeAfterEdit(doc);
}

function setOpacity(doc: Doc, n: Node, to: number) {
  const from = n.opacity;
  hist.exec({
    label: 'Opacity',
    do: () => { n.opacity = to; refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { n.opacity = from; refreshPsdPreviewModeAfterEdit(doc); },
  });
}

// ---- state capture --------------------------------------------------------------------
function hashCanvas(c: HTMLCanvasElement | null): number | null {
  if (!c) return null;
  const px = new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) h = Math.imul(h ^ px[i]!, 0x01000193);
  return h >>> 0;
}

interface DocSnap { sig: string; roots: Node[]; canvases: Array<HTMLCanvasElement | null>; preview: number | null; embedded: boolean; mode: string | undefined; fileComposite: unknown; offset: string }
function snapDoc(d: Doc): DocSnap {
  const all = [...walk(d.roots)];
  const p = getDocPreviewCanvas(d);
  return {
    sig: JSON.stringify(all.map((n) => [n.id, n.key, n.name, n.x, n.y, n.w, n.h, n.rotation, n.opacity, n.visible, n.ox, n.oy])),
    roots: [...d.roots],
    canvases: all.map((n) => n.canvas),
    preview: hashCanvas(p),
    embedded: !!p && p === d.fileComposite,
    mode: d.psdPreviewMode,
    fileComposite: d.fileComposite,
    offset: `${d.offsetX},${d.offsetY}`,
  };
}
function sameDoc(d: Doc, s: DocSnap): [boolean, string] {
  const now = snapDoc(d);
  const tree = now.sig === s.sig && now.roots.length === s.roots.length && now.roots.every((r, i) => r === s.roots[i]);
  const pixels = now.canvases.every((c, i) => c === s.canvases[i]);
  const ok = tree && pixels && now.preview === s.preview && now.embedded === s.embedded && now.mode === s.mode && now.fileComposite === s.fileComposite && now.offset === s.offset;
  return [ok, `tree=${tree} layerPixels=${pixels} preview=${now.preview === s.preview} mode=${now.mode}/${s.mode} embedded=${now.embedded}`];
}

const stacks = () => {
  const x = hist as unknown as { undoStack: Command[]; redoStack: Command[] };
  return `undo=${x.undoStack.length} redo=${x.redoStack.length}`;
};
const order = () => docs.map((d) => d.name).join(' | ');

function movable(doc: Doc): Node {
  return leaves(doc)
    .filter((n) => canEditPsdLayerPosition(n) && n.canvas && n.opacity > 0.001 && n.w > 0 && n.h > 0 && !(n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0]!;
}

// ---- scenario -------------------------------------------------------------------------
const fixture =
  process.argv[2] ?? process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const loadOriginal = (): Doc => {
  if (!fs.existsSync(fixture)) return importPsd('original.psd', createSamplePsd());
  const b = fs.readFileSync(fixture);
  return importPsd(path.basename(fixture), b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

// Edit the original, export it, import the export as a new document.
const original = loadOriginal();
open(original);
const layer = movable(original);
const opacity0 = layer.opacity;
move(original, layer, 60, 30);
setOpacity(original, layer, 0.6);
await settle();
const exported = importPsd(`${original.name.replace(/\.psd$/i, '')}-edited.psd`, exportPsd(original));
exported.offsetX = original.width + 200;
open(exported);
await settle();

const reLayer = leaves(exported).find((n) => n.key === layer.key)!;
log('import-is-the-edited-export', reLayer.x === layer.x && reLayer.y === layer.y && Math.abs(reLayer.opacity - 0.6) < 0.01, `x,y=${reLayer.x},${reLayer.y} opacity=${reLayer.opacity.toFixed(3)}`);
log('import-is-one-history-step', stacks() === 'undo=4 redo=0', stacks());

const originalSnap = snapDoc(original);
const exportedSnap = snapDoc(exported);
selected = reLayer;
await settle();

// Undo right after the import removes only the imported document.
hist.undo();
log('undo-import-removes-only-imported', docs.length === 1 && docs[0] === original && shown.get(exported) === false && shown.get(original) === true, order());
log('undo-import-original-unchanged', ...sameDoc(original, originalSnap));
log('undo-import-history', stacks() === 'undo=3 redo=1', stacks());
log('undo-import-clears-selection', selected === null, String(selected?.name ?? null));
await settle();

// Redo brings back the same document, unchanged.
hist.redo();
log('redo-import-restores-document', docs.length === 2 && docs[1] === exported && shown.get(exported) === true, order());
log('redo-import-restores-state', ...sameDoc(exported, exportedSnap));
log('redo-import-original-unchanged', ...sameDoc(original, originalSnap));
log('redo-import-history', stacks() === 'undo=4 redo=0', stacks());
await settle();

// Later edits inside the imported document undo first, then the import, then the original's edits.
move(exported, reLayer, -25, 40);
const editedImportSnap = snapDoc(exported);
await settle();
hist.undo();
log('undo-edit-in-import-keeps-docs', docs.length === 2 && docs[0] === original && docs[1] === exported, order());
log('undo-edit-in-import-restores-import-state', ...sameDoc(exported, exportedSnap));
log('undo-edit-in-import-original-unchanged', ...sameDoc(original, originalSnap));
await settle();
hist.undo();
log('then-undo-removes-import', docs.length === 1 && docs[0] === original, order());
log('then-undo-original-unchanged', ...sameDoc(original, originalSnap));
await settle();
hist.undo();
log('then-undo-reaches-original-edit', layer.opacity === opacity0 && docs.length === 1, `original opacity=${layer.opacity.toFixed(3)} expected=${opacity0.toFixed(3)}`);
await settle();
hist.redo();
hist.redo();
log('redo-chain-restores-import', docs.length === 2 && docs[1] === exported && layer.opacity === 0.6, order());
hist.redo();
log('redo-chain-restores-import-edit', ...sameDoc(exported, editedImportSnap));
log('redo-chain-original-unchanged', ...sameDoc(original, originalSnap));
await settle();

// Three or more documents: ordering, close/undo slots, batch open (folder import / multi-file).
const third = importPsd('third.psd', createSamplePsd());
open(third);
log('three-docs-order', order() === `${original.name} | ${exported.name} | third.psd`, order());
hist.exec(closeDocCommand(docs, exported, view));
log('close-middle-doc', order() === `${original.name} | third.psd` && shown.get(exported) === false, order());
hist.undo();
log('undo-close-restores-slot', order() === `${original.name} | ${exported.name} | third.psd` && shown.get(exported) === true, order());

const batch = [importPsd('folder/a.psd', createSamplePsd()), importPsd('folder/b.psd', createSamplePsd())];
const beforeBatch = stacks();
open(...batch);
log('batch-open-is-one-step', stacks() !== beforeBatch && order().endsWith('folder/a.psd | folder/b.psd'), stacks());
selected = leaves(batch[1]!)[0]!;
hist.undo();
log('undo-batch-removes-all', order() === `${original.name} | ${exported.name} | third.psd` && batch.every((d) => shown.get(d) === false), order());
log('undo-batch-clears-selection', selected === null, String(selected?.name ?? null));
log('undo-batch-others-unchanged', sameDoc(original, originalSnap)[0] && sameDoc(exported, editedImportSnap)[0], 'original and imported docs');
hist.redo();
log('redo-batch-restores-order', order() === `${original.name} | ${exported.name} | third.psd | folder/a.psd | folder/b.psd` && batch.every((d) => shown.get(d) === true), order());

// The undone close was dropped from redo by the batch open, so stepping back goes batch, then the third file's open.
hist.undo();
hist.undo();
log('undo-third-open', order() === `${original.name} | ${exported.name}`, order());
hist.redo();
log('redo-third-open-slot', order() === `${original.name} | ${exported.name} | third.psd`, order());

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

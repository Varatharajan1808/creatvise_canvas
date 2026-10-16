/**
 * Deleting PSD layers must refresh preview (no stale embedded composite after structural edits).
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';
import type { Command } from '../src/core/history';
import type { Doc, Node } from '../src/core/model';

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

const { importPsd, refreshPsdPreviewModeAfterEdit } = await import('../src/psd/psd');
const { History } = await import('../src/core/history');
const { leaves, walk } = await import('../src/core/model');
const {
  composeDocPreview,
  getDocPreviewCanvas,
  docPsdFlattenedAtImport,
  docPsdStructureChanged,
  invalidatePsdPreviewCache,
} = await import('../src/psd/psdComposite');
const { sourceIndex, sourceRemove, sourceRestore } = await import('../src/core/sourceTree');

const W = 120;
const H = 90;

function mk(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return c;
}

function fill(w: number, h: number, css: string) {
  return mk(w, h, (g) => {
    g.fillStyle = css;
    g.fillRect(0, 0, w, h);
  });
}

const rect = (name: string, x: number, y: number, w: number, h: number, css: string, extra: Partial<Layer> = {}): Layer => ({
  name,
  left: x,
  top: y,
  right: x + w,
  bottom: y + h,
  canvas: fill(w, h, css),
  ...extra,
});

const realComposite = () =>
  mk(W, H, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2050d0';
    g.fillRect(10, 10, 40, 40);
    g.fillStyle = '#f08030';
    g.fillRect(70, 40, 40, 40);
  });

function buildWithComposite(children: Layer[]): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = realComposite() as unknown as HTMLCanvasElement;
  return importPsd('del-preview.psd', writePsd(psd));
}

function deleteCommand(doc: Doc, n: Node): Command {
  const list = n.parent ? n.parent.children : doc.roots;
  const idx = list.indexOf(n);
  const srcIdx = sourceIndex(doc, n);
  return {
    label: 'Delete layer',
    do: () => {
      list.splice(list.indexOf(n), 1);
      sourceRemove(doc, n);
      invalidatePsdPreviewCache(doc);
      refreshPsdPreviewModeAfterEdit(doc);
    },
    undo: () => {
      list.splice(idx, 0, n);
      sourceRestore(doc, n, srcIdx);
      invalidatePsdPreviewCache(doc);
      refreshPsdPreviewModeAfterEdit(doc);
    },
  };
}

const previewCanvas = (doc: Doc) => getDocPreviewCanvas(doc) ?? composeDocPreview(doc);
const px = (c: HTMLCanvasElement | null, x: number, y: number) =>
  c ? [...c.getContext('2d')!.getImageData(x, y, 1, 1).data].join(',') : 'null';

// --- import: layers + composite ---
{
  const doc = buildWithComposite([
    rect('BG', 0, 0, W, H, '#ffffff'),
    rect('Blue', 10, 10, 40, 40, '#2050d0'),
    rect('Orange', 70, 40, 40, 40, '#f08030'),
  ]);
  log('import-leaf-count', leaves(doc).length === 3, String(leaves(doc).length));
  log('import-panel-walk', [...walk(doc.roots)].length === 3, String([...walk(doc.roots)].length));
  log('import-not-flattened', !docPsdFlattenedAtImport(doc), String(doc.psdImportLeafCount));
  const prev = previewCanvas(doc);
  log('import-shows-blue', px(prev, 25, 25).startsWith('32,80,208'), px(prev, 25, 25));
}

// --- delete one layer updates preview (file-composite base) ---
{
  const doc = buildWithComposite([
    rect('BG', 0, 0, W, H, '#ffffff'),
    rect('Blue', 10, 10, 40, 40, '#2050d0'),
    rect('Orange', 70, 40, 40, 40, '#f08030'),
  ]);
  doc.psdFileCompositeBase = true;
  doc.psdStaticComposite = true;
  doc.psdPreviewMode = 'file-composite';
  const before = px(previewCanvas(doc), 25, 25);
  const blue = leaves(doc).find((n) => n.name === 'Blue')!;
  const hist = new History();
  hist.exec(deleteCommand(doc, blue));
  log('delete-structure-changed', docPsdStructureChanged(doc), String(leaves(doc).length));
  log('delete-not-static-composite', doc.psdStaticComposite === false, String(doc.psdPreviewMode));
  const after = px(previewCanvas(doc), 25, 25);
  log('delete-blue-gone-from-preview', before.startsWith('32,80,208') && !after.startsWith('32,80,208'), `${before} -> ${after}`);
  log('delete-orange-remains', px(previewCanvas(doc), 85, 55).startsWith('240,128,48'), px(previewCanvas(doc), 85, 55));
  hist.undo();
  log('undo-restores-leaf-count', leaves(doc).length === 3, String(leaves(doc).length));
  log('undo-blue-returns', px(previewCanvas(doc), 25, 25).startsWith('32,80,208'), px(previewCanvas(doc), 25, 25));
}

// --- delete all editable layers: empty preview, not embedded composite ---
{
  const doc = buildWithComposite([
    rect('BG', 0, 0, W, H, '#ffffff'),
    rect('Blue', 10, 10, 40, 40, '#2050d0'),
  ]);
  doc.psdFileCompositeBase = true;
  doc.psdStaticComposite = true;
  const hist = new History();
  for (const n of [...leaves(doc)]) hist.exec(deleteCommand(doc, n));
  log('all-deleted-zero-leaves', leaves(doc).length === 0, '0');
  const prev = previewCanvas(doc);
  log('all-deleted-not-blue', !px(prev, 25, 25).startsWith('32,80,208'), px(prev, 25, 25));
  log('all-deleted-transparent-center', px(prev, 60, 45).endsWith(',0'), px(prev, 60, 45));
}

// --- flattened at import: no editable leaves; embedded composite still shown (read-only) ---
{
  const doc = buildWithComposite([
    rect('BG', 0, 0, W, H, '#ffffff'),
    rect('Blue', 10, 10, 40, 40, '#2050d0'),
  ]);
  doc.roots = [];
  if (doc.psd) doc.psd.children = [];
  doc.psdImportLeafCount = 0;
  doc.psdFileCompositeBase = true;
  doc.psdStaticComposite = true;
  doc.psdPreviewMode = 'file-composite';
  log('flattened-zero-leaves', leaves(doc).length === 0, String(leaves(doc).length));
  log('flattened-flag', docPsdFlattenedAtImport(doc), 'true');
  log('flattened-shows-embedded', px(previewCanvas(doc), 25, 25).startsWith('32,80,208'), px(previewCanvas(doc), 25, 25));
}

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`${failures.length} of ${results.length} delete-preview tests failed`);
  process.exit(1);
}
console.log(`All ${results.length} delete-preview tests passed`);

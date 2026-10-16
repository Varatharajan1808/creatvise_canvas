/**
 * Export must not change the open document: layer pixels, bounds, transform, preview and undo/redo history
 * stay exactly as they were, for resized and rotated layers too (and when the export fails).
 * transformCommand mirrors src/main.ts, which cannot be imported headlessly.
 */
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, type Layer, type Psd } from 'ag-psd';
import { importPsd, exportPsd, createSamplePsd, refreshPsdPreviewModeAfterEdit } from '../src/psd/psd';
import { History, type Command } from '../src/core/history';
import { leaves, walk, effVisible, isLocked, type Doc, type Node } from '../src/core/model';
import { getDocPreviewCanvas } from '../src/psd/psdComposite';

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

function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return new Uint8ClampedArray(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
}

function mismatches(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): number {
  if (!a || !b) return a === b ? 0 : -1;
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
}

// ---- mirror of main.ts transformCommand -------------------------------------------
interface Xform { x: number; y: number; w: number; h: number; rotation: number }
const getX = (n: Node): Xform => ({ x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation });

function transformCommand(doc: Doc, n: Node, before: Xform, after: Xform): Command {
  const apply = (t: Xform) => { n.x = t.x; n.y = t.y; n.w = t.w; n.h = t.h; n.rotation = t.rotation; };
  return {
    label: 'Transform',
    do: () => { apply(after); refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { apply(before); refreshPsdPreviewModeAfterEdit(doc); },
  };
}

/** Resize around the layer centre (as endPointer does), optionally rotated. */
function transformed(n: Node, sx: number, sy: number, rotation: number): Xform {
  const w = Math.max(1, Math.round(n.w * sx));
  const h = Math.max(1, Math.round(n.h * sy));
  return { x: n.x + n.w / 2 - w / 2, y: n.y + n.h / 2 - h / 2, w, h, rotation };
}

// ---- state capture ----------------------------------------------------------------
interface ModelSnap { sig: string; canvases: Array<HTMLCanvasElement | null> }
function modelSnap(doc: Doc): ModelSnap {
  const all = [...walk(doc.roots)];
  return {
    sig: JSON.stringify(all.map((n) => [
      n.key, n.x, n.y, n.w, n.h, n.rotation, n.ox, n.oy, n.ow, n.oh,
      n.opacity, n.visible, n.textTransform ?? null, n.previewContentEpoch ?? 0, !!n.textEdited,
    ])),
    canvases: all.map((n) => n.canvas),
  };
}
const sameModel = (a: ModelSnap, b: ModelSnap) =>
  a.sig === b.sig && a.canvases.length === b.canvases.length && a.canvases.every((c, i) => c === b.canvases[i]);

interface PreviewSnap { mode: string | undefined; isFile: boolean; px: Uint8ClampedArray | null }
function previewSnap(doc: Doc): PreviewSnap {
  const p = getDocPreviewCanvas(doc);
  return { mode: doc.psdPreviewMode, isFile: !!p && p === doc.fileComposite, px: p ? pixels(p) : null };
}
function comparePreview(a: PreviewSnap, b: PreviewSnap): [boolean, string] {
  const m = mismatches(a.px, b.px);
  return [a.mode === b.mode && a.isFile === b.isFile && m === 0, `mode=${a.mode}/${b.mode} embedded=${a.isFile}/${b.isFile} mismatched=${m}`];
}

const stacks = (h: History) => {
  const x = h as unknown as { undoStack: Command[]; redoStack: Command[] };
  return `undo=${x.undoStack.length} redo=${x.redoStack.length}`;
};

function layerAt(psd: Psd, key: string): Layer | undefined {
  let list = psd.children ?? [];
  let l: Layer | undefined;
  for (const i of key.split('/').map(Number)) {
    l = list[i];
    list = l?.children ?? [];
  }
  return l;
}

interface ExportedLayer { bounds: number[]; px: Uint8ClampedArray | null }
/** ImageData (not canvases) keeps decoded layers in the JS heap, so large fixtures are garbage-collected. */
function exportedLayer(bytes: ArrayBuffer, key: string): ExportedLayer {
  const l = layerAt(readPsd(bytes, { skipThumbnail: true, skipCompositeImageData: true, useImageData: true }), key);
  return {
    bounds: [l?.left ?? 0, l?.top ?? 0, l?.right ?? 0, l?.bottom ?? 0],
    px: l?.imageData ? new Uint8ClampedArray(l.imageData.data) : null,
  };
}
function compareLayer(a: ExportedLayer, b: ExportedLayer): [boolean, string] {
  const m = mismatches(a.px, b.px);
  return [JSON.stringify(a.bounds) === JSON.stringify(b.bounds) && m === 0, `bounds=${JSON.stringify(a.bounds)} vs ${JSON.stringify(b.bounds)} mismatched=${m}`];
}

/** Visible layers the editor lets you resize/rotate (main.ts canTransform), smallest first. */
function transformable(doc: Doc): Node[] {
  return leaves(doc)
    .filter((n) => n.kind === 'raster' && n.canvas && !isLocked(n) && !n.src.mask && !n.src.vectorMask)
    .filter((n) => effVisible(n) && n.opacity > 0.001 && n.w > 0 && n.h > 0)
    .sort((a, b) => a.w * a.h - b.w * b.h);
}

// ---- checks -----------------------------------------------------------------------
async function runCase(label: string, load: () => Doc, key: string, clean: ExportedLayer, xf: (n: Node) => Xform) {
  const doc = load();
  const n = leaves(doc).find((l) => l.key === key)!;
  const hist = new History();
  const importModel = modelSnap(doc);
  const importPreview = previewSnap(doc);
  await settle();

  hist.exec(transformCommand(doc, n, getX(n), xf(n)));
  const editedModel = modelSnap(doc);
  const editedPreview = previewSnap(doc);
  const editedStacks = stacks(hist);
  await settle();

  const first = exportedLayer(exportPsd(doc), key);
  log(`${label}-export-keeps-model`, sameModel(modelSnap(doc), editedModel), `x=${n.x} w=${n.w} rot=${n.rotation} ox=${n.ox} ow=${n.ow}`);
  log(`${label}-export-keeps-preview`, ...comparePreview(previewSnap(doc), editedPreview));
  log(`${label}-export-keeps-history`, stacks(hist) === editedStacks, `${stacks(hist)} expected ${editedStacks}`);
  log(`${label}-export-writes-baked-layer`, JSON.stringify(first.bounds) !== JSON.stringify(clean.bounds), `baked=${JSON.stringify(first.bounds)} import=${JSON.stringify(clean.bounds)}`);
  await settle();

  const second = exportedLayer(exportPsd(doc), key);
  log(`${label}-repeat-export-identical`, ...compareLayer(second, first));
  await settle();

  hist.undo();
  log(`${label}-undo-after-export-restores-model`, sameModel(modelSnap(doc), importModel), `x=${n.x} w=${n.w} rot=${n.rotation} canvasOriginal=${n.canvas === importModel.canvases[[...walk(doc.roots)].indexOf(n)]}`);
  log(`${label}-undo-after-export-restores-preview`, ...comparePreview(previewSnap(doc), importPreview));
  await settle();
  log(`${label}-undo-then-export-matches-import`, ...compareLayer(exportedLayer(exportPsd(doc), key), clean));
  await settle();

  hist.redo();
  log(`${label}-redo-restores-model`, sameModel(modelSnap(doc), editedModel), `x=${n.x} w=${n.w} rot=${n.rotation}`);
  log(`${label}-redo-restores-preview`, ...comparePreview(previewSnap(doc), editedPreview));
  await settle();
  log(`${label}-redo-then-export-matches-first`, ...compareLayer(exportedLayer(exportPsd(doc), key), first));
  await settle();
}

/** An export that throws part-way (layer too large to bake) leaves the document and history untouched. */
async function runFailedExport(label: string, load: () => Doc, keys: [string, string], clean: Map<string, ExportedLayer>) {
  const doc = load();
  const [a, b] = keys.map((k) => leaves(doc).find((l) => l.key === k)!);
  const hist = new History();
  hist.exec(transformCommand(doc, a!, getX(a!), transformed(a!, 1.1, 1.1, 20)));
  hist.exec(transformCommand(doc, b!, getX(b!), { ...getX(b!), w: 17000 }));
  const model = modelSnap(doc);
  const mode = doc.psdPreviewMode;
  const before = stacks(hist);
  let error = '';
  try {
    exportPsd(doc);
  } catch (e) {
    error = (e as Error).message;
  }
  log(`${label}-failed-export-throws`, error.includes('too large'), error || 'no error');
  log(`${label}-failed-export-keeps-model`, sameModel(modelSnap(doc), model), `a: w=${a!.w} rot=${a!.rotation} ox=${a!.ox}`);
  log(`${label}-failed-export-keeps-history`, stacks(hist) === before && doc.psdPreviewMode === mode, `${stacks(hist)} mode=${doc.psdPreviewMode}`);
  await settle();
  hist.undo();
  hist.undo();
  const bytes = exportPsd(doc);
  await settle();
  const ok = keys.every((k) => compareLayer(exportedLayer(bytes, k), clean.get(k)!)[0]);
  log(`${label}-failed-export-then-undo-exports-import`, ok, 'both layers back to import bounds and pixels');
  await settle();
}

async function runMultiDoc(label: string, load: () => Doc, key: string) {
  const docA = load();
  const docB = load();
  const snapB = modelSnap(docB);
  const previewB = previewSnap(docB);
  await settle();
  const n = leaves(docA).find((l) => l.key === key)!;
  transformCommand(docA, n, getX(n), transformed(n, 1.3, 1.3, 45)).do();
  exportPsd(docA);
  await settle();
  log(`${label}-multidoc-other-doc-untouched`, sameModel(modelSnap(docB), snapB) && comparePreview(previewSnap(docB), previewB)[0], String(docB.psdPreviewMode));
  await settle();
}

async function runSource(label: string, load: () => Doc) {
  const base = load();
  const candidates = transformable(base);
  if (candidates.length < 2) {
    log(`${label}-skip`, true, 'need two transformable layers');
    return;
  }
  const target = candidates[0]!.key;
  const cleanBytes = exportPsd(base);
  const clean = new Map(candidates.slice(0, 2).map((n) => [n.key, exportedLayer(cleanBytes, n.key)]));
  // Walk order: the first layer is baked before the oversized one throws.
  const order = [...walk(base.roots)].map((n) => n.key);
  const [first, last] = [candidates[0]!.key, candidates[1]!.key].sort((x, y) => order.indexOf(x) - order.indexOf(y));

  await settle();

  await runCase(`${label}-resize`, load, target, clean.get(target)!, (n) => transformed(n, 1.25, 0.8, 0));
  await runCase(`${label}-rotate`, load, target, clean.get(target)!, (n) => transformed(n, 1, 1, 30));
  await runCase(`${label}-resize-rotate`, load, target, clean.get(target)!, (n) => transformed(n, 1.2, 1.2, -15));
  await runFailedExport(label, load, [first!, last!], clean);
  await runMultiDoc(label, load, target);
}

await runSource('sample', () => importPsd('sample.psd', createSamplePsd()));

const fixtureA =
  process.argv[2] ?? process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const fixtureB = process.argv[3] ?? process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');
for (const [label, filePath] of [['fixture-a', fixtureA], ['fixture-b', fixtureB]] as const) {
  if (!fs.existsSync(filePath)) {
    log(`${label}-skip`, true, `missing ${filePath}`);
    continue;
  }
  const buf = fs.readFileSync(filePath);
  await runSource(label, () => importPsd(path.basename(filePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
}

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

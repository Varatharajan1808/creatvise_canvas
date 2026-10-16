/**
 * Sequential edits, then undo and redo one step at a time: each step must land exactly on the state recorded
 * after the matching edit (layer model, preview pixels, preview mode), with one history entry per user action.
 * Commands mirror src/main.ts (propCommand, positionsCommand/moveBy/endPointer, editContent/contentCommand),
 * which cannot be imported headlessly.
 */
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, createSamplePsd, refreshPsdPreviewModeAfterEdit } from '../src/psd/psd';
import { History, type Command } from '../src/core/history';
import { leaves, walk, type Doc, type Node } from '../src/core/model';
import { applyText, captureState, restoreState, type LayerState } from '../src/operations/edit';
import { getDocPreviewCanvas, markNodePreviewContentChanged } from '../src/psd/psdComposite';
import { canEditPsdLayerPosition, leavesForPositionEdit } from '../src/psd/psdLayerInfo';

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

// ---- mirrors of main.ts commands ------------------------------------------------------
function propCommand(doc: Doc, n: Node, to: number, from: number): Command {
  return {
    label: 'Opacity',
    do: () => { n.opacity = to; refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { n.opacity = from; refreshPsdPreviewModeAfterEdit(doc); },
  };
}

function positionsCommand(doc: Doc, before: Array<[Node, number, number]>, after: Array<[Node, number, number]>): Command {
  const apply = (list: Array<[Node, number, number]>) => list.forEach(([n, x, y]) => { n.x = x; n.y = y; });
  return {
    label: 'Move',
    do: () => { apply(after); refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { apply(before); refreshPsdPreviewModeAfterEdit(doc); },
  };
}

const snapshot = (n: Node): Array<[Node, number, number]> => leavesForPositionEdit(n).map((l) => [l, l.x, l.y]);

/** pointerdown → pointermove per step → pointerup (endPointer rounds, then records the applied command). */
function drag(hist: History, doc: Doc, n: Node, steps: Array<[number, number]>) {
  const before = snapshot(n);
  for (const [dx, dy] of steps) {
    for (const l of leavesForPositionEdit(n)) { l.x += dx; l.y += dy; }
    refreshPsdPreviewModeAfterEdit(doc);
  }
  for (const [l] of before) { l.x = Math.round(l.x); l.y = Math.round(l.y); }
  hist.exec(positionsCommand(doc, before, snapshot(n)), true);
}

/** Slider input per value (live preview), then change commits one history entry. */
function scrubOpacity(hist: History, doc: Doc, n: Node, values: number[]) {
  const start = n.opacity;
  for (const v of values) { n.opacity = v; refreshPsdPreviewModeAfterEdit(doc); }
  hist.exec(propCommand(doc, n, values[values.length - 1]!, start), true);
}

function contentCommand(doc: Doc, n: Node, before: LayerState, after: LayerState): Command {
  return {
    label: 'Edit layer',
    do: () => { restoreState(n, after); refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { restoreState(n, before); refreshPsdPreviewModeAfterEdit(doc); },
  };
}

/** Textarea input per keystroke, then change on blur commits one history entry. */
function typeText(hist: History, doc: Doc, n: Node, text: string) {
  const before = captureState(n);
  for (let i = 1; i <= text.length; i++) {
    applyText(n, { text: text.slice(0, i) });
    markNodePreviewContentChanged(n);
    refreshPsdPreviewModeAfterEdit(doc);
  }
  hist.exec(contentCommand(doc, n, before, captureState(n)), true);
}

// ---- state capture --------------------------------------------------------------------
interface Snap { model: string; canvases: Array<HTMLCanvasElement | null>; preview: number | null; embedded: boolean; mode: string | undefined }

/** FNV-1a over the preview pixels: keeps per-step snapshots small for large documents. */
function hashCanvas(c: HTMLCanvasElement): number {
  const px = new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) h = Math.imul(h ^ px[i]!, 0x01000193);
  return h >>> 0;
}

function snap(doc: Doc): Snap {
  const all = [...walk(doc.roots)];
  const p = getDocPreviewCanvas(doc);
  return {
    model: JSON.stringify(all.map((n) => [
      n.key, n.x, n.y, n.w, n.h, n.rotation, +n.opacity.toFixed(4), n.visible, n.ox, n.oy, n.ow, n.oh,
      n.textTransform ?? null, n.src.text?.text ?? null, n.previewContentEpoch ?? 0, !!n.textEdited,
    ])),
    canvases: all.map((n) => n.canvas),
    preview: p ? hashCanvas(p) : null,
    embedded: !!p && p === doc.fileComposite,
    mode: doc.psdPreviewMode,
  };
}

function compare(a: Snap, b: Snap): [boolean, string] {
  const model = a.model === b.model && a.canvases.every((c, i) => c === b.canvases[i]);
  const ok = model && a.preview === b.preview && a.embedded === b.embedded && a.mode === b.mode;
  return [ok, `model=${model} preview=${a.preview === b.preview} mode=${a.mode}/${b.mode} embedded=${a.embedded}/${b.embedded}`];
}

const stacks = (h: History) => {
  const x = h as unknown as { undoStack: Command[]; redoStack: Command[] };
  return [x.undoStack.length, x.redoStack.length] as const;
};

/** Run actions recording a snapshot after each, then undo×N and redo×N checking every step. */
async function runSequence(label: string, doc: Doc, actions: Array<{ name: string; run: (h: History) => void }>) {
  const hist = new History();
  const states: Snap[] = [snap(doc)];
  await settle();
  for (const a of actions) {
    a.run(hist);
    states.push(snap(doc));
    await settle();
  }
  const [u0] = stacks(hist);
  log(`${label}-one-entry-per-action`, u0 === actions.length, `undo=${u0} actions=${actions.length}`);
  for (let i = actions.length; i >= 1; i--) {
    hist.undo();
    const [u, r] = stacks(hist);
    const [ok, detail] = compare(snap(doc), states[i - 1]!);
    log(`${label}-undo-${actions[i - 1]!.name}`, ok && u === i - 1 && r === actions.length - i + 1, `undo=${u} redo=${r} ${detail}`);
    await settle();
  }
  if (doc.psdFileCompositeBase) {
    log(`${label}-fully-undone-shows-embedded`, getDocPreviewCanvas(doc) === doc.fileComposite, String(doc.psdPreviewMode));
  }
  for (let i = 1; i <= actions.length; i++) {
    hist.redo();
    const [u, r] = stacks(hist);
    const [ok, detail] = compare(snap(doc), states[i]!);
    log(`${label}-redo-${actions[i - 1]!.name}`, ok && u === i && r === actions.length - i, `undo=${u} redo=${r} ${detail}`);
    await settle();
  }
}

// ---- sources --------------------------------------------------------------------------
function isFullDocumentFill(n: Node, doc: Doc) {
  return n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1;
}

/** Movable visible layers, smallest first. */
function movable(doc: Doc): Node[] {
  return leaves(doc)
    .filter((n) => canEditPsdLayerPosition(n) && n.canvas && n.opacity > 0.001 && n.w > 0 && n.h > 0 && !isFullDocumentFill(n, doc))
    .sort((a, b) => a.w * a.h - b.w * b.h);
}

async function runFixture(label: string, filePath: string) {
  if (!fs.existsSync(filePath)) {
    log(`${label}-skip`, true, `missing ${filePath}`);
    return;
  }
  const buf = fs.readFileSync(filePath);
  const load = () => importPsd(path.basename(filePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const pick = (doc: Doc, which: 'small' | 'large') => {
    const list = movable(doc);
    return which === 'small' ? list[0]! : list[list.length - 1]!;
  };

  {
    const doc = load();
    const n = pick(doc, 'small');
    await runSequence(`${label}-position`, doc, [
      { name: 'move1', run: (h) => drag(h, doc, n, [[10.4, 5.2], [20.3, 10.1], [9.7, 4.9]]) },
      { name: 'move2', run: (h) => drag(h, doc, n, [[-15.2, 30.6], [-4.8, 9.4]]) },
      { name: 'move3', run: (h) => drag(h, doc, n, [[50, -20]]) },
    ]);
  }
  {
    const doc = load();
    const n = pick(doc, 'small');
    await runSequence(`${label}-opacity`, doc, [
      { name: 'opacity1', run: (h) => scrubOpacity(h, doc, n, [0.9, 0.8, 0.7]) },
      { name: 'opacity2', run: (h) => scrubOpacity(h, doc, n, [0.6, 0.4]) },
      { name: 'opacity3', run: (h) => scrubOpacity(h, doc, n, [0.5]) },
    ]);
  }
  {
    const doc = load();
    const n = pick(doc, 'large');
    await runSequence(`${label}-mixed`, doc, [
      { name: 'move', run: (h) => drag(h, doc, n, [[40, 20]]) },
      { name: 'opacity', run: (h) => scrubOpacity(h, doc, n, [0.5]) },
      { name: 'move-again', run: (h) => drag(h, doc, n, [[-20, 10]]) },
    ]);
  }
}

async function runLiveText() {
  const load = () => importPsd('sample.psd', createSamplePsd());
  const textOf = (doc: Doc) => [...walk(doc.roots)].find((n) => n.kind === 'text' && !!n.src.text)!;

  {
    const doc = load();
    const t = textOf(doc);
    await runSequence('text-content', doc, [
      { name: 'type1', run: (h) => typeText(h, doc, t, 'Hello A') },
      { name: 'type2', run: (h) => typeText(h, doc, t, 'Hello AB') },
      { name: 'type3', run: (h) => typeText(h, doc, t, 'Bye') },
    ]);
  }
  {
    const doc = load();
    const t = textOf(doc);
    await runSequence('text-move', doc, [
      { name: 'move1', run: (h) => drag(h, doc, t, [[10, 0], [10, 0], [10, 0]]) },
      { name: 'move2', run: (h) => drag(h, doc, t, [[0, 15], [0, 15]]) },
    ]);
  }
  {
    const doc = load();
    const t = textOf(doc);
    await runSequence('text-mixed', doc, [
      { name: 'move', run: (h) => drag(h, doc, t, [[12.6, 4.2], [7.1, 3.3]]) },
      { name: 'type', run: (h) => typeText(h, doc, t, 'Moved then typed') },
      { name: 'opacity', run: (h) => scrubOpacity(h, doc, t, [0.7, 0.6]) },
      { name: 'move-again', run: (h) => drag(h, doc, t, [[-5, 9]]) },
    ]);
  }
}

const fixtureA =
  process.argv[2] ?? process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const fixtureB = process.argv[3] ?? process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');
await runFixture('fixture-a', fixtureA);
await runFixture('fixture-b', fixtureB);
await runLiveText();

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

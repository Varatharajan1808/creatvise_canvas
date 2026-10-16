/**
 * Live text layers: the exported text anchor (text.transform) must follow the layer's current position,
 * however many moves, exports, undos and redos happen, and must agree with the exported layer bounds.
 * Commands mirror src/main.ts (moveBy/endPointer/positionsCommand, editContent/contentCommand), which cannot be imported headlessly.
 * The fixture PSDs have no live text layers, so this uses the in-app sample and a generated scaled, centred text layer.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';
import { importPsd, exportPsd, createSamplePsd, refreshPsdPreviewModeAfterEdit } from '../src/psd/psd';
import { History, type Command } from '../src/core/history';
import { walk, type Doc, type Node } from '../src/core/model';
import { applyText, captureState, restoreState, type LayerState } from '../src/operations/edit';
import { markNodePreviewContentChanged } from '../src/psd/psdComposite';

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

// ---- mirrors of main.ts commands ------------------------------------------------------
function positionsCommand(doc: Doc, before: Array<[Node, number, number]>, after: Array<[Node, number, number]>): Command {
  const apply = (list: Array<[Node, number, number]>) => list.forEach(([n, x, y]) => { n.x = x; n.y = y; });
  return {
    label: 'Move',
    do: () => { apply(after); refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { apply(before); refreshPsdPreviewModeAfterEdit(doc); },
  };
}

/** pointerdown → pointermove per step → pointerup (endPointer rounds, then records the applied command). */
function drag(hist: History, doc: Doc, n: Node, steps: Array<[number, number]>) {
  const before: Array<[Node, number, number]> = [[n, n.x, n.y]];
  for (const [dx, dy] of steps) { n.x += dx; n.y += dy; refreshPsdPreviewModeAfterEdit(doc); }
  n.x = Math.round(n.x);
  n.y = Math.round(n.y);
  hist.exec(positionsCommand(doc, before, [[n, n.x, n.y]]), true);
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

// ---- helpers --------------------------------------------------------------------------
const fmt = (t?: number[]) => (t ? `[${t.map((v) => +v.toFixed(3)).join(',')}]` : 'none');
const near = (a?: number[], b?: number[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
const shifted = (t: number[], dx: number, dy: number) => [t[0]!, t[1]!, t[2]!, t[3]!, t[4]! + dx, t[5]! + dy];

function layerAt(psd: Psd, key: string): Layer | undefined {
  let list = psd.children ?? [];
  let l: Layer | undefined;
  for (const i of key.split('/').map(Number)) {
    l = list[i];
    list = l?.children ?? [];
  }
  return l;
}

interface ExportedText { transform?: number[]; left: number; top: number; text?: string }
function exportedText(bytes: ArrayBuffer, key: string): ExportedText {
  const l = layerAt(readPsd(bytes, { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true }), key);
  return { transform: l?.text?.transform, left: l?.left ?? NaN, top: l?.top ?? NaN, text: l?.text?.text };
}

const textLayer = (doc: Doc) => [...walk(doc.roots)].find((n) => n.kind === 'text' && !!n.src.text?.transform)!;

/** Export and check the text anchor equals `anchor` moved by (dx, dy), and the layer bounds equal (left, top). */
function checkExport(name: string, doc: Doc, n: Node, anchor: number[], dx: number, dy: number, left: number, top: number): ExportedText {
  const re = exportedText(exportPsd(doc), n.key);
  const want = shifted(anchor, dx, dy);
  log(
    name,
    near(re.transform, want) && re.left === left && re.top === top,
    `transform=${fmt(re.transform)} expected=${fmt(want)} bounds=${re.left},${re.top} expected=${left},${top}`,
  );
  return re;
}

function scaledCentredTextPsd(): ArrayBuffer {
  const W = 800;
  const H = 600;
  const bg = createCanvas(W, H);
  const bgc = bg.getContext('2d');
  bgc.fillStyle = '#eeeeee';
  bgc.fillRect(0, 0, W, H);
  const glyphs = createCanvas(300, 120);
  const g = glyphs.getContext('2d');
  g.fillStyle = '#202020';
  g.font = 'bold 48px Arial';
  g.textAlign = 'center';
  g.fillText('Scaled', 150, 80);
  const psd: Psd = {
    width: W,
    height: H,
    children: [
      { name: 'Background', left: 0, top: 0, right: W, bottom: H, canvas: bg as unknown as HTMLCanvasElement },
      {
        name: 'Headline',
        left: 250,
        top: 250,
        right: 550,
        bottom: 370,
        canvas: glyphs as unknown as HTMLCanvasElement,
        text: {
          text: 'Scaled',
          shapeType: 'point',
          transform: [2, 0, 0, 2, 400, 330],
          paragraphStyle: { justification: 'center' },
          style: { font: { name: 'Arial-BoldMT' }, fontSize: 24, fillColor: { r: 32, g: 32, b: 32 } },
        },
      },
    ],
  };
  psd.canvas = bg as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

// ---- checks ---------------------------------------------------------------------------
function runSource(label: string, load: () => Doc) {
  // Many fractional pointer steps in one drag.
  {
    const doc = load();
    const n = textLayer(doc);
    const t0 = [...n.textTransform!];
    const [x0, y0] = [n.x, n.y];
    const hist = new History();
    drag(hist, doc, n, [[3.4, 1.2], [7.7, 2.6], [10.1, -4.3], [4.2, 9.9], [0.3, 0.4]]);
    const [dx, dy] = [n.x - x0, n.y - y0];
    log(`${label}-drag-keeps-anchor`, near(n.textTransform, t0), `anchor=${fmt(n.textTransform)} import=${fmt(t0)}`);
    checkExport(`${label}-drag-export`, doc, n, t0, dx, dy, x0 + dx, y0 + dy);
    const re = importPsd('re.psd', exportPsd(doc));
    const rn = textLayer(re);
    log(`${label}-drag-reimport`, rn.x === n.x && rn.y === n.y && near(rn.textTransform, shifted(t0, dx, dy)), `x,y=${rn.x},${rn.y} anchor=${fmt(rn.textTransform)}`);
  }

  // Three moves with an export after each, then undo/redo with an export at every step.
  {
    const doc = load();
    const n = textLayer(doc);
    const t0 = [...n.textTransform!];
    const [x0, y0] = [n.x, n.y];
    const hist = new History();
    const moves: Array<Array<[number, number]>> = [
      [[10, 0], [10, 0], [10, 0]],
      [[0, 15], [0, 15], [0, 15]],
      [[-6, 3], [-6, 4]],
    ];
    const positions: Array<[number, number]> = [[0, 0]];
    moves.forEach((steps, i) => {
      drag(hist, doc, n, steps);
      positions.push([n.x - x0, n.y - y0]);
      const [dx, dy] = positions[i + 1]!;
      checkExport(`${label}-move${i + 1}-export`, doc, n, t0, dx, dy, x0 + dx, y0 + dy);
    });
    const [fx, fy] = positions[3]!;
    const a = exportedText(exportPsd(doc), n.key);
    const b = exportedText(exportPsd(doc), n.key);
    log(`${label}-repeat-export-identical`, near(a.transform, b.transform) && a.left === b.left && a.top === b.top, `${fmt(a.transform)} vs ${fmt(b.transform)}`);
    log(`${label}-repeat-export-position`, near(b.transform, shifted(t0, fx, fy)), `${fmt(b.transform)} expected ${fmt(shifted(t0, fx, fy))}`);

    for (let i = 3; i >= 1; i--) {
      hist.undo();
      const [dx, dy] = positions[i - 1]!;
      log(`${label}-undo${i}-anchor`, near(n.textTransform, t0), fmt(n.textTransform));
      checkExport(`${label}-undo${i}-export`, doc, n, t0, dx, dy, x0 + dx, y0 + dy);
    }
    for (let i = 1; i <= 3; i++) {
      hist.redo();
      const [dx, dy] = positions[i]!;
      checkExport(`${label}-redo${i}-export`, doc, n, t0, dx, dy, x0 + dx, y0 + dy);
    }
  }

  // Move, then edit the text: the glyphs stay where the move put them.
  {
    const moved = load();
    const m = textLayer(moved);
    const t0 = [...m.textTransform!];
    const text0 = m.src.text!.text;
    const hm = new History();
    drag(hm, moved, m, [[20, 10], [20, 15]]);
    typeText(hm, moved, m, 'Edited text');

    const still = load();
    const s = textLayer(still);
    typeText(new History(), still, s, 'Edited text');

    log(`${label}-edit-after-move-anchor`, near(m.textTransform, shifted(t0, 40, 25)), `anchor=${fmt(m.textTransform)} expected=${fmt(shifted(t0, 40, 25))}`);
    log(`${label}-edit-after-move-no-jump`, m.x - s.x === 40 && m.y - s.y === 25, `offset from unmoved edit=${m.x - s.x},${m.y - s.y} expected=40,25`);
    checkExport(`${label}-edit-after-move-export`, moved, m, t0, 40, 25, m.x, m.y);

    // Undo the edit, then the move: back to the import anchor and bounds.
    hm.undo();
    checkExport(`${label}-edit-after-move-undo-edit`, moved, m, t0, 40, 25, m.x, m.y);
    hm.undo();
    const re = checkExport(`${label}-edit-after-move-undo-all`, moved, m, t0, 0, 0, m.ox, m.oy);
    log(`${label}-edit-after-move-undo-all-text`, re.text === text0, `text=${re.text} expected=${text0}`);
  }

  // Edit, then move: the export follows the edited anchor.
  {
    const doc = load();
    const n = textLayer(doc);
    const t0 = [...n.textTransform!];
    const hist = new History();
    typeText(hist, doc, n, 'Bye');
    const anchor = [...n.textTransform!];
    log(`${label}-edit-keeps-anchor`, near(anchor, t0), `anchor=${fmt(anchor)} import=${fmt(t0)}`);
    const [x1, y1] = [n.x, n.y];
    drag(hist, doc, n, [[12, -4], [8, -6]]);
    checkExport(`${label}-move-after-edit-export`, doc, n, anchor, 20, -10, x1 + 20, y1 - 10);
    hist.undo();
    checkExport(`${label}-move-after-edit-undo-move`, doc, n, anchor, 0, 0, x1, y1);
    hist.redo();
    checkExport(`${label}-move-after-edit-redo-move`, doc, n, anchor, 20, -10, x1 + 20, y1 - 10);
  }

  // Export, re-import, move again: anchored to the re-imported file.
  {
    const doc = load();
    const n = textLayer(doc);
    const t0 = [...n.textTransform!];
    const [x0, y0] = [n.x, n.y];
    drag(new History(), doc, n, [[30, 15]]);
    const re = importPsd('re.psd', exportPsd(doc));
    const rn = textLayer(re);
    drag(new History(), re, rn, [[10, 10]]);
    checkExport(`${label}-reimport-move-export`, re, rn, t0, 40, 25, x0 + 40, y0 + 25);
  }
}

runSource('sample', () => importPsd('sample.psd', createSamplePsd()));
const scaled = scaledCentredTextPsd();
runSource('scaled-centred', () => importPsd('scaled.psd', scaled.slice(0)));

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

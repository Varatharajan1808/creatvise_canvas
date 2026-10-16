/**
 * Ghost suppression: moved layers must not leave baked pixels at import footprint.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd/psd';
import { History } from '../src/core/history';
import { leaves } from '../src/core/model';
import { canEditPsdLayerPosition } from '../src/psd/psdLayerInfo';
import {
  clipBaseOf,
  composeDocPreviewExcluding,
  getDocPreviewCanvas,
  isShowingEmbeddedFileComposite,
} from '../src/psd/psdComposite';

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

function load(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return importPsd(path.basename(filePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function sample(c: HTMLCanvasElement, x: number, y: number) {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]] as const;
}

type Rect = { x: number; y: number; w: number; h: number };
type Doc = ReturnType<typeof importPsd>;
type Leaf = ReturnType<typeof leaves>[number];

const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};
const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Where the layer can show: its bounds, limited to its clip base's bounds when clipped. */
function visibleArea(doc: Doc, n: Leaf, at: 'import' | 'current'): Rect {
  const own = at === 'import' ? { x: n.ox, y: n.oy, w: n.ow, h: n.oh } : { x: n.x, y: n.y, w: n.w, h: n.h };
  const base = clipBaseOf(doc, n);
  if (!base || base.kind === 'group' || !base.canvas) return own;
  return intersect(own, at === 'import' ? { x: base.ox, y: base.oy, w: base.ow, h: base.oh } : { x: base.x, y: base.y, w: base.w, h: base.h });
}

/** Point inside the layer's old visible area that does not overlap its new visible area after a move. */
function oldFootprintProbe(doc: Doc, n: Leaf) {
  const old = visibleArea(doc, n, 'import');
  const now = visibleArea(doc, n, 'current');
  const candidates: Array<[number, number]> = [
    [Math.round(old.x + 24), Math.round(old.y + 24)],
    [Math.round(old.x + old.w - 24), Math.round(old.y + 24)],
    [Math.round(old.x + 24), Math.round(old.y + old.h - 24)],
    [Math.round(old.x + old.w - 24), Math.round(old.y + old.h - 24)],
  ];
  for (const [x, y] of candidates) {
    if (inside(old, x, y) && !inside(now, x, y)) return [x, y] as const;
  }
  return [Math.round(old.x + 24), Math.round(old.y + 24)] as const;
}

/** Grid samples outside the layer's old and new visible areas that differ from the embedded composite. */
function changedOutsideEdit(doc: Doc, n: Leaf, preview: HTMLCanvasElement, step = 16) {
  const holes = [visibleArea(doc, n, 'import'), visibleArea(doc, n, 'current')];
  const a = preview.getContext('2d')!.getImageData(0, 0, doc.width, doc.height).data;
  const b = doc.fileComposite!.getContext('2d')!.getImageData(0, 0, doc.width, doc.height).data;
  let samples = 0, changed = 0;
  for (let y = 0; y < doc.height; y += step) {
    for (let x = 0; x < doc.width; x += step) {
      if (holes.some((r) => inside(r, x, y))) continue;
      const i = (y * doc.width + x) * 4;
      samples++;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed++;
    }
  }
  return { samples, changed };
}

function isFullDocumentFill(n: { w: number; h: number; x: number; y: number }, doc: { width: number; height: number }) {
  return n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1;
}

function smallestEditableLeaf(doc: ReturnType<typeof load>) {
  const list = leaves(doc).filter(
    (n) =>
      canEditPsdLayerPosition(n) &&
      n.canvas &&
      n.w > 0 &&
      n.h > 0 &&
      n.opacity > 0.001 &&
      !isFullDocumentFill(n, doc),
  );
  return [...list].sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null;
}

function largestEditableLeaf(doc: ReturnType<typeof load>) {
  const list = leaves(doc).filter(
    (n) =>
      canEditPsdLayerPosition(n) &&
      n.canvas &&
      n.w > 0 &&
      n.h > 0 &&
      n.opacity > 0.001 &&
      !isFullDocumentFill(n, doc),
  );
  return [...list].sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null;
}

function runFixture(label: string, filePath: string) {
  if (!fs.existsSync(filePath)) {
    log(`${label}-skip`, true, 'missing fixture');
    return;
  }
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const doc0 = load(filePath);
  if (!doc0.fileComposite || !doc0.psdFileCompositeBase) {
    log(`${label}-file-base`, true, 'skip non-embedded preview');
    return;
  }

  const small = smallestEditableLeaf(doc0);
  const large = largestEditableLeaf(doc0);
  if (!small || !large || small.id === large.id) {
    log(`${label}-pair`, true, 'skip: need distinct small/large editable leaves');
    return;
  }

  const doc = importPsd(`${label}.psd`, ab.slice(0));
  const leaf = leaves(doc).find((n) => n.key === small.key)!;
  if (!leaf) {
    log(`${label}-small-leaf`, false, 'missing leaf after re-import');
    return;
  }
  leaf.x += 72;
  leaf.y += 36;
  refreshPsdPreviewModeAfterEdit(doc);
  const [oldPx, oldPy] = oldFootprintProbe(doc, leaf);
  const embeddedAtOld = sample(doc.fileComposite!, oldPx, oldPy);

  const preview = getDocPreviewCanvas(doc)!;
  const atOld = sample(preview, oldPx, oldPy);
  const sans = composeDocPreviewExcluding(doc, new Set([leaf.id]));
  const expectedOld = sample(sans, oldPx, oldPy);
  const newCx = Math.round(leaf.x + leaf.w / 2);
  const newCy = Math.round(leaf.y + leaf.h / 2);
  const atNew = sample(preview, newCx, newCy);

  log(
    `${label}-small-old-footprint-patched`,
    atOld[0] === expectedOld[0] && atOld[1] === expectedOld[1] && atOld[2] === expectedOld[2],
    `old=${atOld.join(',')} expected=${expectedOld.join(',')} import=${embeddedAtOld.join(',')}`,
  );
  log(`${label}-small-new-position-opaque`, atNew[3] > 200, `new=${atNew.join(',')}`);

  const docL = importPsd(`${label}-l.psd`, ab.slice(0));
  const big = leaves(docL).find((n) => n.key === large.key)!;
  big.x += 60;
  big.y += 30;
  refreshPsdPreviewModeAfterEdit(docL);
  const [oldBx, oldBy] = oldFootprintProbe(docL, big);
  const embeddedPuzzle = sample(docL.fileComposite!, oldBx, oldBy);
  const prevL = getDocPreviewCanvas(docL)!;
  const atOldBig = sample(prevL, oldBx, oldBy);
  const sansBig = composeDocPreviewExcluding(docL, new Set([big.id]));
  const expectedPuzzle = sample(sansBig, oldBx, oldBy);
  log(
    `${label}-large-old-footprint-not-duplicate`,
    atOldBig[0] === expectedPuzzle[0] && atOldBig[1] === expectedPuzzle[1] && atOldBig[2] === expectedPuzzle[2],
    `puzzle=${atOldBig.join(',')} sans=${expectedPuzzle.join(',')} embed=${embeddedPuzzle.join(',')}`,
  );
  const outsideBig = changedOutsideEdit(docL, big, prevL);
  log(
    `${label}-large-outside-edit-unchanged`,
    outsideBig.samples > 0 && outsideBig.changed === 0,
    `${outsideBig.changed}/${outsideBig.samples} grid samples differ from the embedded composite`,
  );

  const docU = importPsd(`${label}-u.psd`, ab.slice(0));
  const uLeaf = leaves(docU).find((n) => n.key === small.key)!;
  const ox = uLeaf.x;
  const oy = uLeaf.y;
  uLeaf.x += 40;
  uLeaf.y += 24;
  refreshPsdPreviewModeAfterEdit(docU);
  const hist = new History();
  hist.exec({
    label: 'Move',
    do: () => {
      uLeaf.x = ox + 40;
      uLeaf.y = oy + 24;
      refreshPsdPreviewModeAfterEdit(docU);
    },
    undo: () => {
      uLeaf.x = ox;
      uLeaf.y = oy;
      refreshPsdPreviewModeAfterEdit(docU);
    },
  });
  hist.undo();
  log(
    `${label}-undo-embedded`,
    isShowingEmbeddedFileComposite(docU) && getDocPreviewCanvas(docU) === docU.fileComposite,
    docU.psdPreviewMode ?? '',
  );
  hist.redo();
  const [redoOldPx, redoOldPy] = oldFootprintProbe(docU, uLeaf);
  const redoPrev = getDocPreviewCanvas(docU)!;
  const redoOld = sample(redoPrev, redoOldPx, redoOldPy);
  const redoNew = sample(redoPrev, Math.round(uLeaf.x + uLeaf.w / 2), Math.round(uLeaf.y + uLeaf.h / 2));
  log(
    `${label}-redo-single-copy`,
    redoOld[0] === expectedOld[0] && redoOld[1] === expectedOld[1] && redoNew[3] > 200,
    `old=${redoOld.join(',')} newA=${redoNew[3]}`,
  );
}

setupDom();
const fixtureA =
  process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const fixtureB =
  process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');

runFixture('9015560', fixtureA);
runFixture('10960916', fixtureB);

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

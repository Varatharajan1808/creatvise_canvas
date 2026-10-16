/**
 * Phase 4 — ghost regression: large vs small raster moves, unrelated regions, undo, immutable fileComposite.
 * Uses layer metadata (area, full-doc fill), not production branches on names/files.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd/psd';
import { History } from '../src/core/history';
import type { Doc, Node } from '../src/core/model';
import { leaves } from '../src/core/model';
import { canEditPsdLayerPosition } from '../src/psd/psdLayerInfo';
import {
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

function loadPsd(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return importPsd(path.basename(filePath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function isFullDocumentFill(n: Node, doc: Doc): boolean {
  return n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1;
}

function editableNonFullDocLeaves(doc: Doc): Node[] {
  return leaves(doc).filter(
    (n) =>
      canEditPsdLayerPosition(n) &&
      n.canvas &&
      n.w > 0 &&
      n.h > 0 &&
      n.opacity > 0.001 &&
      !isFullDocumentFill(n, doc),
  );
}

function classifyByArea(doc: Doc): { large: Node; small: Node } | null {
  const list = editableNonFullDocLeaves(doc);
  if (list.length < 2) return null;
  const sorted = [...list].sort((a, b) => a.w * a.h - b.w * b.h);
  const small = sorted[0]!;
  const large = sorted[sorted.length - 1]!;
  if (small.id === large.id) return null;
  const docArea = doc.width * doc.height;
  const largeRatio = (large.w * large.h) / docArea;
  const smallRatio = (small.w * small.h) / docArea;
  if (largeRatio < 0.08) return null;
  if (smallRatio > largeRatio * 0.5) return null;
  return { large, small };
}

function sample(c: HTMLCanvasElement, x: number, y: number) {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]] as const;
}

function pixelsEqual(a: readonly number[], b: readonly number[]) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Upper-center doc region (typical puzzle / effect artwork), away from bottom text band. */
function puzzleProbePoints(doc: Doc, exclude: Node): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const ys = [0.35, 0.45, 0.55].map((f) => Math.round(doc.height * f));
  const xs = [0.35, 0.5, 0.65].map((f) => Math.round(doc.width * f));
  for (const y of ys) {
    for (const x of xs) {
      if (x < exclude.x || x >= exclude.x + exclude.w || y < exclude.y || y >= exclude.y + exclude.h) {
        pts.push([x, y]);
      }
    }
  }
  return pts.slice(0, 12);
}

/** Lower doc band probes; omit points inside `avoid` bounds (e.g. large layer after move). */
function labelBandProbe(doc: Doc, avoid?: Node): Array<[number, number]> {
  const raw: Array<[number, number]> = [
    [Math.round(doc.width * 0.65), Math.round(doc.height * 0.88)],
    [Math.round(doc.width * 0.75), Math.round(doc.height * 0.92)],
    [Math.round(doc.width * 0.85), Math.round(doc.height * 0.9)],
  ];
  if (!avoid) return raw;
  return raw.filter(
    ([x, y]) => x < avoid.x || x >= avoid.x + avoid.w || y < avoid.y || y >= avoid.y + avoid.h,
  );
}

function regionMatchesEmbedded(
  embedded: HTMLCanvasElement,
  preview: HTMLCanvasElement,
  points: Array<[number, number]>,
): { ok: boolean; mismatches: number } {
  let mismatches = 0;
  for (const [x, y] of points) {
    if (!pixelsEqual(sample(embedded, x, y), sample(preview, x, y))) mismatches++;
  }
  return { ok: mismatches === 0, mismatches };
}

function runFixture(label: string, filePath: string, buf: ArrayBuffer) {
  if (!fs.existsSync(filePath)) {
    log(`${label}-skip`, true, `missing ${filePath}`);
    return;
  }

  const doc = loadPsd(filePath);
  if (!doc.psdFileCompositeBase || !doc.fileComposite) {
    log(`${label}-file-base`, true, `skip non-file-composite (${doc.psdPreviewMode})`);
    return;
  }

  const pair = classifyByArea(doc);
  if (!pair) {
    log(`${label}-area-pair`, true, 'skip: need large+small editable non-full-doc leaves');
    return;
  }
  const { large, small } = pair;
  log(
    `${label}-metadata-pair`,
    true,
    `large=${Math.round((large.w * large.h) / (doc.width * doc.height) * 100)}% small=${Math.round((small.w * small.h) / (doc.width * doc.height) * 100)}%`,
  );

  const embeddedRef = doc.fileComposite!;
  const embeddedSnap = createCanvas(doc.width, doc.height) as unknown as HTMLCanvasElement;
  embeddedSnap.getContext('2d')!.drawImage(embeddedRef, 0, 0);

  // --- Small leaf move: puzzle region should stay identical to embedded (no unintentional puzzle shift)
  const docSmall = importPsd('s.psd', buf.slice(0));
  const fcBefore = docSmall.fileComposite!;
  const puzzlePts = puzzleProbePoints(docSmall, small);
  const fcProbeBefore = puzzlePts.length ? sample(fcBefore, puzzlePts[0]![0], puzzlePts[0]![1]) : null;
  const sLeaf = leaves(docSmall).find((n) => n.key === small.key)!;
  sLeaf.x += 80;
  sLeaf.y += 40;
  refreshPsdPreviewModeAfterEdit(docSmall);
  const prevSmall = getDocPreviewCanvas(docSmall)!;
  const smallPuzzle = regionMatchesEmbedded(embeddedSnap, prevSmall, puzzlePts);
  log(
    `${label}-small-move-puzzle-unchanged`,
    smallPuzzle.ok,
    `mismatches=${smallPuzzle.mismatches}/${puzzlePts.length}`,
  );

  const fcAfter = docSmall.fileComposite!;
  log(
    `${label}-fileComposite-immutable-after-small-move`,
    fcBefore === fcAfter &&
      (fcProbeBefore === null ||
        pixelsEqual(fcProbeBefore, sample(fcAfter, puzzlePts[0]![0], puzzlePts[0]![1]))),
    'same doc ref, pixels unchanged on fileComposite',
  );

  // --- Large leaf move: lower label band (outside large import bbox) unchanged vs embedded
  const docLarge = importPsd('l.psd', buf.slice(0));
  const lLeaf = leaves(docLarge).find((n) => n.key === large.key)!;
  lLeaf.x += 80;
  lLeaf.y += 40;
  refreshPsdPreviewModeAfterEdit(docLarge);
  const prevLarge = getDocPreviewCanvas(docLarge)!;
  const labelPts = labelBandProbe(docLarge, lLeaf);
  const largeLabels = regionMatchesEmbedded(embeddedSnap, prevLarge, labelPts);
  log(
    `${label}-large-move-label-band-unchanged`,
    labelPts.length === 0 ? true : largeLabels.ok,
    `mismatches=${largeLabels.mismatches}/${labelPts.length}`,
  );
  const sx = Math.round(small.ox + small.ow / 2);
  const sy = Math.round(small.oy + small.oh / 2);
  const sansNoLarge = composeDocPreviewExcluding(docLarge, new Set([lLeaf.id]));
  const smallCenterStable = pixelsEqual(sample(sansNoLarge, sx, sy), sample(prevLarge, sx, sy));
  log(
    `${label}-large-move-small-leaf-center-stable`,
    smallCenterStable,
    `small area ${Math.round((small.w * small.h) / (doc.width * doc.height) * 100)}% doc`,
  );

  // --- Undo restores embedded composite (small leaf)
  const docU = importPsd('u.psd', buf.slice(0));
  const uLeaf = leaves(docU).find((n) => n.key === small.key)!;
  const ox = uLeaf.x;
  const oy = uLeaf.y;
  uLeaf.x += 50;
  uLeaf.y += 30;
  refreshPsdPreviewModeAfterEdit(docU);
  const hist = new History();
  hist.exec({
    label: 'Move',
    do: () => {
      uLeaf.x = ox + 50;
      uLeaf.y = oy + 30;
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
    `${label}-undo-embedded-preview`,
    isShowingEmbeddedFileComposite(docU) && getDocPreviewCanvas(docU) === docU.fileComposite,
    docU.psdPreviewMode ?? '',
  );
  const undoPts = puzzleProbePoints(docU, uLeaf);
  const undoMatch = regionMatchesEmbedded(embeddedSnap, getDocPreviewCanvas(docU)!, undoPts);
  log(`${label}-undo-puzzle-pixels`, undoMatch.ok, `mismatches=${undoMatch.mismatches}`);
}

setupDom();

const fixtureA =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const fixtureB =
  process.argv[3] ??
  process.env.PSD_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');

const bufA = fs.existsSync(fixtureA) ? fs.readFileSync(fixtureA) : null;
const bufB = fs.existsSync(fixtureB) ? fs.readFileSync(fixtureB) : null;
if (bufA) runFixture('fixture-a', fixtureA, bufA.buffer.slice(bufA.byteOffset, bufA.byteOffset + bufA.byteLength));
if (bufB) runFixture('fixture-b', fixtureB, bufB.buffer.slice(bufB.byteOffset, bufB.byteOffset + bufB.byteLength));

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

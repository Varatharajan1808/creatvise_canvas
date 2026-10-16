/**
 * Export → re-import must preserve the visible composition (embedded composite) and the layer tree.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, type Layer, type Psd } from 'ag-psd';
import { importPsd, exportPsd, createSamplePsd, renderComposite, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { History } from '../src/history';
import { leaves, type Doc, type Node } from '../src/model';
import { getDocPreviewCanvas } from '../src/psdComposite';
import { canEditPsdLayerPosition } from '../src/psdLayerInfo';

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

function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return new Uint8ClampedArray(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
}

/** Pixels whose RGBA differs by more than `tol` on any channel. */
function mismatches(a: Uint8ClampedArray, b: Uint8ClampedArray, tol = 0): number {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i]! - b[i]!) > tol ||
      Math.abs(a[i + 1]! - b[i + 1]!) > tol ||
      Math.abs(a[i + 2]! - b[i + 2]!) > tol ||
      Math.abs(a[i + 3]! - b[i + 3]!) > tol
    ) n++;
  }
  return n;
}

function layerSignature(psd: Psd): string {
  const out: unknown[] = [];
  const rec = (ls?: Layer[]) =>
    ls?.forEach((l) => {
      out.push({
        name: l.name,
        hidden: !!l.hidden,
        opacity: +(l.opacity ?? 1).toFixed(3),
        blend: l.blendMode ?? 'normal',
        clip: !!l.clipping,
        bounds: [l.left ?? 0, l.top ?? 0, l.right ?? 0, l.bottom ?? 0],
        mask: !!l.mask,
        adjustment: (l.adjustment as { type?: string } | undefined)?.type ?? null,
        effects: l.effects ? Object.keys(l.effects).sort() : null,
        placed: !!l.placedLayer,
        text: !!l.text,
      });
      rec(l.children);
    });
  rec(psd.children);
  return JSON.stringify(out);
}

function isFullDocumentFill(n: Node, doc: Doc) {
  return n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1;
}

function editableBySize(doc: Doc): { small: Node; large: Node } | null {
  const list = leaves(doc)
    .filter((n) => canEditPsdLayerPosition(n) && n.canvas && n.w > 0 && n.h > 0 && n.opacity > 0.001 && !isFullDocumentFill(n, doc))
    .sort((a, b) => a.w * a.h - b.w * b.h);
  if (list.length < 2) return null;
  return { small: list[0]!, large: list[list.length - 1]! };
}

/** Edit, export, re-import; re-imported composite must equal the in-memory preview. */
function checkEditedExport(label: string, load: () => Doc, key: string, edit: (n: Node) => void, verify: (re: Node, n: Node) => [boolean, string]) {
  const doc = load();
  const n = leaves(doc).find((l) => l.key === key)!;
  edit(n);
  refreshPsdPreviewModeAfterEdit(doc);
  const preview = pixels(getDocPreviewCanvas(doc)!);
  const re = importPsd('re.psd', exportPsd(doc));
  const reNode = leaves(re).find((l) => l.key === key)!;
  const m = mismatches(preview, pixels(re.fileComposite!));
  log(`${label}-reimport-matches-preview`, m === 0, `mismatched pixels=${m}`);
  log(`${label}-reimport-shows-embedded`, re.psdPreviewMode === 'file-composite' && getDocPreviewCanvas(re) === re.fileComposite, String(re.psdPreviewMode));
  const [ok, detail] = verify(reNode, n);
  log(`${label}-reimport-layer-state`, ok, detail);
}

function runFixture(label: string, filePath: string) {
  if (!fs.existsSync(filePath)) {
    log(`${label}-skip`, true, `missing ${filePath}`);
    return;
  }
  const buf = fs.readFileSync(filePath);
  const ab = () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const load = () => importPsd(path.basename(filePath), ab());

  const original = load();
  if (!original.psdFileCompositeBase || !original.fileComposite) {
    log(`${label}-file-base`, true, `skip: preview mode ${original.psdPreviewMode}`);
    return;
  }
  const originalPx = pixels(original.fileComposite);
  const originalSig = layerSignature(readPsd(ab(), { skipThumbnail: true }));

  // Unedited export: composition and layer tree are identical after re-import.
  const docA = load();
  const bytesA = exportPsd(docA);
  const reA = importPsd('a.psd', bytesA);
  const mA = mismatches(originalPx, pixels(reA.fileComposite!));
  log(`${label}-noedit-composite-identical`, mA === 0, `mismatched pixels=${mA}`);
  log(`${label}-noedit-layer-tree-identical`, layerSignature(readPsd(bytesA, { skipThumbnail: true })) === originalSig, 'name/visibility/opacity/blend/clip/mask/adjustment/effects/bounds');
  log(`${label}-noedit-fileComposite-untouched`, mismatches(originalPx, pixels(docA.fileComposite!)) === 0, 'source doc embedded composite unchanged');

  const pair = editableBySize(original);
  if (!pair) {
    log(`${label}-pair`, true, 'skip: need two editable leaves');
    return;
  }

  checkEditedExport(`${label}-small-move`, load, pair.small.key, (n) => { n.x += 80; n.y += 40; }, (re, n) => [re.x === n.x && re.y === n.y, `re=${re.x},${re.y} expected=${n.x},${n.y}`]);
  checkEditedExport(`${label}-large-move`, load, pair.large.key, (n) => { n.x += 60; n.y += 30; }, (re, n) => [re.x === n.x && re.y === n.y, `re=${re.x},${re.y} expected=${n.x},${n.y}`]);
  checkEditedExport(`${label}-opacity`, load, pair.small.key, (n) => { n.opacity = 0.5; }, (re) => [Math.abs(re.opacity - 0.5) < 0.01, `re opacity=${re.opacity}`]);

  // Edit then undo back to the import state: export equals the original.
  const docU = load();
  const u = leaves(docU).find((l) => l.key === pair.small.key)!;
  const ox = u.x;
  const oy = u.y;
  const hist = new History();
  hist.exec({
    label: 'Move',
    do: () => { u.x = ox + 50; u.y = oy + 25; refreshPsdPreviewModeAfterEdit(docU); },
    undo: () => { u.x = ox; u.y = oy; refreshPsdPreviewModeAfterEdit(docU); },
  });
  hist.undo();
  const mU = mismatches(originalPx, pixels(importPsd('u.psd', exportPsd(docU)).fileComposite!));
  log(`${label}-undo-then-export-identical`, mU === 0, `mismatched pixels=${mU}`);

  // Multi-document: exporting an edited doc leaves another open doc's preview untouched.
  const doc1 = load();
  const doc2 = load();
  const d1 = leaves(doc1).find((l) => l.key === pair.small.key)!;
  d1.x += 40;
  refreshPsdPreviewModeAfterEdit(doc1);
  exportPsd(doc1);
  log(
    `${label}-multidoc-other-doc-untouched`,
    getDocPreviewCanvas(doc2) === doc2.fileComposite && mismatches(originalPx, pixels(doc2.fileComposite!)) === 0,
    String(doc2.psdPreviewMode),
  );
  log(`${label}-multidoc-edited-fileComposite-untouched`, mismatches(originalPx, pixels(doc1.fileComposite!)) === 0, 'immutable after export');
}

const fixtureA =
  process.argv[2] ?? process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const fixtureB = process.argv[3] ?? process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');
runFixture('fixture-a', fixtureA);
runFixture('fixture-b', fixtureB);

// PSD without an embedded-composite preview keeps the existing flattened export.
{
  const sample = importPsd('sample.psd', createSamplePsd());
  const expected = pixels(renderComposite(sample));
  const re = importPsd('sample-re.psd', exportPsd(sample));
  const m = mismatches(expected, pixels(re.psd!.canvas as HTMLCanvasElement));
  log('sample-layers-mode-export-unchanged', !sample.psdFileCompositeBase && m === 0, `mode=${sample.psdPreviewMode} mismatched=${m}`);
}

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

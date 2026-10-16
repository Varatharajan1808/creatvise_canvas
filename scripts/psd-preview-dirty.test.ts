/**
 * S4 preview-dirty: live opacity, content edits, undo/redo, stale static flag.
 * Fixtures: PSD_TEXT_FIXTURE (default 9015560 path), PSD_FIXTURE (10960916), optional argv.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import {
  createSamplePsd,
  importPsd,
  markNodePreviewContentChanged,
  refreshPsdPreviewModeAfterEdit,
} from '../src/psd/psd';
import { applyText } from '../src/operations/edit';
import { History } from '../src/core/history';
import { effOpacity, leaves, walk } from '../src/core/model';
import { canEditPsdLayerPosition } from '../src/psd/psdLayerInfo';
import {
  docHasPreviewDirtyLayers,
  getDocPreviewCanvas,
  isLayerPreviewAffecting,
  isLayerPreviewContentDirty,
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

function firstEditableLeaf(doc: ReturnType<typeof importPsd>) {
  return leaves(doc).find(
    (n) =>
      canEditPsdLayerPosition(n) &&
      n.canvas &&
      n.w > 0 &&
      n.h > 0 &&
      effOpacity(n) > 0.01 &&
      !(n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1),
  );
}

function testFileCompositeFixture(label: string, filePath: string) {
  if (!fs.existsSync(filePath)) {
    log(`${label}-skip`, true, `missing ${filePath}`);
    return;
  }
  const doc = loadPsd(filePath);
  if (!doc.psdFileCompositeBase || !doc.fileComposite) {
    log(`${label}-file-base`, false, `expected file-composite base, got ${doc.psdPreviewMode}`);
    return;
  }
  const leaf = firstEditableLeaf(doc);
  if (!leaf) {
    log(`${label}-editable-leaf`, false, 'none');
    return;
  }

  const embedded = doc.fileComposite;
  log(`${label}-import-embedded`, getDocPreviewCanvas(doc) === embedded, String(doc.psdPreviewMode));

  const origOpacity = leaf.opacity;
  leaf.opacity = Math.max(0.05, origOpacity * 0.45);
  refreshPsdPreviewModeAfterEdit(doc);
  log(
    `${label}-live-opacity-not-static`,
    isLayerPreviewAffecting(leaf) &&
      !isShowingEmbeddedFileComposite(doc) &&
      getDocPreviewCanvas(doc) !== embedded,
    `mode=${doc.psdPreviewMode}`,
  );

  doc.psdStaticComposite = true;
  log(
    `${label}-stale-static-bypass`,
    docHasPreviewDirtyLayers(doc) && getDocPreviewCanvas(doc) !== embedded,
    'getDocPreviewCanvas ignores stale static when dirty',
  );

  const hist = new History();
  const from = origOpacity;
  const to = leaf.opacity;
  hist.exec({
    label: 'Opacity',
    do: () => {
      leaf.opacity = to;
      refreshPsdPreviewModeAfterEdit(doc);
    },
    undo: () => {
      leaf.opacity = from;
      refreshPsdPreviewModeAfterEdit(doc);
    },
  });
  hist.undo();
  log(
    `${label}-undo-opacity-preview`,
    Math.abs(leaf.opacity - from) < 0.001 &&
      isShowingEmbeddedFileComposite(doc) &&
      getDocPreviewCanvas(doc) === embedded,
    String(leaf.opacity),
  );
  hist.redo();
  log(`${label}-redo-opacity-dirty`, isLayerPreviewAffecting(leaf), String(doc.psdPreviewMode));

  leaf.opacity = origOpacity;
  refreshPsdPreviewModeAfterEdit(doc);
}

setupDom();

const fixtureA =
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
const fixtureB =
  process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');

testFileCompositeFixture('9015560', process.argv[2] ?? fixtureA);
testFileCompositeFixture('10960916', process.argv[3] ?? fixtureB);

// Text / pixel content on built-in sample (no external fixture)
const sampleDoc = importPsd('sample.psd', createSamplePsd());
const textLeaf = leaves(sampleDoc).find((n) => n.kind === 'text' && n.src.text)!;
log('sample-text-layer', !!textLeaf, textLeaf?.name ?? '');
const sampleEmbedded = sampleDoc.fileComposite;
const beforeCanvas = textLeaf.canvas;
applyText(textLeaf, { text: 'Preview dirty S4' });
markNodePreviewContentChanged(textLeaf);
refreshPsdPreviewModeAfterEdit(sampleDoc);
log(
  'sample-text-content-dirty',
  isLayerPreviewContentDirty(textLeaf) && textLeaf.canvas !== beforeCanvas,
  String(textLeaf.textEdited),
);
if (sampleDoc.psdFileCompositeBase && sampleEmbedded) {
  log(
    'sample-text-preview-live',
    getDocPreviewCanvas(sampleDoc) !== sampleEmbedded || !isShowingEmbeddedFileComposite(sampleDoc),
    sampleDoc.psdPreviewMode ?? '',
  );
} else {
  log(
    'sample-text-preview-live',
    getDocPreviewCanvas(sampleDoc) === null || getDocPreviewCanvas(sampleDoc) !== sampleEmbedded,
    'layers/composite path',
  );
}

// Multi-document isolation
if (fs.existsSync(fixtureA)) {
  const d1 = loadPsd(fixtureA);
  const d2 = loadPsd(fixtureB);
  if (fs.existsSync(fixtureB)) {
    const l1 = firstEditableLeaf(d1)!;
    l1.x += 10;
    refreshPsdPreviewModeAfterEdit(d1);
    log(
      'multi-doc-d1-dirty-d2-clean',
      docHasPreviewDirtyLayers(d1) && !docHasPreviewDirtyLayers(d2),
      `${d1.psdPreviewMode}|${d2.psdPreviewMode}`,
    );
    log(
      'multi-doc-d2-still-embedded',
      isShowingEmbeddedFileComposite(d2),
      String(getDocPreviewCanvas(d2) === d2.fileComposite),
    );
  } else {
    log('multi-doc-skip', true, 'second fixture missing');
  }
} else {
  log('multi-doc-skip', true, 'primary fixture missing');
}

void walk;

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

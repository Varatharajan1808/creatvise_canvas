/**
 * Investigation only — duplicate artwork during Text drag on 9015560.psd.
 * Run: tsx scripts/psd-duplicate-investigation.ts [path-to.psd]
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { effOpacity, leaves, walk } from '../src/model';
import {
  composeDocPreviewWithFileBase,
  docHasPreviewDirtyLayers,
  getDocPreviewCanvas,
  isLayerPreviewDirty,
  isShowingEmbeddedFileComposite,
  shouldOverlayDirtyLayer,
} from '../src/psdComposite';

const fixture =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');

if (!fs.existsSync(fixture)) {
  console.error('Fixture not found:', fixture);
  process.exit(1);
}

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

function sample(c: HTMLCanvasElement, x: number, y: number) {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

function parentChain(n: { parent: { name: string } | null }): string {
  const parts: string[] = [];
  let p: { name: string; parent: { name: string } | null } | null = n.parent;
  while (p) {
    parts.push(p.name);
    p = p.parent;
  }
  return parts.length ? parts.join(' > ') : '(root)';
}

function previewModeLabel(doc: {
  psdPreviewMode?: string;
  psdStaticComposite?: boolean;
}): string {
  if (doc.psdStaticComposite) return 'file-composite (static)';
  return doc.psdPreviewMode ?? 'unknown';
}

function reportLayers(doc: ReturnType<typeof importPsd>, tag: string) {
  console.log(`\n=== Layers @ ${tag} ===`);
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') continue;
    console.log(
      [
        n.name,
        `kind=${n.kind}`,
        `parent=${parentChain(n)}`,
        `opacity=${n.opacity} eff=${effOpacity(n).toFixed(3)}`,
        `importOpacity=${n.importOpacity}`,
        `bounds=(${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.w)}x${Math.round(n.h)})`,
        `import=(${Math.round(n.ox)},${Math.round(n.oy)},${Math.round(n.ow)}x${Math.round(n.oh)})`,
        `canvas=${n.canvas ? `${n.canvas.width}x${n.canvas.height}` : 'none'}`,
        `dirty=${isLayerPreviewDirty(n)}`,
        `overlay=${shouldOverlayDirtyLayer(n)}`,
      ].join(' | '),
    );
  }
}

function diffRegions(
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  label: string,
  threshold = 8,
): { count: number; samples: string[] } {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let count = 0;
  const samples: string[] = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 80));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const pa = sample(a, x, y);
      const pb = sample(b, x, y);
      const dr = Math.abs(pa.r - pb.r) + Math.abs(pa.g - pb.g) + Math.abs(pa.b - pb.b) + Math.abs(pa.a - pb.a);
      if (dr > threshold) {
        count++;
        if (samples.length < 12) samples.push(`(${x},${y}) a=${pa.r},${pa.g},${pa.b},${pa.a} b=${pb.r},${pb.g},${pb.b},${pb.a}`);
      }
    }
  }
  console.log(`\n--- ${label}: ${count} differing sample cells (step=${step}, thr=${threshold}) ---`);
  samples.forEach((s) => console.log(' ', s));
  return { count, samples };
}

const buf = fs.readFileSync(fixture);
const doc = importPsd(path.basename(fixture), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log('Fixture:', fixture);
console.log('Doc size:', doc.width, 'x', doc.height);
console.log('Import preview mode:', previewModeLabel(doc));
console.log('psdFileCompositeBase:', doc.psdFileCompositeBase);
console.log('getDocPreviewCanvas === fileComposite:', getDocPreviewCanvas(doc) === doc.fileComposite);

reportLayers(doc, 'import');

const text = [...walk(doc.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
const portrait = [...walk(doc.roots)].find((n) => n.name === 'Place your portrait here')!;

console.log('\n=== Focus nodes ===');
console.log('Text:', {
  kind: text.kind,
  bounds: { x: text.x, y: text.y, w: text.w, h: text.h },
  import: { ox: text.ox, oy: text.oy },
  canvas: text.canvas ? [text.canvas.width, text.canvas.height] : null,
});
console.log('Place your portrait here:', {
  kind: portrait.kind,
  opacity: portrait.opacity,
  effOpacity: effOpacity(portrait),
  bounds: { x: portrait.x, y: portrait.y, w: portrait.w, h: portrait.h },
  canvas: portrait.canvas ? [portrait.canvas.width, portrait.canvas.height] : null,
  placedLayer: !!portrait.src.placedLayer,
});

// Text center samples: file composite vs isolated text canvas blitted at import vs current
const tcx2 = Math.round(text.ox + text.w / 2);
const tcy2 = Math.round(text.oy + text.h / 2);
const fileAtTextImport = sample(doc.fileComposite!, tcx2, tcy2);

console.log('\nfileComposite pixel at Text import center', tcx2, tcy2, fileAtTextImport);

// Simulate selection (no model change)
console.log('\n=== Phase: selection only ===');
console.log('preview mode:', previewModeLabel(doc));
console.log('isShowingEmbeddedFileComposite:', isShowingEmbeddedFileComposite(doc));

// First drag delta: move text, refresh like activatePsdLivePreviewForEdit
const docDrag = importPsd('dup.psd', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const tDrag = [...walk(docDrag.roots)].find((n) => n.name === 'Text' && n.kind !== 'group')!;
const dx = 80;
const dy = 40;
tDrag.x += dx;
tDrag.y += dy;
console.log('\n=== Phase: after move (before refresh) ===');
console.log('preview mode (stale doc flags):', previewModeLabel(docDrag));
console.log('docHasPreviewDirtyLayers:', docHasPreviewDirtyLayers(docDrag));
console.log('getDocPreviewCanvas still fileComposite?:', getDocPreviewCanvas(docDrag) === docDrag.fileComposite);

refreshPsdPreviewModeAfterEdit(docDrag);
console.log('\n=== Phase: first drag (after refreshPsdPreviewModeAfterEdit) ===');
console.log('preview mode:', previewModeLabel(docDrag));
console.log('shouldOverlayDirtyLayer(Text):', shouldOverlayDirtyLayer(tDrag));

const previewDrag = getDocPreviewCanvas(docDrag)!;
const overlayBuilt = composeDocPreviewWithFileBase(docDrag)!;

diffRegions(docDrag.fileComposite!, previewDrag, 'fileComposite vs getDocPreviewCanvas (drag)');

// Prove overlay draws Text at NEW position on unchanged base
const newCx = Math.round(tDrag.x + tDrag.w / 2);
const newCy = Math.round(tDrag.y + tDrag.h / 2);
const oldCx = Math.round(tDrag.ox + tDrag.ow / 2);
const oldCy = Math.round(tDrag.oy + tDrag.oh / 2);

console.log('\n=== Text region pixels (drag preview) ===');
console.log('OLD center in fileComposite:', sample(docDrag.fileComposite!, oldCx, oldCy));
console.log('OLD center in drag preview:', sample(previewDrag, oldCx, oldCy));
console.log('NEW center in fileComposite (ghost?):', sample(docDrag.fileComposite!, newCx, newCy));
console.log('NEW center in drag preview:', sample(previewDrag, newCx, newCy));

// Isolated: draw only file base vs base+text layer at new pos
const onlyBase = docDrag.fileComposite!;
const scratch = createCanvas(docDrag.width, docDrag.height) as unknown as HTMLCanvasElement;
scratch.getContext('2d')!.drawImage(onlyBase, 0, 0);
const onlyBaseCopy = createCanvas(docDrag.width, docDrag.height) as unknown as HTMLCanvasElement;
onlyBaseCopy.getContext('2d')!.drawImage(onlyBase, 0, 0);
const withTextAtNew = createCanvas(docDrag.width, docDrag.height) as unknown as HTMLCanvasElement;
const g2 = withTextAtNew.getContext('2d')!;
g2.drawImage(onlyBase, 0, 0);
g2.globalAlpha = effOpacity(tDrag);
g2.drawImage(tDrag.canvas!, tDrag.x, tDrag.y, tDrag.w, tDrag.h);
diffRegions(previewDrag, withTextAtNew, 'drag preview vs manual base+Text@new');
diffRegions(previewDrag, onlyBaseCopy, 'drag preview vs fileComposite alone');

// Portrait-like pixel hunt: compare import center of portrait bounds vs puzzle bg
const pCx = Math.round(portrait.x + portrait.w / 2);
const pCy = Math.round(portrait.y + portrait.h / 2);
console.log('\n=== Portrait placeholder layer ===');
console.log('Sample at portrait layer center in fileComposite:', sample(docDrag.fileComposite!, pCx, pCy));
console.log('Sample at portrait center in drag preview:', sample(previewDrag, pCx, pCy));
console.log('Portrait overlay eligible?', shouldOverlayDirtyLayer(portrait));

// Pointer-up: same as drag for preview (history does not revert preview mode until undo)
console.log('\n=== Phase: pointer-up (model unchanged after drag) ===');
console.log('preview mode:', previewModeLabel(docDrag));

// Undo simulation
tDrag.x = tDrag.ox;
tDrag.y = tDrag.oy;
refreshPsdPreviewModeAfterEdit(docDrag);
const previewUndo = getDocPreviewCanvas(docDrag)!;
console.log('\n=== Phase: Undo ===');
console.log('preview mode:', previewModeLabel(docDrag));
console.log('isShowingEmbeddedFileComposite:', isShowingEmbeddedFileComposite(docDrag));
console.log('preview === fileComposite ref:', previewUndo === docDrag.fileComposite);
diffRegions(docDrag.fileComposite!, previewUndo, 'fileComposite vs undo preview');

// Redo
tDrag.x += dx;
tDrag.y += dy;
refreshPsdPreviewModeAfterEdit(docDrag);
console.log('\n=== Phase: Redo ===');
console.log('preview mode:', previewModeLabel(docDrag));

console.log('\n=== Dirty overlay contributors after drag ===');
for (const n of leaves(docDrag)) {
  if (shouldOverlayDirtyLayer(n)) console.log('  OVERLAY:', n.name, n.kind);
}

// Non-overlapping "old text only" vs "new text only" vs portrait puzzle slots
const oldOnlyX = 1180;
const oldOnlyY = 2090;
const newOnlyX = 1980;
const newOnlyY = 2330;
console.log('\n=== Duplicate evidence (Text move +80,+40) ===');
console.log('old-only pixel fileComposite:', sample(docDrag.fileComposite!, oldOnlyX, oldOnlyY));
console.log('old-only pixel drag preview:', sample(previewDrag, oldOnlyX, oldOnlyY));
console.log('new-only pixel fileComposite:', sample(docDrag.fileComposite!, newOnlyX, newOnlyY));
console.log('new-only pixel drag preview:', sample(previewDrag, newOnlyX, newOnlyY));
for (const [x, y] of [
  [1000, 900],
  [1000, 1200],
  [600, 800],
]) {
  const a = sample(docDrag.fileComposite!, x, y);
  const b = sample(previewDrag, x, y);
  console.log(`portrait/puzzle slot (${x},${y}) file vs drag:`, a, b, 'changed=', a.r !== b.r || a.g !== b.g || a.b !== b.b);
}

console.log('\nDone.');

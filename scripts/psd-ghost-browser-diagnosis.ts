/**
 * Phase 4 diagnosis: which layer moves duplicate puzzle vs labels (9015560 or any PSD path).
 * Investigation only — no production changes.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { importPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { effOpacity, leaves } from '../src/model';
import { canEditPsdLayerPosition } from '../src/psdLayerInfo';
import {
  composeDocPreviewWithFileBase,
  getDocPreviewCanvas,
  isLayerPreviewAffecting,
  shouldOverlayDirtyLayer,
} from '../src/psdComposite';

const fixture =
  process.argv[2] ??
  process.env.PSD_TEXT_FIXTURE ??
  path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');

if (!fs.existsSync(fixture)) {
  console.error('Missing fixture:', fixture);
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
  return [d[0], d[1], d[2], d[3]] as const;
}

function regionMeanAbsDiff(
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  step: number,
): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const pa = sample(a, x, y);
      const pb = sample(b, x, y);
      sum += Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]) + Math.abs(pa[3] - pb[3]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

function isFullDocFill(n: { x: number; y: number; w: number; h: number }, doc: { width: number; height: number }) {
  return n.w >= doc.width * 0.99 && n.h >= doc.height * 0.99 && n.x <= 1 && n.y <= 1;
}

function simulateMove(
  doc: ReturnType<typeof importPsd>,
  leafId: string,
  dx: number,
  dy: number,
  puzzleProbe: { x: number; y: number },
  labelProbe: { x: number; y: number },
) {
  const leaf = leaves(doc).find((n) => n.id === leafId)!;
  const embedded = doc.fileComposite!;
  const before = createCanvas(doc.width, doc.height) as unknown as HTMLCanvasElement;
  before.getContext('2d')!.drawImage(embedded, 0, 0);

  leaf.x += dx;
  leaf.y += dy;
  refreshPsdPreviewModeAfterEdit(doc);
  const preview = getDocPreviewCanvas(doc)!;
  const mode = doc.psdPreviewMode;
  const overlay = shouldOverlayDirtyLayer(leaf);

  const step = 8;
  const puzzleDiff = regionMeanAbsDiff(before, preview, puzzleProbe.x - 40, puzzleProbe.y - 40, puzzleProbe.x + 40, puzzleProbe.y + 40, step);
  const labelDiff = regionMeanAbsDiff(before, preview, labelProbe.x - 80, labelProbe.y - 30, labelProbe.x + 80, labelProbe.y + 30, step);

  // Duplicate signature: import composite unchanged at probe vs preview differs strongly when layer moved away
  const embeddedAtPuzzle = sample(embedded, puzzleProbe.x, puzzleProbe.y);
  const previewAtPuzzle = sample(preview, puzzleProbe.x, puzzleProbe.y);
  const embeddedAtLabel = sample(embedded, labelProbe.x, labelProbe.y);
  const previewAtLabel = sample(preview, labelProbe.x, labelProbe.y);

  return {
    layer: leaf.name,
    kind: leaf.kind,
    parent: leaf.parent?.name ?? null,
    bounds: { x: leaf.x, y: leaf.y, w: leaf.w, h: leaf.h },
    importBounds: { ox: leaf.ox, oy: leaf.oy, ow: leaf.ow, oh: leaf.oh },
    previewMode: mode,
    psdStaticComposite: doc.psdStaticComposite,
    previewIsEmbeddedRef: preview === embedded,
    overlayContributor: overlay,
    regionMeanAbsDiff: { puzzle: puzzleDiff, label: labelDiff },
    probePixels: {
      puzzle: { embedded: embeddedAtPuzzle, preview: previewAtPuzzle },
      label: { embedded: embeddedAtLabel, preview: previewAtLabel },
    },
  };
}

const buf = fs.readFileSync(fixture);
const baseDoc = importPsd(path.basename(fixture), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log('=== Document preview at import ===');
console.log({
  previewMode: baseDoc.psdPreviewMode,
  psdFileCompositeBase: baseDoc.psdFileCompositeBase,
  previewRefIsFileComposite: getDocPreviewCanvas(baseDoc) === baseDoc.fileComposite,
});

console.log('\n=== Editable leaves (generic filter) ===');
const editable = leaves(baseDoc).filter(
  (n) => canEditPsdLayerPosition(n) && n.canvas && n.w > 0 && effOpacity(n) > 0.01,
);
for (const n of editable) {
  console.log({
    id: n.id,
    name: n.name,
    parent: n.parent?.name,
    bounds: [n.x, n.y, n.w, n.h],
    canvas: [n.canvas!.width, n.canvas!.height],
    fullDocFill: isFullDocFill(n, baseDoc),
    pickTarget: !isFullDocFill(n, baseDoc),
  });
}

// Probes: center of doc (puzzle) and lower third (typical instruction text band) — doc-relative, not layer names
const puzzleProbe = { x: Math.round(baseDoc.width * 0.5), y: Math.round(baseDoc.height * 0.45) };
const labelProbe = { x: Math.round(baseDoc.width * 0.75), y: Math.round(baseDoc.height * 0.92) };

console.log('\n=== Simulated move +80,+40 per editable leaf (fresh import each) ===');
const dx = 80;
const dy = 40;
for (const template of editable) {
  const doc = importPsd('sim.psd', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const leaf = leaves(doc).find((n) => n.key === template.key)!;
  const report = simulateMove(doc, leaf.id, dx, dy, puzzleProbe, labelProbe);
  console.log(JSON.stringify(report));
}

console.log('\n=== Viewport path check (code) ===');
console.log(
  'When getDocPreviewCanvas returns non-null, per-layer meshes are hidden (viewport.ts syncDoc). Duplicate must be inside single 2D composite canvas unless compositeMesh visible twice.',
);

console.log('\n=== file-base-overlay composition check (Text-like small leaf vs large raster) ===');
const docText = importPsd('t.psd', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const small = editable.filter((n) => !isFullDocFill(n, baseDoc) && n.h < baseDoc.height * 0.2).sort((a, b) => a.w * a.h - b.w * b.h)[0];
const large = editable.filter((n) => !isFullDocFill(n, baseDoc)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
if (small && large) {
  for (const [label, target] of [
    ['smallest-editable-leaf', small],
    ['largest-editable-leaf', large],
  ] as const) {
    const d = importPsd('x.psd', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const L = leaves(d).find((n) => n.key === target.key)!;
    L.x += dx;
    L.y += dy;
    refreshPsdPreviewModeAfterEdit(d);
    const p = getDocPreviewCanvas(d)!;
    const manual = composeDocPreviewWithFileBase(d)!;
    console.log(label, {
      name: L.name,
      area: L.w * L.h,
      previewEqualsComposeHelper: p !== manual,
      puzzleDiff: regionMeanAbsDiff(d.fileComposite!, p, puzzleProbe.x - 60, puzzleProbe.y - 60, puzzleProbe.x + 60, puzzleProbe.y + 60, 10),
      labelDiff: regionMeanAbsDiff(d.fileComposite!, p, labelProbe.x - 100, labelProbe.y - 40, labelProbe.x + 100, labelProbe.y + 40, 10),
    });
  }
}
void docText;

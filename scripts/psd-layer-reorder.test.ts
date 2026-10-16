/**
 * PSD layer stack reorder: model + ag-psd tree stay in sync, preview z-order, export, undo/redo, clipping guards.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';
import type { Command } from '../src/core/history';

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

const { importPsd, exportPsd, refreshPsdPreviewModeAfterEdit } = await import('../src/psd/psd');
const { History } = await import('../src/core/history');
const {
  applySiblingReorder,
  canReorderSiblingIndex,
  clipBaseInSiblingOrder,
  clippingSiblingOrderValid,
  nodeSiblings,
} = await import('../src/core/sourceTree');
const { composeDocPreview } = await import('../src/psd/psdComposite');
const { canReorderLayer } = await import('../src/formats/formatCaps');
type Doc = ReturnType<typeof importPsd>;

const W = 80;
const H = 80;

function fillLayer(name: string, css: string, extra: Partial<Layer> = {}): Layer {
  const c = createCanvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, W, H);
  return {
    name,
    left: 0,
    top: 0,
    right: W,
    bottom: H,
    canvas: c as unknown as HTMLCanvasElement,
    ...extra,
  };
}

function buildRootLayers(children: Layer[]): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = createCanvas(W, H) as unknown as HTMLCanvasElement;
  return importPsd('reorder.psd', writePsd(psd));
}

const rootNames = (doc: Doc) => doc.roots.map((n) => n.name);
const psdChildNames = (doc: Doc) => doc.psd!.children!.map((l) => l.name);
const centerBlue = (doc: Doc) => {
  const px = composeDocPreview(doc).getContext('2d')!.getImageData(40, 40, 1, 1).data;
  return px[2]! > 200 && px[0]! < 80;
};
const centerGreen = (doc: Doc) => {
  const px = composeDocPreview(doc).getContext('2d')!.getImageData(40, 40, 1, 1).data;
  return px[1]! > 200 && px[0]! < 80;
};

function reorderCommand(doc: Doc, n: Doc['roots'][0], fromIdx: number, toIdx: number): Command {
  return {
    label: 'Reorder layer',
    do: () => {
      applySiblingReorder(doc, n, fromIdx, toIdx);
      refreshPsdPreviewModeAfterEdit(doc);
    },
    undo: () => {
      applySiblingReorder(doc, n, toIdx, fromIdx);
      refreshPsdPreviewModeAfterEdit(doc);
    },
  };
}

// --- policy: PSD only ---
{
  const doc = buildRootLayers([fillLayer('A', '#ff0000'), fillLayer('B', '#00ff00'), fillLayer('C', '#0000ff')]);
  log('psd-can-reorder', canReorderLayer(doc), String(doc.format));
}

// --- stack order + composite ---
{
  const doc = buildRootLayers([
    fillLayer('Bottom', '#ff0000'),
    fillLayer('Middle', '#00ff00'),
    fillLayer('Top', '#0000ff'),
  ]);
  log('initial-root-order', rootNames(doc).join(',') === 'Bottom,Middle,Top', rootNames(doc).join(','));
  log('initial-psd-order', psdChildNames(doc).join(',') === 'Bottom,Middle,Top', psdChildNames(doc).join(','));
  log('initial-top-wins-composite', centerBlue(doc), 'center should be blue');

  const top = doc.roots[2]!;
  const ok = applySiblingReorder(doc, top, 2, 1);
  log('move-top-down-applied', ok, String(ok));
  log('after-move-root-order', rootNames(doc).join(',') === 'Bottom,Top,Middle', rootNames(doc).join(','));
  log('after-move-psd-order', psdChildNames(doc).join(',') === 'Bottom,Top,Middle', psdChildNames(doc).join(','));
  log('after-move-green-on-top', centerGreen(doc), 'center should be green');
  log('node-id-preserved', top.id.length > 0 && top.name === 'Top', top.id);
}

// --- undo / redo ---
{
  const doc = buildRootLayers([
    fillLayer('Bottom', '#ff0000'),
    fillLayer('Middle', '#00ff00'),
    fillLayer('Top', '#0000ff'),
  ]);
  const top = doc.roots[2]!;
  const hist = new History();
  hist.exec(reorderCommand(doc, top, 2, 1));
  log('undo-before', rootNames(doc).join(',') === 'Bottom,Top,Middle', rootNames(doc).join(','));
  hist.undo();
  log('undo-restored-order', rootNames(doc).join(',') === 'Bottom,Middle,Top', rootNames(doc).join(','));
  log('undo-restored-composite', centerBlue(doc), 'blue again');
  hist.redo();
  log('redo-reapplied-order', rootNames(doc).join(',') === 'Bottom,Top,Middle', rootNames(doc).join(','));
  log('redo-reapplied-composite', centerGreen(doc), 'green again');
}

// --- export / re-import ---
{
  const doc = buildRootLayers([
    fillLayer('Bottom', '#ff0000'),
    fillLayer('Middle', '#00ff00'),
    fillLayer('Top', '#0000ff'),
  ]);
  applySiblingReorder(doc, doc.roots[2]!, 2, 0);
  const out = exportPsd(doc);
  const reread = readPsd(out, { skipThumbnail: true });
  const names = (reread.children ?? []).map((l) => l.name);
  log('export-order-after-move', names.join(',') === 'Top,Bottom,Middle', names.join(','));
}

// --- clipping: invalid moves blocked ---
{
  const doc = buildRootLayers([
    fillLayer('BG', '#ffffff'),
    fillLayer('Base', '#0000ff'),
    fillLayer('Clip', '#ff0000', { clipping: true }),
  ]);
  const sibs = nodeSiblings(doc, doc.roots[2]!);
  log('clip-stack-valid-initial', clippingSiblingOrderValid(sibs), rootNames(doc).join(','));
  const clip = doc.roots[2]!;
  log('block-clip-to-bottom', !canReorderSiblingIndex(sibs, 2, 0), 'clip index 2 → 0');
  const twoLayer = buildRootLayers([
    fillLayer('Base', '#0000ff'),
    fillLayer('Clip', '#ff0000', { clipping: true }),
  ]);
  log('block-base-above-only-clip', !canReorderSiblingIndex(twoLayer.roots, 0, 1), 'Base 0 → 1 with Clip only below');
  const blocked = applySiblingReorder(doc, clip, 2, 0);
  log('apply-clip-to-bottom-noop', !blocked && rootNames(doc).join(',') === 'BG,Base,Clip', rootNames(doc).join(','));
}

// --- clip base preservation (compositor-aligned) ---
{
  const doc = buildRootLayers([
    fillLayer('Base', '#0000ff'),
    fillLayer('Clip', '#ff0000', { clipping: true }),
    fillLayer('Extra', '#00ff00'),
  ]);
  const sibs = doc.roots;
  const clip = doc.roots[1]!;
  log('clip-base-is-base', clipBaseInSiblingOrder(sibs, clip)?.name === 'Base', clip?.name ?? '');
  log('block-base-swap-with-clip', !canReorderSiblingIndex(sibs, 0, 1), 'Base 0 → 1');
  log('block-extra-between-base-and-clip', !canReorderSiblingIndex(sibs, 2, 1), 'Extra 2 → 1 would sit between Base and Clip');
  log('allow-extra-to-top', canReorderSiblingIndex(sibs, 2, 0), 'Extra 2 → 0 keeps Clip on Base');
}

// --- 10960916.psd: Image group vs inner raster (regression) ---
{
  const fixture =
    process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd');
  if (fs.existsSync(fixture)) {
    const buf = fs.readFileSync(fixture);
    const doc = importPsd(
      '10960916.psd',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const imageGroup = doc.roots
      .flatMap((r) => (r.name === 'Effects' ? r.children : []))
      .find((n) => n.name === 'Image' && n.kind === 'group');
    const innerRaster = imageGroup?.children.find((n) => n.name === 'Image' && n.kind === 'raster');
    if (imageGroup && innerRaster && imageGroup.parent) {
      const effectsSibs = nodeSiblings(doc, imageGroup);
      const gi = effectsSibs.indexOf(imageGroup);
      log('10960916-effects-group-move-up', canReorderSiblingIndex(effectsSibs, gi, gi + 1), `idx=${gi}`);
      const innerSibs = nodeSiblings(doc, innerRaster);
      const ii = innerSibs.indexOf(innerRaster);
      log('10960916-inner-image-block-swap-clip', !canReorderSiblingIndex(innerSibs, ii, ii + 1), 'Image over Image 2');
      log('10960916-inner-clip-base', clipBaseInSiblingOrder(innerSibs, innerSibs[1]!)?.name === 'Image', innerSibs[1]?.name ?? '');
    } else {
      log('10960916-fixture-skipped', false, 'Effects/Image structure not found');
    }
  } else {
    log('10960916-fixture-missing', true, 'skipped (no file)');
  }
}

// --- reorder within nested group only ---
{
  const innerA = fillLayer('InnerA', '#ff0000');
  const innerB = fillLayer('InnerB', '#0000ff');
  const group: Layer = {
    name: 'Group',
    children: [innerA, innerB],
  };
  const doc = buildRootLayers([fillLayer('BG', '#ffffff'), group]);
  const groupNode = doc.roots[1]!;
  const innerTop = groupNode.children[1]!;
  applySiblingReorder(doc, innerTop, 1, 0);
  log('group-child-order', groupNode.children.map((n) => n.name).join(',') === 'InnerB,InnerA', groupNode.children.map((n) => n.name).join(','));
  log('group-src-order', (groupNode.src.children ?? []).map((l) => l.name).join(',') === 'InnerB,InnerA', (groupNode.src.children ?? []).map((l) => l.name).join(','));
}

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`${failures.length} of ${results.length} layer reorder tests failed`);
  process.exit(1);
}
console.log(`All ${results.length} layer reorder tests passed`);

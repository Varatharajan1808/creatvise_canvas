/**
 * Multi-object selection: shift-toggle, union bounds, same-document rule, multi-move undo, PSD/AI export positions.
 */
import fs from 'fs';
import path from 'path';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import type { Layer } from 'ag-psd';
import { History } from '../src/history';
import { walk, type Doc, type Node } from '../src/model';
import {
  addToSelection,
  canAddNodeToSelection,
  emptySelection,
  isNodeSelected,
  moveLeavesBy,
  replaceSelection,
  sameDocument,
  selectionBounds,
  singleSelection,
  snapshotPositions,
  toggleNodeInSelection,
  selectionBoundsScreen,
  selectionSpansDocuments,
  pointInSelectionForMoveAtScreen,
  type ScreenProjection,
} from '../src/selection';
import { importPsd, exportPsd, refreshPsdPreviewModeAfterEdit } from '../src/psd';
import { docHasPreviewDirtyLayers, isLayerPreviewDirty } from '../src/psdComposite';
import { leavesForPositionEdit } from '../src/psdLayerInfo';
import { applyAiDuplicateMetadata } from '../src/aiLayerMeta';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

function setupDom() {
  const window = new Window();
  (globalThis as unknown as { window: Window }).window = window;
  (globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = ((tag: string, options?: unknown) => {
    if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
    return origCreate(tag, options as never);
  }) as typeof window.document.createElement;
  initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);
}

function makeLeaf(id: string, x: number, y: number, w: number, h: number): Node {
  return {
    id,
    key: id,
    name: id,
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x,
    y,
    w,
    h,
    ox: x,
    oy: y,
    ow: w,
    oh: h,
    rotation: 0,
    canvas: createCanvas(w, h) as unknown as HTMLCanvasElement,
    children: [],
    parent: null,
    src: {} as Layer,
    unsupported: [],
  };
}

function syntheticDoc(name: string, layers: Node[]): Doc {
  for (const n of layers) n.parent = null;
  return {
    id: name,
    name: `${name}.psd`,
    format: 'psd',
    width: 800,
    height: 600,
    offsetX: 0,
    offsetY: 0,
    roots: layers,
    original: new ArrayBuffer(0),
    warnings: [],
  };
}

setupDom();

const docs: Doc[] = [];
const a = makeLeaf('a', 10, 20, 50, 40);
const b = makeLeaf('b', 100, 80, 30, 30);
const docA = syntheticDoc('a', [a, b]);
docs.push(docA);
const c = makeLeaf('c', 0, 0, 20, 20);
const docB = syntheticDoc('b', [c]);
docs.push(docB);

// Shift-toggle / replace
{
  let sel = emptySelection();
  sel = replaceSelection(a);
  log('replace-single', sel.primary === a && sel.nodes.length === 1, String(sel.nodes.length));
  sel = addToSelection(sel, b);
  log('add-second', sel.nodes.length === 2 && sel.primary === b, sel.nodes.map((n) => n.id).join(','));
  sel = toggleNodeInSelection(sel, b, docs);
  log('toggle-off', sel.nodes.length === 1 && sel.primary === a, sel.nodes.map((n) => n.id).join(','));
  sel = toggleNodeInSelection(sel, b, docs);
  log('toggle-on', sel.nodes.length === 2, String(sel.nodes.length));
  sel = toggleNodeInSelection(sel, a, docs);
  log('toggle-primary-removed', sel.nodes.length === 1 && sel.primary === b, sel.primary?.id ?? 'null');
}

// Cross-document shift adds (does not replace)
{
  let sel = singleSelection(a);
  const next = toggleNodeInSelection(sel, c, docs);
  log('cross-doc-shift-adds', next.nodes.length === 2 && isNodeSelected(next, a) && isNodeSelected(next, c), next.nodes.map((n) => n.id).join(','));
  const afterRemoveC = toggleNodeInSelection(next, c, docs);
  log('cross-doc-toggle-off', afterRemoveC.nodes.length === 1 && afterRemoveC.primary === a, afterRemoveC.nodes.map((n) => n.id).join(','));
  log('can-add-cross-doc', canAddNodeToSelection(singleSelection(a), c, docs), String(canAddNodeToSelection(singleSelection(a), c, docs)));
  log('spans-documents', selectionSpansDocuments(toggleNodeInSelection(singleSelection(a), c, docs), docs), 'a+c');
  log('same-doc-two', sameDocument([a, b], docs), String(canAddNodeToSelection(singleSelection(a), b, docs)));
  log('same-doc-false', !sameDocument([a, c], docs), 'a+c');
}

// Screen-space union with offset documents (simulates building.psd + logo.ai on canvas)
{
  docA.offsetX = 0;
  docA.offsetY = 0;
  docB.offsetX = 900;
  docB.offsetY = 0;
  const proj: ScreenProjection = {
    docToScreen: (d, x, y) => ({ x: d.offsetX + x, y: d.offsetY + y }),
    screenToDoc: (d, sx, sy) => ({ x: sx - d.offsetX, y: sy - d.offsetY }),
  };
  const sel = toggleNodeInSelection(singleSelection(a), c, docs);
  const sb = selectionBoundsScreen(sel, docs, proj)!;
  log('cross-doc-screen-union-min', sb.sx === 10 && sb.sy === 0, `${sb.sx},${sb.sy}`);
  log('cross-doc-screen-union-span', sb.sw === 910 && sb.sh === 60, `${sb.sw}x${sb.sh}`);
  log(
    'cross-doc-move-hit-screen',
    pointInSelectionForMoveAtScreen(sel, 905, 5, docs, proj, (n, px, py) => px >= n.x && px < n.x + n.w && py >= n.y && py < n.y + n.h),
    'inside logo doc',
  );
  const ax0 = a.x;
  const cx0 = c.x;
  moveLeavesBy([a, c], 7, 3);
  log('cross-doc-move-delta', a.x === ax0 + 7 && c.x === cx0 + 7, `${a.x},${c.x}`);
  // Reset for same-document tests below
  a.x = 10;
  a.y = 20;
  b.x = 100;
  b.y = 80;
  c.x = 0;
  c.y = 0;
  docA.offsetX = 0;
  docA.offsetY = 0;
  docB.offsetX = 0;
  docB.offsetY = 0;
}

// Union bounds (document space, single document)
{
  const sel = addToSelection(singleSelection(a), b);
  const ub = selectionBounds(sel)!;
  log('union-x', ub.x === 10, String(ub.x));
  log('union-y', ub.y === 20, String(ub.y));
  log('union-w', ub.w === 120, String(ub.w));
  log('union-h', ub.h === 90, String(ub.h));
}

// Multi-move + single undo step
{
  const a2 = makeLeaf('m1', 0, 0, 40, 40);
  const b2 = makeLeaf('m2', 60, 10, 40, 40);
  const doc = syntheticDoc('move', [a2, b2]);
  const before = snapshotPositions([a2, b2]);
  moveLeavesBy([a2, b2], 15, -5);
  const after = snapshotPositions([a2, b2]);
  const hist = new History();
  const positionsCommand = (
    label: string,
    b: Array<[Node, number, number]>,
    af: Array<[Node, number, number]>,
  ) => {
    const apply = (list: Array<[Node, number, number]>) => list.forEach(([n, x, y]) => { n.x = x; n.y = y; });
    return {
      label,
      do: () => { apply(af); refreshPsdPreviewModeAfterEdit(doc); },
      undo: () => { apply(b); refreshPsdPreviewModeAfterEdit(doc); },
    };
  };
  hist.exec(positionsCommand('Move', before, after), true);
  log('multi-move-delta', a2.x === 15 && b2.x === 75 && b2.y === 5, `${a2.x},${a2.y} ${b2.x},${b2.y}`);
  hist.undo();
  log('multi-move-undo', a2.x === 0 && b2.x === 60 && b2.y === 10, `${a2.x},${b2.y} ${b2.x},${b2.y}`);
  hist.redo();
  log('multi-move-redo', a2.x === 15 && b2.x === 75, `${a2.x} ${b2.x}`);
}

// PSD export positions (two raster layers)
{
  const fixture =
    process.env.PSD_TEXT_FIXTURE ??
    path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
  if (fs.existsSync(fixture)) {
    const buf = fs.readFileSync(fixture);
    const doc = importPsd(
      '9015560.psd',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    const layers = [...walk(doc.roots)].filter(
      (n) => n.kind === 'raster' && n.canvas && n.w > 30 && n.h > 30 && n.opacity > 0,
    );
    const L0 = layers[0];
    const L1 = layers[1];
    if (L0 && L1) {
      const ox0 = L0.x;
      const oy0 = L0.y;
      const ox1 = L1.x;
      const oy1 = L1.y;
      moveLeavesBy([L0, L1], 33, 22);
      refreshPsdPreviewModeAfterEdit(doc);
      const exported = exportPsd(doc);
      const rt = importPsd('rt.psd', exported);
      const r0 = [...walk(rt.roots)].find((n) => n.name === L0.name)!;
      const r1 = [...walk(rt.roots)].find((n) => n.name === L1.name)!;
      log(
        'psd-multi-export-a',
        r0.x === ox0 + 33 && r0.y === oy0 + 22,
        `${r0.x},${r0.y} vs ${ox0 + 33},${oy0 + 22}`,
      );
      log(
        'psd-multi-export-b',
        r1.x === ox1 + 33 && r1.y === oy1 + 22,
        `${r1.x},${r1.y} vs ${ox1 + 33},${oy1 + 22}`,
      );
      const relBefore = { dx: ox1 - ox0, dy: oy1 - oy0 };
      const relAfter = { dx: L1.x - L0.x, dy: L1.y - L0.y };
      log(
        'psd-multi-relative-spacing',
        relAfter.dx === relBefore.dx && relAfter.dy === relBefore.dy,
        `before ${relBefore.dx},${relBefore.dy} after ${relAfter.dx},${relAfter.dy}`,
      );
      log(
        'psd-multi-preview-dirty-both',
        isLayerPreviewDirty(L0) && isLayerPreviewDirty(L1) && docHasPreviewDirtyLayers(doc),
        String(docHasPreviewDirtyLayers(doc)),
      );
      // One history step undo/redo (mirrors main.ts positionsCommand + psdEdited per node)
      const docH = importPsd(
        '9015560.psd',
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      const H0 = [...walk(docH.roots)].find((n) => n.name === L0.name)!;
      const H1 = [...walk(docH.roots)].find((n) => n.name === L1.name)!;
      const beforeH = snapshotPositions([H0, H1]);
      moveLeavesBy([H0, H1], 10, 5);
      const afterH = snapshotPositions([H0, H1]);
      const histPsd = new History();
      const psdPositionsCommand = (
        label: string,
        b: Array<[Node, number, number]>,
        af: Array<[Node, number, number]>,
      ) => {
        const apply = (list: Array<[Node, number, number]>) => list.forEach(([n, x, y]) => { n.x = x; n.y = y; });
        return {
          label,
          do: () => {
            apply(af);
            af.forEach(([n]) => refreshPsdPreviewModeAfterEdit(docH));
          },
          undo: () => {
            apply(b);
            b.forEach(([n]) => refreshPsdPreviewModeAfterEdit(docH));
          },
        };
      };
      histPsd.exec(psdPositionsCommand('Move', beforeH, afterH), true);
      log('psd-multi-one-history-step', histPsd.canUndo && !histPsd.canRedo, `undo=${histPsd.canUndo}`);
      histPsd.undo();
      log(
        'psd-multi-undo-both',
        H0.x === beforeH[0][1] && H0.y === beforeH[0][2] && H1.x === beforeH[1][1] && H1.y === beforeH[1][2],
        `${H0.x},${H0.y} ${H1.x},${H1.y}`,
      );
      histPsd.redo();
      log(
        'psd-multi-redo-both',
        H0.x === afterH[0][1] && H1.x === afterH[1][1],
        `${H0.x},${H1.x}`,
      );
    } else {
      log('psd-multi-export-skip', true, 'need two layers');
    }
  } else {
    log('psd-multi-export-skip', true, 'missing fixture');
  }
}

// AI: single-layer move round-trip (sample.ai has one movable leaf — not multi-layer proof)
async function aiSingleLayerMoveTests() {
  const { importAi, exportAi } = await import('../src/ai');
  const samplePath = 'public/sample.ai';
  if (!fs.existsSync(samplePath)) {
    log('ai-single-move-skip', true, 'missing sample.ai');
    return;
  }
  const buf = fs.readFileSync(samplePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const doc = await importAi('sample.ai', ab.slice(0));
  const leaves = [...walk(doc.roots)].filter((n) => n.kind !== 'group' && n.canvas);
  log('ai-sample-movable-leaf-count', leaves.length === 1, String(leaves.length));
  const n = leaves[0];
  if (!n) return;
  const ox = n.x;
  const oy = n.y;
  n.x += 50;
  n.y += 30;
  const out = await exportAi(doc);
  const re = await importAi('edited.ai', out);
  const r = [...walk(re.roots)].find((x) => x.kind !== 'group' && x.canvas)!;
  log('ai-single-move-export', r.x === n.x && r.y === n.y, `${r.x},${r.y} vs ${n.x},${n.y}`);
  log('ai-single-move-delta', r.x - ox === 50 && r.y - oy === 30, `delta ${r.x - ox},${r.y - oy}`);
}

/** Two independently placed AI layers via duplicate metadata (same pattern as duplicate export tests). */
async function aiTwoLayerMultiMoveTests() {
  const twoPath = 'public/fixtures/ai/two-ocg-layers.ai';
  if (!fs.existsSync(twoPath)) {
    log('ai-two-layer-skip', true, 'missing two-ocg-layers.ai');
    return;
  }
  const { importAi, exportAi } = await import('../src/ai');
  const buf = fs.readFileSync(twoPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const doc = await importAi('two-ocg-layers.ai', ab.slice(0));
  const roots = doc.roots.filter((n) => n.kind !== 'group' && n.canvas);
  log('ai-two-layer-import-count', roots.length === 2, String(roots.length));
  if (roots.length < 2) return;
  const movable = roots.filter((n) => leavesForPositionEdit(n).length > 0);
  log('ai-two-layer-movable-count', movable.length === 2, String(movable.length));
  const [A, B] = movable;
  const ax0 = A.x;
  const ay0 = A.y;
  const bx0 = B.x;
  const by0 = B.y;
  const rel0 = { dx: B.x - A.x, dy: B.y - A.y };
  moveLeavesBy([A, B], 25, -10);
  const rel1 = { dx: B.x - A.x, dy: B.y - A.y };
  log(
    'ai-two-layer-relative-spacing',
    rel1.dx === rel0.dx && rel1.dy === rel0.dy,
    `before ${rel0.dx},${rel0.dy} after ${rel1.dx},${rel1.dy}`,
  );
  log(
    'ai-two-layer-shared-delta',
    A.x - ax0 === 25 && A.y - ay0 === -10 && B.x - bx0 === 25 && B.y - by0 === -10,
    `A=${A.x - ax0},${A.y - ay0} B=${B.x - bx0},${B.y - by0}`,
  );
  const out = await exportAi(doc);
  const re = await importAi('two-moved.ai', out);
  log('ai-two-layer-reimport-root-count', re.roots.length === 2, String(re.roots.length));
  const rA = re.roots.find((n) => n.name === A.name)!;
  const rB = re.roots.find((n) => n.name === B.name)!;
  log('ai-two-layer-export-a', rA.x === A.x && rA.y === A.y, `${rA.x},${rA.y} vs ${A.x},${A.y}`);
  log('ai-two-layer-export-b', rB.x === B.x && rB.y === B.y, `${rB.x},${rB.y} vs ${B.x},${B.y}`);
  log(
    'ai-two-layer-export-relative',
    rB.x - rA.x === rel0.dx && rB.y - rA.y === rel0.dy,
    `export rel ${rB.x - rA.x},${rB.y - rA.y} (fixture layers share frame if 0,0)`,
  );
}

/** Duplicate sample.ai → two roots; multi-move + export (independent transforms in PDF). */
async function aiDuplicatedTwoLayerMoveTests() {
  const samplePath = 'public/sample.ai';
  if (!fs.existsSync(samplePath)) {
    log('ai-dup-two-skip', true, 'missing sample.ai');
    return;
  }
  const { importAi, exportAi } = await import('../src/ai');
  const buf = fs.readFileSync(samplePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const doc = await importAi('sample.ai', ab.slice(0));
  const orig = doc.roots[0]!;
  const clone = {
    ...orig,
    id: 'dup_test',
    key: `${orig.key}_dup`,
    name: `${orig.name} copy`,
    x: orig.x + 40,
    y: orig.y + 40,
    ox: orig.ox + 40,
    oy: orig.oy + 40,
    canvas: orig.canvas,
    children: [],
    parent: null,
    src: { ...orig.src, name: `${orig.name} copy` },
  } as Node;
  applyAiDuplicateMetadata(doc, orig, clone);
  doc.roots.push(clone);
  log('ai-dup-two-roots', doc.roots.length === 2, String(doc.roots.length));
  const rel0 = clone.x - orig.x;
  moveLeavesBy([orig, clone], 12, 8);
  log('ai-dup-two-relative', clone.x - orig.x === rel0 && clone.y - orig.y === 40, `rel ${clone.x - orig.x},${clone.y - orig.y}`);
  const out = await exportAi(doc);
  const re = await importAi('dup-moved.ai', out);
  log('ai-dup-two-reimport-count', re.roots.length === 2, String(re.roots.length));
  const r0 = re.roots.find((n) => n.name === orig.name)!;
  const r1 = re.roots.find((n) => n.name === clone.name)!;
  log('ai-dup-two-export-positions', r0.x === orig.x && r1.x === clone.x, `${r0.x},${r1.x} vs ${orig.x},${clone.x}`);
}

await aiSingleLayerMoveTests();
await aiTwoLayerMultiMoveTests();
await aiDuplicatedTwoLayerMoveTests();

/** Cross-document move then independent PSD + AI export (building.psd + logo.ai scenario). */
async function crossDocumentExportTests() {
  const psdFixture =
    process.env.PSD_TEXT_FIXTURE ??
    path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd');
  const aiPath = 'public/sample.ai';
  if (!fs.existsSync(psdFixture) || !fs.existsSync(aiPath)) {
    log('cross-doc-export-skip', true, 'missing psd or sample.ai');
    return;
  }
  const { importAi, exportAi } = await import('../src/ai');
  const psdBuf = fs.readFileSync(psdFixture);
  const psdDoc = importPsd(
    'building.psd',
    psdBuf.buffer.slice(psdBuf.byteOffset, psdBuf.byteOffset + psdBuf.byteLength),
  );
  const psdLayer = [...walk(psdDoc.roots)].find(
    (n) => n.kind === 'raster' && n.canvas && n.w > 30 && n.opacity > 0,
  );
  const aiBuf = fs.readFileSync(aiPath);
  const aiDoc = await importAi(
    'logo.ai',
    aiBuf.buffer.slice(aiBuf.byteOffset, aiBuf.byteOffset + aiBuf.byteLength),
  );
  const aiLayer = [...walk(aiDoc.roots)].find((n) => n.kind !== 'group' && n.canvas);
  if (!psdLayer || !aiLayer) {
    log('cross-doc-export-skip', true, 'missing layer');
    return;
  }
  const snap = {
    px: psdLayer.x,
    py: psdLayer.y,
    ax: aiLayer.x,
    ay: aiLayer.y,
    rel: { dx: aiLayer.x - psdLayer.x, dy: aiLayer.y - psdLayer.y },
  };
  moveLeavesBy([psdLayer, aiLayer], 18, -6);
  refreshPsdPreviewModeAfterEdit(psdDoc);
  log(
    'cross-doc-relative-after-move',
    aiLayer.x - psdLayer.x === snap.rel.dx && aiLayer.y - psdLayer.y === snap.rel.dy,
    `${aiLayer.x - psdLayer.x},${aiLayer.y - psdLayer.y}`,
  );
  const psdRt = importPsd('building-out.psd', exportPsd(psdDoc));
  const psdBack = [...walk(psdRt.roots)].find((n) => n.name === psdLayer.name)!;
  log(
    'cross-doc-psd-export',
    psdBack.x === psdLayer.x && psdBack.y === psdLayer.y,
    `${psdBack.x},${psdBack.y}`,
  );
  const aiRt = await importAi('logo-out.ai', await exportAi(aiDoc));
  const aiBack = [...walk(aiRt.roots)].find((n) => n.kind !== 'group' && n.canvas)!;
  log(
    'cross-doc-ai-export',
    aiBack.x === aiLayer.x && aiBack.y === aiLayer.y,
    `${aiBack.x},${aiBack.y}`,
  );
  const afterMove = snapshotPositions([psdLayer, aiLayer]);
  const beforeMove: Array<[Node, number, number]> = [
    [psdLayer, snap.px, snap.py],
    [aiLayer, snap.ax, snap.ay],
  ];
  const hist = new History();
  hist.exec({
    label: 'Move',
    do: () => {
      psdLayer.x = afterMove[0][1];
      psdLayer.y = afterMove[0][2];
      aiLayer.x = afterMove[1][1];
      aiLayer.y = afterMove[1][2];
      refreshPsdPreviewModeAfterEdit(psdDoc);
    },
    undo: () => {
      psdLayer.x = beforeMove[0][1];
      psdLayer.y = beforeMove[0][2];
      aiLayer.x = beforeMove[1][1];
      aiLayer.y = beforeMove[1][2];
      refreshPsdPreviewModeAfterEdit(psdDoc);
    },
  }, true);
  hist.undo();
  log(
    'cross-doc-undo-both-docs',
    psdLayer.x === snap.px && psdLayer.y === snap.py && aiLayer.x === snap.ax && aiLayer.y === snap.ay,
    `psd=${psdLayer.x},${psdLayer.y} ai=${aiLayer.x},${aiLayer.y}`,
  );
  hist.redo();
  log(
    'cross-doc-redo-both-docs',
    psdLayer.x === afterMove[0][1] && aiLayer.x === afterMove[1][1],
    `psd=${psdLayer.x} ai=${aiLayer.x}`,
  );
}

await crossDocumentExportTests();

const failed = results.filter((r) => !r.ok);
console.log('\nJSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

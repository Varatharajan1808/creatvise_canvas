/**
 * Phase 6d: canvas group selection, chrome hit-test, group drag, undo/redo.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';
import {
  hitTestCanvasClickTarget,
  hitTestCanvasGroupChrome,
  hitTestCanvasLayer,
  isPointInGroupBounds,
} from '../src/canvas/canvasHitTest';
import { importPsd } from '../src/psd/psd';
import { History } from '../src/core/history';
import type { Doc, Node } from '../src/core/model';
import { executeGroupCreation, planGroupCreation } from '../src/operations/groupOps';
import { leavesForPositionEdit } from '../src/psd/psdLayerInfo';
import {
  movableLeavesForSelection,
  moveLeavesBy,
  pointInSelectionForMove,
  pointInSelectionForMoveAtScreen,
  replaceSelection,
  singleSelection,
  snapshotPositions,
  toggleNodeInSelection,
} from '../src/canvas/selection';

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

const identityScreenToDoc = (_d: Doc, sx: number, sy: number) => ({ x: sx, y: sy });
const identityDocToScreen = (_d: Doc, x: number, y: number) => ({ x, y });
const proj = { screenToDoc: identityScreenToDoc, docToScreen: identityDocToScreen };

function ctx(doc: Doc) {
  return { docs: [doc], screenToDoc: identityScreenToDoc };
}

function fill(name: string, x: number, y: number, w: number, h: number, css: string): Layer {
  const c = createCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, w, h);
  return { name, left: x, top: y, right: x + w, bottom: y + h, canvas: c as unknown as HTMLCanvasElement };
}

function importLayers(children: Layer[]): Doc {
  const psd: Psd = { width: 200, height: 200, children };
  psd.canvas = createCanvas(200, 200) as unknown as HTMLCanvasElement;
  return importPsd('cg.psd', writePsd(psd));
}

function makeGroupDoc(): { doc: Doc; group: Node; a: Node; b: Node } {
  const doc = importLayers([
    fill('A', 20, 20, 40, 40, '#f00'),
    fill('B', 100, 100, 40, 40, '#0f0'),
  ]);
  const planned = planGroupCreation(doc, doc.roots);
  if (!planned.ok) throw new Error('plan');
  executeGroupCreation(planned.plan);
  const group = doc.roots.find((n) => n.kind === 'group')!;
  const a = group.children.find((n) => n.name === 'A')!;
  const b = group.children.find((n) => n.name === 'B')!;
  return { doc, group, a, b };
}

// Leaf vs group click
{
  const { doc, group, a } = makeGroupDoc();
  const c = ctx(doc);
  log('leaf-hit-on-child', hitTestCanvasLayer(c, 35, 35)?.name === 'A', hitTestCanvasLayer(c, 35, 35)?.name ?? '');
  log('normal-click-selects-leaf', hitTestCanvasClickTarget(c, 35, 35)?.name === 'A', '');
  log('alt-click-selects-group', hitTestCanvasClickTarget(c, 35, 35, { preferGroup: true })?.name === 'Group', '');
  log('chrome-gap-selects-group', hitTestCanvasGroupChrome(c, 70, 70)?.id === group.id, group.name);
}

// Group move initiation on bounds
{
  const { doc, group } = makeGroupDoc();
  const sel = singleSelection(group);
  log(
    'group-bounds-move-hit',
    pointInSelectionForMove(sel, 70, 70, () => false),
    '',
  );
  log(
    'group-screen-move-hit',
    pointInSelectionForMoveAtScreen(sel, 70, 70, [doc], proj, () => false),
    '',
  );
}

// Group drag preserves relative spacing + undo/redo
{
  const { doc, group, a, b } = makeGroupDoc();
  const relX = b.x - a.x;
  const relY = b.y - a.y;
  const leaves = movableLeavesForSelection(singleSelection(group));
  const before = snapshotPositions(leaves);
  moveLeavesBy(leaves, 11, -7);
  log('group-move-relative', b.x - a.x === relX && b.y - a.y === relY, `${b.x - a.x},${b.y - a.y}`);
  const after = snapshotPositions(leaves);
  const hist = new History();
  hist.exec({
    label: 'Move',
    do: () => {
      after.forEach(([n, x, y]) => {
        n.x = x;
        n.y = y;
      });
    },
    undo: () => {
      before.forEach(([n, x, y]) => {
        n.x = x;
        n.y = y;
      });
    },
  });
  hist.undo();
  log('group-move-undo', a.x === 20 && b.x === 100, `${a.x},${b.x}`);
  hist.redo();
  log('group-move-redo', a.x === 31 && b.x === 111, `${a.x},${b.x}`);
}

// Nested group: movable leaves include nested raster
{
  const inner = fill('Inner', 5, 5, 30, 30, '#abc');
  const doc = importLayers([
    fill('BG', 0, 0, 200, 200, '#fff'),
    {
      name: 'Outer',
      opened: true,
      children: [fill('L', 40, 40, 30, 30, '#111'), { name: 'InnerG', opened: true, children: [inner], blendMode: 'pass through' }],
      blendMode: 'pass through',
    },
  ]);
  const outer = doc.roots[1]!;
  const innerGroup = outer.children[1]!;
  const leaves = leavesForPositionEdit(outer);
  log('nested-leaves-count', leaves.length === 2, String(leaves.length));
  log(
    'nested-group-chrome-in-bounds',
    hitTestCanvasGroupChrome(ctx(doc), 15, 15)?.name === 'Outer',
    hitTestCanvasGroupChrome(ctx(doc), 15, 15)?.name ?? 'null',
  );
  log(
    'alt-select-outer-from-inner-leaf',
    hitTestCanvasClickTarget(ctx(doc), 50, 50, { preferGroup: true })?.name === 'Outer',
    hitTestCanvasClickTarget(ctx(doc), 50, 50, { preferGroup: true })?.name ?? '',
  );
  log(
    'nested-inner-group-alt',
    hitTestCanvasClickTarget(ctx(doc), 20, 20, { preferGroup: true })?.name === 'InnerG',
    hitTestCanvasClickTarget(ctx(doc), 20, 20, { preferGroup: true })?.name ?? '',
  );
}

// Locked group: chrome miss
{
  const { doc, group } = makeGroupDoc();
  group.locked = true;
  log('locked-group-no-chrome', hitTestCanvasGroupChrome(ctx(doc), 70, 70) === null, '');
}

// Cross-doc multi-select unchanged (Phase 5 regression)
{
  const d1 = importLayers([fill('X', 10, 10, 20, 20, '#f00')]);
  const d2 = importLayers([fill('Y', 10, 10, 20, 20, '#00f')]);
  let sel = replaceSelection(d1.roots[0]!);
  sel = toggleNodeInSelection(sel, d2.roots[0]!, [d1, d2]);
  log('cross-doc-two-selected', sel.nodes.length === 2, String(sel.nodes.length));
}

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`${failures.length} of ${results.length} canvas group interaction tests failed`);
  process.exit(1);
}
console.log(`All ${results.length} canvas group interaction tests passed`);

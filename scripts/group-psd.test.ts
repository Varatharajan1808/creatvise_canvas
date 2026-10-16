/**
 * PSD group/ungroup: model + ag-psd sync, sibling order, leaf geometry, undo/redo, rollback.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';
import { importPsd } from '../src/psd/psd';
import { History } from '../src/core/history';
import { walk, type Doc } from '../src/core/model';
import {
  groupCreateCommand,
  groupUngroupCommand,
  planGroupCreation,
  planUngroup,
  executeGroupCreation,
} from '../src/operations/groupOps';
import {
  applyCreateGroup,
  assertModelSourceTreeInSync,
  sourceRemove,
} from '../src/core/sourceTree';

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

const W = 80;
const H = 80;

function fillLayer(name: string, css: string, extra: Partial<Layer> = {}): Layer {
  const c = createCanvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, W, H);
  return { name, left: 0, top: 0, right: W, bottom: H, canvas: c as unknown as HTMLCanvasElement, ...extra };
}

function buildDoc(children: Layer[]): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = createCanvas(W, H) as unknown as HTMLCanvasElement;
  return importPsd('group-psd.psd', writePsd(psd));
}

function leafGeom(doc: Doc): Map<string, { x: number; y: number; w: number; h: number }> {
  const m = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') continue;
    m.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
  }
  return m;
}

function geomEqual(a: Map<string, { x: number; y: number; w: number; h: number }>, b: Map<string, { x: number; y: number; w: number; h: number }>) {
  if (a.size !== b.size) return false;
  for (const [id, g] of a) {
    const h = b.get(id);
    if (!h || h.x !== g.x || h.y !== g.y || h.w !== g.w || h.h !== g.h) return false;
  }
  return true;
}

const rootNames = (doc: Doc) => doc.roots.map((n) => n.name).join(',');
const psdNames = (doc: Doc) => (doc.psd!.children ?? []).map((l) => l.name).join(',');

// --- non-contiguous root group (A, B, C) select A + C ---
{
  const doc = buildDoc([
    fillLayer('A', '#ff0000'),
    fillLayer('B', '#00ff00'),
    fillLayer('C', '#0000ff'),
  ]);
  const before = leafGeom(doc);
  const planned = planGroupCreation(doc, [doc.roots[0]!, doc.roots[2]!]);
  log('plan-non-contiguous', planned.ok === true, '');
  if (planned.ok) {
    const hist = new History();
    hist.exec(groupCreateCommand(planned.plan));
    log('after-group-root-names', rootNames(doc) === 'Group,B', rootNames(doc));
    log('group-at-min-index', doc.roots[0]!.kind === 'group' && doc.roots[0]!.name === 'Group', doc.roots[0]?.name ?? '');
    log('group-children-order', doc.roots[0]!.children.map((n) => n.name).join(',') === 'A,C', doc.roots[0]!.children.map((n) => n.name).join(','));
    log('psd-sync-after-group', assertModelSourceTreeInSync(doc), psdNames(doc));
    log('geometry-preserved-group', geomEqual(before, leafGeom(doc)), '');
    hist.undo();
    log('undo-root-order', rootNames(doc) === 'A,B,C', rootNames(doc));
    log('psd-sync-after-undo-group', assertModelSourceTreeInSync(doc), psdNames(doc));
    log('geometry-preserved-undo-group', geomEqual(before, leafGeom(doc)), '');
    hist.redo();
    log('redo-group-exists', doc.roots.some((n) => n.kind === 'group'), rootNames(doc));
  }
}

// --- nested group: group two inner siblings inside existing folder ---
{
  const innerA = fillLayer('InnerA', '#ff0000');
  const innerB = fillLayer('InnerB', '#0000ff');
  const innerC = fillLayer('InnerC', '#00ff00');
  const folderLayer: Layer = { name: 'Folder', opened: true, children: [innerA, innerB, innerC] };
  const doc = buildDoc([fillLayer('BG', '#ffffff'), folderLayer]);
  const folder = doc.roots[1]!;
  const before = leafGeom(doc);
  const planned = planGroupCreation(doc, [folder.children[0]!, folder.children[2]!]);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    const innerNames = folder.children.map((n) => (n.kind === 'group' ? `G(${n.children.map((c) => c.name).join('+')})` : n.name)).join(',');
    log('nested-reparent', innerNames.includes('G(InnerA+InnerC)'), innerNames);
    log('nested-psd-sync', assertModelSourceTreeInSync(doc), (folder.src.children ?? []).map((l) => l.name).join(','));
    log('nested-geometry', geomEqual(before, leafGeom(doc)), '');
    const ung = planUngroup(doc, planned.plan.group);
    if (ung.ok) {
      const hist = new History();
      hist.exec(groupUngroupCommand(ung.plan));
      log('ungroup-inner-order', folder.children.map((n) => n.name).join(',') === 'InnerA,InnerB,InnerC', folder.children.map((n) => n.name).join(','));
      log('ungroup-psd-sync', assertModelSourceTreeInSync(doc), '');
      hist.undo();
      log('undo-regroup', folder.children.some((n) => n.kind === 'group'), '');
      hist.redo();
      log('redo-ungroup', folder.children.every((n) => n.kind !== 'group'), folder.children.map((n) => n.name).join(','));
    }
  } else {
    log('nested-plan', false, 'plan failed');
  }
}

// --- failed operation rollback (stale plan indices) ---
{
  const doc = buildDoc([fillLayer('L1', '#111'), fillLayer('L2', '#222')]);
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    const removed = doc.roots[0]!;
    doc.roots.splice(0, 1);
    sourceRemove(doc, removed);
    let threw = false;
    try {
      applyCreateGroup(planned.plan);
    } catch {
      threw = true;
    }
    log('rollback-on-failure', threw && assertModelSourceTreeInSync(doc) && rootNames(doc) === 'L2', rootNames(doc));
  }
}

// --- source references not cloned ---
{
  const doc = buildDoc([fillLayer('S1', '#aaa'), fillLayer('S2', '#bbb')]);
  const srcBefore = doc.roots.map((n) => n.src);
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    const group = doc.roots.find((n) => n.kind === 'group')!;
    const refs = group.children.map((n) => n.src);
    log('same-src-refs', refs[0] === srcBefore[0] && refs[1] === srcBefore[1], '');
    log('src-still-on-psd-tree', (group.src.children ?? []).length === 2, '');
  }
}

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`${failures.length} of ${results.length} group-psd tests failed`);
  process.exit(1);
}
console.log(`All ${results.length} group-psd tests passed`);

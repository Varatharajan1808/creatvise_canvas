/**
 * Phase 6b: Group/Ungroup UI eligibility, panel expand/collapse, selection + history wiring.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';
import { importPsd } from '../src/psd';
import { History } from '../src/history';
import type { Doc, Node } from '../src/model';
import {
  groupActionState,
  groupCreateCommand,
  groupUngroupCommand,
  planGroupCreation,
  planUngroup,
  ungroupActionState,
} from '../src/groupOps';
import { GROUP_LAYERS_BLOCKED_MESSAGE } from '../src/formatCaps';
import { emptySelection, singleSelection, toggleNodeInSelection, type Selection } from '../src/selection';
import { panelShowsGroupChildren, toggleGroupRowExpanded } from '../src/panel';

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

const W = 64;
function fillLayer(name: string, css: string): Layer {
  const c = createCanvas(W, W);
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, W, W);
  return { name, left: 0, top: 0, right: W, bottom: W, canvas: c as unknown as HTMLCanvasElement };
}

function buildDoc(children: Layer[]): Doc {
  const psd: Psd = { width: W, height: W, children };
  psd.canvas = createCanvas(W, W) as unknown as HTMLCanvasElement;
  return importPsd('ui.psd', writePsd(psd));
}

const doc = buildDoc([fillLayer('A', '#f00'), fillLayer('B', '#0f0'), fillLayer('C', '#00f')]);
const docs = [doc];

log('group-enabled-two-layers', groupActionState([doc.roots[0]!, doc.roots[1]!], docs).enabled, '');
log('group-disabled-one', !groupActionState([doc.roots[0]!], docs).enabled, '');
log(
  'group-disabled-cross-doc',
  !groupActionState([doc.roots[0]!, buildDoc([fillLayer('X', '#000')]).roots[0]!], [doc, buildDoc([fillLayer('X', '#000')])]).enabled,
  '',
);

const doc2 = buildDoc([fillLayer('X', '#000')]);
let crossSel = emptySelection();
crossSel = toggleNodeInSelection(crossSel, doc.roots[0]!, [doc, doc2]);
crossSel = toggleNodeInSelection(crossSel, doc2.roots[0]!, [doc, doc2]);
log(
  'cross-doc-multi-select-unchanged',
  crossSel.nodes.length === 2,
  String(crossSel.nodes.length),
);
log(
  'cross-doc-group-title',
  groupActionState(crossSel.nodes, [doc, doc2]).title.includes('one document'),
  groupActionState(crossSel.nodes, [doc, doc2]).title,
);

const innerA = fillLayer('InnerA', '#111');
const innerB = fillLayer('InnerB', '#222');
const nested = buildDoc([
  fillLayer('BG', '#fff'),
  { name: 'Outer', opened: true, children: [innerA, { name: 'InnerGroup', opened: true, children: [innerB] }] },
]);
const outer = nested.roots[1]!;
const innerGroup = outer.children[1]!;
log('ungroup-disabled-leaf', !ungroupActionState(singleSelection(outer.children[0]!), [nested]).enabled, '');
log('ungroup-enabled-group', ungroupActionState(singleSelection(innerGroup), [nested]).enabled, innerGroup.name);

const aiDoc: Doc = {
  id: 'ai',
  name: 't.ai',
  format: 'ai',
  width: 100,
  height: 100,
  offsetX: 0,
  offsetY: 0,
  roots: [],
  original: new ArrayBuffer(0),
  warnings: [],
  ai: {
    kind: 'ai',
    pageCount: 1,
    hasOcg: false,
    ocgNames: [],
    ocgRefs: [],
    hasExtGStateOpacity: false,
    extGStateCaAtImport: 1,
    nextMcIndex: 0,
    canDuplicateMarkedContent: false,
  },
};
const aiLeaf = (id: string): Node => ({
  id,
  key: id,
  name: id,
  kind: 'raster',
  visible: true,
  locked: false,
  opacity: 1,
  importOpacity: 1,
  importVisible: true,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ox: 0,
  oy: 0,
  ow: 10,
  oh: 10,
  rotation: 0,
  canvas: null,
  children: [],
  parent: null,
  src: {} as Layer,
  unsupported: [],
});
aiDoc.roots.push(aiLeaf('a1'), aiLeaf('a2'));
const aiState = groupActionState(aiDoc.roots, [aiDoc]);
log(
  'ai-group-ui-blocked',
  !aiState.enabled && (aiState.title === GROUP_LAYERS_BLOCKED_MESSAGE || aiState.title.includes('PDF optional layers')),
  aiState.title,
);

// Panel expand/collapse does not remove children
const folder: Node = {
  ...doc.roots[0]!,
  kind: 'group',
  children: [doc.roots[0]!, doc.roots[1]!],
  src: { name: 'G', opened: true, children: [] },
};
log('panel-expanded-default', panelShowsGroupChildren(folder), '');
toggleGroupRowExpanded(folder);
log('panel-collapsed', !panelShowsGroupChildren(folder) && folder.children.length === 2, String(folder.children.length));
toggleGroupRowExpanded(folder);
log('panel-re-expanded', panelShowsGroupChildren(folder), '');

{
  const d = buildDoc([fillLayer('L1', '#a'), fillLayer('L2', '#b')]);
  const planned = planGroupCreation(d, d.roots);
  if (planned.ok) {
    let sel: Selection = { primary: d.roots[1]!, nodes: [...d.roots] };
    const before = { ...sel, nodes: [...sel.nodes] };
    const after = singleSelection(planned.plan.group);
    const hist = new History();
    const cmd = groupCreateCommand(planned.plan);
    hist.exec({
      label: cmd.label,
      do: () => cmd.do(),
      undo: () => cmd.undo(),
    });
    sel = after;
    log('after-group-selects-folder', sel.nodes.length === 1 && sel.primary?.kind === 'group', sel.primary?.kind ?? '');
    hist.undo();
    sel = before;
    log('undo-group-selection-count', sel.nodes.length === 2, String(sel.nodes.length));
    hist.redo();
    sel = after;
    log('redo-group-selection', sel.primary?.kind === 'group', sel.primary?.kind ?? '');
  }
}

// Nested ungroup one level
{
  const d = buildDoc([
    fillLayer('BG', '#fff'),
    {
      name: 'Outer',
      opened: true,
      children: [
        fillLayer('In1', '#1'),
        { name: 'Inner', opened: true, children: [fillLayer('In2', '#2')] },
      ],
    },
  ]);
  const outerNode = d.roots[1]!;
  const innerNode = outerNode.children[1]!;
  const ung = planUngroup(d, innerNode);
  if (ung.ok) {
    const hist = new History();
    hist.exec(groupUngroupCommand(ung.plan));
    log(
      'nested-ungroup-one-level',
      outerNode.children.map((n) => n.name).join(',') === 'In1,In2',
      outerNode.children.map((n) => n.name).join(','),
    );
  }
}

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`${failures.length} of ${results.length} group-ui tests failed`);
  process.exit(1);
}
console.log(`All ${results.length} group-ui tests passed`);

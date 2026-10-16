/**
 * Group selection validation: same parent, cross-doc rejection, ancestor/descendant normalization, duplicates.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';
import { importPsd } from '../src/psd/psd';
import type { Doc, Node } from '../src/core/model';
import {
  normalizeGroupSelection,
  validateGroupCreation,
  validateUngroup,
} from '../src/operations/groupOps';
import { canGroupLayers } from '../src/formats/formatCaps';
import { emptySelection, toggleNodeInSelection } from '../src/canvas/selection';

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
const H = 64;

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
  return importPsd('group-sel.psd', writePsd(psd));
}

const doc = buildDoc([
  fillLayer('A', '#ff0000'),
  fillLayer('B', '#00ff00'),
  fillLayer('C', '#0000ff'),
]);
const docs = [doc];

log('psd-can-group', canGroupLayers(doc), 'psd');
log('valid-two-siblings', validateGroupCreation([doc.roots[0]!, doc.roots[2]!], docs).ok === true, 'A+C');
log(
  'reject-single',
  validateGroupCreation([doc.roots[0]!], docs).ok === false,
  validateGroupCreation([doc.roots[0]!], docs).ok ? '' : (validateGroupCreation([doc.roots[0]!], docs) as { reason: string }).reason,
);

const dup = validateGroupCreation([doc.roots[0]!, doc.roots[0]!], docs);
log('reject-duplicate-node', dup.ok === false, dup.ok ? '' : dup.reason);

// nested: group with inner layers
const inner1 = fillLayer('Inner1', '#111111');
const inner2 = fillLayer('Inner2', '#222222');
const nestedDoc = buildDoc([
  fillLayer('BG', '#ffffff'),
  { name: 'Folder', opened: true, children: [inner1, inner2] },
]);
const folder = nestedDoc.roots[1]!;
const child0 = folder.children[0]!;
const child1 = folder.children[1]!;
log(
  'valid-nested-siblings',
  validateGroupCreation([child0, child1], [nestedDoc]).ok === true,
  'inner pair',
);
const ancestorPick = validateGroupCreation([folder, child0], [nestedDoc]);
log(
  'normalize-ancestor-descendant',
  ancestorPick.ok === false,
  ancestorPick.ok ? '' : ancestorPick.reason,
);
const normalized = normalizeGroupSelection([folder, child0, child1]);
log('normalize-keeps-ancestor-only', normalized.length === 1 && normalized[0] === folder, normalized.map((n) => n.name).join(','));

// cross-document (multi-select allowed; grouping rejected)
const doc2 = buildDoc([fillLayer('X', '#abcdef')]);
const cross = validateGroupCreation([doc.roots[0]!, doc2.roots[0]!], [doc, doc2]);
log('reject-cross-document', cross.ok === false, cross.ok ? '' : cross.reason);

// multi-select regression: cross-doc toggle still works
let sel = emptySelection();
sel = toggleNodeInSelection(sel, doc.roots[0]!, [doc, doc2]);
sel = toggleNodeInSelection(sel, doc2.roots[0]!, [doc, doc2]);
log('cross-doc-selection-still-allowed', sel.nodes.length === 2, String(sel.nodes.length));

// AI grouping blocked
const aiDoc: Doc = {
  id: 'ai1',
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
const leaf: Node = {
  id: 'l1',
  key: 'l1',
  name: 'L1',
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
};
aiDoc.roots.push(leaf, { ...leaf, id: 'l2', key: 'l2', name: 'L2' });
log('ai-group-blocked', !canGroupLayers(aiDoc), 'ai');
const aiVal = validateGroupCreation(aiDoc.roots, [aiDoc]);
log(
  'ai-validate-fails',
  aiVal.ok === false && (aiVal.reason.includes('PSD') || aiVal.reason.includes('PDF')),
  aiVal.ok ? '' : aiVal.reason,
);

// ungroup validation
const ung = validateUngroup(folder, [nestedDoc]);
log('ungroup-valid-group', ung.ok === true, folder.name);
log('ungroup-rejects-leaf', validateUngroup(nestedDoc.roots[0]!, [nestedDoc]).ok === false, 'BG');

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`${failures.length} of ${results.length} group-selection tests failed`);
  process.exit(1);
}
console.log(`All ${results.length} group-selection tests passed`);

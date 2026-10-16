/**
 * AI Group UI & Operations tests: validation, planning, execution, undo/redo, action states.
 */
import type { Doc, Node } from '../src/model';
import type { Layer } from 'ag-psd';
import {
  validateAiGroupCreation,
  validateAiUngroup,
  planAiGroupCreation,
  planAiUngroup,
  executeAiGroupCreation,
  executeAiUngroup,
  aiGroupCreateCommand,
  aiUngroupCommand,
  aiGroupActionState,
  aiUngroupActionState,
  createAiGroupNode,
} from '../src/aiGroupOps';
import { singleSelection } from '../src/selection';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

function makeLeaf(id: string, name: string, opts: Partial<Node> = {}): Node {
  return {
    id,
    key: `ocg-${id}`,
    name,
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 50,
    h: 50,
    ox: 0,
    oy: 0,
    ow: 50,
    oh: 50,
    rotation: 0,
    canvas: null,
    children: [],
    parent: null,
    src: { name, opened: true, children: [] } as unknown as Layer,
    unsupported: [],
    ...opts,
  };
}

function makeAiDoc(roots: Node[] = [], hasOcg = true): Doc {
  const doc: Doc = {
    id: 'ai-doc-1',
    name: 'test.ai',
    format: 'ai',
    width: 500,
    height: 500,
    offsetX: 0,
    offsetY: 0,
    roots,
    original: new ArrayBuffer(10),
    warnings: [],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg,
      ocgNames: roots.map((r) => r.name),
      ocgRefs: roots.map((_, i) => `${i + 5} 0 R`),
      hasExtGStateOpacity: true,
      extGStateCaAtImport: 1,
      nextMcIndex: roots.length,
      canDuplicateMarkedContent: true,
    },
  };
  for (const r of roots) r.parent = null;
  return doc;
}

// 1. Validation tests
const l1 = makeLeaf('1', 'Layer 1');
const l2 = makeLeaf('2', 'Layer 2');
const l3 = makeLeaf('3', 'Layer 3');
const doc = makeAiDoc([l1, l2, l3]);

// Single node rejected
const singleVal = validateAiGroupCreation([l1], [doc]);
assert('reject-single', !singleVal.ok && singleVal.reason.includes('at least two'), singleVal.ok ? '' : singleVal.reason);

// Non-OCG doc rejected
const noOcgDoc = makeAiDoc([makeLeaf('a', 'A'), makeLeaf('b', 'B')], false);
const noOcgVal = validateAiGroupCreation(noOcgDoc.roots, [noOcgDoc]);
assert('reject-no-ocg', !noOcgVal.ok && noOcgVal.reason.includes('no PDF optional layers'), noOcgVal.ok ? '' : noOcgVal.reason);

// Cross doc rejected
const docB = makeAiDoc([makeLeaf('b1', 'B1'), makeLeaf('b2', 'B2')]);
docB.id = 'ai-doc-2';
const crossVal = validateAiGroupCreation([doc.roots[0]!, docB.roots[0]!], [doc, docB]);
assert('reject-cross-doc', !crossVal.ok && crossVal.reason.includes('single file'), crossVal.ok ? '' : crossVal.reason);

// Non-contiguous nodes rejected
const nonContigVal = validateAiGroupCreation([l1, l3], [doc]);
assert('reject-non-contiguous', !nonContigVal.ok && nonContigVal.reason.includes('non-contiguous'), nonContigVal.ok ? '' : nonContigVal.reason);

// Locked layer rejected
const lockedLeaf = makeLeaf('locked', 'Locked', { locked: true });
const docWithLock = makeAiDoc([lockedLeaf, makeLeaf('other', 'Other')]);
const lockedVal = validateAiGroupCreation(docWithLock.roots, [docWithLock]);
assert('reject-locked', !lockedVal.ok && lockedVal.reason.includes('Locked'), lockedVal.ok ? '' : lockedVal.reason);

// Valid contiguous group
const validVal = validateAiGroupCreation([l1, l2], [doc]);
assert('accept-valid-contiguous', validVal.ok && validVal.nodes.length === 2, validVal.ok ? 'valid' : validVal.reason);

// 2. Planning and Execution
const planResult = planAiGroupCreation(doc, [l1, l2], 'MyGroup');
assert('plan-ok', planResult.ok, planResult.ok ? 'plan created' : planResult.reason);

if (planResult.ok) {
  const plan = planResult.plan;
  executeAiGroupCreation(plan);
  assert('execute-group-roots-count', doc.roots.length === 2, `roots=${doc.roots.length}`);
  assert('execute-group-name', doc.roots[0]!.name === 'MyGroup' && doc.roots[0]!.kind === 'group', doc.roots[0]!.name);
  assert('execute-group-children-count', doc.roots[0]!.children.length === 2, `children=${doc.roots[0]!.children.length}`);
  assert('execute-children-parent-pointer', l1.parent === doc.roots[0]! && l2.parent === doc.roots[0]!, 'parents set');

  // Ungroup validation & execution
  const groupNode = doc.roots[0]!;
  const ungroupVal = validateAiUngroup(groupNode, [doc]);
  assert('validate-ungroup-ok', ungroupVal.ok, ungroupVal.ok ? 'valid' : ungroupVal.reason);

  const ungroupPlan = planAiUngroup(doc, groupNode);
  assert('plan-ungroup-ok', ungroupPlan.ok, ungroupPlan.ok ? 'ungroup planned' : ungroupPlan.reason);

  if (ungroupPlan.ok) {
    executeAiUngroup(ungroupPlan.plan);
    assert('execute-ungroup-roots-count', doc.roots.length === 3, `roots=${doc.roots.length}`);
    assert('execute-ungroup-order', doc.roots[0] === l1 && doc.roots[1] === l2 && doc.roots[2] === l3, 'original order restored');
    assert('execute-ungroup-parent-null', l1.parent === null && l2.parent === null, 'parents reset to null');
  }
}

// 3. Command Undo/Redo
const freshDoc = makeAiDoc([makeLeaf('x1', 'X1'), makeLeaf('x2', 'X2')]);
const freshPlan = planAiGroupCreation(freshDoc, freshDoc.roots, 'CommandGroup');
if (freshPlan.ok) {
  const cmd = aiGroupCreateCommand(freshPlan.plan);
  cmd.do();
  assert('cmd-do-groups', freshDoc.roots.length === 1 && freshDoc.roots[0]!.kind === 'group', 'grouped');
  cmd.undo();
  assert('cmd-undo-ungroups', freshDoc.roots.length === 2 && freshDoc.roots[0]!.kind === 'raster', 'ungrouped');
}

// 4. Action states
const stateDoc = makeAiDoc([makeLeaf('s1', 'S1'), makeLeaf('s2', 'S2')]);
const groupState = aiGroupActionState(stateDoc.roots, [stateDoc]);
assert('action-state-group-enabled', groupState.enabled, groupState.title);

const ungroupStateEmpty = aiUngroupActionState(singleSelection(stateDoc.roots[0]!), [stateDoc]);
assert('action-state-ungroup-disabled-for-leaf', !ungroupStateEmpty.enabled, ungroupStateEmpty.title);

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.error(`${failures.length} of ${results.length} ai-group-ui checks failed!`);
  process.exit(1);
} else {
  console.log(`All ${results.length} ai-group-ui checks passed!`);
}

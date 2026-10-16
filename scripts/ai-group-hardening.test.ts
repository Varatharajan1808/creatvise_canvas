/**
 * AI Group hardening tests: nested grouping, stack mutation detection, ancestor normalization,
 * undo/redo cycling, and defensive edge cases.
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
  normalizeAiGroupSelection,
  createAiGroupNode,
} from '../src/aiGroupOps';

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

function makeAiDoc(roots: Node[] = []): Doc {
  return {
    id: 'ai-hardening-doc',
    name: 'hardening.ai',
    format: 'ai',
    width: 600,
    height: 600,
    offsetX: 0,
    offsetY: 0,
    roots,
    original: new ArrayBuffer(16),
    warnings: [],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: true,
      ocgNames: roots.map((r) => r.name),
      ocgRefs: roots.map((_, i) => `${i + 5} 0 R`),
      hasExtGStateOpacity: true,
      extGStateCaAtImport: 1,
      nextMcIndex: 10,
      canDuplicateMarkedContent: true,
    },
  };
}

// 1. Ancestor / Descendant Selection Normalization
const parentGroup = createAiGroupNode('ParentGroup');
const childA = makeLeaf('cA', 'Child A');
const childB = makeLeaf('cB', 'Child B');
childA.parent = parentGroup;
childB.parent = parentGroup;
parentGroup.children = [childA, childB];

const normalized = normalizeAiGroupSelection([parentGroup, childA, childB]);
assert('normalize-ancestor-descendant', normalized.length === 1 && normalized[0] === parentGroup, 'kept only ancestor');

// 2. Nested Group Creation
const n1 = makeLeaf('n1', 'Node 1');
const n2 = makeLeaf('n2', 'Node 2');
const n3 = makeLeaf('n3', 'Node 3');
const n4 = makeLeaf('n4', 'Node 4');
const doc = makeAiDoc([n1, n2, n3, n4]);

// Group n2 and n3
const plan1 = planAiGroupCreation(doc, [n2, n3], 'InnerGroup');
assert('plan-inner-group', plan1.ok, plan1.ok ? 'ok' : plan1.reason);
if (plan1.ok) {
  executeAiGroupCreation(plan1.plan);
  const innerGroup = doc.roots[1]!;
  assert('inner-group-created', innerGroup.name === 'InnerGroup' && doc.roots.length === 3, `roots=${doc.roots.length}`);

  // Group n1 and innerGroup (contiguous group of a leaf and a group)
  const plan2 = planAiGroupCreation(doc, [doc.roots[0]!, innerGroup], 'OuterGroup');
  assert('plan-outer-group', plan2.ok, plan2.ok ? 'ok' : plan2.reason);
  if (plan2.ok) {
    executeAiGroupCreation(plan2.plan);
    const outerGroup = doc.roots[0]!;
    assert('outer-group-created', outerGroup.name === 'OuterGroup' && doc.roots.length === 2, `roots=${doc.roots.length}`);
    assert('nested-structure-depth', outerGroup.children[1] === innerGroup && innerGroup.children.length === 2, 'depth 2 verified');

    // Ungroup outer group
    const ungroupOuterPlan = planAiUngroup(doc, outerGroup);
    assert('ungroup-outer-plan', ungroupOuterPlan.ok, ungroupOuterPlan.ok ? 'ok' : ungroupOuterPlan.reason);
    if (ungroupOuterPlan.ok) {
      executeAiUngroup(ungroupOuterPlan.plan);
      assert('ungroup-outer-done', doc.roots.length === 3 && doc.roots[1] === innerGroup, 'inner group remains intact');

      // Ungroup inner group
      const ungroupInnerPlan = planAiUngroup(doc, innerGroup);
      assert('ungroup-inner-plan', ungroupInnerPlan.ok, ungroupInnerPlan.ok ? 'ok' : ungroupInnerPlan.reason);
      if (ungroupInnerPlan.ok) {
        executeAiUngroup(ungroupInnerPlan.plan);
        assert('all-ungrouped-flat', doc.roots.length === 4 && doc.roots[0] === n1 && doc.roots[1] === n2 && doc.roots[2] === n3 && doc.roots[3] === n4, 'fully flat');
      }
    }
  }
}

// 3. Stack Mutation Detection (defensive check)
const m1 = makeLeaf('m1', 'M1');
const m2 = makeLeaf('m2', 'M2');
const mutDoc = makeAiDoc([m1, m2]);
const mutPlan = planAiGroupCreation(mutDoc, [m1, m2], 'MutGroup');
if (mutPlan.ok) {
  // Tamper with stack before execution
  mutDoc.roots.reverse();
  let threw = false;
  try {
    executeAiGroupCreation(mutPlan.plan);
  } catch (e) {
    threw = true;
  }
  assert('stack-mutation-throws', threw, 'threw error on modified stack');
}

// 4. Repeated Undo/Redo Cycles
const u1 = makeLeaf('u1', 'U1');
const u2 = makeLeaf('u2', 'U2');
const undoDoc = makeAiDoc([u1, u2]);
const cmdPlan = planAiGroupCreation(undoDoc, [u1, u2], 'CycleGroup');
if (cmdPlan.ok) {
  const cmd = aiGroupCreateCommand(cmdPlan.plan);
  for (let cycle = 0; cycle < 3; cycle++) {
    cmd.do();
    assert(`cycle-${cycle}-do`, undoDoc.roots.length === 1 && undoDoc.roots[0]!.kind === 'group', 'grouped');
    cmd.undo();
    assert(`cycle-${cycle}-undo`, undoDoc.roots.length === 2 && undoDoc.roots[0] === u1 && undoDoc.roots[1] === u2, 'restored');
  }
}

// 5. Empty Group Ungroup Rejection
const emptyGrp = createAiGroupNode('Empty');
const emptyDoc = makeAiDoc([emptyGrp]);
const emptyUngroupVal = validateAiUngroup(emptyGrp, [emptyDoc]);
assert('reject-empty-ungroup', !emptyUngroupVal.ok && emptyUngroupVal.reason.includes('empty folder'), emptyUngroupVal.ok ? '' : emptyUngroupVal.reason);

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.error(`${failures.length} of ${results.length} ai-group-hardening checks failed!`);
  process.exit(1);
} else {
  console.log(`All ${results.length} ai-group-hardening checks passed!`);
}

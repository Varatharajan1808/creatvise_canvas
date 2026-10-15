import type { Layer } from 'ag-psd';
import type { Doc, Node } from './model';
import { docOf, isLocked } from './model';
import type { Selection } from './selection';
import type { Command } from './history';
import { isAiDuplicateLayer } from './aiLayerMeta';
import { nodeSiblingsForParent } from './sourceTree';

let aiGroupUid = 0;

export function nextAiGroupNodeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `ai_g_${crypto.randomUUID().slice(0, 8)}`
    : `ai_g_${Date.now().toString(36)}_${(++aiGroupUid).toString(36)}`;
}

export function createAiGroupLayer(name: string): Layer {
  return { name, opened: true, children: [], blendMode: 'pass through' };
}

export function createAiGroupNode(name = 'Group'): Node {
  const src = createAiGroupLayer(name);
  aiGroupUid += 1;
  return {
    id: nextAiGroupNodeId(),
    key: `ai-group/${aiGroupUid}`,
    name,
    kind: 'group',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    ow: 0,
    oh: 0,
    ox: 0,
    oy: 0,
    canvas: null,
    children: [],
    parent: null,
    src,
    unsupported: [],
    importPreviewContentEpoch: 0,
    previewContentEpoch: 0,
  };
}

export interface AiGroupCreatePlan {
  doc: Doc;
  parent: Node | null;
  group: Node;
  groupIndex: number;
  children: Node[];
}

export interface AiUngroupPlan {
  doc: Doc;
  group: Node;
  parent: Node | null;
  groupIndex: number;
  children: Node[];
  recreatePlan?: AiGroupCreatePlan;
}

export const aiGroupOriginPlans = new WeakMap<Node, AiGroupCreatePlan>();

export function normalizeAiGroupSelection(nodes: Node[]): Node[] {
  const set = new Set(nodes);
  return nodes.filter((n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (set.has(p)) return false;
    }
    return true;
  });
}

function uniqueNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const out: Node[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

export type AiGroupValidationResult =
  | { ok: true; nodes: Node[]; doc: Doc }
  | { ok: false; reason: string };

export function validateAiGroupCreation(nodes: Node[], docs: Doc[]): AiGroupValidationResult {
  const unique = uniqueNodes(nodes);
  const normalized = normalizeAiGroupSelection(unique);
  if (normalized.length < 2) {
    return { ok: false, reason: 'Select at least two layers in the same folder to group.' };
  }

  let doc: Doc | null = null;
  for (const n of normalized) {
    const d = docOf(n, docs);
    if (!d) return { ok: false, reason: 'One or more layers are not in an open document.' };
    if (doc && d !== doc) {
      return { ok: false, reason: 'Grouping works within one document. Select layers from a single file.' };
    }
    doc = d;
  }

  if (!doc || doc.format !== 'ai' || !doc.ai) {
    return { ok: false, reason: 'Grouping is not supported for this document.' };
  }

  if (!doc.ai.hasOcg) {
    return { ok: false, reason: 'This file has no PDF optional layers (OCG); grouping is not available.' };
  }

  const parent = normalized[0]!.parent;
  if (!normalized.every((n) => n.parent === parent)) {
    return { ok: false, reason: 'Selected layers must share the same parent folder.' };
  }

  const siblings = nodeSiblingsForParent(doc, parent);
  for (const n of normalized) {
    if (!siblings.includes(n)) {
      return { ok: false, reason: 'Selected layers are not siblings in the layer stack.' };
    }
  }

  // Contiguity check: grouping non-contiguous layers alters layer drawing order and z-order.
  const ordered = [...normalized].sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
  for (let i = 1; i < ordered.length; i++) {
    const prevIdx = siblings.indexOf(ordered[i - 1]!);
    const curIdx = siblings.indexOf(ordered[i]!);
    if (curIdx !== prevIdx + 1) {
      return {
        ok: false,
        reason: 'Grouping non-contiguous layers in Illustrator documents is not supported because it alters layer drawing order.',
      };
    }
  }

  // Locked layers check
  if (normalized.some((n) => isLocked(n))) {
    return { ok: false, reason: 'Locked layers cannot be grouped. Unlock them first.' };
  }

  // Duplicated layers check (unexported duplicates must be exported before grouping)
  if (normalized.some((n) => isAiDuplicateLayer(n))) {
    return { ok: false, reason: 'Duplicated layers must be exported before grouping is available.' };
  }

  // Empty group check
  if (normalized.some((n) => n.kind === 'group' && n.children.length === 0)) {
    return { ok: false, reason: 'Cannot group empty folders.' };
  }

  return { ok: true, nodes: ordered, doc };
}

export function validateAiUngroup(group: Node, docs: Doc[]): AiGroupValidationResult {
  const doc = docOf(group, docs);
  if (!doc) return { ok: false, reason: 'Layer is not in an open document.' };
  if (doc.format !== 'ai' || !doc.ai) {
    return { ok: false, reason: 'Ungrouping is not supported for this document.' };
  }
  if (!doc.ai.hasOcg) {
    return { ok: false, reason: 'This file has no PDF optional layers (OCG); ungrouping is not available.' };
  }
  if (group.kind !== 'group') {
    return { ok: false, reason: 'Select a group folder to ungroup.' };
  }
  if (group.children.length === 0) {
    return { ok: false, reason: 'Cannot ungroup an empty folder.' };
  }
  if (isLocked(group)) {
    return { ok: false, reason: 'Locked folders cannot be ungrouped. Unlock them first.' };
  }
  const siblings = nodeSiblingsForParent(doc, group.parent);
  if (!siblings.includes(group)) {
    return { ok: false, reason: 'Group is not in the layer stack.' };
  }

  return { ok: true, nodes: [group], doc };
}

export function planAiGroupCreation(
  doc: Doc,
  nodes: Node[],
  name = 'Group',
): { ok: true; plan: AiGroupCreatePlan } | { ok: false; reason: string } {
  const val = validateAiGroupCreation(nodes, [doc]);
  if (!val.ok) return val;

  const siblings = nodeSiblingsForParent(doc, val.nodes[0]!.parent);
  const ordered = val.nodes;
  const groupIndex = siblings.indexOf(ordered[0]!);
  if (groupIndex < 0) return { ok: false, reason: 'Could not locate selected layers in the stack.' };

  const parent = ordered[0]!.parent;
  const group = createAiGroupNode(name);

  return {
    ok: true,
    plan: {
      doc,
      parent,
      group,
      groupIndex,
      children: ordered,
    },
  };
}

export function planAiUngroup(
  doc: Doc,
  group: Node,
): { ok: true; plan: AiUngroupPlan } | { ok: false; reason: string } {
  const val = validateAiUngroup(group, [doc]);
  if (!val.ok) return val;

  const siblings = nodeSiblingsForParent(doc, group.parent);
  const groupIndex = siblings.indexOf(group);
  if (groupIndex < 0) return { ok: false, reason: 'Group is not in the layer stack.' };

  const recreatePlan: AiGroupCreatePlan = {
    doc,
    parent: group.parent,
    group,
    groupIndex,
    children: [...group.children],
  };

  return {
    ok: true,
    plan: {
      doc,
      group,
      parent: group.parent,
      groupIndex,
      children: [...group.children],
      recreatePlan,
    },
  };
}

export function executeAiGroupCreation(plan: AiGroupCreatePlan): void {
  const { doc, parent, group, groupIndex, children } = plan;
  const siblings = nodeSiblingsForParent(doc, parent);

  for (let i = 0; i < children.length; i++) {
    if (siblings[groupIndex + i] !== children[i]) {
      throw new Error('Group create: layer stack changed since plan was built.');
    }
  }

  siblings.splice(groupIndex, children.length, group);
  if (parent?.src?.children) {
    parent.src.children.splice(groupIndex, children.length, group.src);
  }
  group.parent = parent;
  group.children = [...children];
  group.src.children = children.map((c) => c.src);

  for (const c of children) {
    c.parent = group;
  }

  aiGroupOriginPlans.set(group, plan);
}

export function executeAiUngroup(plan: AiUngroupPlan): void {
  const { doc, group, parent, groupIndex, children } = plan;
  const siblings = nodeSiblingsForParent(doc, parent);

  if (siblings[groupIndex] !== group) {
    throw new Error('Ungroup: group is not at the expected position in the layer stack.');
  }

  siblings.splice(groupIndex, 1, ...children);
  if (parent?.src?.children) {
    parent.src.children.splice(groupIndex, 1, ...children.map((c) => c.src));
  }
  for (const c of children) {
    c.parent = parent;
  }

  group.children = [];
  group.src.children = [];
  group.parent = null;

  aiGroupOriginPlans.delete(group);
}

export function aiGroupCreateCommand(plan: AiGroupCreatePlan): Command {
  return {
    label: 'Group layers',
    do: () => {
      executeAiGroupCreation(plan);
    },
    undo: () => {
      executeAiUngroup({
        doc: plan.doc,
        group: plan.group,
        parent: plan.parent,
        groupIndex: plan.groupIndex,
        children: plan.children,
        recreatePlan: plan,
      });
    },
  };
}

export function aiUngroupCommand(plan: AiUngroupPlan): Command {
  return {
    label: 'Ungroup layers',
    do: () => {
      executeAiUngroup(plan);
    },
    undo: () => {
      const recreate: AiGroupCreatePlan = plan.recreatePlan ?? {
        doc: plan.doc,
        parent: plan.parent,
        group: plan.group,
        groupIndex: plan.groupIndex,
        children: plan.children,
      };
      executeAiGroupCreation(recreate);
    },
  };
}

export function aiGroupActionState(nodes: Node[], docs: Doc[]): { enabled: boolean; title: string } {
  const v = validateAiGroupCreation(nodes, docs);
  return {
    enabled: v.ok,
    title: v.ok ? 'Group selected layers (Ctrl+G)' : v.reason,
  };
}

export function aiUngroupActionState(sel: Selection, docs: Doc[]): { enabled: boolean; title: string } {
  if (sel.nodes.length !== 1) {
    return { enabled: false, title: 'Select a single group folder to ungroup.' };
  }
  const n = sel.primary ?? sel.nodes[0]!;
  const v = validateAiUngroup(n, docs);
  return {
    enabled: v.ok,
    title: v.ok ? 'Ungroup one level (Ctrl+Shift+G)' : v.reason,
  };
}

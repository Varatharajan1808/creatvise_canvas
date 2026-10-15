import type { Layer } from 'ag-psd';
import type { Doc, Node } from './model';
import { docOf, walk } from './model';
import { GROUP_LAYERS_BLOCKED_MESSAGE, canGroupLayers, canUngroupLayer } from './formatCaps';
import type { Selection } from './selection';
import {
  applyCreateGroup,
  applyUngroupGroup,
  assertModelSourceTreeInSync,
  groupOriginPlans,
  nodeSiblings,
  sourceIndex,
  type GroupCreatePlan,
  type UngroupPlan,
} from './sourceTree';
import type { Command } from './history';
import { invalidatePsdPreviewCache } from './psdComposite';
import { refreshPsdPreviewModeAfterEdit } from './psd';
import { validateAiGroupCreation, validateAiUngroup } from './aiGroupOps';

let groupUid = 0;

export function nextGroupNodeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `g_${crypto.randomUUID().slice(0, 8)}`
    : `g_${Date.now().toString(36)}_${(++groupUid).toString(36)}`;
}

export function createGroupLayer(name: string): Layer {
  return { name, opened: true, children: [], blendMode: 'pass through' };
}

export function createGroupNode(doc: Doc, parent: Node | null, name: string, keySuffix: string): Node {
  const src = createGroupLayer(name);
  return {
    id: nextGroupNodeId(),
    key: `group/${keySuffix}`,
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
    parent,
    src,
    unsupported: [],
    importPreviewContentEpoch: 0,
    previewContentEpoch: 0,
  };
}

export type GroupValidationResult =
  | { ok: true; nodes: Node[]; doc: Doc }
  | { ok: false; reason: string };

/** Remove selected descendants when an ancestor is also selected. */
export function normalizeGroupSelection(nodes: Node[]): Node[] {
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

export function validateGroupCreation(nodes: Node[], docs: Doc[]): GroupValidationResult {
  const unique = uniqueNodes(nodes);
  const normalized = normalizeGroupSelection(unique);
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
  if (!doc) {
    return { ok: false, reason: 'Grouping is not supported for this document.' };
  }
  if (doc.format === 'ai') {
    return validateAiGroupCreation(nodes, docs);
  }
  if (!canGroupLayers(doc)) {
    return {
      ok: false,
      reason: GROUP_LAYERS_BLOCKED_MESSAGE,
    };
  }
  const parent = normalized[0]!.parent;
  if (!normalized.every((n) => n.parent === parent)) {
    return { ok: false, reason: 'Selected layers must share the same parent folder.' };
  }
  const siblings = nodeSiblings(doc, normalized[0]!);
  for (const n of normalized) {
    if (!siblings.includes(n)) {
      return { ok: false, reason: 'Selected layers are not siblings in the layer stack.' };
    }
  }
  return { ok: true, nodes: normalized, doc };
}

export type GroupActionState = { enabled: boolean; title: string };

export function groupActionState(nodes: Node[], docs: Doc[]): GroupActionState {
  const v = validateGroupCreation(nodes, docs);
  return {
    enabled: v.ok,
    title: v.ok ? 'Group selected layers (Ctrl+G)' : v.reason,
  };
}

export function ungroupActionState(sel: Selection, docs: Doc[]): GroupActionState {
  if (sel.nodes.length !== 1) {
    return { enabled: false, title: 'Select a single group folder to ungroup.' };
  }
  const n = sel.primary ?? sel.nodes[0]!;
  const v = validateUngroup(n, docs);
  return {
    enabled: v.ok,
    title: v.ok ? 'Ungroup one level (Ctrl+Shift+G)' : v.reason,
  };
}

export function validateUngroup(group: Node, docs: Doc[]): GroupValidationResult {
  const doc = docOf(group, docs);
  if (!doc) return { ok: false, reason: 'Layer is not in an open document.' };
  if (doc.format === 'ai') {
    return validateAiUngroup(group, docs);
  }
  if (!canGroupLayers(doc)) {
    return { ok: false, reason: GROUP_LAYERS_BLOCKED_MESSAGE };
  }
  if (!canUngroupLayer(doc, group)) {
    return { ok: false, reason: 'This layer cannot be ungrouped.' };
  }
  return { ok: true, nodes: [group], doc };
}

function leafGeometrySnapshot(nodes: Node[]): Map<string, { x: number; y: number; w: number; h: number }> {
  const m = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const root of nodes) {
    for (const n of walk([root])) {
      if (n.kind === 'group') continue;
      m.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
    }
  }
  return m;
}

/** Build a group plan (does not mutate the document). */
export function planGroupCreation(
  doc: Doc,
  nodes: Node[],
  name = 'Group',
): { ok: true; plan: GroupCreatePlan; geometry: Map<string, { x: number; y: number; w: number; h: number }> } | { ok: false; reason: string } {
  const siblings = nodeSiblings(doc, nodes[0]!);
  const ordered = [...nodes].sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
  const groupIndex = siblings.indexOf(ordered[0]!);
  if (groupIndex < 0) return { ok: false, reason: 'Could not locate selected layers in the stack.' };
  const parent = ordered[0]!.parent;
  const group = createGroupNode(doc, parent, name, `${Date.now()}_${++groupUid}`);
  const geometry = leafGeometrySnapshot(ordered);
  const plan: GroupCreatePlan = {
    doc,
    parent,
    group,
    groupIndex,
    children: ordered.map((node) => ({
      node,
      modelIndex: siblings.indexOf(node),
      srcIndex: sourceIndex(doc, node),
    })),
  };
  return { ok: true, plan, geometry };
}

export function planUngroup(doc: Doc, group: Node): { ok: true; plan: UngroupPlan } | { ok: false; reason: string } {
  if (group.kind !== 'group') return { ok: false, reason: 'Select a group folder to ungroup.' };
  if (group.children.length === 0) return { ok: false, reason: 'Cannot ungroup an empty folder.' };
  const siblings = nodeSiblings(doc, group);
  const groupIndex = siblings.indexOf(group);
  if (groupIndex < 0) return { ok: false, reason: 'Group is not in the layer stack.' };
  const origin = groupOriginPlans.get(group);
  return {
    ok: true,
    plan: {
      doc,
      group,
      groupIndex,
      groupSrcIndex: sourceIndex(doc, group),
      parent: group.parent,
      children: group.children.map((node, i) => ({
        node,
        indexInGroup: i,
        srcIndexInGroup: sourceIndex(doc, node),
        restoreModelIndex:
          origin?.children.find((c) => c.node === node)?.modelIndex ?? groupIndex + i,
        restoreSrcIndex: origin?.children.find((c) => c.node === node)?.srcIndex,
      })),
      recreatePlan: origin,
    },
  };
}

function afterStructuralEdit(doc: Doc) {
  invalidatePsdPreviewCache(doc);
  refreshPsdPreviewModeAfterEdit(doc);
}

export function groupCreateCommand(plan: GroupCreatePlan): Command {
  return {
    label: 'Group layers',
    do: () => {
      applyCreateGroup(plan);
      if (!assertModelSourceTreeInSync(plan.doc)) {
        throw new Error('PSD layer tree out of sync after grouping.');
      }
      afterStructuralEdit(plan.doc);
    },
    undo: () => {
      applyUngroupGroup({
        doc: plan.doc,
        group: plan.group,
        groupIndex: plan.groupIndex,
        groupSrcIndex: plan.groupIndex,
        parent: plan.parent,
        children: plan.children.map((c, i) => ({
          node: c.node,
          indexInGroup: i,
          srcIndexInGroup: c.srcIndex,
          restoreModelIndex: c.modelIndex,
          restoreSrcIndex: c.srcIndex,
        })),
      });
      if (!assertModelSourceTreeInSync(plan.doc)) {
        throw new Error('PSD layer tree out of sync after undo group.');
      }
      afterStructuralEdit(plan.doc);
    },
  };
}

export function groupUngroupCommand(plan: UngroupPlan): Command {
  return {
    label: 'Ungroup layers',
    do: () => {
      applyUngroupGroup(plan);
      if (!assertModelSourceTreeInSync(plan.doc)) {
        throw new Error('PSD layer tree out of sync after ungroup.');
      }
      afterStructuralEdit(plan.doc);
    },
    undo: () => {
      const recreate: GroupCreatePlan = plan.recreatePlan ?? {
        doc: plan.doc,
        parent: plan.parent,
        group: plan.group,
        groupIndex: plan.groupIndex,
        children: plan.children.map((c) => ({
          node: c.node,
          modelIndex: c.restoreModelIndex ?? plan.groupIndex + c.indexInGroup,
          srcIndex: c.srcIndexInGroup,
        })),
      };
      applyCreateGroup(recreate);
      if (!assertModelSourceTreeInSync(plan.doc)) {
        throw new Error('PSD layer tree out of sync after undo ungroup.');
      }
      afterStructuralEdit(plan.doc);
    },
  };
}

/** Apply grouping; returns new group node or throws with rollback on failure. */
export function executeGroupCreation(plan: GroupCreatePlan): void {
  applyCreateGroup(plan);
  if (!assertModelSourceTreeInSync(plan.doc)) {
    applyUngroupGroup({
      doc: plan.doc,
      group: plan.group,
      groupIndex: plan.groupIndex,
      groupSrcIndex: plan.groupIndex,
      parent: plan.parent,
      children: plan.children.map((c, i) => ({
        node: c.node,
        indexInGroup: i,
        srcIndexInGroup: c.srcIndex,
        restoreModelIndex: c.modelIndex,
        restoreSrcIndex: c.srcIndex,
      })),
    });
    throw new Error('Grouping failed: model and PSD source tree diverged.');
  }
  afterStructuralEdit(plan.doc);
}

export function executeUngroup(plan: UngroupPlan): void {
  applyUngroupGroup(plan);
  if (!assertModelSourceTreeInSync(plan.doc)) {
    throw new Error('Ungroup failed: model and PSD source tree diverged.');
  }
  afterStructuralEdit(plan.doc);
}

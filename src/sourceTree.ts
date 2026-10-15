import type { Layer, Psd } from 'ag-psd';
import type { AiDocBacking, Doc, Node } from './model';
import { canDuplicateLayer } from './formatCaps';

export type { AiDocBacking };

export function isPsdDoc(doc: Doc): doc is Doc & { psd: Psd } {
  return doc.format === 'psd' && doc.psd != null;
}

export function isAiDoc(doc: Doc): doc is Doc & { ai: AiDocBacking } {
  return doc.format === 'ai' && doc.ai != null;
}

export function requirePsdDoc(doc: Doc): Psd {
  if (!isPsdDoc(doc)) {
    throw new Error(`Expected a PSD document, got format "${doc.format}".`);
  }
  return doc.psd;
}

/** Whether duplicate/reparent should update the native PSD ag-psd tree on export. */
export function canMutateSourceTree(doc: Doc): boolean {
  return isPsdDoc(doc) && canDuplicateLayer(doc);
}

/**
 * Mutable sibling list in the file's native layer tree (PSD: ag-psd `Layer[]`).
 * Returns null for formats without a linked native tree yet (e.g. AI Phase C).
 */
export function sourceSiblings(doc: Doc, node: Node): Layer[] | null {
  if (!isPsdDoc(doc)) return null;
  if (node.parent) {
    if (!node.parent.src.children) node.parent.src.children = [];
    return node.parent.src.children;
  }
  if (!doc.psd.children) doc.psd.children = [];
  return doc.psd.children;
}

/** Sibling list for a would-be parent (null = document roots). */
export function sourceSiblingsForParent(doc: Doc, parent: Node | null): Layer[] | null {
  if (!isPsdDoc(doc)) return null;
  if (parent) {
    if (!parent.src.children) parent.src.children = [];
    return parent.src.children;
  }
  if (!doc.psd.children) doc.psd.children = [];
  return doc.psd.children;
}

export function sourceIndex(doc: Doc, node: Node): number {
  const list = sourceSiblings(doc, node);
  if (!list) return -1;
  return list.indexOf(node.src);
}

export function sourceRemove(doc: Doc, node: Node): number {
  const list = sourceSiblings(doc, node);
  if (!list) return -1;
  const i = list.indexOf(node.src);
  if (i >= 0) list.splice(i, 1);
  return i;
}

export function sourceInsert(doc: Doc, parent: Node | null, layer: Layer, index: number): void {
  const list = sourceSiblingsForParent(doc, parent);
  if (!list) return;
  const at = Math.max(0, Math.min(index, list.length));
  list.splice(at, 0, layer);
}

export function sourceRestore(doc: Doc, node: Node, index: number): void {
  if (index < 0 || !isPsdDoc(doc)) return;
  const list = sourceSiblings(doc, node);
  if (!list) return;
  list.splice(Math.max(0, Math.min(index, list.length)), 0, node.src);
}

/** Model sibling list (bottom → top) for a layer within its parent group or document roots. */
export function nodeSiblings(doc: Doc, node: Node): Node[] {
  return node.parent ? node.parent.children : doc.roots;
}

export function reorderInPlace<T>(list: T[], from: number, to: number): boolean {
  if (from === to || from < 0 || from >= list.length || to < 0 || to > list.length) return false;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);
  return true;
}

/**
 * Nearest non-clipped sibling below `clipped` in bottom→top order (matches `clipBaseOf` in `psdComposite.ts`).
 * Null when none — compositor draws that layer unclipped.
 */
export function clipBaseInSiblingOrder(siblings: Node[], clipped: Node): Node | null {
  if (!clipped.src.clipping) return null;
  const i = siblings.indexOf(clipped);
  if (i < 0) return null;
  for (let j = i - 1; j >= 0; j--) {
    if (!siblings[j]!.src.clipping) return siblings[j]!;
  }
  return null;
}

function clippedLayerBases(siblings: Node[]): Map<string, Node | null> {
  const m = new Map<string, Node | null>();
  for (const n of siblings) {
    if (n.src.clipping) m.set(n.id, clipBaseInSiblingOrder(siblings, n));
  }
  return m;
}

function clippingBasesUnchanged(before: Map<string, Node | null>, after: Map<string, Node | null>): boolean {
  if (before.size !== after.size) return false;
  for (const [id, baseBefore] of before) {
    if (after.get(id) !== baseBefore) return false;
  }
  return true;
}

/** Current stack satisfies compositor clipping rules (any order clipBaseOf can represent). */
export function clippingSiblingOrderValid(siblings: Node[]): boolean {
  return clippingBasesUnchanged(clippedLayerBases(siblings), clippedLayerBases(siblings));
}

/** Whether moving `from` → `to` keeps every clipped layer on the same clip base (or still unclipped). */
export function canReorderSiblingIndex(siblings: Node[], from: number, to: number): boolean {
  if (from === to || from < 0 || from >= siblings.length || to < 0 || to > siblings.length) return false;
  const basesBefore = clippedLayerBases(siblings);
  const trial = siblings.slice();
  reorderInPlace(trial, from, to);
  const basesAfter = clippedLayerBases(trial);
  return clippingBasesUnchanged(basesBefore, basesAfter);
}

/** Clipped layers that use `base` as their clip base in this sibling list. */
export function clippedLayersWithBase(siblings: Node[], base: Node): Node[] {
  return siblings.filter((n) => n.src.clipping && clipBaseInSiblingOrder(siblings, n) === base);
}

/** Reorder model siblings and matching ag-psd `Layer[]` at the same indices. */
export function applySiblingReorder(doc: Doc, node: Node, from: number, to: number): boolean {
  const siblings = nodeSiblings(doc, node);
  if (!canReorderSiblingIndex(siblings, from, to)) return false;
  reorderInPlace(siblings, from, to);
  const srcList = sourceSiblings(doc, node);
  if (srcList) reorderInPlace(srcList, from, to);
  return true;
}

export function nodeSiblingsForParent(doc: Doc, parent: Node | null): Node[] {
  return parent ? parent.children : doc.roots;
}

export interface GroupCreatePlan {
  doc: Doc;
  parent: Node | null;
  group: Node;
  groupIndex: number;
  children: Array<{ node: Node; modelIndex: number; srcIndex: number }>;
}

/** Original sibling indices for layers grouped in-session (ungroup restores exact stack gaps). */
export const groupOriginPlans = new WeakMap<Node, GroupCreatePlan>();

export interface UngroupPlan {
  doc: Doc;
  group: Node;
  groupIndex: number;
  groupSrcIndex: number;
  parent: Node | null;
  children: Array<{
    node: Node;
    indexInGroup: number;
    srcIndexInGroup: number;
    /** Parent stack index before the group existed (non-contiguous ungroup restore). */
    restoreModelIndex?: number;
    /** Parent ag-psd index before the group existed. */
    restoreSrcIndex?: number;
  }>;
  /** When the group was created in-session, used to redo grouping on undo ungroup. */
  recreatePlan?: GroupCreatePlan;
}

function requirePsdMutation(doc: Doc): void {
  if (!canMutateSourceTree(doc)) {
    throw new Error('PSD source tree cannot be mutated for this document.');
  }
}

/** Model tree and ag-psd `Layer[]` share the same child order and `node.src` references. */
export function assertModelSourceTreeInSync(doc: Doc): boolean {
  if (!isPsdDoc(doc)) return true;
  const psdChildren = doc.psd.children ?? [];
  function check(nodes: Node[], layers: Layer[]): boolean {
    if (nodes.length !== layers.length) return false;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const layer = layers[i]!;
      if (n.src !== layer) return false;
      if (n.kind === 'group') {
        const ch = n.children;
        const srcCh = layer.children ?? [];
        if (ch.length !== srcCh.length) return false;
        if (!check(ch, srcCh)) return false;
      }
    }
    return true;
  }
  return check(doc.roots, psdChildren);
}

/**
 * Reparent selected siblings into a new group at `groupIndex` without changing leaf geometry or cloning layers.
 */
export function applyCreateGroup(plan: GroupCreatePlan): void {
  requirePsdMutation(plan.doc);
  const { doc, parent, group, groupIndex, children } = plan;
  const siblings = nodeSiblingsForParent(doc, parent);
  const ordered = [...children].sort((a, b) => a.modelIndex - b.modelIndex);

  for (const c of children) {
    const sibs = nodeSiblings(doc, c.node);
    if (sibs.indexOf(c.node) !== c.modelIndex) {
      throw new Error('Group create: layer stack changed since plan was built.');
    }
    if (c.node.parent !== parent) {
      throw new Error('Group create: selected layers no longer share the same parent.');
    }
  }
  if (groupIndex < 0 || groupIndex > siblings.length) {
    throw new Error('Group create: invalid group insertion index.');
  }

  const removed: Array<{ node: Node; modelIndex: number; srcIndex: number }> = [];
  try {
    const sortedRem = [...children].sort((a, b) => b.modelIndex - a.modelIndex);
    for (const entry of sortedRem) {
      const sibs = nodeSiblings(doc, entry.node);
      const i = sibs.indexOf(entry.node);
      if (i < 0) throw new Error('Group create: layer missing from stack.');
      sibs.splice(i, 1);
      const srcIdx = sourceRemove(doc, entry.node);
      removed.push({ node: entry.node, modelIndex: entry.modelIndex, srcIndex: srcIdx >= 0 ? srcIdx : entry.srcIndex });
    }

    siblings.splice(groupIndex, 0, group);
    group.parent = parent;
    group.src.children = [];
    sourceInsert(doc, parent, group.src, groupIndex);

    const nodes = ordered.map((c) => c.node);
    group.children = nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      n.parent = group;
      sourceInsert(doc, group, n.src, i);
    }
    groupOriginPlans.set(group, plan);
  } catch (err) {
    if (siblings.includes(group)) {
      const gi = siblings.indexOf(group);
      if (gi >= 0) siblings.splice(gi, 1);
      sourceRemove(doc, group);
      group.parent = null;
      group.children = [];
    }
    const restore = [...removed].sort((a, b) => a.modelIndex - b.modelIndex);
    for (const { node, modelIndex, srcIndex } of restore) {
      node.parent = parent;
      siblings.splice(modelIndex, 0, node);
      sourceInsert(doc, parent, node.src, srcIndex >= 0 ? srcIndex : modelIndex);
    }
    throw err;
  }
}

/** Promote one group level into its parent; preserves leaf nodes and source `Layer` references. */
export function applyUngroupGroup(plan: UngroupPlan): void {
  requirePsdMutation(plan.doc);
  const { doc, group, parent } = plan;
  const siblings = nodeSiblingsForParent(doc, parent);
  const groupIdx = siblings.indexOf(group);
  if (groupIdx < 0) throw new Error('Ungroup: group is not in the layer stack.');
  if (group.children.length !== plan.children.length) {
    throw new Error('Ungroup: group contents changed since plan was built.');
  }

  const childNodes = plan.children.map((c) => c.node);
  siblings.splice(groupIdx, 1);
  sourceRemove(doc, group);
  group.children = [];
  group.parent = null;

  const placements = plan.children
    .map((c) => ({
      node: c.node,
      modelIndex: c.restoreModelIndex ?? plan.groupIndex + c.indexInGroup,
      srcIndex: c.restoreSrcIndex ?? plan.groupIndex + c.indexInGroup,
    }))
    .sort((a, b) => a.modelIndex - b.modelIndex);

  for (const { node, modelIndex, srcIndex } of placements) {
    const inGroup = group.src.children;
    if (inGroup) {
      const gi = inGroup.indexOf(node.src);
      if (gi >= 0) inGroup.splice(gi, 1);
    }
    siblings.splice(modelIndex, 0, node);
    node.parent = parent;
    const parentSrc = sourceSiblingsForParent(doc, parent);
    const at =
      srcIndex >= 0 && parentSrc
        ? Math.max(0, Math.min(srcIndex, parentSrc.length))
        : modelIndex;
    sourceInsert(doc, parent, node.src, at);
  }
  group.src.children = [];
  groupOriginPlans.delete(group);

  for (const n of childNodes) {
    if (n.parent !== parent) throw new Error('Ungroup: failed to reparent child.');
  }
}

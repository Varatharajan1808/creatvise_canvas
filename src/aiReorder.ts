import type { Doc, Node } from './model';
import { isLocked, leaves, walk } from './model';
import {
  asAiLayerStub,
  isAiDuplicateLayer,
  ocgIndexFromNodeKey,
  resolveAiMcIndex,
} from './aiLayerMeta';
import { reorderInPlace } from './sourceTree';

/** Bottom→top marked-content indices for the current layer stack. */
export function mcPaintOrderFromDoc(doc: Doc): number[] {
  return leaves(doc).map((n) => resolveAiMcIndex(n));
}

/** Stable PDF OCG ref for a layer (`ocg-N` → import catalog slot N). */
export function resolveStableOcgRef(doc: Doc, node: Node): string | null {
  if (!doc.ai) return null;
  const idx = ocgIndexFromNodeKey(node.key);
  if (idx !== null && doc.ai.importOcgRefsByCatalogIndex?.[idx]) {
    return doc.ai.importOcgRefsByCatalogIndex[idx]!;
  }
  if (idx !== null && doc.ai.ocgRefs[idx]) return doc.ai.ocgRefs[idx]!;
  const stackIdx = doc.roots.indexOf(node);
  if (stackIdx >= 0 && doc.ai.ocgRefs[stackIdx]) return doc.ai.ocgRefs[stackIdx]!;
  return null;
}

/** Leaf ids in current paint order (bottom→top). */
export function currentStackNodeIds(doc: Doc): string[] {
  return leaves(doc).map((n) => n.id);
}

/**
 * True when the relative order of import-time layers changed (ignores duplicates/deletes).
 */
export function docHasAiStackReordered(doc: Doc): boolean {
  const imp = doc.ai?.importStackNodeIds;
  if (!imp?.length) return false;
  const current = currentStackNodeIds(doc);
  const impSet = new Set(imp);
  const filtered = current.filter((id) => impSet.has(id));
  if (filtered.length !== imp.length) return false;
  return filtered.some((id, i) => id !== imp[i]);
}

/** Call at end of `importAi` after shape/text/image promotion. */
export function captureAiImportStackSnapshot(doc: Doc): void {
  if (!doc.ai) return;
  doc.ai.importStackNodeIds = currentStackNodeIds(doc);
}

/**
 * User-facing reason when the document cannot support AI layer reorder (null = eligible).
 */
export function aiReorderDocumentBlockedReason(doc: Doc): string | null {
  if (doc.format !== 'ai' || !doc.ai) {
    return 'Layer reordering is only available for Illustrator (.ai) documents.';
  }
  const ai = doc.ai;
  if (!ai.hasOcg) {
    return 'This file has no PDF optional layers (OCG); layer stack reorder is not available.';
  }
  if (!ai.canDuplicateMarkedContent) {
    return 'This file has no PDF marked-content layer blocks; layer reorder is not available.';
  }
  const blockCount = ai.markedContentBlockCount;
  if (blockCount == null || blockCount < 2) {
    return 'Layer reorder needs at least two marked-content layers in the PDF.';
  }
  const n = ai.ocgNames.length;
  if (n < 2 || ai.ocgRefs.length !== n || blockCount !== n) {
    return 'Marked-content blocks and optional layers do not match one-to-one in this file.';
  }
  if (doc.roots.length !== n) {
    return 'The layer panel stack does not match PDF optional layers one-to-one.';
  }
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') {
      return 'Grouped layers cannot be reordered in this Illustrator document yet.';
    }
  }
  for (const root of doc.roots) {
    if (root.parent !== null) {
      return 'Only top-level layers can be reordered in this Illustrator document.';
    }
    if (root.kind === 'shape') {
      return 'Shape-promoted layers cannot be reordered safely in this file.';
    }
    if (isAiDuplicateLayer(root)) {
      return 'Duplicated layers must be exported before layer reorder is available.';
    }
    const ocgIdx = ocgIndexFromNodeKey(root.key);
    if (ocgIdx === null || ocgIdx < 0 || ocgIdx >= n) {
      return 'A layer is not mapped to a PDF optional layer index (ocg-N).';
    }
    const mc = resolveAiMcIndex(root);
    if (mc !== ocgIdx) {
      return 'Marked-content index and optional layer index disagree for one or more layers.';
    }
    const stubMc = asAiLayerStub(root.src).aiMcIndex;
    if (typeof stubMc === 'number' && stubMc !== mc) {
      return 'Layer marked-content metadata is inconsistent with its optional layer mapping.';
    }
  }
  const seenKeys = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (seenKeys.has(i)) {
      return 'Duplicate optional layer indices in the stack.';
    }
    seenKeys.add(i);
    const hasRoot = doc.roots.some((r) => ocgIndexFromNodeKey(r.key) === i);
    if (!hasRoot) {
      return 'Missing a layer for each PDF optional content group.';
    }
  }
  if (ai.nextMcIndex !== blockCount) {
    return 'Extra marked-content indices are allocated (e.g. duplicated layers); reorder is blocked.';
  }
  return null;
}

export function canReorderAiDocument(doc: Doc): boolean {
  return aiReorderDocumentBlockedReason(doc) === null;
}

export function canReorderAiLayer(doc: Doc, node: Node): boolean {
  if (!canReorderAiDocument(doc)) return false;
  if (node.parent !== null) return false;
  if (node.kind === 'group' || node.kind === 'shape') return false;
  if (!doc.roots.includes(node)) return false;
  if (isLocked(node)) return false;
  return ocgIndexFromNodeKey(node.key) !== null;
}

/** Whether `node` can move from `fromIdx` to `toIdx` among top-level AI roots. */
export function canReorderAiStackStep(
  doc: Doc,
  node: Node,
  siblings: Node[],
  fromIdx: number,
  toIdx: number,
): boolean {
  if (!canReorderAiLayer(doc, node)) return false;
  if (fromIdx !== siblings.indexOf(node)) return false;
  if (fromIdx === toIdx || fromIdx < 0 || fromIdx >= siblings.length) return false;
  if (toIdx < 0 || toIdx > siblings.length) return false;
  return true;
}

/**
 * Reorder top-level AI roots and permute parallel `ocgNames` / `ocgRefs` arrays.
 * Does not change `aiMcIndex` or node keys.
 */
export function applyAiSiblingReorder(doc: Doc, node: Node, from: number, to: number): boolean {
  if (!canReorderAiLayer(doc, node)) return false;
  const siblings = doc.roots;
  if (from < 0 || from >= siblings.length || to < 0 || to > siblings.length) return false;
  if (siblings[from] !== node) return false;
  if (!doc.ai || doc.ai.ocgNames.length !== siblings.length) return false;
  if (doc.ai.ocgRefs.length !== siblings.length) return false;

  if (!reorderInPlace(siblings, from, to)) return false;
  reorderInPlace(doc.ai.ocgNames, from, to);
  reorderInPlace(doc.ai.ocgRefs, from, to);
  return true;
}

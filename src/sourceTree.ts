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

/** Whether duplicate/reparent should update the native file tree on export. */
export function canMutateSourceTree(doc: Doc): boolean {
  return canDuplicateLayer(doc);
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

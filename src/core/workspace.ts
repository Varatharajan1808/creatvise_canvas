import { type Doc, type Node, walk } from './model';
import { sourceRemove } from './sourceTree';
import { serializeState, applySavedState, type SavedLayerState } from '../operations/edit';

/** What is saved for one layer: its edits only. The pixels come back from the original file. */
export interface SavedNode extends SavedLayerState {
  key: string; // position of the layer in the original file (e.g. "1/0"), so edits find their layer again
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
}

export interface SavedDoc {
  id: string;
  name: string;
  format: Doc['format'];
  origin?: Doc['origin'];
  offsetX: number;
  offsetY: number;
  nodes: SavedNode[]; // layers that still exist. Layers missing from this list were deleted.
}

export interface SavedWorkspace {
  version: 1;
  savedAt: number;
  docs: SavedDoc[];
  view: { cx: number; cy: number; zoom: number };
}

export function serializeDoc(d: Doc): SavedDoc {
  return {
    id: d.id,
    name: d.name,
    format: d.format,
    origin: d.origin,
    offsetX: d.offsetX,
    offsetY: d.offsetY,
    nodes: [...walk(d.roots)].map((n) => ({
      key: n.key,
      name: n.name,
      visible: n.visible,
      locked: n.locked,
      opacity: n.opacity,
      ...serializeState(n),
    })),
  };
}

function detach(doc: Doc, n: Node) {
  const list = n.parent ? n.parent.children : doc.roots;
  const i = list.indexOf(n);
  if (i >= 0) list.splice(i, 1);
  sourceRemove(doc, n);
}

/** Puts saved edits onto a freshly imported copy of the original file. */
export function applySavedDoc(doc: Doc, saved: SavedDoc) {
  if (saved.name) doc.name = saved.name;
  if (saved.origin) doc.origin = saved.origin;
  const byKey = new Map(saved.nodes.map((s) => [s.key, s]));
  doc.offsetX = saved.offsetX;
  doc.offsetY = saved.offsetY;
  const all = [...walk(doc.roots)];
  for (const n of all) {
    const s = byKey.get(n.key);
    if (!s) continue;
    n.name = s.name;
    n.visible = s.visible;
    n.locked = s.locked;
    n.opacity = s.opacity;
    applySavedState(n, s);
  }
  for (const n of all) if (!byKey.has(n.key)) detach(doc, n); // deleted before the reload
}

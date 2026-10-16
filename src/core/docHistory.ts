import type { Command } from './history';
import type { Doc } from './model';

export interface DocVisibility {
  setDocVisible(doc: Doc, visible: boolean): void;
}

/**
 * Opening files is undoable as one step per open action (one file, or a whole folder/multi-file batch).
 * Undo takes the files off the canvas (their data stays in memory); redo puts the same documents back in the same slots.
 * Recorded with applied=true: the files are already on the canvas when the command is created.
 */
export function openDocsCommand(docs: Doc[], added: Doc[], view: DocVisibility): Command {
  let slots: Array<[number, Doc]> = [];
  return {
    label: added.length === 1 ? 'Open file' : `Open ${added.length} files`,
    do: () => {
      for (const [i, d] of [...slots].sort((a, b) => a[0] - b[0])) docs.splice(Math.min(i, docs.length), 0, d);
      for (const [, d] of slots) view.setDocVisible(d, true);
    },
    undo: () => {
      slots = added.map((d): [number, Doc] => [docs.indexOf(d), d]).filter(([i]) => i >= 0);
      for (const [i] of [...slots].sort((a, b) => b[0] - a[0])) docs.splice(i, 1);
      for (const [, d] of slots) view.setDocVisible(d, false);
    },
  };
}

/** Closing a file is undoable too: the file is only taken off the canvas, its data stays in memory. */
export function closeDocCommand(docs: Doc[], doc: Doc, view: DocVisibility): Command {
  let idx = -1;
  return {
    label: 'Close file',
    do: () => { idx = docs.indexOf(doc); if (idx >= 0) docs.splice(idx, 1); view.setDocVisible(doc, false); },
    undo: () => { docs.splice(Math.max(0, idx), 0, doc); view.setDocVisible(doc, true); },
  };
}

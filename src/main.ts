import './style.css';
import { escapeHtml } from './utils';
import { Viewport } from './canvas/viewport';
import { fpsTracker } from './canvas/fps';
import { History, type Command } from './core/history';
import { type Doc, type Node, walk, isLocked, nodeBounds, docOf } from './core/model';
import {
  fetchPublicPsd,
  importPsd,
  markNodePreviewContentChanged,
  refreshPsdPreviewModeAfterEdit,
} from './psd/psd';
import { invalidatePsdPreviewCache } from './psd/psdComposite';
import { hitTestCanvasClickTarget, hitTestCanvasLayer, isPointInLayer } from './canvas/canvasHitTest';
import {
  addToSelection,
  emptySelection,
  isNodeSelected,
  movableLeavesForSelection,
  MARQUEE_DRAG_THRESHOLD_PX,
  moveLeavesBy,
  nodesInMarqueeRect,
  normalizeScreenRect,
  pointInSelectionForMoveAtScreen,
  pruneSelection,
  replaceSelection,
  selectionBounds,
  selectionBoundsScreen,
  selectionCanMove,
  selectionDoc,
  selectionFromMarqueeHits,
  selectionSpansDocuments,
  singleSelection,
  snapshotPositions,
  toggleNodeInSelection,
  type Selection,
} from './canvas/selection';
import {
  canEditPsdLayerPosition,
  leavesForPositionEdit,
} from './psd/psdLayerInfo';
import { fetchPublicAi } from './ai/ai';
import { applyAiDuplicateMetadata, canDuplicateAiLayer } from './ai/aiLayerMeta';
import { applyAiPlacedImagePreviewReplace } from './ai/aiImageEdit';
import {
  canDeleteLayer,
  canDuplicateLayer,
  canExportDocument,
  canReplaceAiImageOnNode,
  canReplaceIdmlImageOnNode,
  canReorderLayer,
  canReorderLayerStackStep,
  canResizeRotate,
  reorderLayerBlockedReason,
  reorderLayerNodeBlockedReason,
  aiPlacedImageReplaceBlockedReason,
  DELETE_BLOCKED_MESSAGE,
  duplicateBlockedMessage,
  formatFromFileName,
  importErrorModalTitle,
  RESIZE_ROTATE_BLOCKED_MESSAGE,
  unsupportedDocSubtitle,
} from './formats/formatCaps';
import { importDocument } from './formats/formatImport';
import { exportDocument, exportEditedDownloadName, exportEditedMimeType } from './formats/formatExport';
import { BackendError, fetchBackendHealth } from './formats/backend';
import { exportIdml } from './indd/idml';
import { rasterizeAllIdmlTextNodes } from './indd/rasterText';
import { activeInddDoc, downloadBytes, downloadJson } from './indd/inddImportReport';
import { healthStateFromResponse, indesignChipLabel, indesignChipTitle } from './indd/indesignStatus';
import { canEditIdmlPosition, canTransformIdml, leavesForIdmlPositionEdit, rasterizeIdmlTextNode } from './indd/idmlEdit';
import { rotationPointerAngleDeg } from './indd/idmlRotatePointer';
import {
  sourceIndex,
  sourceInsert,
  sourceRemove,
  sourceRestore,
  sourceSiblingsForParent,
  nodeSiblings,
  applySiblingReorder,
  canReorderSiblingIndex,
  clippedLayersWithBase,
} from './core/sourceTree';
import { applyAiSiblingReorder } from './ai/aiReorder';
import {
  aiGroupCreateCommand,
  aiUngroupCommand,
  planAiGroupCreation,
  planAiUngroup,
} from './ai/aiGroupOps';
import {
  groupActionState,
  groupCreateCommand,
  groupUngroupCommand,
  planGroupCreation,
  planUngroup,
  ungroupActionState,
  validateGroupCreation,
  validateUngroup,
} from './operations/groupOps';
import { closeDocCommand, openDocsCommand } from './core/docHistory';
import { renderLayers, renderProps, type PanelHandlers } from './ui/panel';
import { saveWorkspace, loadWorkspace, clearAll } from './core/storage';
import { serializeDoc, applySavedDoc, type SavedWorkspace } from './core/workspace';
import { applyTextOrAiLiveText, applyShapeColor, applyShapeBorder, applyBrightnessContrast, captureState, restoreState, getTextInfo, shapeColorBlockReason, shapeBorderBlockReason, hexToRgb, type LayerState } from './operations/edit';
import { canEditAiLiveTextOnNode } from './ai/aiTextEdit';
import { toast, alertModal, confirmModal, promptModal, infoListModal, folderImportModal } from './ui/popup';
import {
  collectFilesFromDirectoryPicker,
  discoverFromFileList,
  formatEmptyFolderScanMessage,
  rootFolderNameFromFileList,
  uniqueDocumentName,
  type FolderDiscoveredFile,
  type FolderCollectionMeta,
  type FolderImportSource,
} from './formats/folderImport';
import type { Layer } from 'ag-psd';
import { initTooltips } from './ui/tooltip';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

initTooltips();

const vp = new Viewport();
const hist = new History();
const docs: Doc[] = [];
let selection: Selection = emptySelection();

const vpProjection = {
  docToScreen: (d: Doc, x: number, y: number) => vp.docToScreen(d, x, y),
  screenToDoc: (d: Doc, sx: number, sy: number) => vp.screenToDoc(d, sx, sy),
};


let lastEditWarn = '';
let lastEditWarnAt = 0;
function warnEditOnce(msg: string) {
  const now = Date.now();
  if (msg === lastEditWarn && now - lastEditWarnAt < 2500) return;
  lastEditWarn = msg;
  lastEditWarnAt = now;
  toast(msg, 'warning');
}

// ---------- commands ----------
function propCommand<K extends 'name' | 'visible' | 'locked' | 'opacity'>(label: string, n: Node, key: K, to: Node[K], from: Node[K] = n[key]): Command {
  return {
    label,
    do: () => {
      n[key] = to;
      if (key === 'visible' || key === 'opacity') psdEdited(n);
    },
    undo: () => {
      n[key] = from;
      if (key === 'visible' || key === 'opacity') psdEdited(n);
    },
  };
}

function positionsCommand(label: string, before: Array<[Node, number, number]>, after: Array<[Node, number, number]>): Command {
  const apply = (list: Array<[Node, number, number]>) =>
    list.forEach(([n, x, y]) => {
      n.x = x;
      n.y = y;
    });
  return {
    label,
    do: () => {
      apply(after);
      after.forEach(([n]) => psdEdited(n));
    },
    undo: () => {
      apply(before);
      before.forEach(([n]) => psdEdited(n));
    },
  };
}

/** Removes a layer from both the model and the original PSD tree (so export drops it too). Undo puts it back at the same index. */
function deleteCommand(doc: Doc, n: Node): Command {
  const list = n.parent ? n.parent.children : doc.roots;
  const idx = list.indexOf(n);
  const srcIdx = sourceIndex(doc, n);
  return {
    label: 'Delete layer',
    do: () => {
      list.splice(list.indexOf(n), 1);
      sourceRemove(doc, n);
      invalidatePsdPreviewCache(doc);
      refreshPsdPreviewModeAfterEdit(doc);
    },
    undo: () => {
      list.splice(idx, 0, n);
      sourceRestore(doc, n, srcIdx);
      invalidatePsdPreviewCache(doc);
      refreshPsdPreviewModeAfterEdit(doc);
    },
  };
}

function commandWithSelectionRestore(base: Command, before: Selection, after: Selection): Command {
  return {
    label: base.label,
    do: () => {
      base.do();
      selection = pruneSelection(after, docs);
      syncAll();
      refresh(false);
    },
    undo: () => {
      base.undo();
      selection = pruneSelection(before, docs);
      syncAll();
      refresh(false);
    },
  };
}

/** Phase 6a: history entry point (UI wired in Phase 6b). */
function groupSelectedLayers() {
  const v = validateGroupCreation(selection.nodes, docs);
  if (!v.ok) {
    toast(v.reason, 'warning');
    return;
  }
  if (v.doc.format === 'ai') {
    const planned = planAiGroupCreation(v.doc, v.nodes);
    if (!planned.ok) {
      toast(planned.reason, 'warning');
      return;
    }
    const before = selection;
    const after = singleSelection(planned.plan.group);
    hist.exec(commandWithSelectionRestore(aiGroupCreateCommand(planned.plan), before, after));
    toast(`Grouped ${v.nodes.length} layers. Press Ctrl+Z to undo.`, 'success');
    return;
  }
  const planned = planGroupCreation(v.doc, v.nodes);
  if (!planned.ok) {
    toast(planned.reason, 'warning');
    return;
  }
  const before = selection;
  const after = singleSelection(planned.plan.group);
  hist.exec(commandWithSelectionRestore(groupCreateCommand(planned.plan), before, after));
  toast(`Grouped ${v.nodes.length} layers. Press Ctrl+Z to undo.`, 'success');
}

/** Phase 6a: history entry point (UI wired in Phase 6b). */
function ungroupSelectedLayer() {
  if (selection.nodes.length !== 1) {
    toast('Select a single group folder to ungroup.', 'warning');
    return;
  }
  const n = selection.primary ?? selection.nodes[0]!;
  const v = validateUngroup(n, docs);
  if (!v.ok) {
    toast(v.reason, 'warning');
    return;
  }
  if (v.doc.format === 'ai') {
    const planned = planAiUngroup(v.doc, n);
    if (!planned.ok) {
      toast(planned.reason, 'warning');
      return;
    }
    const before = selection;
    let after = emptySelection();
    for (const c of planned.plan.children) {
      after = addToSelection(after, c);
    }
    hist.exec(commandWithSelectionRestore(aiUngroupCommand(planned.plan), before, after));
    toast(`Ungrouped "${n.name}". Press Ctrl+Z to undo.`, 'success');
    return;
  }
  const planned = planUngroup(v.doc, n);
  if (!planned.ok) {
    toast(planned.reason, 'warning');
    return;
  }
  const before = selection;
  let after = emptySelection();
  for (const c of planned.plan.children) {
    after = addToSelection(after, c.node);
  }
  hist.exec(commandWithSelectionRestore(groupUngroupCommand(planned.plan), before, after));
  toast(`Ungrouped "${n.name}". Press Ctrl+Z to undo.`, 'success');
}

function toggleGroupExpanded(n: Node) {
  if (n.kind !== 'group') return;
  const open = n.src.opened !== false;
  n.src.opened = !open;
  refresh(false);
}

function deleteNode(n: Node | null) {
  if (selection.nodes.length > 1) {
    toast('Select a single layer to delete.', 'warning');
    return;
  }
  if (!n) { toast('Select a layer to delete.', 'warning'); return; }
  const doc = docOf(n, docs);
  if (!doc) return;
  if (!canDeleteLayer(doc)) { toast(DELETE_BLOCKED_MESSAGE, 'warning'); return; }
  if (isLocked(n)) { toast('This layer is locked. Unlock it to delete it.', 'warning'); return; }
  selection = emptySelection();
  hist.exec(deleteCommand(doc, n));
  flushSave();
  toast(`Deleted "${n.name}". Press Ctrl+Z to undo.`, 'info');
}

function copyCanvas(src: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!src || src.width === 0 || src.height === 0) return null;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  if (ctx) ctx.drawImage(src, 0, 0);
  return c;
}

function cloneLayerSrc(src: Layer, newCanvas: HTMLCanvasElement | null, dx: number, dy: number): Layer {
  const { canvas: _c, children: _ch, ...rest } = src;
  let clonedSrc: Layer;
  try {
    clonedSrc = structuredClone(rest);
  } catch {
    clonedSrc = JSON.parse(JSON.stringify(rest, (_k, val) => {
      if (typeof val === 'function' || val instanceof HTMLElement) return undefined;
      return val;
    }));
  }
  clonedSrc.canvas = newCanvas ?? undefined;
  clonedSrc.left = (src.left ?? 0) + dx;
  clonedSrc.top = (src.top ?? 0) + dy;
  clonedSrc.right = (src.right ?? 0) + dx;
  clonedSrc.bottom = (src.bottom ?? 0) + dy;
  if (clonedSrc.text?.transform) {
    clonedSrc.text.transform = [...clonedSrc.text.transform];
    clonedSrc.text.transform[4] += dx;
    clonedSrc.text.transform[5] += dy;
  }
  return clonedSrc;
}

function makeCopyName(name: string): string {
  const copyNumMatch = name.match(/^(.*?) copy (\d+)$/);
  if (copyNumMatch) {
    const base = copyNumMatch[1];
    const num = parseInt(copyNumMatch[2], 10) + 1;
    return `${base} copy ${num}`;
  }
  const copyMatch = name.match(/^(.*?) copy$/);
  if (copyMatch) {
    return `${copyMatch[1]} copy 2`;
  }
  return `${name} copy`;
}

let dupSeq = 0;
function uniqueNodeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `n_${crypto.randomUUID().slice(0, 8)}`
    : `n_${Date.now().toString(36)}_${(++dupSeq).toString(36)}`;
}

function cloneNode(n: Node, parent: Node | null, dx = 20, dy = 20): Node {
  const clonedCanvas = copyCanvas(n.canvas);
  const clonedBaseCanvas = copyCanvas(n.baseShapeCanvas ?? null);
  const clonedSrc = cloneLayerSrc(n.src, clonedCanvas, dx, dy);
  const newName = makeCopyName(n.name);
  clonedSrc.name = newName;

  const isGroup = n.kind === 'group';
  const clonedNode: Node = {
    id: uniqueNodeId(),
    key: `${n.key}_copy_${Date.now()}_${++dupSeq}`,
    name: newName,
    kind: n.kind,
    visible: n.visible,
    locked: false,
    opacity: n.opacity,
    importOpacity: n.importOpacity,
    importVisible: n.importVisible,
    x: isGroup ? 0 : n.x + dx,
    y: isGroup ? 0 : n.y + dy,
    w: n.w,
    h: n.h,
    rotation: n.rotation,
    ow: n.ow,
    oh: n.oh,
    ox: isGroup ? 0 : n.ox + dx,
    oy: isGroup ? 0 : n.oy + dy,
    canvas: clonedCanvas,
    baseShapeCanvas: clonedBaseCanvas,
    children: [],
    parent,
    src: clonedSrc,
    textTransform: n.textTransform ? (() => {
      const tt = [...n.textTransform];
      tt[4] += dx;
      tt[5] += dy;
      return tt;
    })() : undefined,
    textEdited: n.textEdited,
    importPreviewContentEpoch: n.importPreviewContentEpoch,
    previewContentEpoch: n.previewContentEpoch,
    unsupported: [...n.unsupported],
  };

  if (n.children.length) {
    clonedNode.children = n.children.map((child) => cloneNode(child, clonedNode, dx, dy));
    clonedSrc.children = clonedNode.children.map((child) => child.src);
  }

  return clonedNode;
}

/** Duplicates a layer and inserts it directly above the original in both the model and the PSD tree. */
function duplicateCommand(doc: Doc, original: Node, clone: Node): Command {
  const list = original.parent ? original.parent.children : doc.roots;
  const srcList = sourceSiblingsForParent(doc, original.parent);
  const idx = list.indexOf(original);
  const srcIdx = srcList ? srcList.indexOf(original.src) : -1;
  const insertIdx = idx >= 0 ? idx + 1 : list.length;
  const srcInsertIdx = srcIdx >= 0 ? srcIdx + 1 : (srcList?.length ?? 0);

  return {
    label: 'Duplicate layer',
    do: () => {
      list.splice(insertIdx, 0, clone);
      sourceInsert(doc, original.parent, clone.src, srcInsertIdx);
      selection = singleSelection(clone);
    },
    undo: () => {
      const ci = list.indexOf(clone);
      if (ci >= 0) list.splice(ci, 1);
      sourceRemove(doc, clone);
      if (selection.primary === clone) selection = singleSelection(original);
    },
  };
}

function applyStackReorder(doc: Doc, n: Node, fromIdx: number, toIdx: number): boolean {
  if (doc.format === 'ai') return applyAiSiblingReorder(doc, n, fromIdx, toIdx);
  return applySiblingReorder(doc, n, fromIdx, toIdx);
}

function afterStackReorder(doc: Doc): void {
  if (doc.format === 'psd') refreshPsdPreviewModeAfterEdit(doc);
  if (doc.format === 'ai') invalidatePsdPreviewCache(doc);
  syncAll();
  refresh(false);
}

function reorderCommand(doc: Doc, n: Node, fromIdx: number, toIdx: number): Command {
  return {
    label: 'Reorder layer',
    do: () => {
      applyStackReorder(doc, n, fromIdx, toIdx);
      afterStackReorder(doc);
    },
    undo: () => {
      applyStackReorder(doc, n, toIdx, fromIdx);
      afterStackReorder(doc);
    },
  };
}

function reorderStackStep(n: Node, delta: 1 | -1) {
  const doc = docOf(n, docs);
  if (!doc) return;
  if (!canReorderLayer(doc)) {
    toast(reorderLayerBlockedReason(doc), 'warning');
    return;
  }
  const list = nodeSiblings(doc, n);
  const fromIdx = list.indexOf(n);
  if (fromIdx < 0) return;
  const toIdx = fromIdx + delta;
  if (toIdx < 0 || toIdx >= list.length) return;
  if (!canReorderLayerStackStep(doc, n, list, fromIdx, toIdx)) {
    const nodeReason = reorderLayerNodeBlockedReason(doc, n);
    if (nodeReason) {
      toast(nodeReason, 'warning');
      return;
    }
    const dependents = clippedLayersWithBase(list, n);
    if (dependents.length) {
      const names = dependents.map((d) => `"${d.name}"`).join(', ');
      toast(`Cannot reorder: "${n.name}" is the clipping base for ${names}.`, 'warning');
    } else {
      toast('Cannot reorder: that would break a clipping group.', 'warning');
    }
    return;
  }
  hist.exec(reorderCommand(doc, n, fromIdx, toIdx));
}

function duplicateNode(n: Node | null) {
  if (selection.nodes.length > 1) {
    toast('Select a single layer to duplicate.', 'warning');
    return;
  }
  if (!n) { toast('Select a layer to duplicate.', 'warning'); return; }
  const doc = docOf(n, docs);
  if (!doc) return;
  if (!canDuplicateLayer(doc)) {
    toast(duplicateBlockedMessage(doc), 'warning');
    return;
  }
  if (doc.format === 'ai' && !canDuplicateAiLayer(doc, n)) {
    toast(duplicateBlockedMessage(doc), 'warning');
    return;
  }

  const clone = cloneNode(n, n.parent, 20, 20);
  if (doc.format === 'ai') applyAiDuplicateMetadata(doc, n, clone);
  hist.exec(duplicateCommand(doc, n, clone));
  toast(`Duplicated "${n.name}" as "${clone.name}". Press Ctrl+D to duplicate again.`, 'success');
}

function closeDoc(doc: Doc) {
  hist.exec(closeDocCommand(docs, doc, vp));
  toast(`Closed "${doc.name}". Press Ctrl+Z to bring it back.`, 'info');
}

// ---------- text and shape colour ----------
let pending: { node: Node; before: LayerState } | null = null;
let posPending: { node: Node; before: Array<[Node, number, number]> } | null = null;
let xfPending: { node: Node; before: Xform } | null = null;

function contentCommand(n: Node, before: LayerState, after: LayerState): Command {
  return {
    label: 'Edit layer',
    do: () => {
      restoreState(n, after);
      psdEdited(n);
    },
    undo: () => {
      restoreState(n, before);
      psdEdited(n);
    },
  };
}

function commitPending() {
  if (!pending) return;
  const { node, before } = pending;
  pending = null;
  hist.exec(contentCommand(node, before, captureState(node)), true);
}

/** Live preview while typing/picking (commit=false), one undo step when finished (commit=true). */
function editContent(n: Node, mutate: () => void, commit: boolean) {
  if (!pending || pending.node !== n) pending = { node: n, before: captureState(n) };
  mutate();
  markNodePreviewContentChanged(n);
  psdEdited(n);
  if (commit) commitPending();
  else scheduleSceneSync();
}

function editText(n: Node, patch: {
  text?: string;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  alignment?: 'left' | 'center' | 'right';
}, commit: boolean) {
  if (selection.nodes.length > 1) return;
  const info = getTextInfo(n);
  if (!info) return;
  if (info.reason && !canEditAiLiveTextOnNode(n)) return;
  if (isLocked(n)) { toast('This layer is locked. Unlock it to edit it.', 'warning'); refresh(); return; }
  if (patch.text !== undefined && !patch.text.trim()) {
    if (commit) {
      if (pending) { restoreState(pending.node, pending.before); pending = null; }
      toast("Text can't be empty. Delete the layer instead.", 'warning');
      refresh();
    }
    return;
  }
  editContent(n, () => applyTextOrAiLiveText(n, {
    text: patch.text,
    fontSize: patch.fontSize,
    color: patch.color ? hexToRgb(patch.color) : undefined,
    fontFamily: patch.fontFamily,
    bold: patch.bold,
    italic: patch.italic,
    alignment: patch.alignment,
  }), commit);
}

function editShapeColor(n: Node, hex: string, commit: boolean) {
  const why = shapeColorBlockReason(n);
  if (why) { toast(why, 'warning'); return; }
  if (isLocked(n)) { toast('This layer is locked. Unlock it to edit it.', 'warning'); refresh(); return; }
  editContent(n, () => applyShapeColor(n, hexToRgb(hex)), commit);
}

function editShapeBorder(n: Node, patch: { enabled?: boolean; width?: number; color?: string }, commit: boolean) {
  if (n.kind !== 'shape') return;
  const borderWhy = shapeBorderBlockReason(n);
  if (borderWhy) { toast(borderWhy, 'warning'); return; }
  if (isLocked(n)) { toast('This layer is locked. Unlock it to edit it.', 'warning'); refresh(); return; }
  editContent(n, () => applyShapeBorder(n, {
    enabled: patch.enabled,
    width: patch.width,
    color: patch.color ? hexToRgb(patch.color) : undefined,
  }), commit);
}

async function loadImageFileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext('2d');
    if (!ctx || c.width < 1 || c.height < 1) {
      throw new Error('The selected image has no drawable pixels.');
    }
    ctx.drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function replaceImageCommand(n: Node, before: LayerState, after: LayerState): Command {
  return {
    label: 'Replace image',
    do: () => {
      restoreState(n, after);
      markNodePreviewContentChanged(n);
      psdEdited(n);
      syncAll();
      refresh();
    },
    undo: () => {
      restoreState(n, before);
      markNodePreviewContentChanged(n);
      psdEdited(n);
      syncAll();
      refresh();
    },
  };
}

async function replaceImage(n: Node, file: File) {
  if (selection.nodes.length > 1) {
    toast('Select a single layer to replace its image.', 'warning');
    return;
  }
  if (n.kind !== 'raster') return;
  if (isLocked(n)) { toast('This layer is locked. Unlock it to replace its image.', 'warning'); return; }
  const doc = docOf(n, docs);
  if (!doc) return;

  if (doc.format === 'ai') {
    if (!canReplaceAiImageOnNode(doc, n)) {
      toast(aiPlacedImageReplaceBlockedReason(doc, n), 'warning');
      return;
    }
    const before = captureState(n);
    try {
      const c = await loadImageFileToCanvas(file);
      applyAiPlacedImagePreviewReplace(n, c);
      markNodePreviewContentChanged(n);
      const after = captureState(n);
      hist.exec(replaceImageCommand(n, before, after), true);
      toast(`Replaced embedded image in "${n.name}". Export writes the PDF XObject. Press Ctrl+Z to undo.`, 'success');
    } catch (err) {
      restoreState(n, before);
      syncAll();
      refresh();
      const msg = (err as Error).message || 'Could not load the selected image file.';
      toast(msg, 'warning');
    }
    return;
  }

  if (canReplaceIdmlImageOnNode(doc, n)) {
    const beforeCanvas = n.canvas;
    const beforeSrcCanvas = n.src.canvas;
    const beforeW = n.w;
    const beforeH = n.h;
    const beforePlaced = n.idml?.placedImage ? structuredClone(n.idml.placedImage) : undefined;
    try {
      const c = await loadImageFileToCanvas(file);
      const { applyIdmlPlacedImageReplace } = await import('./indd/placedImage');
      await applyIdmlPlacedImageReplace(n, c, { sourceMime: file.type || undefined });
      markNodePreviewContentChanged(n);
      hist.exec({
        label: 'Replace image',
        do: () => {
          markNodePreviewContentChanged(n);
          syncAll();
          refresh();
        },
        undo: () => {
          n.canvas = beforeCanvas;
          n.src.canvas = beforeSrcCanvas;
          n.w = beforeW;
          n.h = beforeH;
          if (beforePlaced && n.idml) n.idml.placedImage = beforePlaced;
          markNodePreviewContentChanged(n);
          syncAll();
          refresh();
        },
      }, true);
      toast(`Replaced linked image in "${n.name}". Export updates Links/ in the IDML package. Press Ctrl+Z to undo.`, 'success');
      syncAll();
      refresh();
    } catch (err) {
      n.canvas = beforeCanvas;
      n.src.canvas = beforeSrcCanvas;
      n.w = beforeW;
      n.h = beforeH;
      if (beforePlaced && n.idml) n.idml.placedImage = beforePlaced;
      syncAll();
      refresh();
      const msg = (err as Error).message || 'Could not load the selected image file.';
      toast(msg, 'warning');
    }
    return;
  }

  try {
    const c = await loadImageFileToCanvas(file);
    const beforeCanvas = n.canvas;
    const beforeSrcCanvas = n.src.canvas;
    hist.exec({
      label: 'Replace image',
      do: () => {
        n.canvas = c;
        n.src.canvas = c;
        markNodePreviewContentChanged(n);
        psdEdited(n);
        syncAll();
        refresh();
      },
      undo: () => {
        n.canvas = beforeCanvas;
        n.src.canvas = beforeSrcCanvas;
        markNodePreviewContentChanged(n);
        psdEdited(n);
        syncAll();
        refresh();
      },
    });
    toast(`Replaced image in "${n.name}". Press Ctrl+Z to undo.`, 'success');
  } catch {
    toast('Could not load the selected image file.', 'warning');
  }
}

// ---------- resize / rotate ----------
interface Xform { x: number; y: number; w: number; h: number; rotation: number }
const getX = (n: Node): Xform => ({ x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation });
const normAngle = (a: number) => Math.round((((a + 180) % 360 + 360) % 360 - 180) * 10) / 10;
const MIN_SIZE = 4;

function transformCommand(n: Node, before: Xform, after: Xform): Command {
  const apply = (t: Xform) => {
    n.x = t.x;
    n.y = t.y;
    n.w = t.w;
    n.h = t.h;
    n.rotation = t.rotation;
    if (n.idml && n.kind === 'text') rasterizeIdmlTextNode(n);
  };
  return {
    label: 'Transform',
    do: () => { apply(after); psdEdited(n); },
    undo: () => { apply(before); psdEdited(n); },
  };
}

/** Resize/rotate: raster layers and IDML text/shapes (export patches ItemTransform). */
function canTransform(n: Node, quiet = false): boolean {
  const no = (msg: string) => { if (!quiet) warnEditOnce(msg); return false; };
  const doc = docOf(n, docs);
  if (doc && !canResizeRotate(doc)) return no(RESIZE_ROTATE_BLOCKED_MESSAGE);
  if (n.kind === 'group') return no('Resize and rotate work on image layers. Select a layer inside the group.');
  if (n.idml && canTransformIdml(n)) {
    if (isLocked(n)) return no('This layer is locked. Unlock it to resize or rotate it.');
    return true;
  }
  if (n.kind !== 'raster') return no('Resizing and rotating text and shape layers is not supported yet.');
  if (isLocked(n)) return no('This layer is locked. Unlock it to resize or rotate it.');
  if (n.src.mask || n.src.vectorMask) return no('This layer has a mask. Resizing it would misalign the mask, so it is not supported yet.');
  return true;
}

const snapshot = (n: Node): Array<[Node, number, number]> =>
  leavesForPositionEdit(n).map((l) => [l, l.x, l.y]);

function canMove(n: Node): boolean {
  if (isLocked(n)) {
    warnEditOnce('This layer is locked. Unlock it to move it.');
    return false;
  }
  if (leavesForPositionEdit(n).length === 0) {
    warnEditOnce(
      n.kind === 'shape' && !n.idml
        ? 'Moving vector shapes is not supported yet.'
        : 'This layer cannot be moved in the canvas editor.',
    );
    return false;
  }
  return true;
}

function moveBy(n: Node, dx: number, dy: number) {
  for (const l of leavesForPositionEdit(n)) {
    l.x += dx;
    l.y += dy;
  }
}

function applyPositions(list: Array<[Node, number, number]>) {
  list.forEach(([ln, x, y]) => { ln.x = x; ln.y = y; });
}

function parseCoord(raw: string): number | null {
  const t = raw.trim();
  if (t === '' || t === '-' || t === '+') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function positionsEqual(a: Array<[Node, number, number]>, b: Array<[Node, number, number]>) {
  if (a.length !== b.length) return false;
  return a.every(([n, x, y], i) => b[i][0] === n && b[i][1] === x && b[i][2] === y);
}

function previewPositionScene(n: Node) {
  if (!docOf(n, docs)) {
    drawOverlay();
    return;
  }
  scheduleSceneSync();
}

function xformEqual(a: Xform, b: Xform) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation;
}

function commitXfPending() {
  if (!xfPending) return;
  const { node, before } = xfPending;
  xfPending = null;
  const after = getX(node);
  if (xformEqual(before, after)) return;
  hist.exec(transformCommand(node, before, after), true);
}

/** Live width / height / rotation while typing; one undo step on change or blur. */
function editTransform(n: Node, t: { w?: number; h?: number; rotation?: number }, commit: boolean) {
  if (selection.nodes.length > 1) {
    if (commit) refresh(false);
    return;
  }
  if (!canTransform(n, !commit)) {
    if (commit) refresh(false);
    return;
  }
  if (t.w !== undefined && (!Number.isFinite(t.w) || t.w < 1)) {
    if (commit) refresh(false);
    return;
  }
  if (t.h !== undefined && (!Number.isFinite(t.h) || t.h < 1)) {
    if (commit) refresh(false);
    return;
  }
  if (t.rotation !== undefined && !Number.isFinite(t.rotation)) {
    if (commit) refresh(false);
    return;
  }
  if (posPending) commitPosPending();
  if (!xfPending || xfPending.node !== n) xfPending = { node: n, before: getX(n) };
  const b = xfPending.before;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  n.w = t.w !== undefined ? Math.max(1, Math.round(t.w)) : n.w;
  n.h = t.h !== undefined ? Math.max(1, Math.round(t.h)) : n.h;
  n.x = cx - n.w / 2;
  n.y = cy - n.h / 2;
  n.rotation = t.rotation !== undefined ? normAngle(t.rotation) : n.rotation;
  if (n.idml && n.kind === 'text') rasterizeIdmlTextNode(n);
  psdEdited(n);
  if (!commit) {
    scheduleSceneSync();
    return;
  }
  commitXfPending();
}

function commitPosPending() {
  if (!posPending) return;
  const { node, before } = posPending;
  posPending = null;
  const after = snapshot(node);
  if (positionsEqual(before, after)) return;
  hist.exec(positionsCommand('Move', before, after), true);
}

/** Live preview while typing (commit=false); one undo step on Enter/blur (commit=true). */
function editPosition(n: Node, xRaw: string, yRaw: string, commit: boolean) {
  if (selection.nodes.length > 1) {
    if (commit) refresh(false);
    return;
  }
  if (!canMove(n)) {
    if (commit) refresh();
    return;
  }
  if (xfPending) commitXfPending();
  const bx = parseCoord(xRaw);
  const by = parseCoord(yRaw);
  if (bx === null && by === null) {
    if (commit && posPending) {
      applyPositions(posPending.before);
      posPending = null;
      psdEdited(n);
      refresh();
    }
    return;
  }
  if (!posPending || posPending.node !== n) posPending = { node: n, before: snapshot(n) };
  applyPositions(posPending.before);
  const b = nodeBounds(n);
  if (!b) return;
  const tx = bx ?? Math.round(b.x);
  const ty = by ?? Math.round(b.y);
  const nb = nodeBounds(n)!;
  moveBy(n, Math.round(tx - nb.x), Math.round(ty - nb.y));
  psdEdited(n);
  if (commit) commitPosPending();
  else previewPositionScene(n);
}

/** True after the first pointer delta while transforming — avoids leaving file-composite on click-only selection. */
let psdLivePreviewActivated = false;

/** Callers sync the scene right after. */
function activatePsdLivePreviewForEdits(nodes: Node[]) {
  if (!psdLivePreviewActivated) psdLivePreviewActivated = true;
  const seenDoc = new Set<string>();
  for (const n of nodes) {
    const doc = docOf(n, docs);
    if (doc?.format === 'psd' && !seenDoc.has(doc.id)) {
      seenDoc.add(doc.id);
      refreshPsdPreviewModeAfterEdit(doc);
    }
  }
}

// ---------- panel handlers ----------
const handlers: PanelHandlers = {
  select: (n, shiftKey) => select(n, shiftKey),
  toggleVisible: (n) => hist.exec(propCommand('Toggle visibility', n, 'visible', !n.visible)),
  toggleLocked: (n) => hist.exec(propCommand('Toggle lock', n, 'locked', !n.locked)),
  remove: (n) => deleteNode(n),
  duplicate: (n) => duplicateNode(n),
  toggleGroupExpanded: (n) => toggleGroupExpanded(n),
  reorderStackUp: (n) => reorderStackStep(n, 1),
  reorderStackDown: (n) => reorderStackStep(n, -1),
  closeDoc: (d) => closeDoc(d),
  rename: async (n) => {
    const name = await promptModal({
      title: 'Rename Layer',
      message: 'Enter a new name for this layer:',
      defaultValue: n.name,
      confirmText: 'Save Name',
    });
    if (name && name !== n.name) {
      hist.exec(propCommand('Rename', n, 'name', name));
      toast(`Renamed layer to "${name}"`, 'success');
    }
  },
  setOpacityPreview: (n, v) => {
    n.opacity = v;
    psdEdited(n);
    scheduleSceneSync();
  },
  commitOpacity: (n, from, to) => hist.exec(propCommand('Opacity', n, 'opacity', to, from), true),
  editText,
  editShapeColor,
  editShapeBorder,
  editBrightnessContrast: (n, patch, commit) => {
    if (isLocked(n)) { toast('This layer is locked. Unlock it to edit it.', 'warning'); refresh(); return; }
    editContent(n, () => applyBrightnessContrast(n, patch), commit);
  },
  replaceImage,
  setTransform: (n, t, commit = true) => editTransform(n, t, commit),
  editPosition,
  showUnsupportedDoc: (doc) => {
    const unsupportedLayers = [...walk(doc.roots)].filter((n) => n.unsupported.length);
    infoListModal({
      title: `${doc.name} · Compatibility Notes`,
      subtitle: `${unsupportedLayers.length} layer(s): ${unsupportedDocSubtitle(doc)}`,
      items: unsupportedLayers.map((n) => ({
        label: n.name,
        tag: n.kind.toUpperCase(),
        text: n.unsupported.join(' • '),
        danger: true,
      })),
      confirmText: 'Understood',
    });
  },
  showUnsupportedNode: (n) => {
    infoListModal({
      title: `Layer "${n.name}" Details`,
      subtitle: `Photoshop specification note:`,
      items: n.unsupported.map((u) => ({
        label: 'Feature note',
        tag: 'Read-only in Canvas',
        text: u,
        danger: true,
      })),
      confirmText: 'Got it',
    });
  },
  renameDoc: async (d) => {
    const name = await promptModal({
      title: 'Rename Document',
      message: 'Enter a new name for this file:',
      defaultValue: d.name,
      confirmText: 'Save Name',
    });
    if (name && name.trim() && name.trim() !== d.name) {
      const clean = name.trim();
      const currentExt = d.name.lastIndexOf('.') > 0 ? d.name.slice(d.name.lastIndexOf('.')) : `.${d.format}`;
      const fullName = clean.includes('.') ? clean : `${clean}${currentExt}`;
      const before = d.name;
      hist.exec({
        label: 'Rename file',
        do: () => { d.name = fullName; },
        undo: () => { d.name = before; },
      });
      toast(`Renamed file to "${fullName}"`, 'success');
      refresh();
      scheduleSave();
    }
  },
};

// ---------- rendering the UI ----------
function syncAll() { docs.forEach((d) => vp.syncDoc(d)); }
/** Coalesce drag and number-input updates to one scene sync per frame. */
let sceneSyncQueued = false;
function scheduleSceneSync() {
  if (sceneSyncQueued) return;
  sceneSyncQueued = true;
  requestAnimationFrame(() => {
    sceneSyncQueued = false;
    syncAll();
    renderProps($('props'), { docs, selection }, handlers);
    drawOverlay();
  });
}
function psdEdited(n: Node) {
  const d = docOf(n, docs);
  if (d?.format === 'psd') refreshPsdPreviewModeAfterEdit(d);
}

/** Pass syncScene=false when only the selection changed: syncing re-composites edited PSDs, which can take seconds. */
function refresh(syncScene = true) {
  selection = pruneSelection(selection, docs);
  if (syncScene) syncAll();
  renderLayers($('layers'), { docs, selection }, handlers);
  renderProps($('props'), { docs, selection }, handlers);
  ($('btn-undo') as HTMLButtonElement).disabled = !hist.canUndo;
  ($('btn-redo') as HTMLButtonElement).disabled = !hist.canRedo;
  const selDoc = selectionDoc(selection, docs);
  const primary = selection.primary;
  ($('btn-delete') as HTMLButtonElement).disabled =
    !primary || selection.nodes.length > 1 || !selDoc || !canDeleteLayer(selDoc);
  const dupBlocked =
    !primary ||
    selection.nodes.length > 1 ||
    !selDoc ||
    !canDuplicateLayer(selDoc) ||
    (selDoc.format === 'ai' && !canDuplicateAiLayer(selDoc, primary));
  ($('btn-duplicate') as HTMLButtonElement).disabled = dupBlocked;
  const groupState = groupActionState(selection.nodes, docs);
  const ungroupState = ungroupActionState(selection, docs);
  const btnGroup = $('btn-group') as HTMLButtonElement;
  btnGroup.disabled = !groupState.enabled;
  btnGroup.title = groupState.title;
  const btnUngroup = $('btn-ungroup') as HTMLButtonElement;
  btnUngroup.disabled = !ungroupState.enabled;
  btnUngroup.title = ungroupState.title;
  ($('btn-clear') as HTMLButtonElement).disabled = docs.length === 0;
  const exportDoc = primary ? docOf(primary, docs) : docs.length === 1 ? docs[0] : null;
  ($('btn-export') as HTMLButtonElement).disabled =
    docs.length === 0 || !exportDoc || !canExportDocument(exportDoc);
  ($('btn-fit') as HTMLButtonElement).disabled = docs.length === 0;
  $('empty').style.display = docs.length ? 'none' : 'flex';
  const inddDebugGroup = document.getElementById('indd-debug-group');
  if (inddDebugGroup) {
    inddDebugGroup.hidden = !docs.some((d) => d.format === 'indd');
  }
  drawOverlay();
}
hist.onChange = () => { refresh(); scheduleSave(); };

function commitPendingOnSelectionChange(from: Selection, to: Selection) {
  if (pending && !to.nodes.some((n) => n.id === pending!.node.id)) commitPending();
  if (posPending && !to.nodes.some((n) => n.id === posPending!.node.id)) commitPosPending();
  if (xfPending && (to.nodes.length !== 1 || to.primary !== xfPending.node)) commitXfPending();
}

function applySelection(next: Selection) {
  commitPendingOnSelectionChange(selection, next);
  selection = pruneSelection(next, docs);
  refresh(false);
}

function select(n: Node | null, shiftKey = false) {
  let next: Selection;
  if (!n) next = emptySelection();
  else if (shiftKey) next = toggleNodeInSelection(selection, n, docs);
  else next = replaceSelection(n);
  applySelection(next);
}

const labels = $('labels');
const selbox = $('selbox');
const marqueeBox = $('marquee-box');
const HANDLES: ReadonlyArray<readonly [number, number]> = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
HANDLES.forEach(([hx, hy]) => {
  const h = document.createElement('div');
  h.className = 'handle';
  h.style.left = `calc(${(hx + 1) * 50}% - 5px)`;
  h.style.top = `calc(${(hy + 1) * 50}% - 5px)`;
  selbox.appendChild(h);
});
const rotLine = document.createElement('div');
rotLine.className = 'rot-line';
const rotHandle = document.createElement('div');
rotHandle.className = 'handle rot-handle';
selbox.append(rotLine, rotHandle);

/** Uniform dot grid spacing on screen (px), fixed across zoom levels. */
const DOT_GRID_SPACING = 20;

function posMod(n: number, period: number): number {
  if (period <= 0) return 0;
  return ((n % period) + period) % period;
}

function syncCanvasDots() {
  const el = $('canvas-dots');
  // Screen-fixed spacing (does not scale with zoom); pan offset still follows camera.
  const period = DOT_GRID_SPACING;
  const posX = posMod(vp.width / 2 - vp.cx * vp.zoom, period);
  const posY = posMod(vp.height / 2 + vp.cy * vp.zoom, period);
  el.style.setProperty('--dot-period', `${period}px`);
  el.style.setProperty('--dot-x', `${posX}px`);
  el.style.setProperty('--dot-y', `${posY}px`);
}

function syncMarqueeOverlay(active: boolean, sx0: number, sy0: number, sx1: number, sy1: number) {
  if (!marqueeBox) return;
  if (!active) {
    marqueeBox.style.display = 'none';
    return;
  }
  const r = normalizeScreenRect(sx0, sy0, sx1, sy1);
  if (r.sw < 1 && r.sh < 1) {
    marqueeBox.style.display = 'none';
    return;
  }
  marqueeBox.style.display = 'block';
  marqueeBox.style.left = `${r.sx}px`;
  marqueeBox.style.top = `${r.sy}px`;
  marqueeBox.style.width = `${r.sw}px`;
  marqueeBox.style.height = `${r.sh}px`;
}

function drawOverlay() {
  syncCanvasDots();

  // file labels
  labels.innerHTML = '';
  for (const d of docs) {
    const p = vp.docToScreen(d, 0, 0);
    const el = document.createElement('div');
    el.className = 'doc-label';
    el.textContent = `${d.name} · ${d.width}×${d.height}`;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y - 18}px`;
    labels.appendChild(el);
  }
  // selection box
  const primary = selection.primary;
  const multi = selection.nodes.length > 1;
  const spansDocs = selectionSpansDocuments(selection, docs);
  if (!primary) {
    selbox.style.display = 'none';
  } else if (multi || spansDocs) {
    const sb = selectionBoundsScreen(selection, docs, vpProjection);
    if (!sb || sb.sw <= 0 || sb.sh <= 0) selbox.style.display = 'none';
    else {
      selbox.style.display = 'block';
      selbox.style.left = `${sb.sx + sb.sw / 2}px`;
      selbox.style.top = `${sb.sy + sb.sh / 2}px`;
      selbox.style.width = `${sb.sw}px`;
      selbox.style.height = `${sb.sh}px`;
      selbox.style.transform = 'translate(-50%, -50%) rotate(0deg)';
      selbox.classList.toggle('noxf', true);
    }
  } else {
    const d = docOf(primary, docs);
    const b = nodeBounds(primary);
    if (!d || !b || b.w <= 0 || b.h <= 0) { selbox.style.display = 'none'; }
    else {
      const rot = primary.kind === 'group' ? 0 : primary.rotation;
      const c = vp.docToScreen(d, b.x + b.w / 2, b.y + b.h / 2);
      selbox.style.display = 'block';
      selbox.style.left = `${c.x}px`;
      selbox.style.top = `${c.y}px`;
      selbox.style.width = `${b.w * vp.zoom}px`;
      selbox.style.height = `${b.h * vp.zoom}px`;
      selbox.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
      selbox.classList.toggle('noxf', !canTransform(primary, true));
    }
  }

  // Update status bar
  const statusLeft = $('status-left');
  if (statusLeft) {
    statusLeft.innerHTML = `
      <span class="status-pill"><span class="engine-dot"></span>${vp.backendName}</span>
      ${fpsTracker.getHtml()}
      <span class="status-pill">Zoom: ${Math.round(vp.zoom * 100)}%</span>
      <span class="status-pill">Docs: ${docs.length}</span>
      ${primary ? (multi ? `<span class="status-pill" style="color:#fff;">Selected: <strong>${selection.nodes.length} layers</strong></span>` : `<span class="status-pill" style="color:#fff;">Layer: <strong>${escapeHtml(primary.name)}</strong></span>`) : ''}
      ${showHoverHintInStatus() && hoverHit ? `<span class="status-pill">Would select: <strong>${escapeHtml(hoverHit.name)}</strong></span>` : ''}
    `;
  }

  // Floating stage zoom indicator
  const zoomBadge = $('stage-zoom-badge');
  if (zoomBadge) {
    zoomBadge.textContent = `${Math.round(vp.zoom * 100)}%`;
  }
}
vp.onFrame = () => {
  fpsTracker.recordRenderTime(vp.lastRenderMs);
  drawOverlay();
  if (viewChanged()) scheduleSave();
};

// ---------- hit testing ----------
function pointInNode(n: Node, px: number, py: number): boolean {
  return isPointInLayer(n, px, py);
}

const hitTestCtx = () => ({
  docs,
  screenToDoc: (d: Doc, x: number, y: number) => vp.screenToDoc(d, x, y),
});

/** Leaf hit (hover hint). */
function hitTestLeaf(sx: number, sy: number): Node | null {
  return hitTestCanvasLayer(hitTestCtx(), sx, sy);
}

/** Click selection including Alt+group and group chrome. */
function hitTest(sx: number, sy: number, preferGroup = false): Node | null {
  return hitTestCanvasClickTarget(hitTestCtx(), sx, sy, { preferGroup });
}

/** Layer under pointer for hover hint (selection unchanged until click). */
let hoverHit: Node | null = null;

function updateHoverHint(sx: number, sy: number) {
  const nextHover = hitTestLeaf(sx, sy);
  if (nextHover?.id !== hoverHit?.id) {
    hoverHit = nextHover;
    drawOverlay();
  }
}

/** Show hover hint whenever we are not mid transform (pan is OK). */
function showHoverHintInStatus(): boolean {
  return mode !== 'move' && mode !== 'resize' && mode !== 'rotate' && mode !== 'marquee';
}

// ---------- pointer interaction ----------
const stage = $('stage');
const glEl = $('gl');
type Mode = 'none' | 'pan' | 'move' | 'resize' | 'rotate' | 'marquee';
let mode: Mode = 'none';
let lastX = 0, lastY = 0;
let lastLocalSx = 0;
let lastLocalSy = 0;
let dragBefore: Array<[Node, number, number]> | null = null;
let moved = false;
let marqueeStart: { sx: number; sy: number } | null = null;
let marqueeEnd: { sx: number; sy: number } | null = null;
let marqueeAdditive = false;
/** Click-to-deselect on empty canvas only applies when the marquee did not start over layer content. */
let marqueeStartedOnEmpty = false;

function beginMarquee(sx: number, sy: number, additive: boolean, startedOnEmpty: boolean) {
  mode = 'marquee';
  marqueeStart = { sx, sy };
  marqueeEnd = { sx, sy };
  marqueeAdditive = additive;
  marqueeStartedOnEmpty = startedOnEmpty;
  stage.style.cursor = 'crosshair';
}
let spaceDown = false;
let xf: { n: Node; before: Xform; hx: number; hy: number; angle0: number } | null = null;
/** Plain click on one layer in a multi-selection narrows to that layer on pointer up. */
let clickSelectNarrow: Node | null = null;

function resetPointerGesture() {
  psdLivePreviewActivated = false;
}

type HandleHit = { type: 'resize' | 'rotate'; hx: number; hy: number };

/** Which resize/rotate handle (if any) is under the pointer. Done in screen space so it works at any zoom/rotation. */
function handleAt(sx: number, sy: number): HandleHit | null {
  const n = selection.nodes.length === 1 ? selection.primary : null;
  if (!n || !canTransform(n, true)) return null;
  const d = docOf(n, docs);
  if (!d) return null;
  const c = vp.docToScreen(d, n.x + n.w / 2, n.y + n.h / 2);
  const hw = (n.w * vp.zoom) / 2;
  const hh = (n.h * vp.zoom) / 2;
  const th = (n.rotation * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const at = (lx: number, ly: number) => ({ x: c.x + lx * cs - ly * sn, y: c.y + lx * sn + ly * cs });
  const R = 8;
  const rp = at(0, -hh - 22);
  if (Math.hypot(sx - rp.x, sy - rp.y) <= R + 4) return { type: 'rotate', hx: 0, hy: 0 };
  for (const [hx, hy] of HANDLES) {
    const p = at(hx * hw, hy * hh);
    if (Math.hypot(sx - p.x, sy - p.y) <= R) return { type: 'resize', hx, hy };
  }
  return null;
}

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cg stroke='%23000' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='M4.5 10 A5.5 5.5 0 0 1 14.5 6.2'/%3E%3Cpolyline points='15 3 15 6.5 11.5 6.5'/%3E%3Cpath d='M15.5 10 A5.5 5.5 0 0 1 5.5 13.8'/%3E%3Cpolyline points='5 17 5 13.5 8.5 13.5'/%3E%3C/g%3E%3Cg stroke='%23fff' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='M4.5 10 A5.5 5.5 0 0 1 14.5 6.2'/%3E%3Cpolyline points='15 3 15 6.5 11.5 6.5'/%3E%3Cpath d='M15.5 10 A5.5 5.5 0 0 1 5.5 13.8'/%3E%3Cpolyline points='5 17 5 13.5 8.5 13.5'/%3E%3C/g%3E%3C/svg%3E") 10 10, crosshair`;

function cursorFor(h: HandleHit | null): string {
  if (!h) return spaceDown ? 'grab' : 'default';
  if (h.type === 'rotate') return ROTATE_CURSOR;
  if (h.hy === 0) return 'ew-resize';
  if (h.hx === 0) return 'ns-resize';
  return h.hx * h.hy > 0 ? 'nwse-resize' : 'nesw-resize';
}

function applyResize(sx: number, sy: number, shift: boolean) {
  if (!xf) return;
  const { n, before: b, hx, hy } = xf;
  const d = docOf(n, docs);
  if (!d) return;
  const p = vp.screenToDoc(d, sx, sy);
  const th = (b.rotation * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const rot = (lx: number, ly: number) => ({ x: lx * cs - ly * sn, y: lx * sn + ly * cs });
  const unrot = (wx: number, wy: number) => ({ x: wx * cs + wy * sn, y: -wx * sn + wy * cs });
  // the side opposite to the dragged handle stays where it is
  const aOff = rot(-hx * (b.w / 2), -hy * (b.h / 2));
  const anchor = { x: b.x + b.w / 2 + aOff.x, y: b.y + b.h / 2 + aOff.y };
  const dl = unrot(p.x - anchor.x, p.y - anchor.y);
  let nw = hx !== 0 ? Math.max(MIN_SIZE, hx * dl.x) : b.w;
  let nh = hy !== 0 ? Math.max(MIN_SIZE, hy * dl.y) : b.h;
  if (shift && hx !== 0 && hy !== 0) {
    const k = Math.max(nw / b.w, nh / b.h);
    nw = b.w * k;
    nh = b.h * k;
  }
  const off = rot(hx * (nw / 2), hy * (nh / 2));
  const cx = anchor.x + off.x;
  const cy = anchor.y + off.y;
  n.w = nw;
  n.h = nh;
  n.x = cx - nw / 2;
  n.y = cy - nh / 2;
}

function applyRotate(sx: number, sy: number, shift: boolean) {
  if (!xf) return;
  const { n, before: b } = xf;
  const d = docOf(n, docs);
  if (!d) return;
  const p = vp.screenToDoc(d, sx, sy);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const ang = rotationPointerAngleDeg(n, p.x, p.y, cx, cy);
  let r = b.rotation + (ang - xf.angle0);
  if (shift) r = Math.round(r / 15) * 15;
  n.rotation = normAngle(r);
}

/** Same origin as Viewport (`#gl` client size + screenToDoc). */
const local = (e: PointerEvent | WheelEvent) => {
  const r = glEl.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
};

stage.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('#stage-controls') || target.closest('#empty') || target.closest('#toast-container') || target.closest('#modal-container')) {
    return;
  }
  const { sx, sy } = local(e);
  lastX = e.clientX; lastY = e.clientY; moved = false;
  clickSelectNarrow = null;
  resetPointerGesture();
  if (posPending) commitPosPending();
  if (xfPending) commitXfPending();
  stage.setPointerCapture(e.pointerId);
  if (e.button === 1 || spaceDown) { mode = 'pan'; stage.style.cursor = 'grabbing'; return; }
  if (e.button !== 0) return;
  const hh = handleAt(sx, sy);
  const primary = selection.primary;
  if (hh && primary && selection.nodes.length === 1) {
    const d = docOf(primary, docs)!;
    const p = vp.screenToDoc(d, sx, sy);
    const angle0 = rotationPointerAngleDeg(
      primary,
      p.x,
      p.y,
      primary.x + primary.w / 2,
      primary.y + primary.h / 2,
    );
    xf = { n: primary, before: getX(primary), hx: hh.hx, hy: hh.hy, angle0 };
    mode = hh.type;
    stage.style.cursor = cursorFor(hh);
    return;
  }
  const modSelect = e.ctrlKey || e.metaKey;
  if (modSelect) {
    e.preventDefault();
    beginMarquee(sx, sy, e.shiftKey, !hitTest(sx, sy, false));
    return;
  }
  if (selection.nodes.length && selectionCanMove(selection)) {
    if (pointInSelectionForMoveAtScreen(selection, sx, sy, docs, vpProjection, pointInNode)) {
      mode = 'move';
      dragBefore = snapshotPositions(movableLeavesForSelection(selection));
      if (selection.nodes.length > 1) {
        const hit = hitTestLeaf(sx, sy);
        if (hit && isNodeSelected(selection, hit)) clickSelectNarrow = hit;
      }
      return;
    }
  }
  const hit = hitTest(sx, sy, e.altKey);
  if (hit) {
    if (e.shiftKey) {
      applySelection(toggleNodeInSelection(selection, hit, docs));
      return;
    }
    applySelection(replaceSelection(hit));
    if (selectionCanMove(selection)) {
      mode = 'move';
      dragBefore = snapshotPositions(movableLeavesForSelection(selection));
    }
  } else {
    applySelection(emptySelection());
    mode = 'pan';
    stage.style.cursor = 'grabbing';
  }
});

stage.addEventListener('pointermove', (e) => {
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  const { sx, sy } = local(e);
  lastLocalSx = sx;
  lastLocalSy = sy;
  if (mode === 'none') {
    if (!spaceDown) stage.style.cursor = cursorFor(handleAt(sx, sy));
    updateHoverHint(sx, sy);
    return;
  }
  if (mode === 'resize' || mode === 'rotate') {
    stage.style.cursor = mode === 'rotate' ? ROTATE_CURSOR : (xf ? cursorFor({ type: 'resize', hx: xf.hx, hy: xf.hy }) : 'default');
    if (mode === 'resize') applyResize(sx, sy, e.shiftKey);
    else applyRotate(sx, sy, e.shiftKey);
    moved = true;
    if (xf) activatePsdLivePreviewForEdits([xf.n]);
    scheduleSceneSync();
    return;
  }
  if (mode === 'marquee' && marqueeStart) {
    marqueeEnd = { sx, sy };
    const dist = Math.hypot(sx - marqueeStart.sx, sy - marqueeStart.sy);
    if (dist >= MARQUEE_DRAG_THRESHOLD_PX) moved = true;
    syncMarqueeOverlay(true, marqueeStart.sx, marqueeStart.sy, sx, sy);
    drawOverlay();
    return;
  }
  if (mode === 'pan') {
    vp.panBy(dx, dy);
    updateHoverHint(sx, sy);
  } else if (mode === 'move' && selection.nodes.length && dragBefore) {
    moveLeavesBy(movableLeavesForSelection(selection), dx / vp.zoom, dy / vp.zoom);
    moved = true;
    activatePsdLivePreviewForEdits(movableLeavesForSelection(selection));
    scheduleSceneSync();
  }
});

function endPointer() {
  if ((mode === 'resize' || mode === 'rotate') && xf) {
    const { n, before } = xf;
    if (moved) {
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      const w = Math.max(1, Math.round(n.w));
      const h = Math.max(1, Math.round(n.h));
      const after: Xform = { x: cx - w / 2, y: cy - h / 2, w, h, rotation: normAngle(n.rotation) };
      Object.assign(n, after);
      hist.exec(transformCommand(n, before, after), true);
    }
    xf = null;
  }
  if (mode === 'move' && moved && dragBefore) {
    const leaves = movableLeavesForSelection(selection);
    for (const n of leaves) { n.x = Math.round(n.x); n.y = Math.round(n.y); }
    hist.exec(positionsCommand('Move', dragBefore, snapshotPositions(leaves)), true);
  } else if (mode === 'move' && !moved && clickSelectNarrow) {
    applySelection(replaceSelection(clickSelectNarrow));
  }
  if (mode === 'marquee' && marqueeStart && marqueeEnd) {
    const dist = Math.hypot(marqueeEnd.sx - marqueeStart.sx, marqueeEnd.sy - marqueeStart.sy);
    if (moved && dist >= MARQUEE_DRAG_THRESHOLD_PX) {
      const rect = normalizeScreenRect(marqueeStart.sx, marqueeStart.sy, marqueeEnd.sx, marqueeEnd.sy);
      const hits = nodesInMarqueeRect(docs, rect, vpProjection);
      applySelection(selectionFromMarqueeHits(hits, selection, marqueeAdditive));
    } else if (!marqueeAdditive && marqueeStartedOnEmpty) {
      applySelection(emptySelection());
    }
    syncMarqueeOverlay(false, 0, 0, 0, 0);
  }
  mode = 'none';
  dragBefore = null;
  clickSelectNarrow = null;
  marqueeStart = null;
  marqueeEnd = null;
  marqueeAdditive = false;
  marqueeStartedOnEmpty = false;
  stage.style.cursor = spaceDown ? 'grab' : 'default';
  updateHoverHint(lastLocalSx, lastLocalSy);
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('pointerleave', () => {
  if (hoverHit) {
    hoverHit = null;
    drawOverlay();
  }
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { sx, sy } = local(e);
  vp.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
  if (e.code === 'Space') { spaceDown = true; stage.style.cursor = 'grab'; e.preventDefault(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteNode(selection.primary); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateNode(selection.primary); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); ungroupSelectedLayer(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); groupSelectedLayers(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? hist.redo() : hist.undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); hist.redo(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; stage.style.cursor = 'default'; }
});

// ---------- files ----------
async function processFolderScan(scan: ReturnType<typeof discoverFromFileList>) {
  if (scan.importable.length === 0) {
    await alertModal({
      title: 'No Supported Files in Folder',
      message: formatEmptyFolderScanMessage(scan),
      type: 'warning',
      confirmText: 'Got It',
    });
    return;
  }

  const selectedIdx = await folderImportModal({
    folderName: scan.folderName,
    importable: scan.importable.map((d) => ({
      relativePath: d.relativePath,
      name: d.file.name,
      size: d.file.size,
      format: d.format,
    })),
    skipped: scan.skipped,
    totalScanned: scan.totalScanned,
  });
  if (selectedIdx === null) return;

  const queue = selectedIdx.map((i) => scan.importable[i]).filter(Boolean) as FolderDiscoveredFile[];
  if (queue.length === 0) return;

  let successCount = 0;
  const failedNames: string[] = [];
  const usedNames = new Set(docs.map((d) => d.name));
  const added: Doc[] = [];

  for (const item of queue) {
    const displayName = uniqueDocumentName(item.relativePath, usedNames);
    try {
      const bytes = await item.file.arrayBuffer();
      added.push(addDoc(await importDocument(displayName, bytes, item.format)));
      successCount++;
    } catch (err) {
      failedNames.push(displayName);
      console.error(err);
    }
  }
  recordOpened(added);

  if (successCount > 0) {
    toast(
      `Imported ${successCount} document(s) from "${scan.folderName}".${failedNames.length ? ` Failed: ${failedNames.join(', ')}` : ''}`,
      failedNames.length ? 'warning' : 'success',
    );
  } else if (failedNames.length) {
    await alertModal({
      title: 'Folder Import Error',
      message: `Could not import selected files from "${scan.folderName}": ${failedNames.join(', ')}`,
      type: 'error',
      confirmText: 'OK',
    });
  }
}

async function runFolderImportFromFiles(
  files: File[],
  folderName: string,
  source: FolderImportSource,
  collectionMeta?: FolderCollectionMeta,
) {
  await processFolderScan(discoverFromFileList(files, folderName, { source, collectionMeta }));
}

async function triggerOpenFolder() {
  if ('showDirectoryPicker' in window) {
    try {
      const dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      const { files, meta } = await collectFilesFromDirectoryPicker(dirHandle);
      await runFolderImportFromFiles(files, dirHandle.name, 'directory-picker', meta);
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('showDirectoryPicker error, falling back to input:', err);
    }
  }
  const folder = $('folder') as HTMLInputElement | null;
  if (folder) folder.click();
}

async function openFiles(files: FileList | File[]) {
  const list = Array.from(files);
  const added: Doc[] = [];

  for (const f of list) {
    const format = formatFromFileName(f.name);
    if (!format) {
      alertModal({
        title: 'Unsupported File Format',
        message: `"${f.name}" is not supported. Open a .psd, .ai, .indd, or .idml file.`,
        type: 'error',
        confirmText: 'OK',
      });
      continue;
    }
    const isNativeIndd = f.name.toLowerCase().endsWith('.indd');
    if (isNativeIndd) {
      const h = await fetchBackendHealth();
      const st = healthStateFromResponse(h);
      if (st === 'offline' || st === 'not-found') {
        toast('InDesign server offline. Starting conversion...', 'warning');
      } else if (st === 'starting') {
        toast('InDesign server starting...', 'info');
      } else {
        toast('Converting .indd to IDML via InDesign server...', 'info');
      }
    }
    try {
      added.push(addDoc(await importDocument(f.name, await f.arrayBuffer(), format)));
    } catch (err) {
      alertModal({
        title: importErrorModalTitle(format),
        message: `Could not import "${f.name}": ${(err as Error).message}`,
        type: 'error',
      });
      console.error(err);
    }
  }
  recordOpened(added);
}

function mountDoc(doc: Doc) {
  if (doc.format === 'indd') {
    rasterizeAllIdmlTextNodes(doc);
  }
  docs.push(doc);
  vp.addDoc(doc, docs.length - 1);
}

/** Puts a newly opened file on the canvas. The caller records the open action with recordOpened. */
function addDoc(doc: Doc): Doc {
  doc.offsetX = docs.length ? Math.max(...docs.map((d) => d.offsetX + d.width)) + 200 : 0;
  mountDoc(doc);
  vp.fit(docs);
  refresh();
  scheduleSave();
  const n = [...walk(doc.roots)].filter((x) => x.unsupported.length).length;
  if (n) {
    toast(`${doc.name} opened with ${n} read-only layer(s).`, 'warning');
  } else {
    toast(`${doc.name} opened successfully.`, 'success');
  }
  return doc;
}

/** One undo step for everything opened by one user action (a file, several files, or a folder). */
function recordOpened(added: Doc[]) {
  if (added.length) hist.exec(openDocsCommand(docs, added, vp), true);
}

// File and Folder Picker bindings
$('btn-open').onclick = () => $('file').click();
const btnOpenFolder = $('btn-open-folder');
if (btnOpenFolder) btnOpenFolder.onclick = () => void triggerOpenFolder();

($('file') as HTMLInputElement).onchange = (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length) void openFiles(input.files);
  input.value = '';
};

const folderInput = $('folder') as HTMLInputElement | null;
if (folderInput) {
  folderInput.onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length) {
      const list = Array.from(input.files);
      const folderName = rootFolderNameFromFileList(list);
      await runFolderImportFromFiles(list, folderName, 'webkitdirectory');
    }
    input.value = '';
  };
}

$('btn-sample').onclick = () => {
  void (async () => {
    const btn = $('btn-sample') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    toast('Loading sample 11330937.psd (68MB)...', 'info');
    try {
      let doc: Doc;
      try {
        doc = await fetchPublicPsd('/11330937.psd', '11330937.psd');
      } catch {
        doc = await fetchPublicPsd('/10960916.psd', '10960916.psd');
      }
      recordOpened([addDoc(doc)]);
    } catch (err) {
      alertModal({
        title: 'Sample PSD Error',
        message: (err as Error).message,
        type: 'error',
      });
      console.error(err);
    } finally {
      if (btn) btn.disabled = false;
    }
  })();
};

const btnSampleAi = $('btn-sample-ai');
if (btnSampleAi) {
  btnSampleAi.onclick = () => {
    void (async () => {
      const btn = $('btn-sample-ai') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      toast('Loading sample.ai...', 'info');
      try {
        recordOpened([addDoc(await fetchPublicAi('/sample.ai', 'sample.ai'))]);
      } catch (err) {
        alertModal({
          title: 'Sample AI Error',
          message: (err as Error).message,
          type: 'error',
        });
        console.error(err);
      } finally {
        if (btn) btn.disabled = false;
      }
    })();
  };
}

const btnSampleIndd = $('btn-sample-indd');
if (btnSampleIndd) {
  btnSampleIndd.onclick = () => {
    void (async () => {
      const btn = $('btn-sample-indd') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      toast('Loading sample free_391311709.indd...', 'info');
      try {
        const res = await fetch('/free_391311709.indd');
        if (!res.ok) throw new Error(`Could not load /free_391311709.indd (${res.status}).`);
        const inddBytes = await res.arrayBuffer();

        let doc: Doc;
        try {
          doc = await importDocument('free_391311709.indd', inddBytes, 'indd');
        } catch (convErr) {
          console.warn('Native InDesign bridge conversion failed, falling back to pre-converted IDML package:', convErr);
          const fallbackRes = await fetch('/free_391311709.idml');
          if (fallbackRes.ok) {
            const idmlBytes = await fallbackRes.arrayBuffer();
            doc = await importDocument('free_391311709.indd', idmlBytes, 'indd');
            doc.uploadedBytes = inddBytes;
          } else {
            throw convErr;
          }
        }
        recordOpened([addDoc(doc)]);
      } catch (err) {
        alertModal({
          title: 'Sample INDD Error',
          message: (err as Error).message,
          type: 'error',
        });
        console.error(err);
      } finally {
        if (btn) btn.disabled = false;
      }
    })();
  };
}

// const btnInddReport = $('btn-indd-debug-report');
// if (btnInddReport) {
//   btnInddReport.onclick = () => {
//     const doc = activeInddDoc() ?? docs.find((d) => d.format === 'indd');
//     if (doc?.inddImportReport) {
//       downloadJson(`${doc.name}.import-report.json`, doc.inddImportReport);
//     } else {
//       toast('No active INDD document report available.', 'warning');
//     }
//   };
// }

// const btnInddIdml = $('btn-indd-debug-idml');
// if (btnInddIdml) {
//   btnInddIdml.onclick = async () => {
//     const doc = activeInddDoc() ?? docs.find((d) => d.format === 'indd');
//     if (doc) {
//       try {
//         const idmlBytes = await exportIdml(doc);
//         downloadBytes(`${doc.name.replace(/\.(indd|idml)$/i, '')}.edited.idml`, idmlBytes, 'application/vnd.adobe.indesign-idml-package');
//         toast('Downloaded IDML package.', 'success');
//       } catch (err) {
//         toast(`Failed to export IDML: ${(err as Error).message}`, 'error');
//       }
//     }
//   };
// }

$('btn-undo').onclick = () => hist.undo();
$('btn-redo').onclick = () => hist.redo();
$('btn-delete').onclick = () => deleteNode(selection.primary);
$('btn-duplicate').onclick = () => duplicateNode(selection.primary);
$('btn-group').onclick = () => groupSelectedLayers();
$('btn-ungroup').onclick = () => ungroupSelectedLayer();
$('btn-fit').onclick = () => { vp.fit(docs); drawOverlay(); };

$('btn-export').onclick = async () => {
  if (docs.length === 0) return;
  const doc = selection.primary ? docOf(selection.primary, docs) : docs.length === 1 ? docs[0] : null;
  if (!doc) {
    alertModal({
      title: 'Export Document',
      message: docs.length
        ? 'Please select a layer in the document you want to export.'
        : 'Please open a .psd or .ai document first.',
      type: 'warning',
      confirmText: 'OK',
    });
    return;
  }
  try {
    const warnBefore = doc.warnings.length;
    const bytes = await exportDocument(doc);
    const download = exportEditedDownloadName(doc);
    const url = URL.createObjectURL(new Blob([bytes], { type: exportEditedMimeType(doc) }));
    const a = document.createElement('a');
    a.href = url;
    a.download = download;
    a.click();
    URL.revokeObjectURL(url);
    const exportNotes = doc.warnings.slice(warnBefore).filter((w) => w.startsWith('Export note: '));
    if (exportNotes.length) {
      toast(
        `Exported ${download}. ${exportNotes.length} item(s) could not be fully written — see File Warnings in Properties.`,
        'warning',
      );
    } else {
      toast(`Exported ${a.download}`, 'success');
    }
  } catch (err) {
    if (err instanceof BackendError && doc.origin === 'indd') {
      try {
        const idmlBytes = await exportIdml(doc);
        const fallbackName = `${doc.name.replace(/\.(indd|idml)$/i, '')}.edited.idml`;
        downloadBytes(fallbackName, idmlBytes, 'application/vnd.adobe.indesign-idml-package');
        toast(`Native InDesign export failed. Downloaded patched IDML (${fallbackName}) instead.`, 'warning');
        return;
      } catch (fallbackErr) {
        console.error('IDML fallback export failed:', fallbackErr);
      }
    }
    alertModal({
      title: 'Export Failed',
      message: `Failed to export: ${(err as Error).message}`,
      type: 'error',
    });
    console.error(err);
  }
};

// Floating stage controls: stop propagation so clicks work reliably without panning canvas
const stageControls = $('stage-controls');
if (stageControls) {
  stageControls.addEventListener('pointerdown', (e) => e.stopPropagation());
  stageControls.addEventListener('mousedown', (e) => e.stopPropagation());
  stageControls.addEventListener('click', (e) => e.stopPropagation());
}

$('zoom-in-btn').onclick = (e) => {
  e.stopPropagation();
  vp.zoomAt(vp.width / 2, vp.height / 2, 1.25);
  drawOverlay();
  scheduleSave();
};
$('zoom-out-btn').onclick = (e) => {
  e.stopPropagation();
  vp.zoomAt(vp.width / 2, vp.height / 2, 0.8);
  drawOverlay();
  scheduleSave();
};
$('zoom-fit-btn').onclick = (e) => {
  e.stopPropagation();
  vp.fit(docs);
  drawOverlay();
  scheduleSave();
};
$('zoom-100-btn').onclick = (e) => {
  e.stopPropagation();
  vp.setView({ cx: vp.cx, cy: vp.cy, zoom: 1 });
  drawOverlay();
  scheduleSave();
};
const zoomBadge = $('stage-zoom-badge');
if (zoomBadge) {
  zoomBadge.onclick = (e) => {
    e.stopPropagation();
    vp.setView({ cx: vp.cx, cy: vp.cy, zoom: 1 });
    drawOverlay();
    scheduleSave();
  };
}

// Hero empty state buttons: stop propagation so clicks trigger cleanly
const emptyEl = $('empty');
if (emptyEl) {
  emptyEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  emptyEl.addEventListener('mousedown', (e) => e.stopPropagation());
}

const emptyOpen = $('empty-open');
if (emptyOpen) emptyOpen.onclick = (e) => { e.stopPropagation(); $('file').click(); };
const emptyFolder = $('empty-folder');
if (emptyFolder) emptyFolder.onclick = (e) => { e.stopPropagation(); void triggerOpenFolder(); };

// Shortcuts Modal Popup
const btnShortcuts = $('btn-shortcuts');
if (btnShortcuts) {
  btnShortcuts.onclick = () => {
    infoListModal({
      title: 'Keyboard Shortcuts & Canvas Controls',
      subtitle: 'Fast productivity tips for Creatvise Canvas',
      items: [
        { label: 'Pan Canvas', tag: 'Navigation', text: 'Drag empty canvas, hold Spacebar and drag, or middle-click drag' },
        { label: 'Zoom Viewport', tag: 'Navigation', text: 'Mouse wheel scroll to zoom, or use floating controls bottom-right' },
        { label: 'Select Layer', tag: 'Editing', text: 'Click directly on layer pixel on canvas, or click in Layers panel' },
        { label: 'Marquee Select', tag: 'Editing', text: 'Ctrl+drag (Cmd+drag on Mac) on the canvas — layers intersecting the box are selected. Ctrl+Shift+drag adds to the selection.' },
        { label: 'Move Layer', tag: 'Editing', text: 'Click & drag selected layer on the canvas stage' },
        { label: 'Transform Layer', tag: 'Editing', text: 'Drag selection boundary handles to resize, top handle to rotate' },
        { label: 'Proportional Resize', tag: 'Modifier', text: 'Hold Shift while dragging corner handles' },
        { label: 'Rename Layer', tag: 'Layers', text: 'Double click layer row or click edit pencil icon' },
        { label: 'Duplicate Layer', tag: 'Action', text: 'Press Ctrl+D or click Duplicate button in toolbar / layers row' },
        { label: 'Delete Layer', tag: 'Action', text: 'Press Delete or Backspace key, or click trash icon' },
        { label: 'Undo / Redo', tag: 'History', text: 'Ctrl+Z to Undo, Ctrl+Y or Ctrl+Shift+Z to Redo' },
        { label: 'Auto-Save', tag: 'Storage', text: 'Edits automatically persist into local browser storage in real-time' },
      ],
      confirmText: 'Got It',
    });
  };
}

stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) void openFiles(e.dataTransfer.files);
});

// ---------- saving to the browser (IndexedDB) ----------
type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'off';
const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  pending: 'Unsaved changes…',
  saving: 'Saving…',
  saved: 'All changes saved',
  failed: "Couldn't save to browser",
  off: 'Storage unavailable',
};
let persistReady = false;
let persistOff = false;
let saveTimer = 0;
let saving = false;
let dirty = false;
let warnedSaveFailure = false;
let savedFileIds = new Set<string>();
let lastView = { cx: 0, cy: 0, zoom: 1 };

function setSaveState(s: SaveState) {
  const el = $('save-state');
  if (el) {
    if (el.dataset.state !== s) { el.dataset.state = s; el.textContent = SAVE_TEXT[s]; }
  }
  const dot = $('save-dot');
  if (dot) {
    dot.className = `save-dot ${s}`;
  }
}

function viewChanged(): boolean {
  const v = vp.getView();
  return v.cx !== lastView.cx || v.cy !== lastView.cy || v.zoom !== lastView.zoom;
}

let savePendingFlush = false;

function scheduleSave() {
  if (!persistReady || persistOff) return;
  dirty = true;
  setSaveState('pending');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void doSave(), 600);
}

/** Persist immediately (e.g. after delete) so a quick refresh does not restore stale layers. */
function flushSave(): Promise<void> {
  if (!persistReady || persistOff) return Promise.resolve();
  dirty = true;
  savePendingFlush = true;
  clearTimeout(saveTimer);
  saveTimer = 0;
  return doSave();
}

async function doSave(): Promise<void> {
  if (saving) {
    savePendingFlush = true;
    return;
  }
  if (!dirty || !persistReady || persistOff) return;
  saving = true;
  savePendingFlush = false;
  dirty = false;
  setSaveState('saving');
  try {
    const view = vp.getView();
    const ws: SavedWorkspace = { version: 1, savedAt: Date.now(), docs: docs.map(serializeDoc), view };
    const fresh = docs.filter((d) => !savedFileIds.has(d.id)).map((d) => ({ id: d.id, name: d.name, bytes: d.original }));
    await saveWorkspace(ws, fresh, docs.map((d) => d.id));
    savedFileIds = new Set(docs.map((d) => d.id));
    lastView = view;
    if (!dirty) setSaveState('saved');
  } catch (err) {
    console.error(err);
    dirty = true;
    setSaveState('failed');
    if (!warnedSaveFailure) {
      warnedSaveFailure = true;
      toast("Couldn't save your work in this browser. Export files to keep them.", 'error');
    }
  } finally {
    saving = false;
  }
  if (dirty && !warnedSaveFailure) {
    if (savePendingFlush) {
      void doSave();
    } else {
      scheduleSave();
    }
  }
}

async function restoreWorkspace() {
  let loaded: Awaited<ReturnType<typeof loadWorkspace>>;
  try {
    loaded = await loadWorkspace();
  } catch (err) {
    console.error(err);
    persistOff = true;
    setSaveState('off');
    return;
  }
  if (loaded && loaded.ws.docs.length) {
    const failed: string[] = [];
    for (const sd of loaded.ws.docs) {
      const bytes = loaded.files.get(sd.id);
      if (!bytes) { failed.push(sd.name); continue; }
      try {
        const doc = await importDocument(sd.name, bytes, sd.format);
        doc.id = sd.id;
        applySavedDoc(doc, sd);
        mountDoc(doc);
        savedFileIds.add(sd.id);
      } catch (err) {
        failed.push(sd.name);
        console.error(err);
      }
    }
    if (docs.length) {
      if (loaded.ws.view) vp.setView(loaded.ws.view); else vp.fit(docs);
      lastView = vp.getView();
      refresh();
      if (failed.length) {
        toast(`Restored ${docs.length} file(s). Couldn't restore: ${failed.join(', ')}`, 'warning');
      } else {
        toast(`Restored ${docs.length} file(s) from your last session`, 'success');
      }
    } else if (failed.length) {
      toast(`Couldn't restore: ${failed.join(', ')}`, 'error');
    }
    if (docs.length) setSaveState('saved');
  }
  persistReady = true;
}

$('btn-clear').onclick = async () => {
  if (docs.length === 0) {
    toast('No open files in workspace to clear.', 'warning');
    return;
  }
  const confirmed = await confirmModal({
    title: 'Clear Saved Workspace?',
    message: 'Remove all open files and saved work from this browser? This action will reset your workspace and cannot be undone.',
    confirmText: 'Clear Everything',
    cancelText: 'Keep Working',
    danger: true,
  });
  if (!confirmed) return;
  persistOff = true;
  clearTimeout(saveTimer);
  hist.clear();
  docs.length = 0;
  try { await clearAll(); } catch (err) { console.error(err); }
  toast('Workspace cleared. Reloading...', 'info');
  window.location.reload();
};

window.addEventListener('pagehide', () => {
  if (dirty && persistReady && !persistOff) {
    clearTimeout(saveTimer);
    void doSave();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty && persistReady && !persistOff) {
    clearTimeout(saveTimer);
    void doSave();
  }
});

// ---------- boot ----------
function dismissLoader() {
  const loader = $('app-loader');
  if (loader && !loader.classList.contains('loaded')) {
    loader.classList.add('loaded');
    setTimeout(() => loader.remove(), 400);
  }
}

vp.init($('gl')).then(async () => {
  refresh();
  await restoreWorkspace();
  dismissLoader();
}).catch((err) => {
  dismissLoader();
  alertModal({
    title: 'Graphics Engine Error',
    message: `Could not start the renderer: ${(err as Error).message}`,
    type: 'error',
  });
  console.error(err);
});

// Safety fallback to ensure loader disappears even if WebGPU initialization delays
setTimeout(dismissLoader, 3000);
refresh();

// ADD — end of file
async function updateIndesignStatusChip() {
  const chip = document.getElementById('indesign-status-chip');
  if (!chip) return;
  const h = await fetchBackendHealth();
  const st = healthStateFromResponse(h);
  chip.className = `indesign-status-chip ${st === 'online' ? 'online' : 'offline'}`;
  chip.textContent = indesignChipLabel(h);
  chip.title = indesignChipTitle(h);
}

updateIndesignStatusChip();
window.setInterval(updateIndesignStatusChip, 10_000);

// Start real-time FPS performance tracking
fpsTracker.start();

$('status')?.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('#fps-indicator');
  if (target) {
    const gpuPart = vp.lastRenderMs > 0 ? ` · GPU draw: ${vp.lastRenderMs.toFixed(2)}ms` : '';
    toast(`Performance: ${fpsTracker.fps} FPS · Frame time: ${fpsTracker.frameMs}ms${gpuPart} · Engine: ${vp.backendName}`, 'info');
  }
});

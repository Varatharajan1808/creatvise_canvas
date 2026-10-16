import type { Doc, Node } from './model';
import { aiDocumentSupportsDuplicate } from './aiLayerMeta';
import {
  aiReorderDocumentBlockedReason,
  canReorderAiStackStep,
  canReorderAiDocument,
  canReorderAiLayer,
} from './aiReorder';
import { canReorderSiblingIndex } from './sourceTree';
import { canEditAiLiveTextOnNode } from './aiTextEdit';
import { canReplaceAiPlacedImageOnNode, getAiPlacedImageReplaceBlockedReason } from './aiImageEdit';
import { canReplaceIdmlPlacedImage } from './idml/placedImage';

/** Phase 1: shared UI/policy for formats that use the common `Node` editing path. */
export type SupportedImportFormat = 'psd' | 'ai' | 'indd';

export interface FormatCapabilities {
  export: boolean;
  /** Duplicate inserts into the native file tree on export (PSD ag-psd). */
  duplicateNativeTree: boolean;
  /** Create/ungroup folders in the native layer tree (PSD only in Phase 6). */
  groupLayers: boolean;
  folderBatchImport: boolean;
  /** Layer panel text editing (format-specific backing required). */
  editText: boolean;
  editShape: boolean;
  replaceImage: boolean;
  /** Resize/rotate handles and numeric W/H/rotation; per-layer rules in `canTransform` still apply. */
  resizeRotate: boolean;
  deleteLayer: boolean;
  /** Static format flag; AI also requires `canReorderAiDocument` at runtime. */
  reorderLayer: boolean;
}

const CAPS: Record<SupportedImportFormat, FormatCapabilities> = {
  psd: {
    export: true,
    duplicateNativeTree: true,
    groupLayers: true,
    folderBatchImport: true,
    editText: true,
    editShape: true,
    replaceImage: true,
    resizeRotate: true,
    deleteLayer: true,
    reorderLayer: true,
  },
  ai: {
    export: true,
    duplicateNativeTree: true,
    groupLayers: true,
    folderBatchImport: true,
    editText: false,
    editShape: true,
    replaceImage: false,
    resizeRotate: true,
    deleteLayer: true,
    reorderLayer: false,
  },
  indd: {
    export: true,
    duplicateNativeTree: false,
    groupLayers: false,
    folderBatchImport: false,
    editText: true,
    editShape: true,
    replaceImage: false,
    resizeRotate: true,
    deleteLayer: true,
    reorderLayer: false,
  },
};

export function isSupportedImportFormat(format: Doc['format']): format is SupportedImportFormat {
  return format === 'psd' || format === 'ai' || format === 'indd';
}

export function capabilitiesFor(format: Doc['format']): FormatCapabilities | null {
  if (format === 'psd') return CAPS.psd;
  if (format === 'ai') return CAPS.ai;
  if (format === 'indd') return CAPS.indd;
  return null;
}

export function capabilitiesForDoc(doc: Doc): FormatCapabilities | null {
  return capabilitiesFor(doc.format);
}

export function canExportDocument(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.export ?? false;
}

export function canDuplicateLayer(doc: Doc): boolean {
  const caps = capabilitiesForDoc(doc);
  if (!caps?.duplicateNativeTree) return false;
  if (doc.format === 'ai') return aiDocumentSupportsDuplicate(doc) && !doc.roots.some((r) => r.kind === 'group');
  return true;
}

export function canResizeRotate(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.resizeRotate ?? false;
}

export function canDeleteLayer(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.deleteLayer ?? false;
}

export const GROUP_LAYERS_BLOCKED_MESSAGE =
  'Grouping and ungrouping are supported for PSD and eligible AI documents only.';

export function canGroupLayers(doc: Doc): boolean {
  if (doc.format === 'ai') return Boolean(capabilitiesForDoc(doc)?.groupLayers && doc.ai?.hasOcg);
  return capabilitiesForDoc(doc)?.groupLayers ?? false;
}

export function canUngroupLayer(doc: Doc, node: Node): boolean {
  if (!canGroupLayers(doc)) return false;
  if (node.kind !== 'group') return false;
  if (node.children.length === 0) return false;
  return true;
}

export function canReorderLayer(doc: Doc): boolean {
  if (doc.format === 'ai') return canReorderAiDocument(doc);
  return capabilitiesForDoc(doc)?.reorderLayer ?? false;
}

/** User-facing reason when layer reorder is unavailable for this document. */
export function reorderLayerBlockedReason(doc: Doc): string {
  if (doc.format === 'ai') {
    return aiReorderDocumentBlockedReason(doc) ?? 'Layer reorder is not available for this file.';
  }
  if (!capabilitiesForDoc(doc)?.reorderLayer) {
    return 'Layer reordering is not supported for this file format.';
  }
  return 'Layer reorder is not available.';
}

/** Whether a layer can move one step in the stack (up = toward front). */
export function canReorderLayerStackStep(
  doc: Doc,
  node: Node,
  siblings: Node[],
  fromIdx: number,
  toIdx: number,
): boolean {
  if (fromIdx === toIdx || fromIdx < 0 || fromIdx >= siblings.length) return false;
  if (toIdx < 0 || toIdx >= siblings.length) return false;
  if (doc.format === 'ai') return canReorderAiStackStep(doc, node, siblings, fromIdx, toIdx);
  return canReorderLayer(doc) && canReorderSiblingIndex(siblings, fromIdx, toIdx);
}

/** Per-layer reorder block reason (AI eligibility + lock). */
export function reorderLayerNodeBlockedReason(doc: Doc, node: Node): string {
  if (doc.format === 'ai') {
    if (canReorderAiLayer(doc, node)) return '';
    if (node.locked) return 'This layer is locked. Unlock it to reorder it.';
    return aiReorderDocumentBlockedReason(doc) ?? 'This layer cannot be reordered.';
  }
  if (!canReorderLayer(doc)) return reorderLayerBlockedReason(doc);
  return 'This layer cannot be reordered.';
}

/** Per-layer AI live PDF text (global `editText` stays false; panel uses this). */
export function canEditAiTextOnNode(doc: Doc, n: Node): boolean {
  return doc.format === 'ai' && canEditAiLiveTextOnNode(n);
}

/** Per-layer AI embedded PDF image replace (global `replaceImage` stays false for .ai). */
export function canReplaceAiImageOnNode(doc: Doc, n: Node): boolean {
  return doc.format === 'ai' && canReplaceAiPlacedImageOnNode(n);
}

/** IDML linked image in a graphic frame (`replaceImage` stays false globally for .indd). */
export function canReplaceIdmlImageOnNode(doc: Doc, n: Node): boolean {
  return (doc.format === 'indd' || Boolean(doc.idml)) && canReplaceIdmlPlacedImage(n);
}

/** User-facing reason when AI image replace is blocked on a raster layer. */
export function aiPlacedImageReplaceBlockedReason(doc: Doc, n: Node): string {
  if (doc.format !== 'ai') {
    return 'Replace image is not available for this file format.';
  }
  if (canReplaceAiPlacedImageOnNode(n)) {
    return 'This layer supports embedded PDF image replacement.';
  }
  return getAiPlacedImageReplaceBlockedReason(doc, n);
}

/** Whether layer opacity is written into exported file bytes (PSD always; AI via ExtGState /ca). */
export function opacityExportsToFile(doc: Doc): boolean {
  if (doc.format === 'psd') return true;
  if (doc.format === 'ai') return true;
  if (doc.format === 'indd') return true;
  return false;
}

export function formatFromExtension(ext: string | undefined): Doc['format'] | null {
  switch (ext?.toLowerCase()) {
    case 'psd':
      return 'psd';
    case 'ai':
      return 'ai';
    case 'indd':
      return 'indd';
    case 'idml':
      return 'indd';
    default:
      return null;
  }
}

export function formatFromFileName(name: string): Doc['format'] | null {
  const trimmed = name.trim();
  const parts = trimmed.split('.');
  if (parts.length < 2) return null;
  return formatFromExtension(parts.pop());
}
export function importErrorModalTitle(format: Doc['format']): string {
  switch (format) {
    case 'ai':
      return 'AI Import Error';
    case 'indd':
      return 'INDD Import Error';
    case 'psd':
      return 'PSD Import Error';
  }
}
export function unsupportedDocSubtitle(doc: Doc): string {
  if (doc.format === 'ai') {
    return 'Layers may include Illustrator/PDF features that stay read-only in the browser.';
  }
  if (doc.format === 'psd') {
    return 'Some layers may have PSD features preserved as read-only.';
  }
  return 'Some layers may have features preserved as read-only.';
}

export function duplicateBlockedMessage(doc: Doc): string {
  if (doc.format === 'ai') {
    if (doc.roots.some((r) => r.kind === 'group')) {
      return 'Duplicating layers in Illustrator documents with group folders is not supported yet.';
    }
    return 'Duplicating layers in this .ai file is not supported (no PDF marked-content layer blocks to clone).';
  }
  return 'Duplicating layers in this file format is not supported yet.';
}

export const RESIZE_ROTATE_BLOCKED_MESSAGE = 'Resizing and rotating layers in this file format is not supported yet.';

export const DELETE_BLOCKED_MESSAGE = 'Deleting layers in this file format is not supported yet.';

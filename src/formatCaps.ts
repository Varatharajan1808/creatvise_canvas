import type { Doc } from './model';

/** Phase 1: shared UI/policy for formats that use the common `Node` editing path. */
export type SupportedImportFormat = 'psd' | 'ai';

export interface FormatCapabilities {
  export: boolean;
  /** Duplicate inserts into the native file tree on export (PSD ag-psd). */
  duplicateNativeTree: boolean;
  folderBatchImport: boolean;
  /** Layer panel text editing (format-specific backing required). */
  editText: boolean;
  editShape: boolean;
  replaceImage: boolean;
  /** Resize/rotate handles and numeric W/H/rotation; per-layer rules in `canTransform` still apply. */
  resizeRotate: boolean;
  deleteLayer: boolean;
}

const CAPS: Record<SupportedImportFormat, FormatCapabilities> = {
  psd: {
    export: true,
    duplicateNativeTree: true,
    folderBatchImport: true,
    editText: true,
    editShape: true,
    replaceImage: true,
    resizeRotate: true,
    deleteLayer: true,
  },
  ai: {
    export: true,
    duplicateNativeTree: false,
    folderBatchImport: true,
    editText: false,
    editShape: true,
    replaceImage: false,
    resizeRotate: true,
    deleteLayer: true,
  },
};

export function isSupportedImportFormat(format: Doc['format']): format is SupportedImportFormat {
  return format === 'psd' || format === 'ai';
}

export function capabilitiesFor(format: Doc['format']): FormatCapabilities | null {
  if (format === 'psd') return CAPS.psd;
  if (format === 'ai') return CAPS.ai;
  return null;
}

export function capabilitiesForDoc(doc: Doc): FormatCapabilities | null {
  return capabilitiesFor(doc.format);
}

export function canExportDocument(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.export ?? false;
}

export function canDuplicateLayer(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.duplicateNativeTree ?? false;
}

export function canResizeRotate(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.resizeRotate ?? false;
}

export function canDeleteLayer(doc: Doc): boolean {
  return capabilitiesForDoc(doc)?.deleteLayer ?? false;
}

/** Whether layer opacity is written into exported file bytes (PSD always; AI via ExtGState /ca). */
export function opacityExportsToFile(doc: Doc): boolean {
  if (doc.format === 'psd') return true;
  if (doc.format === 'ai') return true;
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
    return 'Duplicating layers in .ai files is not supported yet (Illustrator/PDF layer tree).';
  }
  return 'Duplicating layers in this file format is not supported yet.';
}

export const RESIZE_ROTATE_BLOCKED_MESSAGE = 'Resizing and rotating layers in this file format is not supported yet.';

export const DELETE_BLOCKED_MESSAGE = 'Deleting layers in this file format is not supported yet.';

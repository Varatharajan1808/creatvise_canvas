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
}

const CAPS: Record<SupportedImportFormat, FormatCapabilities> = {
  psd: {
    export: true,
    duplicateNativeTree: true,
    folderBatchImport: true,
    editText: true,
    editShape: true,
    replaceImage: true,
  },
  ai: {
    export: true,
    duplicateNativeTree: false,
    folderBatchImport: true,
    editText: false,
    editShape: false,
    replaceImage: false,
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

/** Whether layer opacity is written into exported file bytes (PSD always; AI when ExtGState present). */
export function opacityExportsToFile(doc: Doc): boolean {
  if (doc.format === 'psd') return true;
  if (doc.format === 'ai') return doc.ai?.hasExtGStateOpacity ?? false;
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

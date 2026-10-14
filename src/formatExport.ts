import type { Doc } from './model';
import { canExportDocument } from './formatCaps';
import { formatRegistry, type FormatAdapter } from './formats';

export { canExportDocument };

function exportAdapter(doc: Doc): FormatAdapter {
  const adapter = canExportDocument(doc) ? formatRegistry.get(doc.format) : null;
  if (!adapter) throw new Error(`Export is not supported for format "${doc.format}".`);
  return adapter;
}

export function exportEditedDownloadName(doc: Doc): string {
  return exportAdapter(doc).exportFileName(doc);
}

export function exportEditedMimeType(doc: Doc): string {
  return exportAdapter(doc).mimeType;
}

/** Export document bytes in its native format. */
export async function exportDocument(doc: Doc): Promise<ArrayBuffer> {
  return exportAdapter(doc).exportDoc(doc);
}

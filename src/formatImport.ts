import { importAi } from './ai';
import { importPsd } from './psd';
import type { Doc } from './model';
import { isSupportedImportFormat } from './formatCaps';

/** Load a document from stored bytes (file picker, IndexedDB, drag-drop). */
export async function importDocument(
  name: string,
  bytes: ArrayBuffer,
  format: Doc['format'],
): Promise<Doc> {
  if (!isSupportedImportFormat(format)) {
    throw new Error(`Import is not supported for format "${format}".`);
  }
  if (format === 'psd') return importPsd(name, bytes);
  return importAi(name, bytes);
}

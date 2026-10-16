import type { Doc } from '../core/model';
import { formatRegistry } from './index';

/** Load a document from stored bytes (file picker, IndexedDB, drag-drop). */
export async function importDocument(
  name: string,
  bytes: ArrayBuffer,
  format: Doc['format'],
): Promise<Doc> {
  const adapter = formatRegistry.get(format);
  if (!adapter) {
    throw new Error(`Import is not supported for format "${format}".`);
  }
  return adapter.importDoc(name, bytes);
}

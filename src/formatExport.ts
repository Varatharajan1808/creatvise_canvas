import type { Doc } from './model';
import { exportAi } from './ai';
import { canExportDocument, isSupportedImportFormat } from './formatCaps';
import { exportPsd } from './psd';
import { isPsdDoc } from './sourceTree';

export { canExportDocument };

export function exportEditedDownloadName(doc: Doc): string {
  const base = doc.name.replace(/\.(psd|ai)$/i, '');
  return doc.format === 'ai' ? `${base}.edited.ai` : `${base}.edited.psd`;
}

export function exportEditedMimeType(doc: Doc): string {
  return doc.format === 'ai' ? 'application/pdf' : 'image/vnd.adobe.photoshop';
}

/** Export document bytes in its native format. */
export async function exportDocument(doc: Doc): Promise<ArrayBuffer> {
  if (!canExportDocument(doc) || !isSupportedImportFormat(doc.format)) {
    throw new Error(`Export is not supported for format "${doc.format}".`);
  }
  if (isPsdDoc(doc)) return exportPsd(doc);
  return await exportAi(doc);
}

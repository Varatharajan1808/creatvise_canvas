import { capabilitiesFor } from './formatCaps';
import type { Doc } from '../core/model';
import type { FormatAdapter } from './types';
import { inddToIdml, idmlToIndd } from './backend';
import { importIdml, exportIdml } from '../indd/idml';
import { buildInddImportReport, logInddImportReport, setActiveInddDoc } from '../indd/inddImportReport';

function baseName(doc: Doc): string {
  return doc.name.replace(/\.(indd|idml)$/i, '');
}

export const inddAdapter: FormatAdapter = {
  format: 'indd',
  extensions: ['indd', 'idml'],
  mimeType: 'application/x-indesign',
  capabilities: capabilitiesFor('indd')!,
  importDoc: async (name: string, bytes: ArrayBuffer): Promise<Doc> => {
    let doc: Doc;
    if (name.toLowerCase().endsWith('.idml')) {
      doc = await importIdml(name, bytes, 'idml');
    } else {
      const idml = await inddToIdml(bytes, { slowHint: true });
      doc = await importIdml(name.replace(/\.indd$/i, '.idml'), idml, 'indd');
    }
    doc.uploadedBytes = bytes;
    const report = buildInddImportReport(doc);
    doc.inddImportReport = report;
    logInddImportReport(report);
    setActiveInddDoc(doc);
    return doc;
  },
  exportDoc: async (doc: Doc): Promise<ArrayBuffer> => {
    const idml = await exportIdml(doc);
    return doc.origin === 'indd' ? await idmlToIndd(idml) : idml;
  },
  exportFileName: (doc: Doc): string =>
    doc.origin === 'indd' ? `${baseName(doc)}.edited.indd` : `${baseName(doc)}.edited.idml`,
};

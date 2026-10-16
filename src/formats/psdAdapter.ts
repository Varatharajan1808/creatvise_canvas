import { capabilitiesFor } from './formatCaps';
import { exportPsd, importPsd } from '../psd/psd';
import type { FormatAdapter } from './types';

export const psdAdapter: FormatAdapter = {
  format: 'psd',
  extensions: ['psd'],
  mimeType: 'image/vnd.adobe.photoshop',
  capabilities: capabilitiesFor('psd')!,
  importDoc: async (name, bytes) => importPsd(name, bytes),
  exportDoc: async (doc) => exportPsd(doc),
  exportFileName: (doc) => `${doc.name.replace(/\.(psd|ai)$/i, '')}.edited.psd`,
};

import { exportAi, importAi } from '../ai';
import { capabilitiesFor } from '../formatCaps';
import type { FormatAdapter } from './types';

export const aiAdapter: FormatAdapter = {
  format: 'ai',
  extensions: ['ai'],
  mimeType: 'application/pdf',
  capabilities: capabilitiesFor('ai')!,
  importDoc: (name, bytes) => importAi(name, bytes),
  exportDoc: (doc) => exportAi(doc),
  exportFileName: (doc) => `${doc.name.replace(/\.(psd|ai)$/i, '')}.edited.ai`,
};

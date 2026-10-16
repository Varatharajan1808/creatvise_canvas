import { aiAdapter } from './aiAdapter';
import { psdAdapter } from './psdAdapter';
import { inddAdapter } from './inddAdapter';
import { createFormatRegistry } from './registry';

export type { FormatAdapter } from './types';
export type { FormatRegistry } from './registry';
export { createFormatRegistry } from './registry';

/** Formats the editor can open and export. */
export const formatRegistry = createFormatRegistry([psdAdapter, aiAdapter, inddAdapter]);

export * from './formatCaps';
export * from './formatExport';
export * from './formatImport';
export * from './folderImport';
export * from './backend';



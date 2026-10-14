import { aiAdapter } from './aiAdapter';
import { psdAdapter } from './psdAdapter';
import { createFormatRegistry } from './registry';

export type { FormatAdapter } from './types';
export type { FormatRegistry } from './registry';
export { createFormatRegistry } from './registry';

/** Formats the editor can open and export. `.indd` is detected elsewhere but has no adapter. */
export const formatRegistry = createFormatRegistry([psdAdapter, aiAdapter]);

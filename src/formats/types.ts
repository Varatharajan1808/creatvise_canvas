import type { Doc } from '../core/model';
import type { FormatCapabilities, SupportedImportFormat } from './formatCaps';

/** One editable file format: how its bytes become a `Doc` and how an edited `Doc` becomes bytes again. */
export interface FormatAdapter {
  readonly format: SupportedImportFormat;
  /** Lowercase, without the leading dot. */
  readonly extensions: readonly string[];
  readonly mimeType: string;
  readonly capabilities: FormatCapabilities;
  importDoc(name: string, bytes: ArrayBuffer): Promise<Doc>;
  exportDoc(doc: Doc): Promise<ArrayBuffer>;
  exportFileName(doc: Doc): string;
}

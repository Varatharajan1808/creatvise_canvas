import type { FormatAdapter } from './types';

export interface FormatRegistry {
  /** Adapter for a format id such as `psd` (case-insensitive), or null when none is registered. */
  get(format: string): FormatAdapter | null;
  /** Adapter for a file extension such as `ai` or `.AI`, or null when none is registered. */
  forExtension(ext: string): FormatAdapter | null;
  /** Adapter for a file name by its last extension, or null when it has none or none is registered. */
  forFileName(name: string): FormatAdapter | null;
  formats(): string[];
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/^\./, '');

export function createFormatRegistry(adapters: readonly FormatAdapter[]): FormatRegistry {
  const byFormat = new Map<string, FormatAdapter>();
  const byExt = new Map<string, FormatAdapter>();
  for (const a of adapters) {
    const id = normalize(a.format);
    if (byFormat.has(id)) throw new Error(`Duplicate format adapter for "${id}".`);
    byFormat.set(id, a);
    for (const e of a.extensions) {
      const ext = normalize(e);
      const other = byExt.get(ext);
      if (other) throw new Error(`Extension ".${ext}" is claimed by both "${other.format}" and "${a.format}".`);
      byExt.set(ext, a);
    }
  }

  const forExtension = (ext: string) => byExt.get(normalize(ext)) ?? null;
  return {
    get: (format) => byFormat.get(normalize(format)) ?? null,
    forExtension,
    forFileName: (name) => {
      const parts = name.trim().split('.');
      return parts.length < 2 ? null : forExtension(parts.pop()!);
    },
    formats: () => [...byFormat.keys()],
  };
}

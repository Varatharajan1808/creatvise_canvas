import type { Layer } from 'ag-psd';
import type { Doc, Node } from './model';
import type { AiArtFrame } from './aiPdfLib';
import type { AiLiveTextRun } from './aiPdfText';
import type { AiPlacedImageRun } from './aiPdfImages';

/** PDF marked-content / export indices stored on AI stub `Layer` objects. */
export interface AiLayerStubMeta {
  /** Marked content index (`/MCn`) used when patching the content stream. */
  aiMcIndex: number;
  /** MC block whose artwork is copied when this layer is a duplicate. */
  aiSourceMcIndex: number;
  /** True when the layer was created via Duplicate (not present in the original file). */
  aiDuplicate?: boolean;
  aiArtFrame?: AiArtFrame;
  /** Live PDF text runs detected at import (Phase A metadata; not yet editable in the UI). */
  aiLiveTextRuns?: AiLiveTextRun[];
  /** Set when the MC block mixes text with paths/images (no safe live-text metadata). */
  aiLiveTextUnsupported?: string;
  /** `isolate` clears import bounds before drawing edits; `overlay` draws on top (may double). */
  aiTextPreviewMode?: 'isolate' | 'overlay';
  /** Which `aiLiveTextRuns` entry the properties panel edits (default 0). */
  aiTextActiveRunIndex?: number;
  /** Embedded PDF image runs detected at import (Phase 3 preview replacement). */
  aiPlacedImages?: AiPlacedImageRun[];
  /** MC block mixes images with paths/text or has unsupported image XObjects. */
  aiPlacedImageUnsupported?: string;
}

export type AiLayerStub = Layer & AiLayerStubMeta;

export function asAiLayerStub(src: Layer): AiLayerStub {
  return src as AiLayerStub;
}

export function initAiLayerMeta(
  src: Layer,
  mcIndex: number,
  opts?: { sourceMcIndex?: number; duplicate?: boolean },
): void {
  const s = asAiLayerStub(src);
  s.aiMcIndex = mcIndex;
  s.aiSourceMcIndex = opts?.sourceMcIndex ?? mcIndex;
  if (opts?.duplicate) s.aiDuplicate = true;
}

export function resolveAiMcIndex(node: Node): number {
  const s = asAiLayerStub(node.src);
  if (typeof s.aiMcIndex === 'number') return s.aiMcIndex;
  const fromKey = ocgIndexFromNodeKey(node.key);
  return fromKey ?? 0;
}

export function resolveAiSourceMcIndex(node: Node): number {
  const s = asAiLayerStub(node.src);
  if (typeof s.aiSourceMcIndex === 'number') return s.aiSourceMcIndex;
  return resolveAiMcIndex(node);
}

export function isAiDuplicateLayer(node: Node): boolean {
  return asAiLayerStub(node.src).aiDuplicate === true;
}

export function ocgIndexFromNodeKey(key: string): number | null {
  const m = /^ocg-(\d+)$/.exec(key);
  if (m) return parseInt(m[1], 10);
  if (key === 'artwork-0' || key === '0') return 0;
  return null;
}

/** Whether this AI document supports duplicating at least one layer into the PDF on export. */
export function aiDocumentSupportsDuplicate(doc: Doc): boolean {
  return doc.format === 'ai' && doc.ai?.canDuplicateMarkedContent === true;
}

export function canDuplicateAiLayer(doc: Doc, node: Node): boolean {
  if (!aiDocumentSupportsDuplicate(doc)) return false;
  if (node.kind === 'group') return false;
  if (node.parent !== null) return false;
  if (doc.roots.some((r) => r.kind === 'group')) return false;
  return true;
}

export function aiDuplicateLayerBlockedReason(doc: Doc, node: Node): string | null {
  if (doc.format !== 'ai' || !doc.ai) return 'Document is not an Illustrator document.';
  if (!doc.ai.canDuplicateMarkedContent) {
    return 'Duplicating layers in this .ai file is not supported (no PDF marked-content layer blocks to clone).';
  }
  if (node.kind === 'group') {
    return 'Group folders cannot be duplicated in Illustrator documents.';
  }
  if (node.parent !== null || doc.roots.some((r) => r.kind === 'group')) {
    return 'Duplicating layers in Illustrator documents with group folders is not supported yet.';
  }
  return null;
}

/**
 * After a generic `cloneNode`, wire AI export metadata so the duplicate gets its own MC index
 * and shares the original untransformed artwork frame (independent placement via x/y/rotation).
 */
export function applyAiDuplicateMetadata(doc: Doc, original: Node, clone: Node): void {
  if (doc.format !== 'ai' || !doc.ai) return;
  if (original.kind === 'group' || clone.kind === 'group') return;

  const sourceMc = resolveAiSourceMcIndex(original);
  const newMc = doc.ai.nextMcIndex;
  doc.ai.nextMcIndex = newMc + 1;

  initAiLayerMeta(clone.src, newMc, { sourceMcIndex: sourceMc, duplicate: true });

  const origStub = asAiLayerStub(original.src);
  if (origStub.aiArtFrame) {
    asAiLayerStub(clone.src).aiArtFrame = { ...origStub.aiArtFrame };
  }

  // Untransformed artwork frame matches the original; canvas placement uses x/y (+20,+20 from clone).
  clone.ox = original.ox;
  clone.oy = original.oy;
  clone.ow = original.ow;
  clone.oh = original.oh;
}

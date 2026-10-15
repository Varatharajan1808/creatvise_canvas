import type { Layer } from 'ag-psd';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFDict,
  PDFArray,
  PDFRef,
} from 'pdf-lib';
import type { Node } from './model';

/** One OCG leaf or nested optional-content order group from `/D/Order`. */
export type OcgOrderEntry =
  | { kind: 'ocg'; ref: string; catalogIndex: number }
  | { kind: 'group'; name: string; children: OcgOrderEntry[] };

export type OcgOrderLayoutResult =
  | { mode: 'flat'; warnings: string[] }
  | { mode: 'nested'; entries: OcgOrderEntry[]; warnings: string[] };

let importGroupUid = 0;

function refLabel(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber} R`;
}

function catalogIndexForRef(ref: string, ocgRefs: readonly string[]): number | null {
  const idx = ocgRefs.indexOf(ref);
  return idx >= 0 ? idx : null;
}

type ParseState = {
  invalid: boolean;
  seenRefs: Set<string>;
  warnings: string[];
};

function parseOrderArray(
  pdfDoc: PDFDocument,
  arr: PDFArray,
  ocgRefs: readonly string[],
  state: ParseState,
): OcgOrderEntry[] {
  const out: OcgOrderEntry[] = [];
  let pendingLabel: string | null = null;

  for (let i = 0; i < arr.size(); i++) {
    const item = arr.get(i);

    if (item instanceof PDFString) {
      pendingLabel = item.decodeText();
      continue;
    }

    if (item instanceof PDFRef) {
      const ref = refLabel(item);
      const catalogIndex = catalogIndexForRef(ref, ocgRefs);
      if (catalogIndex === null) {
        state.invalid = true;
        state.warnings.push(`Optional content Order references unknown OCG ${ref}.`);
        pendingLabel = null;
        continue;
      }
      if (state.seenRefs.has(ref)) {
        state.invalid = true;
        state.warnings.push(`Optional content Order lists OCG ${ref} more than once.`);
      } else {
        state.seenRefs.add(ref);
      }
      out.push({ kind: 'ocg', ref, catalogIndex });
      pendingLabel = null;
      continue;
    }

    let nested: PDFArray | null = null;
    if (item instanceof PDFArray) nested = item;
    else {
      const looked = pdfDoc.context.lookup(item);
      if (looked instanceof PDFArray) nested = looked;
    }

    if (nested) {
      const children = parseOrderArray(pdfDoc, nested, ocgRefs, state);
      if (children.length === 0) {
        state.invalid = true;
        state.warnings.push('Optional content Order contains an empty nested group.');
      } else {
        const name = pendingLabel?.trim() || `Group ${out.filter((e) => e.kind === 'group').length + 1}`;
        out.push({ kind: 'group', name, children });
      }
      pendingLabel = null;
      continue;
    }

    state.warnings.push(`Optional content Order entry at index ${i} was skipped (unsupported type).`);
    pendingLabel = null;
  }

  return out;
}

function entriesHaveNestedGroup(entries: OcgOrderEntry[]): boolean {
  for (const e of entries) {
    if (e.kind === 'group') return true;
  }
  return false;
}

function collectOcgCatalogIndices(entries: OcgOrderEntry[]): number[] {
  const out: number[] = [];
  const walk = (list: OcgOrderEntry[]) => {
    for (const e of list) {
      if (e.kind === 'ocg') out.push(e.catalogIndex);
      else walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/**
 * Parse and validate `/OCProperties /D /Order` for nested optional-content folders.
 * Returns `flat` when Order is missing, invalid, ambiguous, or has no nested arrays.
 */
export async function resolveOcgOrderImportLayout(
  buf: ArrayBuffer,
  ocgRefs: readonly string[],
): Promise<OcgOrderLayoutResult> {
  const warnings: string[] = [];
  if (ocgRefs.length === 0) return { mode: 'flat', warnings };

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  } catch (e) {
    warnings.push(`Could not read PDF optional content Order (${(e as Error).message}); using flat layer list.`);
    return { mode: 'flat', warnings };
  }

  const catalog = pdfDoc.context.lookup(pdfDoc.catalog);
  if (!(catalog instanceof PDFDict)) {
    warnings.push('PDF catalog missing; using flat layer list.');
    return { mode: 'flat', warnings };
  }
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties')));
  if (!(ocProps instanceof PDFDict)) {
    return { mode: 'flat', warnings };
  }
  const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D')));
  if (!(d instanceof PDFDict)) {
    return { mode: 'flat', warnings };
  }
  const order = pdfDoc.context.lookup(d.get(PDFName.of('Order')));
  if (!(order instanceof PDFArray) || order.size() === 0) {
    return { mode: 'flat', warnings };
  }

  const state: ParseState = { invalid: false, seenRefs: new Set(), warnings: [] };
  const entries = parseOrderArray(pdfDoc, order, ocgRefs, state);
  warnings.push(...state.warnings);

  if (!entriesHaveNestedGroup(entries)) {
    return { mode: 'flat', warnings };
  }

  if (state.invalid) {
    warnings.push('Optional content Order hierarchy was invalid; using flat layer list.');
    return { mode: 'flat', warnings };
  }

  const used = collectOcgCatalogIndices(entries);
  if (used.length !== ocgRefs.length) {
    warnings.push(
      `Optional content Order lists ${used.length} layer(s) but the file defines ${ocgRefs.length}; using flat layer list.`,
    );
    return { mode: 'flat', warnings };
  }

  const seenIdx = new Set<number>();
  for (const idx of used) {
    if (seenIdx.has(idx)) {
      warnings.push('Optional content Order maps the same layer twice; using flat layer list.');
      return { mode: 'flat', warnings };
    }
    seenIdx.add(idx);
  }

  for (let i = 0; i < ocgRefs.length; i++) {
    if (!seenIdx.has(i)) {
      warnings.push(`Optional content Order omits layer index ${i}; using flat layer list.`);
      return { mode: 'flat', warnings };
    }
  }

  return { mode: 'nested', entries, warnings };
}

/** Programmatic readback of Order (tests / PoC); does not validate catalog coverage. */
export async function readOcgOrderTreeForDisplay(buf: ArrayBuffer): Promise<OcgOrderEntry[]> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog);
  if (!(catalog instanceof PDFDict)) return [];
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties')));
  if (!(ocProps instanceof PDFDict)) return [];
  const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D')));
  if (!(d instanceof PDFDict)) return [];
  const order = pdfDoc.context.lookup(d.get(PDFName.of('Order')));
  if (!(order instanceof PDFArray)) return [];
  const ocgFrom = await readOcgRefsFromCatalog(pdfDoc);
  const state: ParseState = { invalid: false, seenRefs: new Set(), warnings: [] };
  return parseOrderArray(pdfDoc, order, ocgFrom, state);
}

async function readOcgRefsFromCatalog(pdfDoc: PDFDocument): Promise<string[]> {
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties')));
  if (!(ocProps instanceof PDFDict)) return [];
  const ocgs = pdfDoc.context.lookup(ocProps.get(PDFName.of('OCGs')));
  if (!(ocgs instanceof PDFArray)) return [];
  const refs: string[] = [];
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    if (ref instanceof PDFRef) refs.push(refLabel(ref));
  }
  return refs;
}

export function formatOcgOrderTree(entries: OcgOrderEntry[]): string {
  return entries
    .map((n) => {
      if (n.kind === 'ocg') return n.ref;
      return `group(${formatOcgOrderTree(n.children)})`;
    })
    .join(';');
}

function createImportGroupLayer(name: string): Layer {
  return { name, opened: true, children: [], blendMode: 'pass through' };
}

export function createAiImportGroupNode(name: string): Node {
  const src = createImportGroupLayer(name);
  importGroupUid += 1;
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `ai_g_${crypto.randomUUID().slice(0, 8)}`
      : `ai_g_${importGroupUid.toString(36)}`;
  return {
    id,
    key: `ai-order-group/${importGroupUid}`,
    name,
    kind: 'group',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    ow: 0,
    oh: 0,
    ox: 0,
    oy: 0,
    canvas: null,
    children: [],
    parent: null,
    src,
    unsupported: [],
    importPreviewContentEpoch: 0,
    previewContentEpoch: 0,
  };
}

/** Attach nested Order entries to pre-rendered leaves (`ocg-N` → catalog index N). */
export function assembleRootsFromOcgOrder(
  entries: OcgOrderEntry[],
  leafByCatalogIndex: Map<number, Node>,
): Node[] {
  const build = (list: OcgOrderEntry[]): Node[] => {
    const roots: Node[] = [];
    for (const e of list) {
      if (e.kind === 'ocg') {
        const leaf = leafByCatalogIndex.get(e.catalogIndex);
        if (leaf) roots.push(leaf);
        continue;
      }
      const group = createAiImportGroupNode(e.name);
      const children = build(e.children);
      for (const c of children) {
        c.parent = group;
        group.children.push(c);
        if (group.src.children) group.src.children.push(c.src);
      }
      roots.push(group);
    }
    return roots;
  };
  return build(entries);
}

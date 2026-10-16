/**
 * AI layer stack reorder — model, PDF MC/OCG export, re-import (synthetic fixtures).
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflate } from 'pako';
import type { Doc, Node } from '../src/model';
import { initAiLayerMeta, resolveAiMcIndex } from '../src/aiLayerMeta';
import {
  applyAiSiblingReorder,
  canReorderAiDocument,
  canReorderAiLayer,
  captureAiImportStackSnapshot,
  docHasAiStackReordered,
  aiReorderDocumentBlockedReason,
  mcPaintOrderFromDoc,
} from '../src/aiReorder';
import { findLayerBlocks, readContentStreamMcStats, readOcgNamesAndRefsFromPdf, reorderMarkedContentBlocksForPaintOrder } from '../src/aiPdfLib';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

function makeAiLeaf(id: string, key: string, name: string, mcIndex: number): Node {
  const src = { name, left: 0, top: 0, right: 100, bottom: 100, hidden: false, opacity: 1 };
  initAiLayerMeta(src as Node['src'], mcIndex);
  return {
    id,
    key,
    name,
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    ow: 100,
    oh: 100,
    ox: 0,
    oy: 0,
    canvas: createCanvas(1, 1) as unknown as HTMLCanvasElement,
    children: [],
    parent: null,
    src: src as Node['src'],
    unsupported: [],
  };
}

function buildTwoLayerDoc(original: ArrayBuffer): Doc {
  const a = makeAiLeaf('id_a', 'ocg-0', 'Bottom', 0);
  const b = makeAiLeaf('id_b', 'ocg-1', 'Top', 1);
  const doc: Doc = {
    id: 'reorder-test',
    name: 'two.ai',
    format: 'ai',
    width: 100,
    height: 100,
    offsetX: 0,
    offsetY: 0,
    roots: [a, b],
    original,
    warnings: [],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: true,
      ocgNames: ['Bottom', 'Top'],
      ocgRefs: ['5 0 R', '6 0 R'],
      importOcgRefsByCatalogIndex: ['5 0 R', '6 0 R'],
      hasExtGStateOpacity: false,
      extGStateCaAtImport: 1,
      nextMcIndex: 2,
      canDuplicateMarkedContent: true,
      markedContentBlockCount: 2,
    },
  };
  captureAiImportStackSnapshot(doc);
  return doc;
}

async function decompressContents(buf: ArrayBuffer): Promise<string> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const contentsObj = pdfDoc.context.lookup(pdfDoc.getPage(0).node.get(PDFName.of('Contents'))) as {
    getContents(): Uint8Array;
  };
  const raw = contentsObj.getContents();
  let bytes: Uint8Array;
  try {
    bytes = inflate(raw);
  } catch {
    bytes = raw;
  }
  return new TextDecoder('latin1').decode(bytes);
}

function mcStreamOrder(text: string): number[] {
  return findLayerBlocks(text).sort((a, b) => a.bdcStart - b.bdcStart).map((b) => b.layerIndex);
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

function copyBuffer(ab: ArrayBuffer): ArrayBuffer {
  const c = new ArrayBuffer(ab.byteLength);
  new Uint8Array(c).set(new Uint8Array(ab));
  return c;
}

/** Sample upper-half center (100,150): blue when Top (MC1) paints last; red when Bottom (MC0) paints last. */
async function upperCenterIsBlue(buf: ArrayBuffer): Promise<boolean> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const g = c.getContext('2d')!;
  await page.render({ canvasContext: g as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const px = g.getImageData(100, 50, 1, 1).data;
  await pdf.destroy();
  return px[2]! > px[0]! + 30;
}

async function runTests() {
  const sampleBuf = fs.readFileSync('public/sample.ai');
  const sampleAb = sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength);
  const twoPath = 'public/fixtures/ai/two-ocg-layers.ai';
  const loadTwoOriginal = (): ArrayBuffer => {
    const b = fs.readFileSync(twoPath);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };

  const { importAi, exportAi } = await import('../src/ai');
  const {
    canReorderLayer,
    canReorderLayerStackStep,
    reorderLayerBlockedReason,
  } = await import('../src/formatCaps');
  const { History } = await import('../src/history');

  // --- imported single-layer sample: blocked ---
  {
    const doc = await importAi('sample.ai', sampleAb.slice(0));
    assert('sample-single-layer-blocked', !canReorderAiDocument(doc), aiReorderDocumentBlockedReason(doc) ?? '');
    const leaf = doc.roots[0]!;
    assert('sample-layer-not-reorderable', !canReorderAiLayer(doc, leaf), leaf.name);
    assert('sample-has-stack-snapshot', (doc.ai?.importStackNodeIds?.length ?? 0) === 1, String(doc.ai?.importStackNodeIds?.length));
    assert('sample-mc-block-count', doc.ai?.markedContentBlockCount === 1, String(doc.ai?.markedContentBlockCount));
  }

  // --- shape-promoted fixture: blocked ---
  {
    const shapesBuf = fs.readFileSync('public/fixtures/ai/simple-shapes.ai');
    const shapesAb = shapesBuf.buffer.slice(shapesBuf.byteOffset, shapesBuf.byteOffset + shapesBuf.byteLength);
    const doc = await importAi('simple-shapes.ai', shapesAb.slice(0));
    assert('shapes-doc-blocked', !canReorderAiDocument(doc), aiReorderDocumentBlockedReason(doc) ?? '');
  }

  // --- two-ocg synthetic import eligible ---
  {
    const doc = await importAi('two-ocg-layers.ai', loadTwoOriginal());
    assert('two-ocg-eligible', canReorderAiDocument(doc), aiReorderDocumentBlockedReason(doc) ?? '');
    assert('two-ocg-roots', doc.roots.length === 2, String(doc.roots.length));
    assert('two-ocg-mc-count', doc.ai?.markedContentBlockCount === 2, String(doc.ai?.markedContentBlockCount));
    assert('two-ocg-import-refs', (doc.ai?.importOcgRefsByCatalogIndex?.length ?? 0) === 2, '');
    assert('ui-can-reorder-doc', canReorderLayer(doc), '');
    assert(
      'ui-stack-step-up',
      canReorderLayerStackStep(doc, doc.roots[0]!, doc.roots, 0, 1),
      '',
    );
    const sampleDoc = await importAi('sample-ui.ai', sampleAb.slice(0));
    assert('ui-blocked-sample', !canReorderLayer(sampleDoc), '');
    assert(
      'ui-blocked-sample-reason',
      reorderLayerBlockedReason(sampleDoc).includes('two marked-content'),
      reorderLayerBlockedReason(sampleDoc),
    );
    assert('baseline-upper-blue', await upperCenterIsBlue(copyBuffer(loadTwoOriginal())), 'MC1 on top in file');
  }

  // --- history undo/redo (model + OCG metadata) ---
  {
    const doc = await importAi('two-hist.ai', loadTwoOriginal());
    const bottom = doc.roots[0]!;
    const hist = new History();
    hist.exec({
      label: 'Reorder layer',
      do: () => applyAiSiblingReorder(doc, bottom, 0, 1),
      undo: () => applyAiSiblingReorder(doc, bottom, 1, 0),
    });
    assert('hist-after-up', doc.roots.map((r) => r.name).join(',') === 'Top,Bottom', doc.roots.map((r) => r.name).join(','));
    assert('hist-ocg-after-up', doc.ai!.ocgNames.join(',') === 'Top,Bottom', doc.ai!.ocgNames.join(','));
    hist.undo();
    assert('hist-undo-roots', doc.roots.map((r) => r.name).join(',') === 'Bottom,Top', doc.roots.map((r) => r.name).join(','));
    assert('hist-undo-ocg', doc.ai!.ocgNames.join(',') === 'Bottom,Top', doc.ai!.ocgNames.join(','));
    assert('hist-undo-not-reordered', !docHasAiStackReordered(doc), '');
    hist.redo();
    assert('hist-redo-roots', doc.roots.map((r) => r.name).join(',') === 'Top,Bottom', '');
  }

  // --- model reorder + stable MC (mock) ---
  {
    const doc = buildTwoLayerDoc(sampleAb.slice(0));
    const mcBefore0 = resolveAiMcIndex(doc.roots[0]!);
    const mcBefore1 = resolveAiMcIndex(doc.roots[1]!);
    applyAiSiblingReorder(doc, doc.roots[1]!, 1, 0);
    assert('mock-mc-stable-0', resolveAiMcIndex(doc.roots[0]!) === mcBefore1, '');
    assert('mock-mc-stable-1', resolveAiMcIndex(doc.roots[1]!) === mcBefore0, '');
    assert('mock-stack-detected', docHasAiStackReordered(doc), '');
  }

  // --- MC reorder helper preserves nested marker + block bodies ---
  {
    const nested =
      'q\n' +
      '/OC /MC0 BDC\nq\n/OC /MC9 BDC\n(keep) Tj\nEMC\nQ\nEMC\n' +
      '/OC /MC1 BDC\n(outer) Tj\nEMC\n';
    const r = reorderMarkedContentBlocksForPaintOrder(nested, [1, 0]);
    assert('nested-reorder-changed', r.changed, String(r.changed));
    assert('nested-inner-kept', r.text.includes('/MC9 BDC') && r.text.includes('(keep) Tj'), '');
    assert('nested-order', mcStreamOrder(r.text).join(',') === '1,0', mcStreamOrder(r.text).join(','));
  }

  // --- export swap paint order + OCG order + re-import ---
  {
    let doc = await importAi('two-export.ai', loadTwoOriginal());
    const uneditedOut = copyBuffer(await exportAi(doc));
    assert(
      'two-unedited-byte-identical',
      buffersEqual(uneditedOut, loadTwoOriginal()),
      `${uneditedOut.byteLength}`,
    );

    applyAiSiblingReorder(doc, doc.roots[1]!, 1, 0);
    assert('two-swap-names', doc.roots[0]!.name === 'Top', doc.roots.map((r) => r.name).join(','));
    assert('two-paint-order', mcPaintOrderFromDoc(doc).join(',') === '1,0', mcPaintOrderFromDoc(doc).join(','));

    const out = copyBuffer(await exportAi(doc));
    assert('two-export-bytes-change', !buffersEqual(out, loadTwoOriginal()), 'export differs from import file');

    const stream = await decompressContents(out);
    assert('two-stream-mc-order', mcStreamOrder(stream).join(',') === '1,0', mcStreamOrder(stream).join(','));
    assert('two-stream-bdc-intact', stream.includes('/OC /MC0 BDC') && stream.includes('/OC /MC1 BDC'), '');
    const ocg = await readOcgNamesAndRefsFromPdf(copyBuffer(out));
    assert('two-ocg-order-names', ocg.names.join(',') === 'Top,Bottom', ocg.names.join(','));

    const outCopy = copyBuffer(out);
    const pdfDoc = await PDFDocument.load(outCopy.slice(0), { ignoreEncryption: true });
    const cat = pdfDoc.context.lookup(pdfDoc.catalog) as import('pdf-lib').PDFDict;
    const ocProps = pdfDoc.context.lookup(cat.get(PDFName.of('OCProperties'))) as import('pdf-lib').PDFDict;
    const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D'))) as import('pdf-lib').PDFDict;
    const order = pdfDoc.context.lookup(d.get(PDFName.of('Order'))) as import('pdf-lib').PDFArray;
    const on = pdfDoc.context.lookup(d.get(PDFName.of('ON'))) as import('pdf-lib').PDFArray;
    const topRef = order.get(0);
    const topOcg = pdfDoc.context.lookup(topRef) as import('pdf-lib').PDFDict;
    const topName = (topOcg.get(PDFName.of('Name')) as import('pdf-lib').PDFString)?.decodeText?.() ?? '';
    assert('two-ocg-order-ref-top', topName === 'Top', topName);
    assert('two-ocg-on-includes-both', on.size() === 2, String(on.size()));

    doc.roots[1]!.visible = false;
    const hiddenOut = copyBuffer(await exportAi(doc));
    const pdfH = await PDFDocument.load(hiddenOut.slice(0), { ignoreEncryption: true });
    const ocH = pdfH.context.lookup(
      (pdfH.context.lookup(pdfH.catalog) as import('pdf-lib').PDFDict).get(PDFName.of('OCProperties')),
    ) as import('pdf-lib').PDFDict;
    const dH = pdfH.context.lookup(ocH.get(PDFName.of('D'))) as import('pdf-lib').PDFDict;
    const offH = pdfH.context.lookup(dH.get(PDFName.of('OFF'))) as import('pdf-lib').PDFArray;
    assert('two-ocg-off-one', offH.size() === 1, String(offH.size()));

    const re = await importAi('two-reimport.ai', copyBuffer(out));
    assert('two-reimport-root-order', re.roots.map((r) => r.name).join(',') === 'Top,Bottom', re.roots.map((r) => r.name).join(','));

    const bottom = re.roots.find((r) => r.name === 'Bottom')!;
    const bottomIdx = re.roots.indexOf(bottom);
    const undoSwap = applyAiSiblingReorder(re, bottom, bottomIdx, 0);
    assert('undo-swap-applied', undoSwap, String(undoSwap));
    assert('undo-root-names', re.roots.map((r) => r.name).join(',') === 'Bottom,Top', re.roots.map((r) => r.name).join(','));
    assert('undo-stack-flag', docHasAiStackReordered(re), String(docHasAiStackReordered(re)));
    assert(
      'undo-mc-paint-by-stable-index',
      mcPaintOrderFromDoc(re).join(',') === '1,0',
      'Bottom=ocg-1 paints before Top=ocg-0 when keys stay catalog-bound',
    );
    const undoOut = copyBuffer(await exportAi(re));
    const undoStream = await decompressContents(undoOut);
    const swapStream = await decompressContents(copyBuffer(out));
    assert(
      'two-undo-stream-mc-order',
      mcStreamOrder(undoStream).join(',') === mcStreamOrder(swapStream).join(','),
      `${mcStreamOrder(undoStream).join(',')} vs ${mcStreamOrder(swapStream).join(',')}`,
    );
  }

  // --- locked / duplicate index blocked ---
  {
    const doc = buildTwoLayerDoc(sampleAb.slice(0));
    doc.roots[1]!.locked = true;
    assert('locked-layer-blocked', !canReorderAiLayer(doc, doc.roots[1]!), 'locked');
    doc.roots[1]!.locked = false;
    doc.ai!.nextMcIndex = 3;
    assert('extra-mc-index-blocked', !canReorderAiDocument(doc), aiReorderDocumentBlockedReason(doc) ?? '');
  }

  // --- sample single-layer export unchanged ---
  {
    const doc = await importAi('sample-guard.ai', sampleAb.slice(0));
    const out = await exportAi(doc);
    assert('sample-export-still-works', out.byteLength === sampleAb.byteLength, `${out.byteLength}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n--- Summary ---\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    failed.forEach((f) => console.error(`FAIL: ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

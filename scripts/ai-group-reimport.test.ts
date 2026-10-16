/**
 * Phase 6g — AI nested OCG /Order import (model tree only; export unchanged).
 */
import fs from 'fs';
import path from 'path';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray } from 'pdf-lib';
import type { Node } from '../src/model';
import { leaves } from '../src/model';
import { resolveAiMcIndex } from '../src/aiLayerMeta';
import {
  aiReorderDocumentBlockedReason,
  canReorderAiDocument,
} from '../src/aiReorder';
import { resolveOcgOrderImportLayout } from '../src/aiOcgOrderImport';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

function loadBuf(rel: string): ArrayBuffer {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function nodeOutline(n: Node): string {
  if (n.kind === 'group') {
    return `group(${n.children.map((c) => nodeOutline(c)).join(',')})`;
  }
  return n.name;
}

function treeOutline(roots: readonly Node[]): string {
  return roots.map((n) => nodeOutline(n)).join(';');
}

function leafMcIndices(doc: { roots: Node[] }): string {
  return leaves(doc).map((n) => resolveAiMcIndex(n)).join(',');
}

function leafKeys(doc: { roots: Node[] }): string {
  return leaves(doc)
    .map((n) => n.key)
    .join(',');
}

async function buildNestedOrderPdf(flatPath: string, orderBuilder: (ocgs: PDFArray, pdfDoc: PDFDocument) => unknown): Promise<ArrayBuffer> {
  const raw = fs.readFileSync(flatPath);
  const pdfDoc = await PDFDocument.load(raw, { ignoreEncryption: true });
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties'))) as PDFDict;
  const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D'))) as PDFDict;
  const ocgs = pdfDoc.context.lookup(ocProps.get(PDFName.of('OCGs'))) as PDFArray;
  d.set(PDFName.of('Order'), orderBuilder(ocgs, pdfDoc));
  const out = await pdfDoc.save({ useObjectStreams: false });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

async function runTests() {
  const { importAi } = await import('../src/ai');
  const flatThree = path.join('public', 'fixtures', 'ai', 'three-ocg-layers.ai');
  const nestedOut = path.join('scripts', 'poc', 'output', 'three-ocg-nested-order.ai');
  const twoOcg = path.join('public', 'fixtures', 'ai', 'two-ocg-layers.ai');
  const sampleAi = path.join('public', 'sample.ai');

  // --- Phase 6f nested fixture ---
  {
    const buf = fs.existsSync(nestedOut) ? loadBuf(nestedOut) : await buildNestedOrderPdf(flatThree, (ocgs, pdfDoc) => {
      const folder = pdfDoc.context.obj([ocgs.get(0), ocgs.get(1)]);
      return pdfDoc.context.obj([folder, ocgs.get(2)]);
    });
    const doc = await importAi('nested-three.ai', buf);
    assert('nested-outline', treeOutline(doc.roots) === 'group(RedSquare,GreenSquare);BlueSquare', treeOutline(doc.roots));
    assert('nested-leaf-count', leaves(doc).length === 3, String(leaves(doc).length));
    assert('nested-mc-indices', leafMcIndices(doc) === '0,1,2', leafMcIndices(doc));
    assert('nested-leaf-keys', leafKeys(doc) === 'ocg-0,ocg-1,ocg-2', leafKeys(doc));
    assert('nested-reorder-blocked', !canReorderAiDocument(doc), aiReorderDocumentBlockedReason(doc) ?? '');
    const g = doc.roots.find((r) => r.kind === 'group');
    assert('nested-group-children', g?.children.length === 2, String(g?.children.length));
    assert('nested-group-parent-links', g?.children.every((c) => c.parent === g) ?? false, '');
  }

  // --- flat three OCG ---
  {
    const doc = await importAi('flat-three.ai', loadBuf(flatThree));
    assert('flat-outline', treeOutline(doc.roots) === 'RedSquare;GreenSquare;BlueSquare', treeOutline(doc.roots));
    assert('flat-all-root-leaves', doc.roots.every((r) => r.kind !== 'group'), '');
    assert('flat-mc-indices', leafMcIndices(doc) === '0,1,2', leafMcIndices(doc));
    const layout = await resolveOcgOrderImportLayout(loadBuf(flatThree), doc.ai!.ocgRefs);
    assert('flat-layout-mode', layout.mode === 'flat', layout.mode);
  }

  // --- OCG ref mapping ---
  {
    const doc = await importAi('nested-map.ai', loadBuf(nestedOut));
    for (let i = 0; i < 3; i++) {
      const leaf = leaves(doc).find((n) => n.key === `ocg-${i}`);
      assert(`ocg-ref-slot-${i}`, doc.ai!.ocgRefs[i] === doc.ai!.importOcgRefsByCatalogIndex?.[i], doc.ai!.ocgRefs[i] ?? '');
      assert(`leaf-name-${i}`, !!leaf, leaf?.name ?? '');
    }
  }

  // --- labeled folder (PDF Order string before nested array) ---
  {
    const buf = await buildNestedOrderPdf(flatThree, (ocgs, pdfDoc) => {
      const inner = pdfDoc.context.obj([ocgs.get(0), ocgs.get(1)]);
      return pdfDoc.context.obj([PDFString.of('MyFolder'), inner, ocgs.get(2)]);
    });
    const doc = await importAi('labeled-nested.ai', buf);
    const g = doc.roots.find((r) => r.kind === 'group');
    assert('labeled-group-name', g?.name === 'MyFolder', g?.name ?? '');
  }

  // --- two-level nesting (four OCGs) ---
  {
    const buf = await buildFourOcgNestedFixture();
    const doc = await importAi('four-nested.ai', buf);
    assert('four-nested-outline', treeOutline(doc.roots) === 'group(group(L1,L2),L3);L4', treeOutline(doc.roots));
    assert('four-leaf-count', leaves(doc).length === 4, String(leaves(doc).length));
  }

  // --- duplicate OCG in Order → flat fallback ---
  {
    const buf = await buildNestedOrderPdf(flatThree, (ocgs, pdfDoc) => {
      return pdfDoc.context.obj([ocgs.get(0), ocgs.get(0), ocgs.get(2)]);
    });
    const doc = await importAi('dup-order.ai', buf);
    assert('dup-fallback-flat', doc.roots.every((r) => r.kind !== 'group'), treeOutline(doc.roots));
    assert('dup-fallback-warning', doc.warnings.some((w) => /more than once|invalid/i.test(w)), doc.warnings.join(' | '));
  }

  // --- empty nested group → flat fallback ---
  {
    const buf = await buildNestedOrderPdf(flatThree, (ocgs, pdfDoc) => {
      const empty = pdfDoc.context.obj([]);
      const folder = pdfDoc.context.obj([ocgs.get(0), ocgs.get(1)]);
      return pdfDoc.context.obj([empty, folder, ocgs.get(2)]);
    });
    const doc = await importAi('empty-group.ai', buf);
    assert('empty-group-fallback', doc.roots.length === 3 && doc.roots.every((r) => r.kind !== 'group'), treeOutline(doc.roots));
  }

  // --- Order omits one catalog OCG → flat fallback ---
  {
    const buf = await buildNestedOrderPdf(flatThree, (ocgs, pdfDoc) => {
      const folder = pdfDoc.context.obj([ocgs.get(0), ocgs.get(1)]);
      return pdfDoc.context.obj([folder]);
    });
    const doc = await importAi('missing-ocg.ai', buf);
    assert('missing-ocg-flat', doc.roots.length === 3, String(doc.roots.length));
    assert('missing-ocg-warning', doc.warnings.some((w) => /omits|lists 2 layer/i.test(w)), doc.warnings.join(' | '));
  }

  // --- single-layer sample (flat; no nested Order groups) ---
  {
    const doc = await importAi('sample.ai', loadBuf(sampleAi));
    assert('sample-single-root', doc.roots.length === 1, String(doc.roots.length));
    assert('sample-no-import-groups', doc.roots.every((r) => r.kind !== 'group'), treeOutline(doc.roots));
    assert('sample-one-leaf', leaves(doc).length === 1, String(leaves(doc).length));
  }

  // --- no OCG catalog → single Artwork leaf ---
  {
    const doc = await importAi('no-ocg.ai', await buildNoOcgArtworkPdf());
    assert('no-ocg-artwork-key', doc.roots.length === 1 && doc.roots[0]!.key === 'artwork-0', doc.roots[0]?.key ?? '');
    assert('no-ocg-hasOcg-false', !doc.ai?.hasOcg, String(doc.ai?.hasOcg));
  }

  // --- regressions: two-ocg reorder still eligible ---
  {
    const doc = await importAi('two-ocg.ai', loadBuf(twoOcg));
    assert('two-ocg-reorder-eligible', canReorderAiDocument(doc), aiReorderDocumentBlockedReason(doc) ?? '');
    assert('two-ocg-flat-roots', doc.roots.length === 2 && doc.roots.every((r) => r.parent === null), '');
  }

  // --- leaf walk order bottom→top follows tree preorder ---
  {
    const doc = await importAi('nested-walk.ai', loadBuf(nestedOut));
    const names = leaves(doc).map((n) => n.name).join(',');
    assert('nested-leaf-paint-names', names === 'RedSquare,GreenSquare,BlueSquare', names);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n--- Summary ---\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    failed.forEach((f) => console.error(`FAIL: ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

async function buildNoOcgArtworkPdf(): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([80, 80]);
  const body = 'q 1 0 0 rg 0 0 m 40 0 l 40 40 h f Q\n';
  const contentsRef = pdfDoc.context.register(pdfDoc.context.flateStream(new TextEncoder().encode(body)));
  page.node.set(PDFName.of('Contents'), contentsRef);
  const out = await pdfDoc.save({ useObjectStreams: false });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

async function buildFourOcgNestedFixture(): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([120, 120]);
  const names = ['L1', 'L2', 'L3', 'L4'];
  const refs = names.map((nm) => pdfDoc.context.register(pdfDoc.context.obj({ Type: 'OCG', Name: PDFString.of(nm) })));
  const streamBody =
    '/OC /MC0 BDC q 1 0 0 rg 0 0 m 10 0 l 10 10 h f Q EMC\n' +
    '/OC /MC1 BDC q 0 1 0 rg 0 0 m 10 0 l 10 10 h f Q EMC\n' +
    '/OC /MC2 BDC q 0 0 1 rg 0 0 m 10 0 l 10 10 h f Q EMC\n' +
    '/OC /MC3 BDC q 1 1 0 rg 0 0 m 10 0 l 10 10 h f Q EMC\n';
  const contentsRef = pdfDoc.context.register(pdfDoc.context.flateStream(new TextEncoder().encode(streamBody)));
  const page = pdfDoc.getPage(0);
  page.node.set(PDFName.of('Contents'), contentsRef);
  page.node.set(
    PDFName.of('Resources'),
    pdfDoc.context.obj({
      Properties: { MC0: refs[0], MC1: refs[1], MC2: refs[2], MC3: refs[3] },
    }),
  );
  const inner = pdfDoc.context.obj([refs[0], refs[1]]);
  const outer = pdfDoc.context.obj([inner, refs[2]]);
  const order = pdfDoc.context.obj([outer, refs[3]]);
  const ocPropsRef = pdfDoc.context.register(
    pdfDoc.context.obj({
      OCGs: refs,
      D: { Name: PDFString.of('D'), Order: order, ON: refs, OFF: [], RBGroups: [] },
    }),
  );
  (pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict).set(PDFName.of('OCProperties'), ocPropsRef);
  const out = await pdfDoc.save({ useObjectStreams: false });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});

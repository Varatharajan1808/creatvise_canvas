/**
 * Format adapters and registry: PSD and AI are registered (and nothing else), lookup is case-insensitive,
 * unsupported formats are refused, capability flags are exact, and importDocument plus exportDocument give
 * exactly what the PSD/AI functions they delegate to give when called directly.
 */
import fs from 'fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import type { Doc, Node } from '../src/model';
import type { FormatAdapter } from '../src/formats';

const hooks = [
  'export async function resolve(specifier, context, next) {',
  "  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };",
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hooks));

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
(globalThis as any).DOMParser = window.DOMParser;
(globalThis as any).window = window;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const errorOf = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return '(no error)';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const sameBytes = (a: ArrayBuffer, b: ArrayBuffer) => {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

const treeSig = (doc: Doc): string => {
  const walkSig = (nodes: Node[]): unknown[] =>
    nodes.map((n) => [n.name, n.kind, n.x, n.y, n.w, n.h, n.visible, n.opacity, walkSig(n.children)]);
  return JSON.stringify([doc.format, doc.name, doc.width, doc.height, walkSig(doc.roots)]);
};

const stubDoc = (format: Doc['format'], name = 'file.' + format): Doc =>
  ({ id: 'd', name, format, width: 1, height: 1, offsetX: 0, offsetY: 0, roots: [], warnings: [] }) as unknown as Doc;

async function atFixedTime<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixed = RealDate.UTC(2026, 0, 1);
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

function aiSampleDoc(): Doc {
  const buf = fs.readFileSync('public/sample.ai');
  const node = {
    id: 'n_ocg-0', key: 'ocg-0', name: 'Layer 1', kind: 'raster', visible: true, locked: false,
    opacity: 0.75, importOpacity: 1, importVisible: true,
    x: 50, y: 30, w: 680, h: 680, rotation: 15, ow: 680, oh: 680, ox: 0, oy: 0,
    canvas: null, children: [], parent: null, unsupported: [],
    src: { name: 'Layer 1', left: 50, top: 30, right: 730, bottom: 710, hidden: false, opacity: 0.75 },
  } as unknown as Node;
  return {
    id: 'doc-sample', name: 'sample.ai', format: 'ai', width: 680, height: 680, offsetX: 0, offsetY: 0,
    original: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    warnings: [],
    ai: {
      kind: 'ai', pageCount: 1, hasOcg: true, ocgNames: ['Layer 1'], ocgRefs: ['5 0 R'],
      hasExtGStateOpacity: true, extGStateCaAtImport: 1,
      nextMcIndex: 1, canDuplicateMarkedContent: true,
    },
    roots: [node],
  } as Doc;
}

async function runTests() {
  const { createFormatRegistry, formatRegistry } = await import('../src/formats');
  const { psdAdapter } = await import('../src/formats/psdAdapter');
  const { aiAdapter } = await import('../src/formats/aiAdapter');
  const caps = await import('../src/formatCaps');
  const { importDocument } = await import('../src/formatImport');
  const { exportDocument, exportEditedDownloadName, exportEditedMimeType } = await import('../src/formatExport');
  const { importPsd, exportPsd, createSamplePsd } = await import('../src/psd');
  const { importAi, exportAi } = await import('../src/ai');

  const reg = createFormatRegistry([psdAdapter, aiAdapter]);
  assert('get-exact', reg.get('psd') === psdAdapter && reg.get('ai') === aiAdapter, 'psd, ai');
  assert('get-case-and-space', reg.get('PSD') === psdAdapter && reg.get(' Ai ') === aiAdapter, 'PSD, " Ai "');
  assert('ext-lookup', reg.forExtension('psd') === psdAdapter && reg.forExtension('.AI') === aiAdapter, 'psd, .AI');
  const byName: Array<[string, FormatAdapter | null]> = [
    ['Poster.Final.PSD', psdAdapter],
    ['logo.ai', aiAdapter],
    [' photo.psd ', psdAdapter],
    ['noextension', null],
    ['archive.ai.zip', null],
    ['draft.indd', null],
    ['layout.idml', null],
    ['.psd', psdAdapter],
  ];
  for (const [name, want] of byName) {
    const got = reg.forFileName(name);
    assert('file-name "' + name + '"', got === want, 'got ' + (got?.format ?? 'null') + ', want ' + (want?.format ?? 'null'));
  }
  const unsupported = ['indd', 'idml', 'pdf', '', 'psb'];
  assert(
    'unsupported-get-null',
    unsupported.every((f) => reg.get(f) === null && reg.forExtension(f) === null),
    unsupported.map((f) => JSON.stringify(f)).join(', '),
  );
  const dupFormat = await errorOf(() => createFormatRegistry([psdAdapter, { ...aiAdapter, format: 'psd' } as FormatAdapter]));
  assert('duplicate-format-throws', dupFormat === 'Duplicate format adapter for "psd".', dupFormat);
  const dupExt = await errorOf(() =>
    createFormatRegistry([psdAdapter, { ...aiAdapter, extensions: ['ai', 'PSD'] } as FormatAdapter]),
  );
  assert('duplicate-extension-throws', dupExt === 'Extension ".psd" is claimed by both "psd" and "ai".', dupExt);

  const { inddAdapter } = await import('../src/formats/inddAdapter');
  const { createSampleIdml } = await import('../src/idml');

  assert(
    'production-formats',
    JSON.stringify(formatRegistry.formats()) === '["psd","ai","indd"]',
    JSON.stringify(formatRegistry.formats()),
  );
  assert(
    'production-adapters',
    formatRegistry.get('psd') === psdAdapter &&
      formatRegistry.get('ai') === aiAdapter &&
      formatRegistry.get('indd') === inddAdapter,
    'psd -> psdAdapter, ai -> aiAdapter, indd -> inddAdapter',
  );
  assert(
    'production-indd-idml',
    formatRegistry.get('indd') === inddAdapter &&
      formatRegistry.forExtension('idml') === inddAdapter &&
      formatRegistry.forExtension('indd') === inddAdapter &&
      formatRegistry.get('idml') === null,
    'indd registered, idml extension maps to indd adapter',
  );
  assert(
    'adapter-metadata',
    JSON.stringify([psdAdapter.extensions, psdAdapter.mimeType, aiAdapter.extensions, aiAdapter.mimeType, inddAdapter.extensions, inddAdapter.mimeType]) ===
      JSON.stringify([['psd'], 'image/vnd.adobe.photoshop', ['ai'], 'application/pdf', ['indd', 'idml'], 'application/x-indesign']),
    psdAdapter.mimeType + ', ' + aiAdapter.mimeType + ', ' + inddAdapter.mimeType,
  );
  for (const name of ['a.psd', 'B.PSD', 'c.ai', 'D.Ai', 'e.indd', 'f.idml', 'g']) {
    const legacy = caps.formatFromFileName(name);
    const viaRegistry = formatRegistry.forFileName(name)?.format ?? null;
    const want = legacy;
    assert('registry-matches-formatFromFileName "' + name + '"', viaRegistry === want, 'legacy=' + legacy + ' registry=' + viaRegistry);
  }

  assert(
    'caps-same-source',
    psdAdapter.capabilities === caps.capabilitiesFor('psd') &&
      aiAdapter.capabilities === caps.capabilitiesFor('ai') &&
      inddAdapter.capabilities === caps.capabilitiesFor('indd'),
    'adapter.capabilities is the formatCaps entry',
  );
  const psdCaps = JSON.stringify(caps.capabilitiesFor('psd'));
  assert(
    'caps-psd-exact',
    psdCaps ===
      '{"export":true,"duplicateNativeTree":true,"groupLayers":true,"folderBatchImport":true,"editText":true,"editShape":true,"replaceImage":true,"resizeRotate":true,"deleteLayer":true,"reorderLayer":true}',
    psdCaps,
  );
  const aiCaps = JSON.stringify(caps.capabilitiesFor('ai'));
  assert(
    'caps-ai-exact',
    aiCaps ===
      '{"export":true,"duplicateNativeTree":true,"groupLayers":true,"folderBatchImport":true,"editText":false,"editShape":true,"replaceImage":false,"resizeRotate":true,"deleteLayer":true,"reorderLayer":false}',
    aiCaps,
  );
  const inddCaps = JSON.stringify(caps.capabilitiesFor('indd'));
  assert(
    'caps-indd-exact',
    inddCaps ===
      '{"export":true,"duplicateNativeTree":false,"groupLayers":false,"folderBatchImport":false,"editText":true,"editShape":true,"replaceImage":false,"resizeRotate":true,"deleteLayer":true,"reorderLayer":false}',
    inddCaps,
  );
  const flagRow = (f: Doc['format']) => {
    const d = stubDoc(f);
    return [caps.canResizeRotate(d), caps.canDeleteLayer(d), caps.canExportDocument(d), caps.canDuplicateLayer(d)];
  };
  assert('caps-helpers-psd', JSON.stringify(flagRow('psd')) === '[true,true,true,true]', JSON.stringify(flagRow('psd')));
  assert(
    'caps-helpers-ai-canDuplicateLayer',
    caps.canDuplicateLayer(stubDoc('ai')) === false,
    'stub ai doc has no canDuplicateMarkedContent',
  );
  assert('caps-helpers-ai-other', JSON.stringify([caps.canResizeRotate(stubDoc('ai')), caps.canDeleteLayer(stubDoc('ai')), caps.canExportDocument(stubDoc('ai'))]) === '[true,true,true]', 'resize/delete/export');
  assert(
    'caps-helpers-indd',
    JSON.stringify(flagRow('indd')) === '[true,true,true,false]' && caps.capabilitiesFor('indd') !== null,
    JSON.stringify(flagRow('indd')),
  );

  const legacyName = (d: Doc) => {
    const base = d.name.replace(/\.(psd|ai)$/i, '');
    return d.format === 'ai' ? base + '.edited.ai' : base + '.edited.psd';
  };
  const legacyMime = (d: Doc) => (d.format === 'ai' ? 'application/pdf' : 'image/vnd.adobe.photoshop');
  for (const format of ['psd', 'ai'] as const) {
    for (const name of ['photo.psd', 'Photo.PSD', 'logo.ai', 'LOGO.AI', 'noext', 'two.psd.ai', 'my file.ai.psd']) {
      const d = stubDoc(format, name);
      const got = [exportEditedDownloadName(d), exportEditedMimeType(d)];
      const want = [legacyName(d), legacyMime(d)];
      assert('download-' + format + ' "' + name + '"', JSON.stringify(got) === JSON.stringify(want), got.join(' | '));
    }
  }
  const inddDownloadName = exportEditedDownloadName(stubDoc('indd', 'brochure.idml'));
  const inddDownloadMime = exportEditedMimeType(stubDoc('indd', 'brochure.idml'));
  assert(
    'download-indd-supported',
    inddDownloadName === 'brochure.edited.idml' && inddDownloadMime === 'application/x-indesign',
    inddDownloadName + ' | ' + inddDownloadMime,
  );
  const badFormatName = await errorOf(() => exportEditedDownloadName(stubDoc('pdf' as any)));
  assert('download-unsupported-refused', badFormatName === 'Export is not supported for format "pdf".', badFormatName);

  const sample = createSamplePsd();
  const psdDirect = importPsd('sample.psd', sample.slice(0));
  const psdViaEntry = await importDocument('sample.psd', sample.slice(0), 'psd');
  const psdViaAdapter = await psdAdapter.importDoc('sample.psd', sample.slice(0));
  assert(
    'import-psd-matches-direct',
    treeSig(psdViaEntry) === treeSig(psdDirect) && treeSig(psdViaAdapter) === treeSig(psdDirect),
    'layers=' + psdDirect.roots.length + ' ' + psdDirect.width + 'x' + psdDirect.height,
  );
  const junk = new TextEncoder().encode('not a real file').buffer;
  const psdJunk = [await errorOf(() => importPsd('bad.psd', junk.slice(0))), await errorOf(() => importDocument('bad.psd', junk.slice(0), 'psd'))];
  assert('import-psd-error-unchanged', psdJunk[0] === psdJunk[1] && psdJunk[0] !== '(no error)', psdJunk[1]);
  const aiJunk = [await errorOf(() => importAi('bad.ai', junk.slice(0))), await errorOf(() => importDocument('bad.ai', junk.slice(0), 'ai'))];
  assert('import-ai-error-unchanged', aiJunk[0] === aiJunk[1] && aiJunk[0] !== '(no error)', aiJunk[1]);
  const badFormatImport = await errorOf(() => importDocument('x.pdf', junk.slice(0), 'pdf' as any));
  assert('import-unsupported-refused', badFormatImport === 'Import is not supported for format "pdf".', badFormatImport);

  // IDML import via registry
  const sampleIdmlBytes = await createSampleIdml();
  const idmlDoc = await importDocument('sample.idml', sampleIdmlBytes, 'indd');
  assert('import-idml-via-registry', idmlDoc.roots.length === 2 && idmlDoc.format === 'indd', 'roots=' + idmlDoc.roots.length);

  const psdA = importPsd('sample.psd', sample.slice(0));
  const psdB = importPsd('sample.psd', sample.slice(0));
  const unedited = [await exportDocument(psdA), exportPsd(psdB)];
  assert('export-psd-unedited-identical', sameBytes(unedited[0], unedited[1]), 'bytes=' + unedited[0].byteLength);
  for (const d of [psdA, psdB]) {
    const leaf = d.roots.find((n) => n.kind === 'raster')!;
    leaf.x += 10;
    leaf.y += 5;
  }
  const edited = [await exportDocument(psdA), exportPsd(psdB)];
  assert(
    'export-psd-edited-identical',
    sameBytes(edited[0], edited[1]) && !sameBytes(edited[0], unedited[0]),
    'bytes=' + edited[0].byteLength,
  );
  const aiBytes = await atFixedTime(async () => [await exportDocument(aiSampleDoc()), await exportAi(aiSampleDoc())]);
  assert('export-ai-identical', sameBytes(aiBytes[0], aiBytes[1]) && aiBytes[0].byteLength > 0, 'bytes=' + aiBytes[0].byteLength);

  // IDML export via registry
  const exportedIdml = await exportDocument(idmlDoc);
  assert('export-idml-via-registry', exportedIdml.byteLength > 0, 'bytes=' + exportedIdml.byteLength);

  const badExport = await errorOf(() => exportDocument(stubDoc('pdf' as any)));
  assert('export-unsupported-refused', badExport === 'Export is not supported for format "pdf".', badExport);
  const psdNoTree = await errorOf(() => exportDocument(stubDoc('psd')));
  assert('export-psd-without-tree-not-sent-to-ai', psdNoTree === 'Expected a PSD document, got format "psd".', psdNoTree);

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error(failures.length + ' of ' + results.length + ' format adapter checks failed!');
    process.exit(1);
  } else {
    console.log('All ' + results.length + ' format adapter checks passed!');
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Phase A: live PDF text detection (parser + import metadata only).
 * Synthetic PDF fixture — not an Illustrator desktop round-trip proof.
 */
import fs from 'fs';
import path from 'path';
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';
import {
  applyAiLiveTextImport,
  parseMcBlockLiveText,
  parsePdfLiveText,
  totalSupportedAiLiveTextRuns,
} from '../src/ai/aiPdfText';
import {
  AiTextStreamExportError,
  applyAiLiveTextEdit,
  buildLiteralTjOperator,
  canEditAiLiveTextOnNode,
  getAiLiveTextInfo,
} from '../src/ai/aiTextEdit';
import { readFirstPageContentStreamText } from '../src/ai/aiVectorShapes';
import { captureState, getTextInfo, restoreState } from '../src/operations/edit';
import { walk, type Doc, type Node } from '../src/core/model';
import { asAiLayerStub, initAiLayerMeta } from '../src/ai/aiLayerMeta';
import type { Layer } from 'ag-psd';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

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

/** Build a minimal PDF-compatible .ai (uncompressed page content stream). */
export function buildMinimalAiPdf(contentStream: string, width = 200, height = 200): Buffer {
  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0];

  const addObj = (body: string) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(body);
  };

  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  addObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  addObj(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ExtGState << /GS0 6 0 R >> >> >>\nendobj\n`,
  );
  addObj(`4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream\nendobj\n`);
  addObj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  addObj('6 0 obj\n<< /Type /ExtGState /ca 1 /CA 1 >>\nendobj\n');

  const xrefPos = Buffer.byteLength(chunks.join(''), 'latin1');
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(xref);
  return Buffer.from(chunks.join(''), 'latin1');
}

export function buildSyntheticLiveTextPdf(contentStream: string, mediaSize = 200): Buffer {
  return buildMinimalAiPdf(contentStream, mediaSize, mediaSize);
}

function ensureAiFixtures(): void {
  const dir = path.join('public', 'fixtures', 'ai');
  fs.mkdirSync(dir, { recursive: true });

  const shapesPath = path.join(dir, 'simple-shapes.ai');
  const rectStream = `/OC /MC0 BDC
q
0.500 0.250 0.000 rg
0.000 0.500 0.000 RG
2 w
50 170 120 80 re
f
Q
EMC
`;
  fs.writeFileSync(shapesPath, buildMinimalAiPdf(rectStream, 400, 300));
}

function countTextKindNodes(doc: Doc): number {
  return [...walk(doc.roots)].filter((n) => n.kind === 'text').length;
}

async function runParserTests() {
  const pageH = 200;
  const pureBody = `/OC /MC0 BDC
q
BT
/F1 18 Tf
1 0 0 1 24 120 Tm
0 0 0 rg
(Hello World) Tj
ET
Q
EMC`;

  const pure = parseMcBlockLiveText(pureBody, 0, pageH);
  assert('pure-tj-count', pure.runs.length === 1 && !pure.mixed, `runs=${pure.runs.length} mixed=${pure.mixed}`);
  assert('pure-tj-text', pure.runs[0]?.text === 'Hello World', pure.runs[0]?.text ?? '');
  assert('pure-tj-font', pure.runs[0]?.fontResource === 'F1' && pure.runs[0]?.fontSize === 18, `${pure.runs[0]?.fontResource}@${pure.runs[0]?.fontSize}`);
  assert('pure-tj-fill', pure.runs[0]?.fillRgb?.r === 0 && pure.runs[0]?.patch.fillSearch === '0 0 0 rg', pure.runs[0]?.patch.fillSearch ?? '');
  assert('pure-tj-matrix', pure.runs[0]?.textMatrix[4] === 24 && pure.runs[0]?.textMatrix[5] === 120, JSON.stringify(pure.runs[0]?.textMatrix));
  assert('pure-tj-doc-y', Math.abs((pure.runs[0]?.docY ?? 0) - (pageH - 120 - 1)) < 2, String(pure.runs[0]?.docY));

  const tjBody = `/OC /MC1 BDC
BT
/F2 24 Tf
1 0 0 1 10 50 Tm
[(Hel)-120(lo)] TJ
ET
EMC`;
  const tj = parseMcBlockLiveText(tjBody, 1, pageH);
  assert('tj-kern-text', tj.runs[0]?.text === 'Hello', tj.runs[0]?.text ?? '');
  assert('tj-kern-search', tj.runs[0]?.patch.tjSearch.includes('TJ'), tj.runs[0]?.patch.tjSearch ?? '');

  const tdBody = `/OC /MC0 BDC
BT
/F1 12 Tf
1 0 0 1 0 100 Tm
0 0 1 rg
(Top) Tj
0 -20 Td
(Bottom) Tj
ET
EMC`;
  const tdBlock = parseMcBlockLiveText(tdBody, 0, pageH);
  assert('td-two-runs', tdBlock.runs.length === 2, `count=${tdBlock.runs.length}`);
  assert('td-second-y', tdBlock.runs[1]?.textMatrix[5] === 80, String(tdBlock.runs[1]?.textMatrix[5]));

  const outlined = `/OC /MC0 BDC
q
10 10 80 40 re
0 0 0 rg
f
Q
EMC`;
  const out = parseMcBlockLiveText(outlined, 0, pageH);
  assert('outlined-no-runs', out.runs.length === 0 && !out.mixed, `runs=${out.runs.length} mixed=${out.mixed}`);

  const mixed = `/OC /MC0 BDC
BT
/F1 12 Tf
1 0 0 1 0 0 Tm
(X) Tj
ET
10 10 20 20 re f
EMC`;
  const mix = parseMcBlockLiveText(mixed, 0, pageH);
  assert('mixed-rejected', mix.mixed && mix.runs.length === 0, `mixed=${mix.mixed} runs=${mix.runs.length}`);

  const full = parsePdfLiveText(pureBody, pageH);
  assert('parse-full-blocks', full.length === 1 && full[0].runs.length === 1, `blocks=${full.length}`);
}

async function runImportTests() {
  const { importAi } = await import('../src/ai/ai');

  const sampleBuf = fs.readFileSync('public/sample.ai');
  const sampleAb = sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength);
  const sampleDoc = await importAi('sample.ai', sampleAb.slice(0));
  assert('sample-no-text-nodes', countTextKindNodes(sampleDoc) === 0, `text nodes=${countTextKindNodes(sampleDoc)}`);
  assert('sample-no-live-runs', totalSupportedAiLiveTextRuns(sampleDoc) === 0, `runs=${totalSupportedAiLiveTextRuns(sampleDoc)}`);

  const fixtureDir = path.join('public', 'fixtures', 'ai');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const stream = `/OC /MC0 BDC
q
BT
/F1 18 Tf
1 0 0 1 24 120 Tm
0 0 0 rg
(Synthetic Live Text) Tj
ET
Q
EMC
`;
  const synthetic = buildSyntheticLiveTextPdf(stream);
  const fixturePath = path.join(fixtureDir, 'live-text-synthetic.ai');
  fs.writeFileSync(fixturePath, synthetic);

  const synAb = synthetic.buffer.slice(synthetic.byteOffset, synthetic.byteOffset + synthetic.byteLength) as ArrayBuffer;
  const stubLayer: Layer = { name: 'Artwork', left: 0, top: 0, right: 200, bottom: 200, hidden: false, opacity: 1 };
  initAiLayerMeta(stubLayer, 0);
  const leaf: Node = {
    id: 'syn-leaf',
    key: 'artwork-0',
    name: 'Artwork',
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    rotation: 0,
    ow: 200,
    oh: 200,
    ox: 0,
    oy: 0,
    canvas: null,
    children: [],
    parent: null,
    src: stubLayer,
    unsupported: [],
  };
  const synDoc: Doc = {
    id: 'syn-doc',
    name: 'live-text-synthetic.ai',
    format: 'ai',
    width: 200,
    height: 200,
    offsetX: 0,
    offsetY: 0,
    roots: [leaf],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: false,
      ocgNames: [],
      ocgRefs: [],
      hasExtGStateOpacity: false,
      extGStateCaAtImport: 1,
      nextMcIndex: 1,
      canDuplicateMarkedContent: true,
    },
    original: synAb.slice(0),
    warnings: [],
  };
  await applyAiLiveTextImport(synDoc);
  assert('synthetic-no-text-kind', countTextKindNodes(synDoc) === 0, `text nodes=${countTextKindNodes(synDoc)}`);
  assert('synthetic-live-runs', totalSupportedAiLiveTextRuns(synDoc) === 1, `runs=${totalSupportedAiLiveTextRuns(synDoc)}`);
  const runs = asAiLayerStub(leaf.src).aiLiveTextRuns;
  assert('synthetic-stub-text', runs?.[0]?.text === 'Synthetic Live Text', runs?.[0]?.text ?? 'missing runs');
  assert('synthetic-still-raster', leaf.kind === 'raster', leaf.kind);
}

async function runEditTests() {
  const stream = `/OC /MC0 BDC
q
BT
/F1 18 Tf
1 0 0 1 24 120 Tm
0 0 0 rg
(Synthetic Live Text) Tj
ET
Q
EMC
`;
  const synthetic = buildSyntheticLiveTextPdf(stream);
  const synAb = synthetic.buffer.slice(synthetic.byteOffset, synthetic.byteOffset + synthetic.byteLength) as ArrayBuffer;
  const c = createCanvas(200, 200);
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(51, 102, 153)';
  g.fillRect(0, 0, 200, 200);
  g.fillStyle = 'rgb(0, 0, 0)';
  g.font = '18px Helvetica';
  g.fillText('Synthetic Live Text', 24, 120);

  const stubLayer: Layer = { name: 'Artwork', left: 0, top: 0, right: 200, bottom: 200, hidden: false, opacity: 1 };
  initAiLayerMeta(stubLayer, 0);
  const leaf: Node = {
    id: 'edit-leaf',
    key: 'artwork-0',
    name: 'Artwork',
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    rotation: 0,
    ow: 200,
    oh: 200,
    ox: 0,
    oy: 0,
    canvas: c as unknown as HTMLCanvasElement,
    children: [],
    parent: null,
    src: stubLayer,
    unsupported: [],
  };
  const synDoc: Doc = {
    id: 'edit-doc',
    name: 'live-text-synthetic.ai',
    format: 'ai',
    width: 200,
    height: 200,
    offsetX: 0,
    offsetY: 0,
    roots: [leaf],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: false,
      ocgNames: [],
      ocgRefs: [],
      hasExtGStateOpacity: false,
      extGStateCaAtImport: 1,
      nextMcIndex: 1,
      canDuplicateMarkedContent: true,
    },
    original: synAb.slice(0),
    warnings: [],
  };

  await applyAiLiveTextImport(synDoc);
  assert('edit-can-edit', canEditAiLiveTextOnNode(leaf), 'expected editable');
  assert('edit-preview-isolate', asAiLayerStub(leaf.src).aiTextPreviewMode === 'isolate', asAiLayerStub(leaf.src).aiTextPreviewMode ?? '');

  const bg = c.getContext('2d')!.getImageData(10, 10, 1, 1).data;
  const before = captureState(leaf);
  applyAiLiveTextEdit(leaf, { text: 'Edited Label' });
  assert('edit-flag', leaf.aiTextEdited === true, String(leaf.aiTextEdited));
  assert('edit-info', getAiLiveTextInfo(leaf)?.text === 'Edited Label', getAiLiveTextInfo(leaf)?.text ?? '');
  assert('edit-getTextInfo', getTextInfo(leaf)?.text === 'Edited Label', getTextInfo(leaf)?.text ?? '');
  const bgAfter = leaf.canvas!.getContext('2d')!.getImageData(10, 10, 1, 1).data;
  assert('edit-preserves-bg', bgAfter[0] === bg[0] && bgAfter[1] === bg[1] && bgAfter[2] === bg[2], `${bgAfter[0]},${bgAfter[1]},${bgAfter[2]}`);
  const run = asAiLayerStub(leaf.src).aiLiveTextRuns?.[0];
  assert('edit-import-text-unchanged', run?.text === 'Synthetic Live Text', run?.text ?? '');

  restoreState(leaf, before);
  assert('undo-text', getAiLiveTextInfo(leaf)?.text === 'Synthetic Live Text', getAiLiveTextInfo(leaf)?.text ?? '');
  assert('undo-flag', !leaf.aiTextEdited, String(leaf.aiTextEdited));

  asAiLayerStub(stubLayer).aiLiveTextUnsupported = 'Mixed marked-content block.';
  asAiLayerStub(stubLayer).aiLiveTextRuns = run ? [{ ...run }] : [];
  assert('mixed-not-editable', !canEditAiLiveTextOnNode(leaf), 'mixed should block');
}

function buildTextExportDoc(streamBody: string, canvasDraw?: (g: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) {
  const synthetic = buildSyntheticLiveTextPdf(streamBody);
  const synAb = synthetic.buffer.slice(synthetic.byteOffset, synthetic.byteOffset + synthetic.byteLength) as ArrayBuffer;
  const c = createCanvas(200, 200);
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(51, 102, 153)';
  g.fillRect(0, 0, 200, 200);
  canvasDraw?.(g);

  const stubLayer: Layer = { name: 'Artwork', left: 0, top: 0, right: 200, bottom: 200, hidden: false, opacity: 1 };
  initAiLayerMeta(stubLayer, 0);
  const leaf: Node = {
    id: 'export-leaf',
    key: 'artwork-0',
    name: 'Artwork',
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    rotation: 0,
    ow: 200,
    oh: 200,
    ox: 0,
    oy: 0,
    canvas: c as unknown as HTMLCanvasElement,
    children: [],
    parent: null,
    src: stubLayer,
    unsupported: [],
  };
  const doc: Doc = {
    id: 'export-doc',
    name: 'live-text-synthetic.ai',
    format: 'ai',
    width: 200,
    height: 200,
    offsetX: 0,
    offsetY: 0,
    roots: [leaf],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: false,
      ocgNames: [],
      ocgRefs: [],
      hasExtGStateOpacity: false,
      extGStateCaAtImport: 1,
      nextMcIndex: 1,
      canDuplicateMarkedContent: true,
    },
    original: synAb.slice(0),
    warnings: [],
  };
  return { doc, leaf, synAb };
}

async function runExportTests() {
  const { exportAi } = await import('../src/ai/ai');
  const { parsePdfLiveText } = await import('../src/ai/aiPdfText');

  const literalStream = `/OC /MC0 BDC
q
BT
/F1 18 Tf
1 0 0 1 24 120 Tm
0 0 0 rg
(Synthetic Live Text) Tj
ET
Q
EMC
`;

  const { doc, leaf, synAb } = buildTextExportDoc(literalStream, (g) => {
    g.fillStyle = 'rgb(0,0,0)';
    g.font = '18px Helvetica';
    g.fillText('Synthetic Live Text', 24, 120);
  });
  await applyAiLiveTextImport(doc);

  const uneditedOut = await exportAi(doc);
  assert(
    'export-unedited-identical',
    uneditedOut.byteLength === synAb.byteLength && Buffer.from(uneditedOut).equals(Buffer.from(synAb)),
    `len ${uneditedOut.byteLength} vs ${synAb.byteLength}`,
  );

  applyAiLiveTextEdit(leaf, { text: 'Edited Label' });
  const editedOut = await exportAi(doc);
  const expStream = await readFirstPageContentStreamText(editedOut);
  assert('export-stream-present', !!expStream, '');
  const wantTj = buildLiteralTjOperator('Edited Label');
  assert(
    'export-stream-contains-edited-tj',
    !!expStream?.text.includes(wantTj),
    expStream?.text.includes('Synthetic Live Text') ? 'still original' : wantTj,
  );
  assert('export-stream-keeps-mc', !!expStream?.text.includes('/OC /MC0 BDC'), 'mc');
  assert('export-stream-keeps-bg-op', !!expStream?.text.includes('0 0 0 rg'), 'rg');

  const parsed = parsePdfLiveText(expStream!.text, expStream!.pageHeight);
  assert('export-reparse-text', parsed[0]?.runs[0]?.text === 'Edited Label', parsed[0]?.runs[0]?.text ?? '');

  const { doc: sameDoc, leaf: sameLeaf } = buildTextExportDoc(literalStream);
  await applyAiLiveTextImport(sameDoc);
  applyAiLiveTextEdit(sameLeaf, { text: 'Synthetic Live TeX' });
  const sameLenOut = await exportAi(sameDoc);
  const sameStream = await readFirstPageContentStreamText(sameLenOut);
  assert(
    'export-same-length',
    sameStream?.text.includes(buildLiteralTjOperator('Synthetic Live TeX')) ?? false,
    'same len token',
  );

  const { doc: colorDoc, leaf: colorLeaf } = buildTextExportDoc(literalStream);
  await applyAiLiveTextImport(colorDoc);
  applyAiLiveTextEdit(colorLeaf, { color: { r: 255, g: 0, b: 0 } });
  const colorOut = await exportAi(colorDoc);
  const colorStream = await readFirstPageContentStreamText(colorOut);
  assert(
    'export-fill-color',
    !!colorStream?.text.includes('1.000 0.000 0.000 rg'),
    colorStream?.text.match(/[\d.]+\s+[\d.]+\s+[\d.]+\s+rg/)?.[0] ?? '',
  );

  const { doc: typoDoc, leaf: typoLeaf } = buildTextExportDoc(literalStream);
  await applyAiLiveTextImport(typoDoc);
  applyAiLiveTextEdit(typoLeaf, { fontSize: 24 });
  let typoThrew = false;
  try {
    await exportAi(typoDoc);
  } catch (e) {
    typoThrew = e instanceof AiTextStreamExportError;
  }
  assert('export-rejects-typography-only', typoThrew, 'expected AiTextStreamExportError');

  const tjStream = `/OC /MC0 BDC
BT
/F1 18 Tf
1 0 0 1 24 120 Tm
[(Hel)-120(lo)] TJ
ET
EMC
`;
  const { doc: tjDoc, leaf: tjLeaf } = buildTextExportDoc(tjStream);
  await applyAiLiveTextImport(tjDoc);
  applyAiLiveTextEdit(tjLeaf, { text: 'Helloz' });
  let tjThrew = false;
  try {
    await exportAi(tjDoc);
  } catch (e) {
    tjThrew = e instanceof AiTextStreamExportError;
  }
  assert('export-rejects-tj-edit', tjThrew, 'expected TJ rejection');
}

async function main() {
  ensureAiFixtures();
  await runParserTests();
  await runImportTests();
  await runEditTests();
  await runExportTests();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

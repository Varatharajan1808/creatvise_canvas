import fs from 'fs';
import { exportAiWithPdfLib } from '../src/aiPdfLib';
import type { Doc, Node } from '../src/model';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

function makeStubNode(
  name: string,
  key: string,
  w: number,
  h: number,
  x = 0,
  y = 0,
  rotation = 0,
  opacity = 1,
  visible = true,
): Node {
  return {
    id: 'n_' + key,
    key,
    name,
    kind: 'raster',
    visible,
    locked: false,
    opacity,
    importOpacity: 1,
    importVisible: true,
    x,
    y,
    w,
    h,
    rotation,
    ow: w,
    oh: h,
    ox: 0,
    oy: 0,
    canvas: null,
    children: [],
    parent: null,
    src: { name, left: x, top: y, right: x + w, bottom: y + h, hidden: !visible, opacity } as any,
    unsupported: [],
  };
}

async function runTests() {
  // Test 1: sample.ai move + rotate + opacity
  const sampleBuf = fs.readFileSync('public/sample.ai');
  const sampleDoc: Doc = {
    id: 'doc-sample',
    name: 'sample.ai',
    format: 'ai',
    width: 680,
    height: 680,
    offsetX: 0,
    offsetY: 0,
    original: sampleBuf.buffer.slice(sampleBuf.byteOffset, sampleBuf.byteOffset + sampleBuf.byteLength),
    warnings: [],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: true,
      ocgNames: ['Layer 1'],
      ocgRefs: ['5 0 R'],
      hasExtGStateOpacity: true,
      extGStateCaAtImport: 1,
    },
    roots: [
      makeStubNode('Edited Layer 1', 'ocg-0', 680, 680, 50, 30, 15, 0.75, true),
    ],
  };

  const res1 = await exportAiWithPdfLib(sampleDoc);
  assert('sample-export-success', res1.bytes.byteLength > 0, `bytes=${res1.bytes.byteLength}`);
  assert('sample-notes-logged', res1.notes.length > 0, res1.notes[0]);

  // Load into pdfjs-dist
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf1 = await getDocument({ data: new Uint8Array(res1.bytes) }).promise;
  assert('sample-pdfjs-pages', pdf1.numPages === 1, `pages=${pdf1.numPages}`);
  const p1 = await pdf1.getPage(1);
  const ops1 = await p1.getOperatorList();
  assert('sample-pdfjs-operators', ops1.fnArray.length > 0, `ops=${ops1.fnArray.length}`);

  // Test 2: DarkTech_Screen.ai multi-layer edit
  const darkBuf = fs.readFileSync('public/DarkTech_Screen.ai');
  const darkDoc: Doc = {
    id: 'doc-dark',
    name: 'DarkTech_Screen.ai',
    format: 'ai',
    width: 576,
    height: 576,
    offsetX: 0,
    offsetY: 0,
    original: darkBuf.buffer.slice(darkBuf.byteOffset, darkBuf.byteOffset + darkBuf.byteLength),
    warnings: [],
    ai: {
      kind: 'ai',
      pageCount: 1,
      hasOcg: false,
      ocgNames: [],
      ocgRefs: [],
      hasExtGStateOpacity: true,
      extGStateCaAtImport: 1,
    },
    roots: [
      makeStubNode('White Backer', 'ocg-0', 576, 576, 0, 0, 0, 1, false), // hidden
      makeStubNode('PANTONE 2925', 'ocg-1', 576, 576, 0, 0, 0, 1, true),
      makeStubNode('PANTONE 2935', 'ocg-2', 576, 576, 0, 0, 0, 1, true),
      makeStubNode('PANTONE 280', 'ocg-3', 576, 576, 0, 0, 0, 1, true),
      makeStubNode('Renamed Preview', 'ocg-4', 576, 576, 40, -20, 0, 0.85, true), // moved + renamed + opacity
    ],
  };

  const res2 = await exportAiWithPdfLib(darkDoc);
  assert('darktech-export-success', res2.bytes.byteLength > 0, `bytes=${res2.bytes.byteLength}`);

  const pdf2 = await getDocument({ data: new Uint8Array(res2.bytes) }).promise;
  assert('darktech-pdfjs-pages', pdf2.numPages === 1, `pages=${pdf2.numPages}`);
  const p2 = await pdf2.getPage(1);
  const ops2 = await p2.getOperatorList();
  assert('darktech-pdfjs-operators', ops2.fnArray.length > 0, `ops=${ops2.fnArray.length}`);

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error(`${failures.length} test(s) failed!`);
    process.exit(1);
  } else {
    console.log(`All ${results.length} AI export round-trip tests passed!`);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Phase 6f — isolated spike: nested PDF OCG /D/Order without touching marked-content streams.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { inflate } from 'pako';
import {
  findLayerBlocks,
  readContentStreamMcStatsFromPdf,
  readOcgNamesAndRefsFromPdf,
} from '../../src/aiPdfLib';
import { findAcrobatWindows, findIllustratorWindows } from './findAdobePdfApps';

const fixturePath = path.join('public', 'fixtures', 'ai', 'three-ocg-layers.ai');
const nestedOutPath = path.join('scripts', 'poc', 'output', 'three-ocg-nested-order.ai');
const reportPath = path.join('scripts', 'poc', 'POC-AI-OCG-NESTED-ORDER.md');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

export type OcgOrderNode =
  | { kind: 'ocg'; ref: string; name: string }
  | { kind: 'group'; children: OcgOrderNode[] };

function refLabel(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber} R`;
}

function ocgNameFromRef(pdfDoc: PDFDocument, ref: PDFRef): string {
  const ocg = pdfDoc.context.lookup(ref);
  if (!(ocg instanceof PDFDict)) return '?';
  const nm = ocg.get(PDFName.of('Name'));
  return nm instanceof PDFString ? nm.decodeText() : '?';
}

function walkOrderArray(pdfDoc: PDFDocument, arr: PDFArray): OcgOrderNode[] {
  const out: OcgOrderNode[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const item = arr.get(i);
    if (item instanceof PDFRef) {
      out.push({ kind: 'ocg', ref: refLabel(item), name: ocgNameFromRef(pdfDoc, item) });
      continue;
    }
    let nested: PDFArray | null = null;
    if (item instanceof PDFArray) nested = item;
    else {
      const looked = pdfDoc.context.lookup(item);
      if (looked instanceof PDFArray) nested = looked;
    }
    if (nested) {
      out.push({ kind: 'group', children: walkOrderArray(pdfDoc, nested) });
      continue;
    }
    out.push({ kind: 'ocg', ref: String(item), name: '?' });
  }
  return out;
}

export async function readOcgOrderTree(buf: ArrayBuffer): Promise<OcgOrderNode[]> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties')));
  if (!(ocProps instanceof PDFDict)) return [];
  const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D')));
  if (!(d instanceof PDFDict)) return [];
  const order = pdfDoc.context.lookup(d.get(PDFName.of('Order')));
  if (!(order instanceof PDFArray)) return [];
  return walkOrderArray(pdfDoc, order);
}

function formatOrderTree(nodes: OcgOrderNode[]): string {
  return nodes
    .map((n) => {
      if (n.kind === 'ocg') return n.name;
      return `group(${n.children.map((c) => (c.kind === 'ocg' ? c.name : formatOrderTree([c]))).join(',')})`;
    })
    .join(';');
}

async function decompressPageContentStream(buf: ArrayBuffer): Promise<string> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  if (pdfDoc.getPageCount() < 1) return '';
  const contentsRef = pdfDoc.getPage(0).node.get(PDFName.of('Contents'));
  const contentsObj = pdfDoc.context.lookup(contentsRef) as { getContents(): Uint8Array };
  const raw = contentsObj.getContents();
  let bytes: Uint8Array;
  try {
    bytes = inflate(raw);
  } catch {
    bytes = raw;
  }
  return new TextDecoder('latin1').decode(bytes);
}

async function readMcPropertyRefs(buf: ArrayBuffer): Promise<string[]> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const page = pdfDoc.getPage(0);
  const resources = pdfDoc.context.lookup(page.node.get(PDFName.of('Resources')));
  if (!(resources instanceof PDFDict)) return [];
  const props = pdfDoc.context.lookup(resources.get(PDFName.of('Properties')));
  if (!(props instanceof PDFDict)) return [];
  const keys = ['MC0', 'MC1', 'MC2'];
  const refs: string[] = [];
  for (const k of keys) {
    const ref = props.get(PDFName.of(k));
    if (ref instanceof PDFRef) refs.push(refLabel(ref));
    else refs.push('?');
  }
  return refs;
}

/** Patch only /OCProperties /D /Order — folder contains first two OCGs, third sibling outside. */
export async function patchNestedOcgOrder(flatBytes: Uint8Array): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(flatBytes.slice(0), { ignoreEncryption: true });
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocProps = pdfDoc.context.lookup(catalog.get(PDFName.of('OCProperties'))) as PDFDict;
  const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D'))) as PDFDict;
  const ocgs = pdfDoc.context.lookup(ocProps.get(PDFName.of('OCGs'))) as PDFArray;
  if (ocgs.size() < 3) throw new Error('expected 3 OCGs');
  const refA = ocgs.get(0);
  const refB = ocgs.get(1);
  const refC = ocgs.get(2);
  const folder = pdfDoc.context.obj([refA, refB]);
  const order = pdfDoc.context.obj([folder, refC]);
  d.set(PDFName.of('Order'), order);
  return pdfDoc.save({ useObjectStreams: false });
}

function externalVerificationNotes(): string {
  const ill = findIllustratorWindows();
  const acro = findAcrobatWindows();
  const lines: string[] = [];
  lines.push(`- **Adobe Illustrator:** ${ill ? `found (${ill.label}) at \`${ill.exe}\`` : 'not detected on this machine'}`);
  lines.push(`- **Adobe Acrobat:** ${acro ? `found (${acro.label}) at \`${acro.exe}\`` : 'not detected on this machine'}`);
  lines.push(`- **Nested sample file:** \`${nestedOutPath}\``);

  const skipOpen = process.env['SKIP_ADOBE_OPEN'] === '1';
  let opened = false;
  if (!skipOpen && fs.existsSync(nestedOutPath)) {
    const abs = path.resolve(nestedOutPath);
    for (const app of [ill, acro].filter(Boolean)) {
      try {
        execSync(`powershell -NoProfile -Command "Start-Process -FilePath '${app!.exe.replace(/'/g, "''")}' -ArgumentList '${abs.replace(/'/g, "''")}'"`, {
          stdio: 'ignore',
        });
        lines.push(`- Launched **${app!.label}** with the nested-order fixture (visual folder structure **not** verified by automation).`);
        opened = true;
        break;
      } catch {
        /* try next app */
      }
    }
  }
  if (!opened) {
    lines.push(
      '- **External UI verification:** not performed (apps missing, `SKIP_ADOBE_OPEN=1`, or launch failed). Do not infer Illustrator/Acrobat compatibility from pdf-lib readback alone.',
    );
  }
  return lines.join('\n');
}

async function main() {
  if (!fs.existsSync(fixturePath)) {
    console.error(`Missing ${fixturePath} — run: tsx scripts/build-three-ocg-fixture.ts`);
    process.exit(1);
  }

  const flatBuf = fs.readFileSync(fixturePath);
  const flatAb = flatBuf.buffer.slice(flatBuf.byteOffset, flatBuf.byteOffset + flatBuf.byteLength);

  const baselineStream = await decompressPageContentStream(flatAb);
  const baselineMc = await readContentStreamMcStatsFromPdf(flatAb);
  const baselineOcg = await readOcgNamesAndRefsFromPdf(flatAb);
  const baselineMcRefs = await readMcPropertyRefs(flatAb);
  const baselineBlocks = findLayerBlocks(baselineStream).map((b) => ({
    layerIndex: b.layerIndex,
    body: baselineStream.slice(b.bdcStart, b.emcEnd),
  }));

  assert('baseline-three-ocgs', baselineOcg.names.length === 3, baselineOcg.names.join(','));
  assert('baseline-mc-count', baselineMc.blockCount === 3, String(baselineMc.blockCount));
  assert('baseline-mc-max', baselineMc.maxMcIndex === 2, String(baselineMc.maxMcIndex));
  assert(
    'baseline-ocg-refs-unique',
    new Set(baselineOcg.refs).size === 3,
    baselineOcg.refs.join(','),
  );

  const nestedBytes = await patchNestedOcgOrder(flatBuf);
  fs.mkdirSync(path.dirname(nestedOutPath), { recursive: true });
  fs.writeFileSync(nestedOutPath, Buffer.from(nestedBytes));
  const nestedAb = nestedBytes.buffer.slice(nestedBytes.byteOffset, nestedBytes.byteOffset + nestedBytes.byteLength);

  const tree = await readOcgOrderTree(nestedAb);
  const treeStr = formatOrderTree(tree);
  assert(
    'nested-order-shape',
    treeStr === 'group(RedSquare,GreenSquare);BlueSquare',
    treeStr,
  );

  const nestedOcg = await readOcgNamesAndRefsFromPdf(nestedAb);
  assert(
    'ocg-catalog-unchanged',
    nestedOcg.names.join(',') === baselineOcg.names.join(',') &&
      nestedOcg.refs.join(',') === baselineOcg.refs.join(','),
    `names ${nestedOcg.names.join(',')} refs ${nestedOcg.refs.join(',')}`,
  );
  assert(
    'ocg-refs-still-unique',
    new Set(nestedOcg.refs).size === 3,
    nestedOcg.refs.join(','),
  );

  const nestedMc = await readContentStreamMcStatsFromPdf(nestedAb);
  assert('mc-count-unchanged', nestedMc.blockCount === baselineMc.blockCount, String(nestedMc.blockCount));
  assert('mc-max-unchanged', nestedMc.maxMcIndex === baselineMc.maxMcIndex, String(nestedMc.maxMcIndex));

  const nestedStream = await decompressPageContentStream(nestedAb);
  assert('content-stream-byte-identical', nestedStream === baselineStream, `${nestedStream.length} vs ${baselineStream.length}`);

  const nestedBlocks = findLayerBlocks(nestedStream);
  assert('mc-identifiers-present', nestedBlocks.map((b) => b.layerIndex).join(',') === '0,1,2', '');
  for (let i = 0; i < baselineBlocks.length; i++) {
    const nb = nestedBlocks[i]!;
    const body = nestedStream.slice(nb.bdcStart, nb.emcEnd);
    assert(`mc-block-${i}-unchanged`, body === baselineBlocks[i]!.body, `MC${i}`);
  }

  const nestedMcRefs = await readMcPropertyRefs(nestedAb);
  assert(
    'properties-mc-refs-unchanged',
    nestedMcRefs.join(',') === baselineMcRefs.join(','),
    `${nestedMcRefs.join(',')} vs ${baselineMcRefs.join(',')}`,
  );

  const external = externalVerificationNotes();
  const allOk = results.every((r) => r.ok);
  const report = `# Phase 6f — Nested OCG Order spike

Generated: ${new Date().toISOString()}

## Programmatic readback

| Check | Result |
|-------|--------|
| Nested \`/Order\` shape | \`${treeStr}\` |
| OCG catalog (names/refs) | ${nestedOcg.names.join(', ')} — refs ${nestedOcg.refs.join(', ')} |
| MC block count | ${nestedMc.blockCount} (unchanged: ${baselineMc.blockCount === nestedMc.blockCount}) |
| Content stream identical | ${nestedStream === baselineStream} |

## Test assertions

${results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} **${r.name}**: ${r.detail}`).join('\n')}

## External applications

${external}

## Recommendation (Phase 6g)

${
  allOk
    ? `**Proceed to Phase 6g (import)** with the scope limited to PDF OCG \`/Order\` hierarchy: programmatic round-trip shows pdf-lib can write nested \`/Order\` arrays while leaving MC streams and \`/OCGs\` refs intact. Production import must parse nested \`/Order\` into model \`kind: 'group'\` nodes; export must patch \`/Order\` only (same constraint as this spike). Illustrator/Acrobat layer-panel parity remains **unverified** until manual Optional Content / Layers checks pass on \`${nestedOutPath}\`.`
    : '**Do not proceed** until programmatic readback failures are resolved.'
}

`;
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`\nWrote ${reportPath}`);
  console.log(external);

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

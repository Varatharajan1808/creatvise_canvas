/**
 * Read-only audit: classify repo .ai files for live PDF text validation.
 * Distinguishes synthetic test PDFs from Illustrator PDF-compatible saves.
 */
import fs from 'fs';
import { readFirstPageContentStreamText } from '../src/ai/aiVectorShapes';
import { parsePdfLiveText } from '../src/ai/aiPdfText';

const CANONICAL_REAL_FIXTURE = 'public/fixtures/ai/illustrator-live-text.ai';

const SCAN_PATHS = [
  CANONICAL_REAL_FIXTURE,
  'public/sample.ai',
  'public/DarkTech_Screen.ai',
  'public/fixtures/ai/live-text-synthetic.ai',
  'public/fixtures/ai/simple-shapes.ai',
];

type FixtureClass =
  | 'missing'
  | 'synthetic'
  | 'illustrator-pdf-no-live-text'
  | 'illustrator-live-text-ready';

function isSyntheticPath(file: string): boolean {
  return (
    file.includes('live-text-synthetic') ||
    file.includes('simple-shapes') ||
    file.includes('buildSyntheticLiveTextPdf')
  );
}

function fileMeta(buf: Buffer) {
  const head = buf.toString('latin1', 0, Math.min(buf.length, 200_000));
  const full = buf.toString('latin1');
  const creatorTool =
    head.match(/<pdfx:CreatorTool>([^<]+)/)?.[1]?.trim()
    ?? head.match(/<xmp:CreatorTool>([^<]+)/)?.[1]?.trim()
    ?? (full.includes('Illustrator') ? 'Illustrator (file contains name)' : 'none');
  return {
    pdfHeader: buf.toString('latin1', 0, 5),
    aiprivateMarkers: (full.match(/AIPrivateData/g) ?? []).length,
    ocgDicts: (full.match(/\/Type\s*\/OCG/g) ?? []).length,
    creatorTool,
    illustratorSignals: full.includes('Illustrator') || (full.match(/AIPrivateData/g) ?? []).length > 0,
  };
}

function classify(file: string, synthetic: boolean, supportedRuns: number, illustratorSignals: boolean): FixtureClass {
  if (synthetic) return 'synthetic';
  if (supportedRuns > 0) return 'illustrator-live-text-ready';
  if (illustratorSignals || file.startsWith('public/sample') || file.startsWith('public/DarkTech')) {
    return 'illustrator-pdf-no-live-text';
  }
  return 'illustrator-pdf-no-live-text';
}

async function auditFile(f: string) {
  if (!fs.existsSync(f)) {
    return {
      file: f,
      fixtureClass: 'missing' as FixtureClass,
      canonicalRealFixture: f === CANONICAL_REAL_FIXTURE,
      status: 'missing',
    };
  }

  const buf = fs.readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const meta = fileMeta(buf);
  const synthetic = isSyntheticPath(f);
  const stream = await readFirstPageContentStreamText(ab);
  const text = stream?.text ?? '';
  const bt = (text.match(/\bBT\b/g) ?? []).length;
  const tj = (text.match(/\)\s*Tj/g) ?? []).length;
  const tjArray = (text.match(/\]\s*TJ/g) ?? []).length;
  const blocks = stream ? parsePdfLiveText(text, stream.pageHeight) : [];
  const runs = blocks.flatMap((b) => (b.mixed ? [] : b.runs.filter((r) => r.supported)));
  const fixtureClass = classify(f, synthetic, runs.length, meta.illustratorSignals);

  return {
    file: f,
    fixtureClass,
    synthetic,
    validForIllustratorCompatibilityProof: fixtureClass === 'illustrator-live-text-ready',
    canonicalRealFixture: f === CANONICAL_REAL_FIXTURE,
    bytes: buf.length,
    pdfHeader: meta.pdfHeader,
    creatorTool: meta.creatorTool,
    aiprivateMarkers: meta.aiprivateMarkers,
    ocgDicts: meta.ocgDicts,
    page1StreamLen: text.length,
    page1Bt: bt,
    page1LiteralTj: tj,
    page1TjArray: tjArray,
    mixedMcBlocks: blocks.filter((b) => b.mixed).length,
    supportedLiveRuns: runs.length,
    sampleRunText: runs[0]?.text?.slice(0, 60),
    exportNotes:
      fixtureClass === 'synthetic'
        ? 'Pipeline tests only — not Illustrator compatibility.'
        : fixtureClass === 'illustrator-live-text-ready'
          ? 'Candidate for real import/edit/export round-trip (desktop check still separate).'
          : fixtureClass === 'illustrator-pdf-no-live-text'
            ? 'Illustrator PDF-compatible but no supported live text on page 1 (often outlined type).'
            : undefined,
  };
}

async function main() {
  console.log('# AI live-text fixture audit\n');
  let hasReadyReal = false;
  for (const f of SCAN_PATHS) {
    const row = await auditFile(f);
    if (row.fixtureClass === 'illustrator-live-text-ready' && !row.synthetic) {
      hasReadyReal = true;
    }
    console.log(JSON.stringify(row));
  }
  console.log('');
  if (!fs.existsSync(CANONICAL_REAL_FIXTURE)) {
    console.log(`Canonical real fixture missing: ${CANONICAL_REAL_FIXTURE}`);
    console.log(`See public/fixtures/ai/ILLUSTRATOR-LIVE-TEXT-FIXTURE.md`);
  } else if (!hasReadyReal) {
    console.log(`${CANONICAL_REAL_FIXTURE} exists but is not illustrator-live-text-ready (see fixtureClass above).`);
  } else {
    console.log(`Real fixture ready for validation: ${CANONICAL_REAL_FIXTURE}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

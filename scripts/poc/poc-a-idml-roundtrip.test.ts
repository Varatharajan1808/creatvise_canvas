/**
 * PoC-A: IDML import → patch one bounded property → export → structural verification.
 * Adobe InDesign open verification: run scripts/poc/poc-a-verify-indesign.jsx when InDesign is installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  patchFirstTextFrameTranslation,
  readFixture,
  validateIdmlStructure,
  writeArtifact,
} from './idmlPatch';

const FIXTURE = 'public/fixtures/poc/plain.idml';
const OUT_DIR = 'artifacts/poc/poc-a';

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

async function main() {
  const fixturePath = path.join(process.cwd(), FIXTURE);
  log('fixture-present', fs.existsSync(fixturePath), fixturePath);

  const original = readFixture(FIXTURE);
  log('fixture-zip-magic', original.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), `bytes=${original.length}`);

  const structIn = await validateIdmlStructure(original);
  log('fixture-structure', structIn.ok, structIn.ok ? `spreads=${structIn.spreadCount}` : structIn.errors.join('; '));

  const { bytes: edited, result } = await patchFirstTextFrameTranslation(original, 20, 15);
  log(
    'patch-item-transform',
    result.ok,
    result.ok
      ? `${result.elementSelf} ${result.before} → ${result.after}`
      : result.notes.join('; '),
  );

  writeArtifact(`${OUT_DIR}/plain.original.idml`, original);
  const editedPath = writeArtifact(`${OUT_DIR}/plain.edited.idml`, edited);
  log('write-artifacts', true, editedPath);

  const structOut = await validateIdmlStructure(edited);
  log('edited-structure', structOut.ok, structOut.ok ? `spreads=${structOut.spreadCount}` : structOut.errors.join('; '));

  const onlySpreadChanged = edited.length !== original.length;
  log('bytes-changed', onlySpreadChanged, `original=${original.length} edited=${edited.length}`);

  const summary = {
    poc: 'PoC-A',
    date: new Date().toISOString(),
    fixture: FIXTURE,
    patch: result,
    structuralValidation: { input: structIn, output: structOut },
    indesignOpenVerified: false,
    indesignNote: 'Not run on this machine — use poc-a-verify-indesign.jsx',
    steps,
    pass: steps.every((s) => s.ok),
  };

  const summaryPath = writeArtifact(
    `${OUT_DIR}/poc-a-summary.json`,
    Buffer.from(JSON.stringify(summary, null, 2), 'utf8'),
  );
  log('summary-json', true, summaryPath);

  if (!summary.pass) {
    console.error('\nPoC-A automated checks FAILED');
    process.exit(1);
  }
  console.log('\nPoC-A automated checks PASSED (InDesign manual step still required for full PoC-A sign-off).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

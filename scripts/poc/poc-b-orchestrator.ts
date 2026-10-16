/**
 * PoC-B orchestrator: INDD → IDML → (Node patch) → IDML → INDD
 * Requires Adobe InDesign on Windows/macOS with ExtendScript execution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluatePocBIndesignReadiness } from './pocBIndesign';
import { patchFirstTextFrameTranslation, validateIdmlStructure, writeArtifact } from './idmlPatch';
import { runIndesignScript } from './runIndesignExtendScript';

const OUT = 'artifacts/poc/poc-b';

type Step = { name: string; ok: boolean; detail: string; phase: 'preflight' | 'conversion' };

function logStep(steps: Step[], phase: Step['phase'], name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail, phase });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
}

async function main() {
  const steps: Step[] = [];
  const readiness = evaluatePocBIndesignReadiness();
  const { discovery } = readiness;
  const exePath = discovery.path;

  logStep(
    steps,
    'preflight',
    'indesign-exe',
    readiness.executableAvailable,
    exePath ?? 'Executable not found (set INDESIGN_PATH or install to a standard location)',
  );
  const comDetail = readiness.comAvailable
    ? `available${discovery.comVersion ? ` (version ${discovery.comVersion})` : ''}`
    : discovery.diagnostics.find((d) => d.startsWith('COM unavailable')) ?? 'unavailable';
  logStep(steps, 'preflight', 'indesign-com', readiness.comAvailable, comDetail);
  logStep(
    steps,
    'preflight',
    'indesign-can-convert',
    readiness.canConvert,
    readiness.canConvert
      ? `ready using ${exePath}`
      : 'conversion requires executable path — COM alone is not sufficient',
  );

  const summary: Record<string, unknown> = {
    poc: 'PoC-B',
    date: new Date().toISOString(),
    platform: process.platform,
    indesign: {
      path: discovery.path,
      version: discovery.version,
      installed: discovery.installed,
      comAvailable: discovery.comAvailable,
      comVersion: discovery.comVersion,
      canConvert: discovery.canConvert,
      diagnostics: discovery.diagnostics,
    },
    steps,
    pass: false,
    nativeInddSupported: false,
    blocker: null as string | null,
  };

  if (!readiness.canConvert) {
    summary.blocker = readiness.blocker;
    writeArtifact(`${OUT}/poc-b-summary.json`, Buffer.from(JSON.stringify(summary, null, 2)));
    console.error('\nPoC-B BLOCKED:\n' + readiness.blocker);
    process.exit(2);
  }

  const pocOutDir = path.join(process.cwd(), OUT);
  fs.mkdirSync(pocOutDir, { recursive: true });

  try {
    runIndesignScript(exePath, 'scripts/poc/poc-b-step1-indd-to-idml.jsx', pocOutDir);
    const exported = path.join(pocOutDir, 'step1-exported.idml');
    if (!fs.existsSync(exported)) {
      const stepLog = path.join(pocOutDir, 'poc-b-step1.log');
      const logHint = fs.existsSync(stepLog)
        ? fs.readFileSync(stepLog, 'utf8').trim()
        : 'poc-b-step1.log was not created';
      throw new Error(`step1-exported.idml not created. ${logHint}`);
    }
    const exportedBytes = fs.readFileSync(exported);
    const struct = await validateIdmlStructure(exportedBytes);
    if (!struct.ok) throw new Error(`step1 IDML invalid: ${struct.errors.join('; ')}`);
    logStep(steps, 'conversion', 'step1-jsx-indd-to-idml', true, exported);
  } catch (e) {
    logStep(steps, 'conversion', 'step1-jsx-indd-to-idml', false, (e as Error).message);
  }

  const conversionSteps = () => steps.filter((s) => s.phase === 'conversion');

  if (conversionSteps().at(-1)?.ok) {
    try {
      const exported = fs.readFileSync(path.join(process.cwd(), OUT, 'step1-exported.idml'));
      const struct = await validateIdmlStructure(exported);
      if (!struct.ok) throw new Error(struct.errors.join('; '));
      const { bytes, result } = await patchFirstTextFrameTranslation(exported, 20, 15);
      if (!result.ok) throw new Error(result.notes.join('; '));
      writeArtifact(`${OUT}/step2-edited.idml`, bytes);
      logStep(steps, 'conversion', 'step2-node-patch-idml', true, `${result.elementSelf}: ${result.after}`);
    } catch (e) {
      logStep(steps, 'conversion', 'step2-node-patch-idml', false, (e as Error).message);
    }
  }

  if (conversionSteps().length > 0 && conversionSteps().every((s) => s.ok)) {
    try {
      runIndesignScript(exePath, 'scripts/poc/poc-b-step3-idml-to-indd.jsx', pocOutDir);
      const indd = path.join(process.cwd(), OUT, 'step3-roundtrip.indd');
      if (!fs.existsSync(indd)) throw new Error('step3-roundtrip.indd not created');
      logStep(steps, 'conversion', 'step3-jsx-idml-to-indd', true, indd);
    } catch (e) {
      logStep(steps, 'conversion', 'step3-jsx-idml-to-indd', false, (e as Error).message);
    }
  }

  const pass = conversionSteps().length > 0 && conversionSteps().every((s) => s.ok);
  summary.steps = steps;
  summary.pass = pass;
  summary.nativeInddSupported = pass;
  writeArtifact(`${OUT}/poc-b-summary.json`, Buffer.from(JSON.stringify(summary, null, 2)));

  if (!pass) {
    console.error('\nPoC-B FAILED');
    process.exit(1);
  }
  console.log('\nPoC-B PASSED — native INDD round trip demonstrated on this machine.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

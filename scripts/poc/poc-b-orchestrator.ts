/**
 * PoC-B orchestrator: INDD → IDML → (Node patch) → IDML → INDD
 * Requires Adobe InDesign on Windows/macOS with ExtendScript execution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { findIndesignWindows, tryIndesignCom } from './findIndesign';
import { patchFirstTextFrameTranslation, validateIdmlStructure, writeArtifact } from './idmlPatch';

const OUT = 'artifacts/poc/poc-b';

type Step = { name: string; ok: boolean; detail: string };

function logStep(steps: Step[], name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
}

function runIndesignScript(exe: string, jsxPath: string): void {
  const jsx = path.resolve(jsxPath);
  if (!fs.existsSync(jsx)) throw new Error(`jsx missing: ${jsx}`);
  execSync(`"${exe}" "${jsx}"`, { stdio: 'inherit', timeout: 180_000 });
}

async function main() {
  const steps: Step[] = [];
  const install = findIndesignWindows();
  const com = tryIndesignCom();

  logStep(
    steps,
    'indesign-exe',
    !!install,
    install ? install.exe : 'InDesign.exe not found under Program Files or PATH',
  );
  logStep(
    steps,
    'indesign-com',
    com.ok,
    com.ok ? `version ${com.version}` : com.error ?? 'COM not registered',
  );

  const summary: Record<string, unknown> = {
    poc: 'PoC-B',
    date: new Date().toISOString(),
    platform: process.platform,
    indesign: { install, com },
    steps,
    pass: false,
    nativeInddSupported: false,
    blocker: null as string | null,
  };

  if (!install || !com.ok) {
    summary.blocker = 'Adobe InDesign not installed or not COM-automation accessible on this machine';
    writeArtifact(`${OUT}/poc-b-summary.json`, Buffer.from(JSON.stringify(summary, null, 2)));
    console.error('\nPoC-B BLOCKED:', summary.blocker);
    process.exit(2);
  }

  fs.mkdirSync(path.join(process.cwd(), OUT), { recursive: true });

  try {
    runIndesignScript(install.exe, 'scripts/poc/poc-b-step1-indd-to-idml.jsx');
    const exported = path.join(process.cwd(), OUT, 'step1-exported.idml');
    if (!fs.existsSync(exported)) throw new Error('step1-exported.idml not created');
    logStep(steps, 'step1-jsx-indd-to-idml', true, exported);
  } catch (e) {
    logStep(steps, 'step1-jsx-indd-to-idml', false, (e as Error).message);
  }

  if (steps[steps.length - 1]?.ok) {
    try {
      const exported = fs.readFileSync(path.join(process.cwd(), OUT, 'step1-exported.idml'));
      const struct = await validateIdmlStructure(exported);
      if (!struct.ok) throw new Error(struct.errors.join('; '));
      const { bytes, result } = await patchFirstTextFrameTranslation(exported, 20, 15);
      if (!result.ok) throw new Error(result.notes.join('; '));
      writeArtifact(`${OUT}/step2-edited.idml`, bytes);
      logStep(steps, 'step2-node-patch-idml', true, `${result.elementSelf}: ${result.after}`);
    } catch (e) {
      logStep(steps, 'step2-node-patch-idml', false, (e as Error).message);
    }
  }

  if (steps.every((s) => s.ok)) {
    try {
      runIndesignScript(install.exe, 'scripts/poc/poc-b-step3-idml-to-indd.jsx');
      const indd = path.join(process.cwd(), OUT, 'step3-roundtrip.indd');
      if (!fs.existsSync(indd)) throw new Error('step3-roundtrip.indd not created');
      logStep(steps, 'step3-jsx-idml-to-indd', true, indd);
    } catch (e) {
      logStep(steps, 'step3-jsx-idml-to-indd', false, (e as Error).message);
    }
  }

  const pass = steps.every((s) => s.ok);
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

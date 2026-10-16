/**
 * PoC-B preflight: executable path via INDESIGN_PATH vs missing path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluatePocBIndesignReadiness } from './pocBIndesign';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function withIndesignPath<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.INDESIGN_PATH;
  if (value === undefined) {
    delete process.env.INDESIGN_PATH;
  } else {
    process.env.INDESIGN_PATH = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.INDESIGN_PATH;
    } else {
      process.env.INDESIGN_PATH = previous;
    }
  }
}

function main() {
  const versionDir = path.join(os.tmpdir(), 'Adobe InDesign PoC-B Test');
  const exePath = path.join(versionDir, 'InDesign.exe');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(exePath, '');

  try {
    withIndesignPath(exePath, () => {
      const r = evaluatePocBIndesignReadiness();
      log('poc-b-configured-exe', r.canConvert && r.discovery.path === exePath, `path=${r.discovery.path}`);
      log('poc-b-configured-no-blocker', r.blocker === null, String(r.blocker));
    });

    const missing = path.join(os.tmpdir(), 'creatvise-poc-b-missing', 'InDesign.exe');
    withIndesignPath(missing, () => {
      const r = evaluatePocBIndesignReadiness();
      if (r.canConvert) {
        log(
          'poc-b-missing-exe-blocked',
          true,
          'skipped: host auto-discovered InDesign (invalid INDESIGN_PATH still reported in diagnostics when set)',
        );
        const hasIssue = r.discovery.diagnostics.some((d) => d.includes('INDESIGN_PATH'));
        log('poc-b-missing-exe-diagnostic', hasIssue, r.discovery.diagnostics.join(' | ').slice(0, 120));
        return;
      }
      log('poc-b-missing-exe-blocked', !r.canConvert && r.blocker !== null, `canConvert=${r.canConvert}`);
      log(
        'poc-b-missing-exe-diagnostic',
        Boolean(r.blocker?.includes('INDESIGN_PATH') || r.blocker?.includes('Executable')),
        r.blocker?.slice(0, 120) ?? '',
      );
    });
  } finally {
    fs.unlinkSync(exePath);
    fs.rmdirSync(versionDir);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('Failures:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main();

/**
 * InDesign discovery: INDESIGN_PATH env override and invalid-path diagnostics.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { discoverIndesign } = await import('../server/indesignDiscover.mjs');

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
  const versionDir = path.join(os.tmpdir(), 'Adobe InDesign 2099 Test');
  const exePath = path.join(versionDir, 'InDesign.exe');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(exePath, '');

  try {
    withIndesignPath(exePath, () => {
      const result = discoverIndesign();
      log(
        'valid-indesign-path-exe',
        result.path === exePath,
        `path=${result.path}`,
      );
      log(
        'valid-indesign-path-can-convert',
        result.canConvert === true,
        `canConvert=${result.canConvert}`,
      );
      log(
        'valid-indesign-path-version-folder',
        result.version === 'Adobe InDesign 2099 Test' || result.version !== null,
        `version=${result.version}`,
      );
    });

    const missingPath = path.join(os.tmpdir(), 'creatvise-indesign-missing', 'InDesign.exe');
    withIndesignPath(missingPath, () => {
      const result = discoverIndesign();
      const hasIssue = result.diagnostics.some((d) =>
        d.includes('INDESIGN_PATH') && d.includes('does not exist'),
      );
      log('invalid-indesign-path-diagnostic', hasIssue, result.diagnostics.join(' | '));
      log(
        'invalid-indesign-path-no-forced-exe',
        result.path !== missingPath,
        `path=${result.path}`,
      );
    });

    withIndesignPath(path.join(versionDir, 'NotInDesign.exe'), () => {
      const wrongName = path.join(versionDir, 'NotInDesign.exe');
      fs.writeFileSync(wrongName, '');
      try {
        const result = discoverIndesign();
        const hasIssue = result.diagnostics.some((d) =>
          d.includes('INDESIGN_PATH') && d.includes('valid InDesign executable'),
        );
        log('invalid-indesign-path-wrong-name', hasIssue, result.diagnostics.join(' | '));
      } finally {
        fs.unlinkSync(wrongName);
      }
    });
  } finally {
    fs.unlinkSync(exePath);
    fs.rmdirSync(versionDir);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('Failures:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main();

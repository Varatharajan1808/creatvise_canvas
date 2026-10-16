import path from 'node:path';
import { buildWindowsDoScriptVbs, progIdsFromExe } from '../../server/runIndesignExtendScript.mjs';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function main() {
  const exe = 'C:\\Program Files\\Adobe\\Adobe InDesign 2026\\InDesign.exe';
  const ids = progIdsFromExe(exe);
  log('prog-id-prefers-2026', ids[0] === 'InDesign.Application.2026', ids.join(', '));

  const jsx = path.join('C:\\repo', 'scripts', 'poc', 'poc-b-step1-indd-to-idml.jsx');
  const vbs = buildWindowsDoScriptVbs(jsx, ids);
  log('vbs-uses-doscript', vbs.includes('app.DoScript scriptPath'), 'DoScript present');
  log('vbs-not-exe-open', !vbs.includes('InDesign.exe'), 'no exe passthrough');
  log('vbs-embeds-jsx', vbs.includes('poc-b-step1-indd-to-idml.jsx'), 'jsx path embedded');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main();

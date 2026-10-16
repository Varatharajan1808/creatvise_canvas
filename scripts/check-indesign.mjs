import { loadIndesignEnv } from '../server/loadIndesignEnv.mjs';
import { discoverIndesign } from '../server/indesignDiscover.mjs';

loadIndesignEnv();

console.log('Checking Adobe InDesign installation...\n');

const status = discoverIndesign();

console.log('Executable path:');
console.log(status.path ?? '(not found — set INDESIGN_PATH or install to a standard location)');

console.log('\nInDesign version:');
console.log(status.version ?? '(unknown)');

console.log('\nCOM automation:');
if (status.comAvailable) {
  console.log(`Available (reported version: ${status.comVersion ?? 'unknown'})`);
} else {
  console.log('Unavailable (see diagnostics for details).');
}

console.log('\nConversion readiness:');
if (status.canConvert) {
  console.log('Ready — the server can run InDesign.exe for IDML/INDD conversion.');
} else {
  console.log('Not ready — conversion requires a valid executable path (INDESIGN_PATH or auto-discovery).');
  if (status.comAvailable) {
    console.log('Note: COM is available, but conversion uses the executable, not COM alone.');
  }
}

if (status.diagnostics?.length) {
  console.log('\nDiagnostics:');
  for (const line of status.diagnostics) {
    console.log(`  • ${line}`);
  }
}

console.log('\n--- Summary ---');
if (status.canConvert) {
  const parts = ['Conversion is ready'];
  if (status.comAvailable) parts.push('exe + COM');
  else parts.push('exe only (COM unavailable)');
  console.log(`${parts[0]} (${parts[1]}).`);
  process.exitCode = 0;
} else if (status.installed) {
  console.log('InDesign appears installed but conversion is unavailable without an executable path.');
  process.exitCode = 1;
} else {
  console.log('InDesign was not detected. Check installation, INDESIGN_PATH, and COM registration.');
  process.exitCode = 1;
}

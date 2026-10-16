/**
 * InDesign status module: verify healthStateFromResponse, indesignChipLabel,
 * and indesignChipTitle behave correctly for all health states.
 */
import type { BackendHealthResponse } from '../src/backend';
import {
  healthStateFromResponse,
  indesignChipLabel,
  indesignChipTitle,
  type IndesignHealthState,
} from '../src/indesignStatus';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function makeHealth(overrides: Partial<BackendHealthResponse>): BackendHealthResponse {
  return {
    ok: false,
    status: 'offline',
    installed: false,
    version: null,
    queueLength: 0,
    lastJob: null,
    detail: '',
    ...overrides,
  };
}

function main() {
  // 1. null → offline
  log('null-state', healthStateFromResponse(null) === 'offline', healthStateFromResponse(null));
  log('null-label', indesignChipLabel(null) === 'InDesign: Offline', indesignChipLabel(null));
  log('null-title-has-offline', indesignChipTitle(null).includes('offline'), indesignChipTitle(null));

  // 2. online response
  const online = makeHealth({ ok: true, status: 'online', installed: true, version: '21.6', canConvert: true });
  log('online-state', healthStateFromResponse(online) === 'online', healthStateFromResponse(online));
  log('online-label-has-version', indesignChipLabel(online).includes('21.6'), indesignChipLabel(online));
  log('online-title-ready', indesignChipTitle(online).includes('ready'), indesignChipTitle(online).toLowerCase());

  // 3. degraded response (COM available, no exe)
  const degraded = makeHealth({
    ok: false,
    status: 'degraded',
    installed: true,
    version: '21.6',
    comAvailable: true,
    canConvert: false,
    detail: 'InDesign COM is available but the executable path was not found.',
  });
  const degradedState = healthStateFromResponse(degraded);
  log('degraded-state', degradedState === 'degraded', degradedState);
  log('degraded-label', indesignChipLabel(degraded).includes('Detected'), indesignChipLabel(degraded));
  log('degraded-title-detail', indesignChipTitle(degraded).includes('executable'), indesignChipTitle(degraded));

  // 4. starting
  const starting = makeHealth({ status: 'starting' });
  log('starting-state', healthStateFromResponse(starting) === 'starting', healthStateFromResponse(starting));
  log('starting-label', indesignChipLabel(starting).includes('Starting'), indesignChipLabel(starting));

  // 5. converting
  const converting = makeHealth({ status: 'converting' });
  log('converting-state', healthStateFromResponse(converting) === 'converting', healthStateFromResponse(converting));
  log('converting-label', indesignChipLabel(converting).includes('Converting'), indesignChipLabel(converting));

  // 6. not-found
  const notFound = makeHealth({ status: 'not-found' });
  log('not-found-state', healthStateFromResponse(notFound) === 'not-found', healthStateFromResponse(notFound));
  log('not-found-label', indesignChipLabel(notFound).includes('Not Found'), indesignChipLabel(notFound));

  // 7. offline
  const offline = makeHealth({ status: 'offline', installed: false });
  log('offline-state', healthStateFromResponse(offline) === 'offline', healthStateFromResponse(offline));
  log('offline-label', indesignChipLabel(offline) === 'InDesign: Offline', indesignChipLabel(offline));
  log('offline-title-not-installed', indesignChipTitle(offline).includes('not installed'), indesignChipTitle(offline).toLowerCase());

  // 8. online without version
  const noVersion = makeHealth({ ok: true, status: 'online', installed: true, version: null, canConvert: true });
  log('no-version-label', indesignChipLabel(noVersion) === 'InDesign: Online', indesignChipLabel(noVersion));

  // 9. Queue info in title
  const withQueue = makeHealth({ ok: true, status: 'online', installed: true, version: '21.6', canConvert: true, queueLength: 3 });
  log('queue-in-title', indesignChipTitle(withQueue).includes('3'), indesignChipTitle(withQueue));

  // Summary
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('Failures:', failed.map(f => f.name).join(', '));
    process.exit(1);
  }
}

main();

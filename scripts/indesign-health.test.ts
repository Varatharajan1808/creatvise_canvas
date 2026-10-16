/**
 * InDesign health endpoint: verify response contract in detail.
 * Tests the health response structure, field types, and value consistency.
 * Does NOT require InDesign to be installed.
 */
import http from 'node:http';

const { createConversionMiddleware } = await import('../server/conversionApi.mjs');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const mw = createConversionMiddleware({ log: () => {} });

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    mw(req, res, () => {
      res.statusCode = 404;
      res.end('Not Found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const health = await res.json() as Record<string, unknown>;

    // Required fields
    log('field-ok', typeof health.ok === 'boolean', `ok=${health.ok} (${typeof health.ok})`);
    log('field-status', typeof health.status === 'string', `status=${health.status}`);
    log('field-installed', typeof health.installed === 'boolean', `installed=${health.installed}`);

    // version can be string or null
    log('field-version', health.version === null || typeof health.version === 'string',
      `version=${health.version} (${typeof health.version})`);

    // path can be string or null
    log('field-path', health.path === null || typeof health.path === 'string',
      `path=${health.path} (${typeof health.path})`);

    // comAvailable must be boolean
    log('field-comAvailable', typeof health.comAvailable === 'boolean',
      `comAvailable=${health.comAvailable}`);

    // canConvert must be boolean
    log('field-canConvert', typeof health.canConvert === 'boolean',
      `canConvert=${health.canConvert}`);

    // queueLength must be number
    log('field-queueLength', typeof health.queueLength === 'number',
      `queueLength=${health.queueLength}`);

    // lastJob starts as null
    log('field-lastJob-initial', health.lastJob === null,
      `lastJob=${JSON.stringify(health.lastJob)}`);

    // detail must be string
    log('field-detail', typeof health.detail === 'string',
      `detail=${String(health.detail).slice(0, 100)}`);

    // diagnostics must be array
    log('field-diagnostics', Array.isArray(health.diagnostics),
      `diagnostics type=${Array.isArray(health.diagnostics) ? 'array' : typeof health.diagnostics}`);

    // Status consistency checks
    const validStatuses = ['online', 'offline', 'degraded', 'starting', 'converting', 'not-found'];
    log('status-valid', validStatuses.includes(health.status as string),
      `${health.status} ∈ [${validStatuses.join(',')}]`);

    // If canConvert is true, status should be online
    if (health.canConvert) {
      log('canConvert-implies-online', health.status === 'online',
        `canConvert=true but status=${health.status}`);
    }

    // If installed but !canConvert, status should be degraded
    if (health.installed && !health.canConvert) {
      log('installed-no-convert-degraded', health.status === 'degraded',
        `installed=true, canConvert=false, status=${health.status}`);
    }

    // ok should match canConvert
    log('ok-matches-canConvert', health.ok === health.canConvert,
      `ok=${health.ok}, canConvert=${health.canConvert}`);

    // Multiple calls should be consistent
    const res2 = await fetch(`${baseUrl}/api/health`);
    const health2 = await res2.json() as Record<string, unknown>;
    log('consistent-status', health.status === health2.status,
      `first=${health.status} second=${health2.status}`);
    log('consistent-installed', health.installed === health2.installed,
      `first=${health.installed} second=${health2.installed}`);

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Summary
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('Failures:', failed.map(f => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});

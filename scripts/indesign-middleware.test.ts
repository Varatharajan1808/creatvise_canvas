/**
 * InDesign conversion middleware tests: verify route handling, health endpoint,
 * input validation, and 404 behaviour WITHOUT requiring InDesign to be installed.
 */
import http from 'node:http';

// Dynamic import of the ESM middleware
const { createConversionMiddleware } = await import('../server/conversionApi.mjs');

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

/** Start a test server, run tests, then close. */
async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const mw = createConversionMiddleware({ log: (m: string) => logs.push(m) });
  // Do not call startWarmUp to avoid COM probe in tests

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
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  await withServer(async (baseUrl) => {
    // 1. GET /api/health returns JSON
    {
      const res = await fetch(`${baseUrl}/api/health`);
      log('health-status-200', res.status === 200, `status=${res.status}`);

      const ct = res.headers.get('content-type') || '';
      log('health-content-type', ct.includes('application/json'), ct);

      const body = await res.json() as Record<string, unknown>;
      log('health-has-ok', 'ok' in body, JSON.stringify(body).slice(0, 200));
      log('health-has-status', 'status' in body, String(body.status));
      log('health-has-installed', 'installed' in body, String(body.installed));
      log('health-has-detail', 'detail' in body, String(body.detail));
      log('health-has-queueLength', 'queueLength' in body, String(body.queueLength));
      log('health-queueLength-zero', body.queueLength === 0, String(body.queueLength));
      log('health-has-lastJob', 'lastJob' in body, String(body.lastJob));
    }

    // 2. POST /api/indd-to-idml with empty body → 400
    {
      const res = await fetch(`${baseUrl}/api/indd-to-idml`, {
        method: 'POST',
        body: new Uint8Array(0),
      });
      log('indd-to-idml-empty-400', res.status === 400, `status=${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      log('indd-to-idml-empty-has-error', 'error' in body, JSON.stringify(body).slice(0, 200));
    }

    // 3. POST /api/idml-to-indd with empty body → 400
    {
      const res = await fetch(`${baseUrl}/api/idml-to-indd`, {
        method: 'POST',
        body: new Uint8Array(0),
      });
      log('idml-to-indd-empty-400', res.status === 400, `status=${res.status}`);
    }

    // 4. Unknown route → 404
    {
      const res = await fetch(`${baseUrl}/api/unknown`);
      log('unknown-route-404', res.status === 404, `status=${res.status}`);
    }

    // 5. GET on POST-only route → 404
    {
      const res = await fetch(`${baseUrl}/api/indd-to-idml`);
      log('get-on-post-route-404', res.status === 404, `status=${res.status}`);
    }

    // 6. POST /api/indd-to-idml with garbage data → 500
    // (This will fail because InDesign isn't available or data is invalid)
    {
      const res = await fetch(`${baseUrl}/api/indd-to-idml`, {
        method: 'POST',
        body: new Uint8Array([1, 2, 3, 4]),
      });
      log('indd-to-idml-garbage-error', res.status === 500, `status=${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      log('indd-to-idml-garbage-has-error', 'error' in body, JSON.stringify(body).slice(0, 200));
    }
  });

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

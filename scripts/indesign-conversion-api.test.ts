/**
 * Conversion API: INDESIGN_PATH / unavailable errors (no mocked successful InDesign run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function withIndesignPath<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.INDESIGN_PATH;
  if (value === undefined) delete process.env.INDESIGN_PATH;
  else process.env.INDESIGN_PATH = value;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.INDESIGN_PATH;
    else process.env.INDESIGN_PATH = previous;
  });
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { createConversionMiddleware } = await import('../server/conversionApi.mjs');
  const mw = createConversionMiddleware({ log: () => {} });
  const server = http.createServer((req, res) => {
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
  const versionDir = path.join(os.tmpdir(), 'Adobe InDesign API Test');
  const exePath = path.join(versionDir, 'InDesign.exe');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(exePath, '');

  try {
    await withIndesignPath(exePath, async () => {
      const { discoverIndesign } = await import('../server/indesignDiscover.mjs');
      const d = discoverIndesign();
      log('indesign-path-honored-health', d.canConvert && d.path === exePath, `path=${d.path}`);
      await withServer(async (baseUrl) => {
        const health = await fetch(`${baseUrl}/api/health`);
        const body = (await health.json()) as { canConvert?: boolean; path?: string };
        log(
          'health-can-convert-with-env',
          body.canConvert === true && body.path === exePath,
          JSON.stringify({ canConvert: body.canConvert, path: body.path }),
        );
      });
    });

    const missing = path.join(os.tmpdir(), 'creatvise-api-no-indesign', 'InDesign.exe');
    await withIndesignPath(missing, async () => {
      const { discoverIndesign } = await import('../server/indesignDiscover.mjs');
      const d = discoverIndesign();
      if (d.canConvert) {
        log(
          'conversion-unavailable-skipped',
          true,
          'Host auto-discovered InDesign; unavailable POST case covered by discover tests',
        );
        return;
      }
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/indd-to-idml`, {
          method: 'POST',
          body: new Uint8Array([0x06, 0x06, 0xed, 0xf5]),
        });
        log('unavailable-post-500', res.status === 500, `status=${res.status}`);
        const errBody = (await res.json()) as { error?: string };
        log(
          'unavailable-post-message',
          Boolean(errBody.error?.includes('Conversion unavailable')),
          String(errBody.error).slice(0, 160),
        );
      });
    });

    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatvise-env-'));
    const envFile = path.join(envDir, '.env');
    const fakeExe = path.join(envDir, 'Adobe InDesign 2098', 'InDesign.exe');
    fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
    fs.writeFileSync(fakeExe, '');
    fs.writeFileSync(envFile, `INDESIGN_PATH="${fakeExe}"\n`, 'utf8');

    await withIndesignPath(undefined, async () => {
      const { loadIndesignEnv } = await import('../server/loadIndesignEnv.mjs');
      loadIndesignEnv({ cwd: envDir, includeRepoRoot: false });
      log('dotenv-loads-indesign-path', process.env.INDESIGN_PATH === fakeExe, process.env.INDESIGN_PATH ?? '');
    });
    fs.rmSync(envDir, { recursive: true, force: true });
  } finally {
    fs.unlinkSync(exePath);
    fs.rmdirSync(versionDir);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

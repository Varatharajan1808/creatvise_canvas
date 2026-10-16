/**
 * Browser runtime: import IDML and count glyph pixels on a real HTMLCanvasElement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const idmlPath = process.argv[2] ?? path.join(root, 'artifacts/poc/poc-b/step1-exported.idml');
const idmlB64 = fs.readFileSync(idmlPath).toString('base64');

function waitForUrl(url, ms = 60_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetch(url)
        .then((r) => (r.ok ? resolve(undefined) : tick()))
        .catch(() => (Date.now() - start > ms ? reject(new Error('timeout')) : setTimeout(tick, 500)));
    };
    tick();
  });
}

const vite = spawn('npm', ['exec', 'vite', '--', '--port', '5199', '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  shell: true,
});

try {
  await waitForUrl('http://127.0.0.1:5199/');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const result = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { importIdml } = await import('/src/idml.ts');
    const { rasterizeAllIdmlTextNodes, countTextGlyphPixels } = await import('/src/idml/rasterText.ts');
    const { leaves } = await import('/src/model.ts');
    const doc = await importIdml('browser.idml', bytes.buffer, 'idml');
    rasterizeAllIdmlTextNodes(doc);
    const text = leaves(doc).find((n) => n.kind === 'text');
    if (!text?.canvas) return { ok: false, reason: 'no text canvas' };
    const ctx = text.canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'no 2d context' };
    const glyphs = countTextGlyphPixels(text.canvas);
    return {
      ok: glyphs > 40,
      glyphs,
      epoch: text.previewContentEpoch ?? 0,
      text: text.src?.text?.text ?? '',
      w: text.w,
      h: text.h,
      has2d: true,
    };
  }, idmlB64);

  console.log('browser-runtime', JSON.stringify(result));
  await browser.close();
  if (!result.ok) process.exit(1);
} finally {
  vite.kill('SIGTERM');
}

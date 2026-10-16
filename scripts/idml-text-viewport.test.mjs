/**
 * Browser: import IDML, mount Viewport with WebGPU, sample mesh texture alpha via readback helper.
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

function waitForUrl(url, ms = 90_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetch(url)
        .then((r) => (r.ok ? resolve(undefined) : setTimeout(tick, 400)))
        .catch(() => (Date.now() - start > ms ? reject(new Error('timeout waiting for ' + url)) : setTimeout(tick, 400)));
    };
    tick();
  });
}

const port = Number(process.env.VITE_TEST_PORT || 5201);
const baseUrl = `http://localhost:${port}/`;
const ownServer = process.env.VITE_TEST_EXTERNAL !== '1';
const vite = ownServer
  ? spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', shell: true })
  : null;

try {
  await waitForUrl(baseUrl);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(baseUrl);
  const result = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { importIdml } = await import('/src/idml.ts');
    const { rasterizeAllIdmlTextNodes, countTextGlyphPixels } = await import('/src/idml/rasterText.ts');
    const { leaves } = await import('/src/model.ts');
    const { Viewport } = await import('/src/viewport.ts');

    const doc = await importIdml('viewport.idml', bytes.buffer, 'idml');
    rasterizeAllIdmlTextNodes(doc);
    const text = leaves(doc).find((n) => n.kind === 'text');
    if (!text?.canvas) return { ok: false, reason: 'no text canvas' };
    const glyphOnCanvas = countTextGlyphPixels(text.canvas);

    const host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '600px';
    document.body.appendChild(host);
    const vp = new Viewport();
    await vp.init(host);
    vp.addDoc(doc, 0);
    vp.requestRender();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const meshes = vp.scene.children.filter((c) => c.type === 'Mesh');
    const leafMesh = meshes.find((m) => m.renderOrder > 0);
    const map = leafMesh?.material?.map;
    const image = map?.image;
    let alphaSum = 0;
    let alphaMax = 0;
    if (image?.data) {
      const d = image.data;
      for (let i = 3; i < d.length; i += 4) {
        alphaSum += d[i];
        if (d[i] > alphaMax) alphaMax = d[i];
      }
    }

    return {
      ok: glyphOnCanvas > 40 && alphaMax > 10,
      glyphOnCanvas,
      alphaMax,
      textureKind: map?.isDataTexture ? 'DataTexture' : map?.isCanvasTexture ? 'CanvasTexture' : map?.constructor?.name,
      meshCount: meshes.length,
    };
  }, idmlB64);

  console.log('viewport-runtime', JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.ok) process.exit(1);
} finally {
  vite?.kill('SIGTERM');
}

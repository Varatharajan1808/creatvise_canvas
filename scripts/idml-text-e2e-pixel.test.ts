/**
 * End-to-end IDML import + rasterize with real 2D canvas (@napi-rs/canvas polyfill).
 */
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { Window } from 'happy-dom';
import { importIdml } from '../src/idml';
import { leaves } from '../src/model';
import { countTextGlyphPixels, rasterizeAllIdmlTextNodes } from '../src/idml/rasterText';

const window = new Window();
const doc = window.document;
(globalThis as any).DOMParser = window.DOMParser;
(globalThis as any).document = doc;

const origCreate = doc.createElement.bind(doc);
doc.createElement = ((tag: string, options?: ElementCreationOptions) => {
  if (String(tag).toLowerCase() === 'canvas') {
    return createCanvas(10, 10) as unknown as HTMLCanvasElement;
  }
  return origCreate(tag, options);
}) as typeof doc.createElement;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const defaultPath = fs.existsSync('artifacts/poc/poc-b/step1-exported.idml')
    ? 'artifacts/poc/poc-b/step1-exported.idml'
    : 'artifacts/fixtures/sample-creatvise.idml';
  const path = process.argv[2] ?? defaultPath;
  const buf = fs.readFileSync(path);
  const imported = await importIdml('e2e.idml', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  rasterizeAllIdmlTextNodes(imported);

  const text = leaves(imported).find((n) => n.kind === 'text');
  log('text-node-found', Boolean(text?.src?.text?.text), text?.src?.text?.text ?? '');
  if (!text?.canvas) {
    log('text-canvas', false, 'missing');
    process.exit(1);
  }

  const glyphs = countTextGlyphPixels(text.canvas);
  log('glyph-pixel-count', glyphs > 40, `glyphPixels=${glyphs}`);
  log('preview-epoch', (text.previewContentEpoch ?? 0) > 0, String(text.previewContentEpoch));
  log('canvas-dimensions', text.canvas.width === text.w && text.canvas.height === text.h, `${text.canvas.width}x${text.canvas.height}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * IDML text rasterization: real 2D canvas pixels (via @napi-rs/canvas).
 */
import { createCanvas } from '@napi-rs/canvas';
import type { Node } from '../src/core/model';
import { rasterizeIdmlTextNode, countTextGlyphPixels, textGlyphsUprightInCanvas } from '../src/indd/rasterText';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function makeTextNode(w: number, h: number, text: string, fontSize = 12): Node {
  const canvas = createCanvas(w, h) as unknown as HTMLCanvasElement;
  return {
    id: 't',
    kind: 'text',
    name: text,
    opacity: 1,
    w,
    h,
    canvas,
    idml: { self: 'uf1', tag: 'TextFrame', spreadPath: 'Spreads/Spread_1.xml' },
    src: {
      text: {
        text,
        style: {
          fontSize,
          font: { name: 'Arial' },
          fillColor: { r: 30, g: 30, b: 30 },
        },
      },
    },
  } as unknown as Node;
}

function main() {
  const large = makeTextNode(233, 137, 'Text', 12);
  rasterizeIdmlTextNode(large);
  const glyphsLarge = countTextGlyphPixels(large.canvas);
  log('real-canvas-glyph-pixels', glyphsLarge > 40, `glyphPixels=${glyphsLarge}`);

  const tiny = makeTextNode(10, 10, 'Text', 12);
  rasterizeIdmlTextNode(tiny);
  const glyphsTiny = countTextGlyphPixels(tiny.canvas);
  log('tiny-frame-still-draws-glyphs', glyphsTiny > 0, `glyphPixels=${glyphsTiny}`);

  log('epoch-set', (large.previewContentEpoch ?? 0) > 0, String(large.previewContentEpoch));
  log('glyphs-upright', textGlyphsUprightInCanvas(large.canvas), 'centroid in upper half');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main();

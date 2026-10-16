/**
 * IDML text: story line breaks, wrapping, and multi-line rasterization (magazine fixture).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml } from '../src/indd/idml';
import { parseStoryFromXml } from '../src/indd/storyParse';
import { parseStylesXmlTextStyles } from '../src/indd/textStyles';
import { parseGraphicXmlColors } from '../src/indd/swatches';
import { layoutIdmlTextLines } from '../src/indd/textLayout';
import {
  rasterizeIdmlTextNode,
  countRasterizedTextLines,
  countVisibleTextPixels,
} from '../src/indd/rasterText';
import { leaves } from '../src/core/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (!fs.existsSync(idmlPath)) {
    log('fixture', false, 'missing');
    process.exit(1);
  }
  const buf = fs.readFileSync(idmlPath);
  const zip = await JSZip.loadAsync(buf);
  const storyXml = await zip.file('Stories/Story_u254.xml')!.async('string');
  const stylesXml = (await zip.file('Resources/Styles.xml')?.async('string')) ?? '';
  const graphicXml = (await zip.file('Resources/Graphic.xml')?.async('string')) ?? '';
  const colors = parseGraphicXmlColors(graphicXml);
  const textStyles = parseStylesXmlTextStyles(stylesXml);
  const parsed = parseStoryFromXml(storyXml, colors, textStyles);

  log('u254-line-breaks', parsed.text.split('\n').length === 3, parsed.text.replace(/\n/g, '|'));
  log('u254-leading', parsed.paragraphs[0]?.leading === 14, String(parsed.paragraphs[0]?.leading));
  log('u254-full-lorem', parsed.text.includes('adipis'), parsed.text.slice(0, 40));

  const doc = await importIdml(
    'magazine.idml',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    'indd',
  );
  const u251 = leaves(doc).find((n) => n.idml?.self === 'u251');
  log('u251-story-newlines', (u251?.src?.text?.text?.split('\n').length ?? 0) === 3, u251?.src?.text?.text?.replace(/\n/g, '|'));
  log('u251-leading-meta', u251?.idml?.storyLeading === 14, String(u251?.idml?.storyLeading));

  if (u251?.canvas) {
    u251.canvas = createCanvas(Math.max(1, u251.w), Math.max(1, u251.h)) as unknown as HTMLCanvasElement;
    rasterizeIdmlTextNode(u251);
    const lineRows = countRasterizedTextLines(u251.canvas);
    const visible = countVisibleTextPixels(u251.canvas);
    log('u251-three-raster-lines', lineRows >= 3, `lines=${lineRows} pixels=${visible}`);
  }

  const sample = await importIdml('sample.idml', await (await import('../src/indd/idml')).createSampleIdml(), 'idml');
  const sampleText = sample.roots.find((n) => n.kind === 'text');
  log('sample-text-unchanged', sampleText?.src?.text?.text?.includes('Creatvise'), sampleText?.src?.text?.text ?? '');

  const wrapCanvas = createCanvas(120, 80) as unknown as HTMLCanvasElement;
  const wctx = wrapCanvas.getContext('2d')!;
  wctx.font = '12px Arial';
  const wrapped = layoutIdmlTextLines(wctx, 'one two three four five six seven eight', {
    maxWidth: 48,
    maxHeight: 80,
    fontSizePt: 12,
  });
  log('wrap-multiple-lines', wrapped.length >= 2, String(wrapped.length));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * IDML text: story parsing, coordinates, and canvas glyph rasterization on import.
 */
import { Window } from 'happy-dom';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

import { importIdml, createSampleIdml } from '../src/idml';
import { decodeIdmlTextContent, parseStoryFromXml } from '../src/idml/storyParse';
import { getIdmlTextInfo } from '../src/idmlEdit';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const storyXml = `<?xml version="1.0"?><Story><CharacterStyleRange PointSize="18"><Properties><AppliedFont type="string">Minion Pro</AppliedFont></Properties><Content>Hello IDML</Content></CharacterStyleRange></Story>`;
  const parsed = parseStoryFromXml(storyXml);
  log('story-text', parsed.text === 'Hello IDML', parsed.text);
  log('story-font-size', parsed.fontSize === 18, String(parsed.fontSize));
  log('story-font-family', parsed.fontFamily === 'Minion Pro', parsed.fontFamily);
  log('decode-strips-bom', decodeIdmlTextContent('\uFEFFText') === 'Text', 'ok');

  const bytes = await createSampleIdml();
  const doc = await importIdml('text-import.idml', bytes, 'idml');
  const textNode = doc.roots.find((n) => n.kind === 'text');
  log('text-node-exists', !!textNode, String(!!textNode));
  if (textNode) {
    log(
      'text-src-content',
      textNode.src?.text?.text === 'Creatvise Canvas InDesign Sample',
      textNode.src?.text?.text ?? '',
    );
    log('text-position-x', textNode.x === 100, `x=${textNode.x}`);
    log('text-position-y', textNode.y === 100, `y=${textNode.y}`);
    log('text-size', textNode.w === 300 && textNode.h === 80, `${textNode.w}x${textNode.h}`);
    const info = getIdmlTextInfo(textNode);
    log('text-info-matches', info?.text === textNode.src?.text?.text, info?.text ?? '');
    log(
      'text-style-font-size',
      textNode.src?.text?.style?.fontSize === 12,
      String(textNode.src?.text?.style?.fontSize),
    );
    log(
      'text-style-color-not-frame-blue',
      textNode.src?.text?.style?.fillColor?.r === 30,
      JSON.stringify(textNode.src?.text?.style?.fillColor),
    );
    log(
      'text-no-default-frame-fill',
      textNode.idml?.frameFillColor === undefined,
      String(textNode.idml?.frameFillColor),
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

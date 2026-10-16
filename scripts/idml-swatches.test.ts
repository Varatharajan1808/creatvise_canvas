import fs from 'node:fs';
import path from 'node:path';
import { applyFillTint, cmykToRgbHex, parseGraphicXmlColors, resolveSwatchRef } from '../src/indd/swatches';
import { importIdml } from '../src/indd/idml';
import { leaves } from '../src/core/model';
import { parseStylesXmlObjectFills, resolveItemFillHex } from '../src/indd/objectStyles';
import { Window } from 'happy-dom';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const graphicSnippet = `<?xml version="1.0"?><Graphic>
  <Color Self="Color/Color 1" Space="CMYK" ColorValue="60 14 11 84" />
  <Color Self="Color/Paper" Space="CMYK" ColorValue="0 0 0 0" />
</Graphic>`;

  const stylesSnippet = `<?xml version="1.0"?><Root>
  <ObjectStyle Self="ObjectStyle/Color 1 Fill" EnableFill="true" FillColor="Color/Color 1" />
  <ObjectStyle Self="ObjectStyle/White Fill" EnableFill="true" FillColor="Color/Paper" />
</Root>`;

  const colors = parseGraphicXmlColors(graphicSnippet);
  const objectFills = parseStylesXmlObjectFills(stylesSnippet, colors);

  log('color-map-size', colors.size >= 2, String(colors.size));
  log(
    'color-1-resolved',
    resolveSwatchRef('Color/Color 1', colors) === cmykToRgbHex(60, 14, 11, 84),
    resolveSwatchRef('Color/Color 1', colors) ?? '',
  );
  log(
    'object-style-fill',
    objectFills.get('ObjectStyle/Color 1 Fill') === colors.get('Color/Color 1'),
    objectFills.get('ObjectStyle/Color 1 Fill') ?? '',
  );

  const rect = new DOMParser().parseFromString(
    '<Rectangle AppliedObjectStyle="ObjectStyle/Color 1 Fill" />',
    'application/xml',
  ).documentElement;
  log(
    'resolve-from-object-style',
    resolveItemFillHex(rect, colors, objectFills) === colors.get('Color/Color 1'),
    'ok',
  );

  log(
    'fill-tint-10-black',
    applyFillTint('#000000', 10, '#ffffff').toLowerCase() === '#e6e6e6',
    applyFillTint('#000000', 10, '#ffffff'),
  );

  const tintedStyle = `<?xml version="1.0"?><Root>
  <ObjectStyle Self="ObjectStyle/Placeholder" EnableFill="true" FillColor="Color/Black" FillTint="10" />
</Root>`;
  const tintColors = parseGraphicXmlColors(`<?xml version="1.0"?><Graphic>
  <Color Self="Color/Black" Space="RGB" ColorValue="0 0 0" />
  <Color Self="Color/Paper" Space="RGB" ColorValue="255 255 255" />
</Graphic>`);
  const tintedFills = parseStylesXmlObjectFills(tintedStyle, tintColors);
  log(
    'object-style-fill-tint',
    tintedFills.get('ObjectStyle/Placeholder')?.toLowerCase() === '#e6e6e6',
    tintedFills.get('ObjectStyle/Placeholder') ?? '',
  );

  const fixture391 = path.join('artifacts', 'fixtures', 'free_391311709.idml');
  if (fs.existsSync(fixture391)) {
    const buf = fs.readFileSync(fixture391);
    const doc = await importIdml(
      '391.idml',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      'indd',
    );
    const u3bb = leaves(doc).find((n) => n.idml?.self === 'u3bb');
    const hex = u3bb?.idml?.fillColor?.toLowerCase();
    log('391-u3bb-not-solid-black', hex !== '#000000', hex ?? 'missing');
    log('391-u3bb-tinted-grey', hex === '#e6e6e6', hex ?? '');
  } else {
    log('391-fixture', true, 'skipped — export free_391311709.idml from INDD to enable');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

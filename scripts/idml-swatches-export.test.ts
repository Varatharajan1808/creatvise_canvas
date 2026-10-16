/**
 * Swatch export regression: reuse, create, text + shape, no duplicate refs.
 */
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml } from '../src/idml';
import { applyIdmlShapeColor, applyIdmlText } from '../src/idmlEdit';
import { leaves } from '../src/model';
import { parseGraphicXmlColors, cmykToRgbHex, resolveSwatchRef } from '../src/idml/swatches';
import { readPageItemAttribute } from '../src/idml/exportPatch';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function buildTextShapeFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0"?><Spread Self="s1"><Page Self="p1" GeometricBounds="0 0 792 612"/>
  <TextFrame Self="tx" ParentStory="st" ItemTransform="1 0 0 1 50 50">
    <Properties><PathGeometry><GeometryPathType PathOpen="false">
    <PathPointType Anchor="0 0"/><PathPointType Anchor="200 0"/><PathPointType Anchor="200 60"/><PathPointType Anchor="0 60"/>
    </GeometryPathType></PathGeometry></Properties>
  </TextFrame>
  <Rectangle Self="rc" ItemTransform="1 0 0 1 50 150" FillColor="Color/Black">
    <Properties><PathGeometry><GeometryPathType PathOpen="false">
    <PathPointType Anchor="0 0"/><PathPointType Anchor="80 0"/><PathPointType Anchor="80 40"/><PathPointType Anchor="0 40"/>
    </GeometryPathType></PathGeometry></Properties>
  </Rectangle></Spread>`;
  const story = `<?xml version="1.0"?><Story Self="st"><ParagraphStyleRange><CharacterStyleRange FillColor="Color/Black"><Content>Hello</Content></CharacterStyleRange></ParagraphStyleRange></Story>`;
  const graphic = `<?xml version="1.0"?><Graphic>
  <Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/>
  <Color Self="Color/Color 1" Space="CMYK" ColorValue="60 14 11 84"/>
  </Graphic>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/><idPkg:Story src="Stories/Story_st.xml"/></Document>',
  );
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Stories/Story_st.xml', story);
  zip.file('Resources/Graphic.xml', graphic);
  const { writeIdmlPackage } = await import('../src/idml/zip');
  return writeIdmlPackage(zip);
}

async function main() {
  const color1Hex = cmykToRgbHex(60, 14, 11, 84);
  const bytes = await buildTextShapeFixture();
  const doc = await importIdml('sw.idml', bytes, 'idml');
  const tx = leaves(doc).find((n) => n.idml?.self === 'tx')!;
  const rc = leaves(doc).find((n) => n.idml?.self === 'rc')!;

  applyIdmlText(tx, { text: 'Swatch test', color: { r: 16, g: 35, b: 36 } });
  applyIdmlShapeColor(rc, { r: 16, g: 35, b: 36 });

  const exported = await exportIdml(doc);
  const zip = await JSZip.loadAsync(exported);
  const graphic = await zip.file('Resources/Graphic.xml')!.async('string');
  const colors = parseGraphicXmlColors(graphic);
  const spread = await zip.file('Spreads/Spread_s1.xml')!.async('string');
  const story = await zip.file('Stories/Story_st.xml')!.async('string');
  const shapeFill = readPageItemAttribute(spread, 'rc', 'FillColor');
  const textFill = story.match(/FillColor="([^"]+)"/)?.[1];

  log('same-hex-one-swatch', colors.size === 2, `count=${colors.size} (Black + Color 1 reused)`);
  log('shape-uses-swatch', shapeFill?.startsWith('Color/') === true, shapeFill ?? '');
  log('text-uses-swatch', textFill?.startsWith('Color/') === true, textFill ?? '');
  log('text-shape-same-ref', shapeFill === textFill, `${shapeFill} vs ${textFill}`);
  log(
    'resolved-hex',
    resolveSwatchRef(shapeFill, colors)?.toLowerCase() === '#102324',
    resolveSwatchRef(shapeFill, colors) ?? '',
  );

  applyIdmlShapeColor(rc, { r: 255, g: 64, b: 32 });
  applyIdmlText(tx, { color: { r: 255, g: 64, b: 32 } });
  const exported2 = await exportIdml(doc);
  const colors2 = parseGraphicXmlColors(await (await JSZip.loadAsync(exported2)).file('Resources/Graphic.xml')!.async('string'));
  log('new-color-adds-swatch', colors2.size === 3, String(colors2.size));
  log('reuse-color1-unchanged', colors2.has('Color/Color 1'), 'Color 1 kept');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

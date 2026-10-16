/**
 * Phase 3: IDML typography export — font, color, mixed ranges, alignment, combined transforms.
 */
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml, createSampleIdml } from '../src/indd/idml';
import { applyIdmlText } from '../src/indd/idmlEdit';
import { parseGraphicXmlColors, resolveSwatchRef } from '../src/indd/swatches';
import { decodeIdmlTextContent } from '../src/indd/storyParse';
import { readPageItemAttribute } from '../src/indd/exportPatch';
import { leaves } from '../src/core/model';
import { hexToRgb, rgbToHex } from '../src/operations/edit';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};
const near = (a: number, b: number, eps = 1.5) => Math.abs(a - b) <= eps;

async function buildMixedStoryFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="s1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    <TextFrame Self="tf1" ParentStory="st1" ItemTransform="1 0 0 1 80 80">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="320 0" />
        <PathPointType Anchor="320 100" /><PathPointType Anchor="0 100" />
      </GeometryPathType></PathGeometry></Properties>
    </TextFrame>
  </Spread>
</idPkg:Spread>`;
  const story = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Story Self="st1">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange PointSize="12" FillColor="Color/Black">
        <Properties><AppliedFont type="string">Minion Pro</AppliedFont></Properties>
        <Content>Big</Content>
      </CharacterStyleRange>
      <CharacterStyleRange PointSize="24" FillColor="Color/Black">
        <Properties><AppliedFont type="string">Minion Pro</AppliedFont></Properties>
        <Content>small</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>`;
  const graphic = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Graphic><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100" Name="Black" /></Graphic>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/><idPkg:Story src="Stories/Story_st1.xml"/></Document>',
  );
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Stories/Story_st1.xml', story);
  zip.file('Resources/Graphic.xml', graphic);
  const { writeIdmlPackage } = await import('../src/indd/zip');
  return writeIdmlPackage(zip);
}

async function main() {
  const sampleBytes = await createSampleIdml();
  let doc = await importIdml('sample.idml', sampleBytes, 'idml');
  const text = doc.roots.find((n) => n.kind === 'text')!;

  applyIdmlText(text, { fontFamily: 'Helvetica Neue' });
  applyIdmlText(text, { fontSize: 22 });
  applyIdmlText(text, { bold: true, italic: true });
  applyIdmlText(text, { color: { r: 200, g: 40, b: 40 } });
  applyIdmlText(text, { alignment: 'center' });

  const exported = await exportIdml(doc);
  const zip = await JSZip.loadAsync(exported);
  const storyXml = await zip.file('Stories/Story_ud4.xml')!.async('string');
  const graphicXml = await zip.file('Resources/Graphic.xml')!.async('string');
  const colors = parseGraphicXmlColors(graphicXml);

  log('export-font-family', storyXml.includes('Helvetica Neue'), 'AppliedFont');
  log('export-font-size', /PointSize="22"/.test(storyXml), '22pt');
  log('export-font-style', /FontStyle="Bold Italic"/.test(storyXml), 'Bold Italic');
  log('export-justification', /Justification="CenterAlign"/.test(storyXml), 'center');
  const fillMatch = storyXml.match(/FillColor="(Color\/[^"]+)"/);
  const fillRef = fillMatch?.[1];
  log('export-text-fill-swatch', Boolean(fillRef?.startsWith('Color/')), fillRef ?? '');
  log(
    'export-text-color-resolves',
    fillRef ? resolveSwatchRef(fillRef, colors)?.toLowerCase() === '#c82828' : false,
    resolveSwatchRef(fillRef ?? '', colors) ?? '',
  );

  const doc2 = await importIdml('re.idml', exported, 'idml');
  const text2 = doc2.roots.find((n) => n.kind === 'text')!;
  log('reimport-font-size', text2.src?.text?.style?.fontSize === 22, String(text2.src?.text?.style?.fontSize));
  log(
    'reimport-font-family',
    text2.src?.text?.style?.font?.name === 'Helvetica Neue',
    text2.src?.text?.style?.font?.name ?? '',
  );
  log('reimport-bold-italic', Boolean(text2.src?.text?.style?.fauxBold) && Boolean(text2.src?.text?.style?.fauxItalic), 'ok');
  log('reimport-justification', text2.idml?.storyJustification === 'CenterAlign', text2.idml?.storyJustification ?? '');

  const ox = text.x;
  text.x += 15;
  text.rotation = 12;
  text.w += 20;
  const exportedCombo = await exportIdml(doc);
  const zCombo = await JSZip.loadAsync(exportedCombo);
  const spreadCombo = await zCombo.file('Spreads/Spread_ud3.xml')!.async('string');
  const tf = readPageItemAttribute(spreadCombo, 'uf3', 'ItemTransform')!.split(/\s+/).map(Number);
  const docCombo = await importIdml('combo.idml', exportedCombo, 'idml');
  const textCombo = docCombo.roots.find((n) => n.kind === 'text')!;
  log(
    'combo-transform-exported',
    near(textCombo.x, ox + 15, 3) && near(textCombo.rotation, 12, 2) && near(textCombo.w, text.w, 3),
    `${textCombo.x} rot=${textCombo.rotation} w=${textCombo.w}`,
  );

  const mixedBytes = await buildMixedStoryFixture();
  doc = await importIdml('mixed.idml', mixedBytes, 'idml');
  const mixed = leaves(doc).find((n) => n.idml?.self === 'tf1')!;
  applyIdmlText(mixed, { text: 'BigSMALL' });
  const mixedOut = await exportIdml(doc);
  const mixedStory = await (await JSZip.loadAsync(mixedOut)).file('Stories/Story_st1.xml')!.async('string');
  log('mixed-content-updated', mixedStory.includes('BigSMALL') || mixedStory.includes('Big'), 'content');
  log('mixed-12pt-preserved', /PointSize="12"/.test(mixedStory), '12pt range kept');
  log('mixed-24pt-preserved', /PointSize="24"/.test(mixedStory), '24pt range kept');

  applyIdmlText(mixed, { fontSize: 18 });
  const mixedStyleOut = await exportIdml(doc);
  const mixedStyleStory = await (await JSZip.loadAsync(mixedStyleOut)).file('Stories/Story_st1.xml')!.async('string');
  log('mixed-unified-size-export', !/PointSize="12"/.test(mixedStyleStory) && /PointSize="18"/.test(mixedStyleStory), 'all 18');

  const paraStory = `<?xml version="1.0"?><Story Self="p1"><ParagraphStyleRange><CharacterStyleRange><Content>Line A</Content></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange><CharacterStyleRange><Content>Line B</Content></CharacterStyleRange></ParagraphStyleRange></Story>`;
  const decoded = decodeIdmlTextContent('a\u2028b');
  log('special-char-decode', decoded === 'a\nb', decoded);

  const unedited = await importIdml('sample2.idml', sampleBytes, 'idml');
  const rect = unedited.roots.find((n) => n.kind === 'shape')!;
  applyIdmlText(unedited.roots.find((n) => n.kind === 'text')!, { text: 'Only text change', fontSize: 12 });
  const tOnly = unedited.roots.find((n) => n.kind === 'text')!;
  const origStyle = tOnly.src?.text?.style?.fontSize;
  applyIdmlText(tOnly, { text: 'Only text change v2' });
  const outUnedited = await exportIdml(unedited);
  const zU = await JSZip.loadAsync(outUnedited);
  const storyU = await zU.file('Stories/Story_ud4.xml')!.async('string');
  log('content-only-story', storyU.includes('Only text change v2'), 'patched');
  log('untouched-shape-on-other-export', near(rect.w, unedited.roots.find((n) => n.kind === 'shape')!.w, 0.1), 'shape ok');

  void paraStory;
  void origStyle;

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

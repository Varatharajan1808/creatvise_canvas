/**
 * IDML shape stroke color: import, swatch reuse/create, export StrokeColor, fill/text unchanged.
 */
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml } from '../src/idml';
import { applyIdmlShapeColor } from '../src/idmlEdit';
import { applyShapeBorder } from '../src/edit';
import { leaves } from '../src/model';
import { readPageItemAttribute } from '../src/idml/exportPatch';
import { cmykToRgbHex, parseGraphicXmlColors, resolveSwatchRef } from '../src/idml/swatches';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function buildStrokedFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="s1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    <Rectangle Self="rStroke" ItemTransform="1 0 0 1 40 40" FillColor="Color/Black" StrokeColor="Color/Color 1" StrokeWeight="2" StrokeTint="-1">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="80 0" />
        <PathPointType Anchor="80 60" /><PathPointType Anchor="0 60" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
    <Rectangle Self="rPlain" ItemTransform="1 0 0 1 160 40" FillColor="Color/Black" StrokeColor="n">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="80 0" />
        <PathPointType Anchor="80 60" /><PathPointType Anchor="0 60" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
  </Spread>
</idPkg:Spread>`;
  const graphic = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Graphic>
  <Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100" Name="Black" />
  <Color Self="Color/Color 1" Space="CMYK" ColorValue="60 14 11 84" Name="Color 1" />
</Graphic>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>');
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Resources/Graphic.xml', graphic);
  const { writeIdmlPackage } = await import('../src/idml/zip');
  return writeIdmlPackage(zip);
}

async function main() {
  const color1Hex = cmykToRgbHex(60, 14, 11, 84);
  const bytes = await buildStrokedFixture();
  const doc = await importIdml('stroke-fixture.idml', bytes, 'idml');
  const rStroke = leaves(doc).find((n) => n.idml?.self === 'rStroke')!;
  const rPlain = leaves(doc).find((n) => n.idml?.self === 'rPlain')!;

  log('import-stroke-enabled', rStroke.idml?.strokeEnabled === true, String(rStroke.idml?.strokeEnabled));
  log('import-stroke-weight', rStroke.idml?.strokeWeight === 2, String(rStroke.idml?.strokeWeight));
  log('import-stroke-tint', rStroke.idml?.strokeTint === -1, String(rStroke.idml?.strokeTint));
  log(
    'import-stroke-color',
    rStroke.idml?.strokeColor?.toLowerCase() === color1Hex.toLowerCase(),
    rStroke.idml?.strokeColor ?? '',
  );
  log('no-stroke-safe', rPlain.idml?.strokeEnabled === false, String(rPlain.idml?.strokeEnabled));

  const fillBefore = rStroke.idml?.fillColor;
  applyShapeBorder(rStroke, { color: { r: 255, g: 64, b: 32 } });
  log('stroke-color-dirty', rStroke.idml?.exportStrokeDirty === true, String(rStroke.idml?.exportStrokeDirty));
  log('fill-unchanged', rStroke.idml?.fillColor === fillBefore, fillBefore ?? '');
  log('weight-unchanged', rStroke.idml?.strokeWeight === 2, String(rStroke.idml?.strokeWeight));

  const exported = await exportIdml(doc);
  const z = await JSZip.loadAsync(exported);
  const spread = await z.file('Spreads/Spread_s1.xml')!.async('string');
  const strokeRef = readPageItemAttribute(spread, 'rStroke', 'StrokeColor');
  const strokeWeight = readPageItemAttribute(spread, 'rStroke', 'StrokeWeight');
  const strokeTint = readPageItemAttribute(spread, 'rStroke', 'StrokeTint');
  const fillAfter = readPageItemAttribute(spread, 'rStroke', 'FillColor');
  const plainStroke = readPageItemAttribute(spread, 'rPlain', 'StrokeColor');
  const graphic = await z.file('Resources/Graphic.xml')!.async('string');
  const colors = parseGraphicXmlColors(graphic);

  log('export-stroke-swatch', strokeRef?.startsWith('Color/') === true, strokeRef ?? '');
  log(
    'export-stroke-hex',
    resolveSwatchRef(strokeRef, colors)?.toLowerCase() === '#ff4020',
    resolveSwatchRef(strokeRef, colors) ?? '',
  );
  log('export-weight-preserved', strokeWeight === '2', strokeWeight ?? '');
  log('export-tint-preserved', strokeTint === '-1', strokeTint ?? 'missing');
  log('export-fill-unchanged', fillAfter === 'Color/Black', fillAfter ?? '');
  log('export-plain-stroke-unchanged', plainStroke === 'n', plainStroke ?? '');

  const rt = await importIdml('rt.idml', exported, 'idml');
  const rRt = leaves(rt).find((n) => n.idml?.self === 'rStroke')!;
  log('reimport-stroke-hex', rRt.idml?.strokeColor === '#ff4020', rRt.idml?.strokeColor ?? '');

  applyIdmlShapeColor(rStroke, { r: 10, g: 20, b: 30 });
  applyShapeBorder(rStroke, { color: { r: 0, g: 180, b: 180 } });
  const exported2 = await exportIdml(doc);
  const z2 = await JSZip.loadAsync(exported2);
  const spread2 = await z2.file('Spreads/Spread_s1.xml')!.async('string');
  const fill2 = readPageItemAttribute(spread2, 'rStroke', 'FillColor');
  const stroke2 = readPageItemAttribute(spread2, 'rStroke', 'StrokeColor');
  const colors2 = parseGraphicXmlColors(await z2.file('Resources/Graphic.xml')!.async('string'));
  log('fill-edited-export', fill2?.startsWith('Color/') === true, fill2 ?? '');
  log(
    'stroke-after-second-edit',
    resolveSwatchRef(stroke2, colors2)?.toLowerCase() === '#00b4b4',
    resolveSwatchRef(stroke2, colors2) ?? '',
  );
  log(
    'fill-stroke-distinct',
    resolveSwatchRef(fill2, colors2) !== resolveSwatchRef(stroke2, colors2),
    'distinct',
  );

  applyShapeBorder(rPlain, { enabled: true, color: { r: 128, g: 128, b: 128 } });
  log('enable-no-stroke', rPlain.idml?.strokeEnabled === true, String(rPlain.idml?.strokeEnabled));
  const outPlain = await exportIdml(doc);
  const zp = await JSZip.loadAsync(outPlain);
  const spPlain = await zp.file('Spreads/Spread_s1.xml')!.async('string');
  log(
    'no-stroke-enable-export',
    readPageItemAttribute(spPlain, 'rPlain', 'StrokeColor')?.startsWith('Color/') === true,
    readPageItemAttribute(spPlain, 'rPlain', 'StrokeColor') ?? '',
  );

  const blackHex = cmykToRgbHex(0, 0, 0, 100);
  log(
    'reimport-fill-after-stroke-edit',
    rRt.idml?.fillColor?.toLowerCase() === blackHex.toLowerCase(),
    rRt.idml?.fillColor ?? '',
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

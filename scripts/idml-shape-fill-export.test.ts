/**
 * IDML shape fill color export: swatch reuse, new swatches, package fidelity, round-trip.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml } from '../src/indd/idml';
import { applyIdmlShapeColor } from '../src/indd/idmlEdit';
import { shapeColorBlockReason } from '../src/operations/edit';
import { applyIdmlText } from '../src/indd/idmlEdit';
import { leaves } from '../src/core/model';
import { createSampleIdml } from '../src/indd/idml';
import { readPageItemAttribute } from '../src/indd/exportPatch';
import { cmykToRgbHex, parseGraphicXmlColors, resolveSwatchRef } from '../src/indd/swatches';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function buildTwoSwatchFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="s1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    <Rectangle Self="rA" ItemTransform="1 0 0 1 40 40" FillColor="Color/Black">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="80 0" />
        <PathPointType Anchor="80 60" /><PathPointType Anchor="0 60" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
    <Rectangle Self="rB" ItemTransform="1 0 0 1 160 40" FillColor="Color/Color 1">
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
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>',
  );
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Resources/Graphic.xml', graphic);
  const { writeIdmlPackage } = await import('../src/indd/zip');
  return writeIdmlPackage(zip);
}

async function buildNoFillRectFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0"?><Spread Self="s1"><Page Self="p1" GeometricBounds="0 0 792 612"/>
  <Rectangle Self="rNone" ItemTransform="1 0 0 1 50 50" FillColor="n">
  <Properties><PathGeometry><GeometryPathType PathOpen="false">
  <PathPointType Anchor="0 0"/><PathPointType Anchor="60 0"/><PathPointType Anchor="60 40"/><PathPointType Anchor="0 40"/>
  </GeometryPathType></PathGeometry></Properties></Rectangle></Spread>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>');
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Resources/Graphic.xml', '<?xml version="1.0"?><Graphic><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/></Graphic>');
  const { writeIdmlPackage } = await import('../src/indd/zip');
  return writeIdmlPackage(zip);
}

async function main() {
  const bytes = await buildTwoSwatchFixture();
  const color1Hex = cmykToRgbHex(60, 14, 11, 84);
  let doc = await importIdml('fill-fixture.idml', bytes, 'idml');
  const rA = leaves(doc).find((n) => n.idml?.self === 'rA')!;
  const rB = leaves(doc).find((n) => n.idml?.self === 'rB')!;

  log('shape-color-not-blocked', shapeColorBlockReason(rA) === null, shapeColorBlockReason(rA) ?? 'ok');
  log('shape-import-vector-fill', rA.src.vectorFill?.type === 'color', String(rA.src.vectorFill?.type));

  applyIdmlShapeColor(rA, hexToRgbObj(color1Hex));
  log('edit-existing-swatch-dirty', rA.idml?.exportFillDirty === true, String(rA.idml?.exportFillDirty));

  const exported1 = await exportIdml(doc);
  const z1 = await JSZip.loadAsync(exported1);
  const spread1 = await z1.file('Spreads/Spread_s1.xml')!.async('string');
  const fillA1 = readPageItemAttribute(spread1, 'rA', 'FillColor');
  const fillB1 = readPageItemAttribute(spread1, 'rB', 'FillColor');
  const graphic1 = await z1.file('Resources/Graphic.xml')!.async('string');
  const colors1 = parseGraphicXmlColors(graphic1);
  log('reuse-swatch-ref', fillA1 === 'Color/Color 1', `${fillA1}`);
  log('untouched-shape-fill', fillB1 === 'Color/Color 1', `${fillB1}`);
  log('no-extra-swatch', colors1.size === 2, String(colors1.size));
  log(
    'roundtrip-existing-swatch',
    resolveSwatchRef(fillA1, colors1)?.toLowerCase() === color1Hex.toLowerCase(),
    resolveSwatchRef(fillA1, colors1) ?? '',
  );

  const docRt1 = await importIdml('rt1.idml', exported1, 'idml');
  const rARt = leaves(docRt1).find((n) => n.idml?.self === 'rA')!;
  log(
    'reimport-edited-fill',
    rARt.idml?.fillColor?.toLowerCase() === color1Hex.toLowerCase(),
    rARt.idml?.fillColor ?? '',
  );
  log('reimport-fill-not-dirty', rARt.idml?.exportFillDirty !== true, String(rARt.idml?.exportFillDirty));

  applyIdmlShapeColor(rA, { r: 255, g: 64, b: 32 });
  const exported2 = await exportIdml(doc);
  const z2 = await JSZip.loadAsync(exported2);
  const spread2 = await z2.file('Spreads/Spread_s1.xml')!.async('string');
  const fillA2 = readPageItemAttribute(spread2, 'rA', 'FillColor');
  const graphic2 = await z2.file('Resources/Graphic.xml')!.async('string');
  const colors2 = parseGraphicXmlColors(graphic2);
  log('new-swatch-added', colors2.size === 3, String(colors2.size));
  log('new-swatch-used', fillA2?.startsWith('Color/Canvas') === true, fillA2 ?? '');
  log('new-swatch-in-graphic', graphic2.includes(`Self="${fillA2}"`), fillA2 ?? '');

  const docRt2 = await importIdml('rt2.idml', exported2, 'idml');
  const rARt2 = leaves(docRt2).find((n) => n.idml?.self === 'rA')!;
  log('reimport-new-fill', rARt2.idml?.fillColor === '#ff4020', rARt2.idml?.fillColor ?? '');

  const exported3 = await exportIdml(doc);
  const z3 = await JSZip.loadAsync(exported3);
  const names2 = Object.keys(z2.files).filter((n) => !z2.files[n].dir).sort();
  const names3 = Object.keys(z3.files).filter((n) => !z3.files[n].dir).sort();
  const dirs3 = Object.keys(z3.files).filter((n) => z3.files[n].dir);
  log('reexport-no-dir-entries', dirs3.length === 0, String(dirs3.length));
  log('reexport-same-members', names2.join(',') === names3.join(','), `count=${names3.length}`);

  const unchangedSpread = await z3.file('Spreads/Spread_s1.xml')!.async('string');
  log(
    'reexport-stable-fill',
    readPageItemAttribute(unchangedSpread, 'rA', 'FillColor') === fillA2,
    readPageItemAttribute(unchangedSpread, 'rA', 'FillColor') ?? '',
  );

  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (fs.existsSync(idmlPath)) {
    const buf = fs.readFileSync(idmlPath);
    doc = await importIdml(
      'magazine.idml',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      'indd',
    );
    const u202 = leaves(doc).find((n) => n.idml?.self === 'u202');
    const u204 = leaves(doc).find((n) => n.idml?.self === 'u204');
    if (u202) {
      applyIdmlShapeColor(u202, { r: 200, g: 120, b: 40 });
      const spreadPath = u202.idml!.spreadPath!;
      const zBefore = await JSZip.loadAsync(buf);
      const beforeXml = await zBefore.file(spreadPath)!.async('string');
      const beforeTint = readPageItemAttribute(beforeXml, 'u202', 'FillTint');
      const magOut = await exportIdml(doc);
      const zm = await JSZip.loadAsync(magOut);
      const afterXml = await zm.file(spreadPath)!.async('string');
      const afterTint = readPageItemAttribute(afterXml, 'u202', 'FillTint');
      log('magazine-fillTint-unchanged', beforeTint === afterTint, `${beforeTint} -> ${afterTint}`);
      if (u204) {
        log(
          'magazine-untouched-u204',
          readPageItemAttribute(beforeXml, 'u204', 'FillColor') ===
            readPageItemAttribute(afterXml, 'u204', 'FillColor'),
          readPageItemAttribute(beforeXml, 'u204', 'FillColor') ?? '',
        );
      }
    }
  } else {
    log('magazine-fixture', true, 'skipped — missing fixture');
  }

  const noFillBytes = await buildNoFillRectFixture();
  const noFillDoc = await importIdml('no-fill.idml', noFillBytes, 'idml');
  const rNone = leaves(noFillDoc).find((n) => n.idml?.self === 'rNone')!;
  log('no-fill-import-color-null', rNone.idml?.fillColor === undefined, String(rNone.idml?.fillColor));
  log('no-fill-edit-allowed', shapeColorBlockReason(rNone) === null, shapeColorBlockReason(rNone) ?? 'ok');
  applyIdmlShapeColor(rNone, { r: 0, g: 128, b: 255 });
  log('no-fill-after-edit', rNone.idml?.fillColor === '#0080ff', rNone.idml?.fillColor ?? '');
  const noFillOut = await exportIdml(noFillDoc);
  const znf = await JSZip.loadAsync(noFillOut);
  const spNf = await znf.file('Spreads/Spread_s1.xml')!.async('string');
  log('no-fill-export-swatch', Boolean(readPageItemAttribute(spNf, 'rNone', 'FillColor')?.startsWith('Color/')), readPageItemAttribute(spNf, 'rNone', 'FillColor') ?? '');

  const sampleBytes = await createSampleIdml();
  const sampleDoc = await importIdml('sample.idml', sampleBytes, 'idml');
  const sampleText = sampleDoc.roots.find((n) => n.kind === 'text')!;
  applyIdmlText(sampleText, { color: { r: 40, g: 40, b: 200 } });
  const sampleOut = await exportIdml(sampleDoc);
  const zS = await JSZip.loadAsync(sampleOut);
  const storyS = await zS.file('Stories/Story_ud4.xml')!.async('string');
  log('text-color-still-exports', /FillColor="Color\//.test(storyS), 'story fill');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

function hexToRgbObj(hex: string): { r: number; g: number; b: number } {
  const s = hex.replace(/^#/, '');
  return {
    r: Number.parseInt(s.slice(0, 2), 16),
    g: Number.parseInt(s.slice(2, 4), 16),
    b: Number.parseInt(s.slice(4, 6), 16),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

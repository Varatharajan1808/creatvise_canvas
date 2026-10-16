/**
 * IDML rotation/resize export: ItemTransform patches, re-import geometry, untouched items.
 */
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml } from '../src/idml';
import { applyIdmlShapeColor } from '../src/idmlEdit';
import { leaves } from '../src/model';
import { readPageItemAttribute } from '../src/idml/exportPatch';
import { rotationDegreesFromMatrix6, parseMatrix6, multiply6 } from '../src/idml/matrix';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};
const near = (a: number, b: number, eps = 2) => Math.abs(a - b) <= eps;

async function buildFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="s1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    <Rectangle Self="rA" ItemTransform="1 0 0 1 40 40" FillColor="Color/Black">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="100 0" />
        <PathPointType Anchor="100 80" /><PathPointType Anchor="0 80" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
    <Rectangle Self="rB" ItemTransform="1 0 0 1 200 40" FillColor="Color/Black">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="60 0" />
        <PathPointType Anchor="60 40" /><PathPointType Anchor="0 40" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
    <TextFrame Self="tf1" ParentStory="st1" ItemTransform="1 0 0 1 40 160">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="220 0" />
        <PathPointType Anchor="220 48" /><PathPointType Anchor="0 48" />
      </GeometryPathType></PathGeometry></Properties>
    </TextFrame>
  </Spread>
</idPkg:Spread>`;
  const story = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Story Self="st1"><ParagraphStyleRange><CharacterStyleRange><Content>Transform export</Content></CharacterStyleRange></ParagraphStyleRange></Story>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/><idPkg:Story src="Stories/Story_st1.xml"/></Document>',
  );
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Stories/Story_st1.xml', story);
  zip.file(
    'Resources/Graphic.xml',
    '<?xml version="1.0"?><Graphic><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/></Graphic>',
  );
  const { writeIdmlPackage } = await import('../src/idml/zip');
  return writeIdmlPackage(zip);
}

function applyTransform(
  n: { x: number; y: number; w: number; h: number; rotation: number; ox: number; oy: number; ow: number; oh: number },
  patch: Partial<{ x: number; y: number; w: number; h: number; rotation: number }>,
) {
  if (patch.w !== undefined) n.w = patch.w;
  if (patch.h !== undefined) n.h = patch.h;
  if (patch.rotation !== undefined) n.rotation = patch.rotation;
  if (patch.x !== undefined) n.x = patch.x;
  if (patch.y !== undefined) n.y = patch.y;
}

async function main() {
  const bytes = await buildFixture();
  let doc = await importIdml('xf.idml', bytes, 'idml');
  const rA = leaves(doc).find((n) => n.idml?.self === 'rA')!;
  const rB = leaves(doc).find((n) => n.idml?.self === 'rB')!;
  const tf = leaves(doc).find((n) => n.idml?.self === 'tf1')!;
  const rA0 = { x: rA.x, y: rA.y, w: rA.w, h: rA.h, rot: rA.rotation };

  applyTransform(rA, { rotation: 35 });
  let exported = await exportIdml(doc);
  let z = await JSZip.loadAsync(exported);
  let spread = await z.file('Spreads/Spread_s1.xml')!.async('string');
  const mRot = readPageItemAttribute(spread, 'rA', 'ItemTransform')!;
  const worldRot = multiply6(parseMatrix6('1 0 0 1 0 0'), parseMatrix6(mRot));
  log('rect-rotate-export', near(rotationDegreesFromMatrix6(worldRot), 35, 1.5), `${rotationDegreesFromMatrix6(worldRot)}`);
  let docR = await importIdml('rt-rot.idml', exported, 'idml');
  let rAr = leaves(docR).find((n) => n.idml?.self === 'rA')!;
  log('rect-rotate-reimport', near(rAr.rotation, 35, 2), String(rAr.rotation));

  applyTransform(rA, { w: Math.round(rA0.w * 1.25), h: Math.round(rA0.h * 0.8) });
  exported = await exportIdml(doc);
  z = await JSZip.loadAsync(exported);
  spread = await z.file('Spreads/Spread_s1.xml')!.async('string');
  docR = await importIdml('rt-resize.idml', exported, 'idml');
  rAr = leaves(docR).find((n) => n.idml?.self === 'rA')!;
  log('rect-resize-w', near(rAr.w, Math.round(rA0.w * 1.25), 3), `${rA0.w} -> ${rAr.w}`);
  log('rect-resize-h', near(rAr.h, Math.round(rA0.h * 0.8), 3), `${rA0.h} -> ${rAr.h}`);

  const tfTargetW = tf.w + 40;
  applyTransform(tf, { rotation: -20, w: tfTargetW });
  exported = await exportIdml(doc);
  docR = await importIdml('rt-tf.idml', exported, 'idml');
  const tfr = leaves(docR).find((n) => n.idml?.self === 'tf1')!;
  log('text-rotate-reimport', near(tfr.rotation, -20, 2), String(tfr.rotation));
  log('text-resize-reimport', near(tfr.w, tfTargetW, 3), `${tfTargetW} vs ${tfr.w}`);

  applyTransform(rA, { x: rA.x + 18, y: rA.y - 10, rotation: 50, w: rA.w - 12, h: rA.h + 6 });
  const fillBefore = readPageItemAttribute(spread, 'rB', 'FillColor');
  applyIdmlShapeColor(rA, { r: 200, g: 40, b: 40 });
  exported = await exportIdml(doc);
  z = await JSZip.loadAsync(exported);
  spread = await z.file('Spreads/Spread_s1.xml')!.async('string');
  log('untouched-rB-fill', readPageItemAttribute(spread, 'rB', 'FillColor') === fillBefore, fillBefore ?? '');
  docR = await importIdml('rt-combo.idml', exported, 'idml');
  rAr = leaves(docR).find((n) => n.idml?.self === 'rA')!;
  log('combo-move-x', near(rAr.x, rA.x, 3), `${rA.x} vs ${rAr.x}`);
  log('combo-rotation', near(rAr.rotation, 50, 2.5), String(rAr.rotation));
  log('combo-fill', rAr.idml?.fillColor === '#c82828', rAr.idml?.fillColor ?? '');

  const exported2 = await exportIdml(doc);
  const z2 = await JSZip.loadAsync(exported2);
  const names1 = Object.keys(z.files).filter((n) => !z.files[n].dir).sort();
  const names2 = Object.keys(z2.files).filter((n) => !z2.files[n].dir).sort();
  log('reexport-same-members', names1.join(',') === names2.join(','), `count=${names2.length}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

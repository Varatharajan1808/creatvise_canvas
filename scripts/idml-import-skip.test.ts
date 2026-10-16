/**
 * IDML import-skip: verify that unsupported/unknown page item tags are
 * gracefully skipped during import without crashing, and only recognized
 * element types produce nodes.
 */
import { Window } from 'happy-dom';
import JSZip from 'jszip';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

import { importIdml } from '../src/indd/idml';
import { writeIdmlPackage } from '../src/indd/zip';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

/** Build a minimal IDML ZIP with specific spread content. */
async function buildIdmlWith(spreadContent: string): Promise<ArrayBuffer> {
  const JSZipModule = (await import('jszip')).default;
  const zip = new JSZipModule();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });

  const designmap = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4" Self="d">
  <idPkg:Spread src="Spreads/Spread_u1.xml" />
</Document>`;
  zip.file('designmap.xml', designmap);

  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="u1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    ${spreadContent}
  </Spread>
</idPkg:Spread>`;
  zip.file('Spreads/Spread_u1.xml', spread);

  return await writeIdmlPackage(zip);
}

async function main() {
  // 1. Unsupported tag should be skipped
  const withUnknown = await buildIdmlWith(`
    <Rectangle Self="r1" ItemTransform="1 0 0 1 50 50">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointType Anchor="0 0" />
            <PathPointType Anchor="100 0" />
            <PathPointType Anchor="100 100" />
            <PathPointType Anchor="0 100" />
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </Rectangle>
    <MasterPageItem Self="m1" ItemTransform="1 0 0 1 200 200">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="50 0" />
        <PathPointType Anchor="50 50" /><PathPointType Anchor="0 50" />
      </GeometryPathType></PathGeometry></Properties>
    </MasterPageItem>
    <CustomUnknownElement Self="x1" SomeAttr="value" />
  `);

  const doc1 = await importIdml('skip-test.idml', withUnknown, 'idml');
  log('unknown-elements-skipped', doc1.roots.length === 1,
    `Expected 1 root (Rectangle only), got ${doc1.roots.length}: ${doc1.roots.map(n => n.idml?.tag).join(', ')}`);

  const hasRect = doc1.roots.some(n => n.idml?.tag === 'Rectangle');
  log('rectangle-imported', hasRect, doc1.roots.map(n => n.idml?.tag).join(', '));

  // 2. Empty spread (no page items) → empty roots
  const empty = await buildIdmlWith('');
  const doc2 = await importIdml('empty.idml', empty, 'idml');
  log('empty-spread-ok', doc2.roots.length === 0, `${doc2.roots.length} roots`);
  log('empty-has-dimensions', doc2.width > 0 && doc2.height > 0, `${doc2.width}x${doc2.height}`);

  // 3. All supported types
  const allTypes = await buildIdmlWith(`
    <TextFrame Self="tf1" ItemTransform="1 0 0 1 10 10">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="100 0" />
        <PathPointType Anchor="100 30" /><PathPointType Anchor="0 30" />
      </GeometryPathType></PathGeometry></Properties>
    </TextFrame>
    <Rectangle Self="r2" ItemTransform="1 0 0 1 10 60" FillColor="Color/Black">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="80 0" />
        <PathPointType Anchor="80 40" /><PathPointType Anchor="0 40" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
    <Oval Self="o1" ItemTransform="1 0 0 1 10 120">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="60 0" />
        <PathPointType Anchor="60 60" /><PathPointType Anchor="0 60" />
      </GeometryPathType></PathGeometry></Properties>
    </Oval>
    <Polygon Self="pg1" ItemTransform="1 0 0 1 10 200">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 50" /><PathPointType Anchor="50 0" />
        <PathPointType Anchor="100 50" />
      </GeometryPathType></PathGeometry></Properties>
    </Polygon>
  `);

  const doc3 = await importIdml('all-types.idml', allTypes, 'idml');
  log('all-types-count', doc3.roots.length === 4,
    `Expected 4, got ${doc3.roots.length}: ${doc3.roots.map(n => n.idml?.tag).join(', ')}`);

  const textNode = doc3.roots.find(n => n.kind === 'text');
  log('textframe-is-text', !!textNode, textNode?.kind ?? 'not found');

  const shapeNodes = doc3.roots.filter(n => n.kind === 'shape');
  log('shapes-count', shapeNodes.length === 3,
    `Expected 3 shapes (Rect+Oval+Poly), got ${shapeNodes.length}`);

  // 4. Group element
  const withGroup = await buildIdmlWith(`
    <Group Self="g1" ItemTransform="1 0 0 1 0 0">
      <Rectangle Self="gr1" ItemTransform="1 0 0 1 10 10">
        <Properties><PathGeometry><GeometryPathType PathOpen="false">
          <PathPointType Anchor="0 0" /><PathPointType Anchor="50 0" />
          <PathPointType Anchor="50 50" /><PathPointType Anchor="0 50" />
        </GeometryPathType></PathGeometry></Properties>
      </Rectangle>
    </Group>
  `);

  const doc4 = await importIdml('group.idml', withGroup, 'idml');
  const rectInGroup = doc4.roots.find((n) => n.idml?.self === 'gr1');
  log('group-children-imported', doc4.roots.length === 1 && !!rectInGroup, doc4.roots.map((n) => n.idml?.tag).join(', '));
  log('group-transform-applied', rectInGroup?.x === 10 && rectInGroup?.y === 10, `x=${rectInGroup?.x} y=${rectInGroup?.y}`);

  // 5. Invalid ZIP → should throw
  let invalidThrew = false;
  try {
    await importIdml('invalid.idml', new ArrayBuffer(10), 'idml');
  } catch {
    invalidThrew = true;
  }
  log('invalid-zip-throws', invalidThrew, invalidThrew ? 'threw as expected' : 'did not throw');

  // Summary
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('Failures:', failed.map(f => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});

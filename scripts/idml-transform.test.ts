/**
 * IDML transform mapping: rotated frames, nested groups, magazine layout goldens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import {
  importIdml,
  pageItemDocPlacement,
  docAabbFromLocalBounds,
  layoutFromPageElement,
  spreadContainerElement,
  elementsLocalCI,
  contentSpreadPathsFromDesignmap,
} from '../src/indd/idml';
import { parseMatrix6 } from '../src/indd/matrix';
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
const near = (a: number, b: number, eps = 1.5) => Math.abs(a - b) <= eps;

async function main() {
  const rotM = parseMatrix6('0 -1 1 0 77.48031496060344 -412.8358290871593');
  const local = {
    minX: -202.41063223770283,
    minY: -34.96062992126008,
    maxX: -70.4106322377027,
    maxY: -25.52996585876008,
  };
  const ctx = { originX: 0, originY: -420.9448818887999, offsetY: 0 };
  const aabb = docAabbFromLocalBounds(local, rotM, ctx);
  const place = pageItemDocPlacement(
    [
      { anchor: [local.minX, local.minY] },
      { anchor: [local.maxX, local.minY] },
      { anchor: [local.maxX, local.maxY] },
      { anchor: [local.minX, local.maxY] },
    ],
    rotM,
    ctx,
  );
  log('rotated-aabb-w', near(aabb.w, 9.43, 0.5), String(aabb.w));
  log('rotated-aabb-h', near(aabb.h, 132, 0.5), String(aabb.h));
  log('rotated-center-x', near(place.x + place.w / 2, aabb.x + aabb.w / 2, 1), `${place.x}+${place.w / 2}`);
  log('rotated-center-y', near(place.y + place.h / 2, aabb.y + aabb.h / 2, 1), `${place.y}+${place.h / 2}`);
  log('rotated-angle', near(place.rotation, -90, 0.5), String(place.rotation));

  const groupSpread = `<?xml version="1.0"?><Spread Self="s1">
  <Page Self="p1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0" />
  <Group Self="g1" ItemTransform="1 0 0 1 100 50">
    <Rectangle Self="r1" ItemTransform="1 0 0 1 20 30" FillColor="Color/Black">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="40 0" />
        <PathPointType Anchor="40 25" /><PathPointType Anchor="0 25" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
  </Group>
</Spread>`;
  const { default: JSZip } = await import('jszip');
  const { writeIdmlPackage } = await import('../src/indd/zip');
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>');
  zip.file('Spreads/Spread_s1.xml', groupSpread);
  zip.file(
    'Resources/Graphic.xml',
    '<?xml version="1.0"?><Graphic><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/></Graphic>',
  );
  const bytes = await writeIdmlPackage(zip);
  const groupDoc = await importIdml('group-offset.idml', bytes, 'idml');
  const rect = leaves(groupDoc).find((n) => n.idml?.self === 'r1');
  log('nested-group-x', rect?.x === 120, `x=${rect?.x}`);
  log('nested-group-y', rect?.y === 80, `y=${rect?.y}`);

  log(
    'designmap-spread-order',
    contentSpreadPathsFromDesignmap(
      '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_a.xml" /><idPkg:Spread src="Spreads/Spread_b.xml" /></Document>',
    ).join(',') === 'Spreads/Spread_a.xml,Spreads/Spread_b.xml',
    'ok',
  );

  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (!fs.existsSync(idmlPath)) {
    log('magazine-fixture', false, 'missing idml');
  } else {
    const buf = fs.readFileSync(idmlPath);
    const doc = await importIdml(
      'magazine.idml',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      'indd',
    );
    log('magazine-page-size', near(doc.width, 595.28, 0.5) && near(doc.height, 841.89 * 5, 5), `${doc.width}x${doc.height}`);
    const bySelf = new Map(leaves(doc).map((n) => [n.idml?.self, n]));
    const title = bySelf.get('u1fd');
    const teal = bySelf.get('u202');
    const grey = bySelf.get('u204');
    const brown = bySelf.get('u206');
    const sideText = bySelf.get('u222');
    log('magazine-title-pos', near(title?.x ?? 0, 74) && near(title?.y ?? 0, 223), `${title?.x},${title?.y}`);
    log('magazine-teal-pos', near(teal?.x ?? 0, 161) && near(teal?.y ?? 0, 331), `${teal?.x},${teal?.y}`);
    log('magazine-grey-pos', near(grey?.x ?? 0, 347) && near(grey?.y ?? 0, 283), `${grey?.x},${grey?.y}`);
    log('magazine-brown-pos', near(brown?.x ?? 0, 292) && near(brown?.y ?? 0, 671), `${brown?.x},${brown?.y}`);
    if (sideText) {
      log('magazine-monthly-mesh-rot', near(sideText.rotation, -90, 0.5), String(sideText.rotation));
      log('magazine-monthly-local-box', sideText.w > sideText.h, `${sideText.w}x${sideText.h}`);
      log('magazine-monthly-page', sideText.idml?.pageIndex === 1, String(sideText.idml?.pageIndex));
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

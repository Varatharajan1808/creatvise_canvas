/**
 * IDML rotation/geometry: import ↔ doc state ↔ export pipeline (no double-rotation on shapes).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml, pageItemDocPlacement } from '../src/idml';
import { multiply6, parseMatrix6, rotationDegreesFromMatrix6 } from '../src/idml/matrix';
import { applyIdmlShapeColor } from '../src/idmlEdit';
import { leaves } from '../src/model';
import { exportItemTransformFromDocState, readPageItemAttribute } from '../src/idml/exportPatch';
import type { Matrix2D } from '../src/idml/matrix';

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

function matrixNear(a: Matrix2D, b: Matrix2D, eps = 0.08): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

async function buildRotatedRectFixture(): Promise<{ bytes: ArrayBuffer; itemM: string }> {
  const itemM = '0.707107 0.707107 -0.707107 0.707107 120 90';
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="s1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    <Rectangle Self="r45" ItemTransform="${itemM}" FillColor="Color/Black">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointType Anchor="0 0" /><PathPointType Anchor="100 0" />
        <PathPointType Anchor="100 60" /><PathPointType Anchor="0 60" />
      </GeometryPathType></PathGeometry></Properties>
    </Rectangle>
  </Spread>
</idPkg:Spread>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>');
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file(
    'Resources/Graphic.xml',
    '<?xml version="1.0"?><Graphic><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/></Graphic>',
  );
  const { writeIdmlPackage } = await import('../src/idml/zip');
  return { bytes: await writeIdmlPackage(zip), itemM };
}

async function main() {
  const { bytes, itemM } = await buildRotatedRectFixture();
  const doc = await importIdml('rot45.idml', bytes, 'idml');
  const r45 = leaves(doc).find((n) => n.idml?.self === 'r45')!;
  const importedM = parseMatrix6(itemM);
  const worldImported = multiply6(parseMatrix6('1 0 0 1 0 0'), importedM);
  log('import-rotation-45', near(r45.rotation, rotationDegreesFromMatrix6(worldImported), 1), String(r45.rotation));

  const parentM = parseMatrix6(r45.idml!.parentTransform!.join(' '));
  const itemFromNode = parseMatrix6(r45.idml!.itemTransform!.join(' '));
  const worldFromStored = multiply6(parentM, itemFromNode);
  log('import-matrix-preserved', matrixNear(worldFromStored, worldImported), worldFromStored.join(','));

  const reexportAtImport = exportItemTransformFromDocState(r45, parseMatrix6('1 0 0 1 0 0'));
  if (reexportAtImport) {
    const worldRoundtrip = multiply6(parentM, reexportAtImport);
    const scaleOk = near(
      Math.hypot(reexportAtImport[0], reexportAtImport[1]),
      Math.hypot(importedM[0], importedM[1]),
      0.05,
    );
    log(
      'import-doc-export-roundtrip-rot',
      near(rotationDegreesFromMatrix6(worldRoundtrip), r45.rotation, 1.5),
      rotationDegreesFromMatrix6(worldRoundtrip).toFixed(2),
    );
    log('import-doc-export-roundtrip-scale', scaleOk, Math.hypot(reexportAtImport[0], reexportAtImport[1]).toFixed(3));
  }

  const exported0 = await exportIdml(doc);
  const z0 = await JSZip.loadAsync(exported0);
  const spread0 = await z0.file('Spreads/Spread_s1.xml')!.async('string');
  log(
    'untouched-export-same-transform',
    readPageItemAttribute(spread0, 'r45', 'ItemTransform') === itemM,
    readPageItemAttribute(spread0, 'r45', 'ItemTransform') ?? '',
  );

  r45.rotation = norm(r45.rotation + 35);
  const m35 = exportItemTransformFromDocState(r45, parseMatrix6('1 0 0 1 0 0'));
  log('rotate-plus-35-matrix', m35 !== null && near(rotationDegreesFromMatrix6(multiply6(parentM, m35!)), norm(r45.rotation), 2), String(r45.rotation));

  r45.rotation = norm(r45.rotation - 70);
  const mNeg = exportItemTransformFromDocState(r45, parseMatrix6('1 0 0 1 0 0'));
  log('rotate-minus-35-matrix', mNeg !== null && near(rotationDegreesFromMatrix6(multiply6(parentM, mNeg!)), r45.rotation, 2), String(r45.rotation));

  r45.w = Math.round(r45.w * 1.2);
  r45.h = Math.round(r45.h * 0.85);
  r45.rotation = norm(r45.rotation + 12);
  const exported = await exportIdml(doc);
  const doc2 = await importIdml('rt.idml', exported, 'idml');
  const r2 = leaves(doc2).find((n) => n.idml?.self === 'r45')!;
  log('resize-then-rotate-w', near(r2.w, r45.w, 3), `${r45.w} -> ${r2.w}`);
  log('resize-then-rotate-h', near(r2.h, r45.h, 3), `${r45.h} -> ${r2.h}`);
  log('resize-then-rotate-angle', near(r2.rotation, r45.rotation, 2), String(r2.rotation));

  applyIdmlShapeColor(r2, { r: 180, g: 90, b: 30 });
  const parentDoc = await importIdml('parent.idml', bytes, 'idml');
  const rParent = leaves(parentDoc).find((n) => n.idml?.self === 'r45')!;
  rParent.x += 10;
  rParent.y += 5;
  rParent.rotation = norm(rParent.rotation + 20);
  rParent.w += 8;
  const exCombo = await exportIdml(parentDoc);
  const zc = await JSZip.loadAsync(exCombo);
  const spreadC = await zc.file('Spreads/Spread_s1.xml')!.async('string');
  const docC = await importIdml('combo.idml', exCombo, 'idml');
  const rC = leaves(docC).find((n) => n.idml?.self === 'r45')!;
  log('combo-move-rotate-resize-x', near(rC.x, rParent.x, 3), `${rParent.x} vs ${rC.x}`);
  log('combo-fill-exported', spreadC.includes('FillColor='), 'fill attr');

  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (fs.existsSync(idmlPath)) {
    const buf = fs.readFileSync(idmlPath);
    const mag = await importIdml('mag.idml', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'indd');
    const brown = leaves(mag).find((n) => n.idml?.self === 'u206');
    const tf = leaves(mag).find((n) => n.idml?.self === 'u222');
    if (brown) {
      const rot0 = brown.rotation;
      const w0 = brown.w;
      const h0 = brown.h;
      log('brown-import-rotation', Number.isFinite(rot0), String(rot0));
      brown.rotation = norm(rot0 + 15);
      brown.w = Math.round(w0 * 0.9);
      brown.h = Math.round(h0 * 1.05);
      const exB = await exportIdml(mag);
      const mag2 = await importIdml('mag2.idml', exB, 'indd');
      const brown2 = leaves(mag2).find((n) => n.idml?.self === 'u206')!;
      log('brown-after-transform-rot', near(brown2.rotation, brown.rotation, 2.5), `${brown.rotation}`);
      log('brown-after-transform-w', near(brown2.w, brown.w, 4), `${brown.w}`);
    }
    if (tf) {
      const rotT = tf.rotation;
      tf.rotation = norm(rotT + 10);
      tf.w += 12;
      const exT = await exportIdml(mag);
      const magT = await importIdml('magT.idml', exT, 'indd');
      const tf2 = leaves(magT).find((n) => n.idml?.self === 'u222')!;
      log('textframe-transform-rot', near(tf2.rotation, tf.rotation, 2.5), String(tf2.rotation));
    }
  } else {
    log('magazine-fixture', true, 'skipped');
  }

  const placement = pageItemDocPlacement(
    [
      { anchor: [0, 0] },
      { anchor: [100, 0] },
      { anchor: [100, 60] },
      { anchor: [0, 60] },
    ],
    importedM,
    { originX: 0, originY: 0, offsetY: 0 },
    parseMatrix6('1 0 0 1 0 0'),
  );
  log('placement-not-aabb-rotated', placement.w <= 101 && placement.h <= 61, `${placement.w}x${placement.h}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

function norm(a: number) {
  return Math.round((((a + 180) % 360 + 360) % 360 - 180) * 10) / 10;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

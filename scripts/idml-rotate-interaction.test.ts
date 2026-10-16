/**
 * IDML rotation: shape mesh/selection pairing, text pointer angles, export round-trip.
 */
import {
  meshRotationZDegrees,
  rotationDeltaFromPointerDrag,
  rotationPointerAngleDeg,
  shapeSelectionMatchesMeshRotation,
} from '../src/idmlVisualRotation';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml } from '../src/idml';
import { leaves } from '../src/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const center = { x: 200, y: 200 };
  const idmlShape = { idml: { self: 's' }, kind: 'shape' as const };
  const idmlText = { idml: { self: 't' }, kind: 'text' as const };
  const rasterNode = { idml: undefined, kind: 'raster' as const };

  const cwStart = { x: 260, y: 200 };
  const cwEnd = { x: 200, y: 260 };
  const shapeCw = rotationDeltaFromPointerDrag(idmlShape, cwStart, cwEnd, center);
  const textCw = rotationDeltaFromPointerDrag(idmlText, cwStart, cwEnd, center);
  const rasterCw = rotationDeltaFromPointerDrag(rasterNode, cwStart, cwEnd, center);
  log('shape-clockwise-drag-positive-delta', shapeCw > 45, String(shapeCw));
  log('text-clockwise-drag-positive-delta', textCw > 45, String(textCw));
  log('text-same-delta-as-shape', Math.abs(textCw - shapeCw) < 1e-6, `${textCw} vs ${shapeCw}`);
  log('raster-clockwise-drag-positive-delta', rasterCw > 45, String(rasterCw));

  const ccwEnd = { x: 200, y: 140 };
  log('shape-counterclockwise-negative-delta', rotationDeltaFromPointerDrag(idmlShape, cwStart, ccwEnd, center) < -45, 'ok');

  const shapeNode = { idml: {}, kind: 'shape' as const, rotation: 35 };
  log('shape-mesh-negative-rotation', meshRotationZDegrees(shapeNode) === -35, String(meshRotationZDegrees(shapeNode)));
  log('shape-mesh-opposes-stored-rotation', meshRotationZDegrees(shapeNode) === -shapeNode.rotation, 'pairing');
  log(
    'shape-css-mesh-pair-at-35',
    shapeSelectionMatchesMeshRotation(shapeNode, 120, 80),
    'css(+θ) corner = mesh(-θ) corner',
  );

  const textNode = { idml: {}, kind: 'text' as const, rotation: -90 };
  log('text-mesh-negative-rotation', meshRotationZDegrees(textNode) === 90, String(meshRotationZDegrees(textNode)));
  log(
    'text-css-mesh-pair-at-35',
    shapeSelectionMatchesMeshRotation({ idml: {}, kind: 'text', rotation: 35 }, 120, 80),
    'css(+θ) corner = mesh(-θ) corner',
  );

  const bytes = await buildRectFixture();
  const doc = await importIdml('r.idml', bytes, 'idml');
  const rect = leaves(doc).find((n) => n.idml?.self === 'r1')!;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const delta = rotationDeltaFromPointerDrag(rect, { x: cx + 80, y: cy }, { x: cx, y: cy + 80 }, { x: cx, y: cy });
  rect.rotation = rect.rotation + delta;
  log('shape-cw-export-rotation', rect.rotation > 45, String(rect.rotation));
  const exported = await exportIdml(doc);
  const doc2 = await importIdml('r2.idml', exported, 'idml');
  const rect2 = leaves(doc2).find((n) => n.idml?.self === 'r1')!;
  log('export-after-cw-drag', Math.abs(rect2.rotation - rect.rotation) < 3, `${rect.rotation} -> ${rect2.rotation}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

async function buildRectFixture(): Promise<ArrayBuffer> {
  const spread = `<?xml version="1.0"?><Spread Self="s1"><Page Self="p1" GeometricBounds="0 0 792 612"/>
  <Rectangle Self="r1" ItemTransform="1 0 0 1 100 100" FillColor="Color/Black">
  <Properties><PathGeometry><GeometryPathType PathOpen="false">
  <PathPointType Anchor="0 0"/><PathPointType Anchor="80 0"/><PathPointType Anchor="80 50"/><PathPointType Anchor="0 50"/>
  </GeometryPathType></PathGeometry></Properties></Rectangle></Spread>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>');
  zip.file('Spreads/Spread_s1.xml', spread);
  zip.file('Resources/Graphic.xml', '<?xml version="1.0"?><Graphic><Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100"/></Graphic>');
  const { writeIdmlPackage } = await import('../src/idml/zip');
  return writeIdmlPackage(zip);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

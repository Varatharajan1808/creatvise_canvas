/**
 * Phase 5 IDML Document Integrity & Regression Test Suite
 *
 * Validates the complete workflow:
 *   Import → Edit → Save → Refresh/Reload → Export → Re-import
 *
 * Covers:
 *  1. Delete a shape (save/reload + export/re-import)
 *  2. Delete a text frame (preserving unrelated stories, spreads, objects)
 *  3. Delete → rapid save/recovery & multi-doc workspace isolation
 *  4. Multiple deletions in the same multi-spread document
 *  5. Move, resize, and rotate shapes & text frames
 *  6. Shape fill, stroke color/weight, and text typography (font size, bold, italic, color, alignment)
 *  7. Placed image move, resize, rotate, and replacement across save/reload + export/re-import
 *  8. Multiple placed images with independent links
 *  9. Unmodified document byte-identical export fidelity
 */

import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { importIdml, exportIdml, createSampleIdml } from '../src/idml';
import {
  applyIdmlText,
  applyIdmlShapeColor,
  applyIdmlShapeBorder,
  getIdmlTextInfo,
} from '../src/idmlEdit';
import {
  applyIdmlPlacedImageReplace,
  setPlacedImageDecodeHookForTests,
} from '../src/idml/placedImage';
import { sniffImageFormat } from '../src/idml/linkImageFormat';
import { parseGraphicXmlColors, findSwatchRefByHex } from '../src/idml/swatches';
import {
  readPageItemAttribute,
  readNestedImageAttribute,
  validateIdmlPackageStructure,
} from '../src/idml/exportPatch';
import { serializeDoc, applySavedDoc } from '../src/workspace';
import type { Doc, Node } from '../src/model';
import { leaves } from '../src/model';
import { writeIdmlPackage } from '../src/idml/zip';

// Setup DOM polyfill
const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
(globalThis as unknown as { XMLSerializer: typeof XMLSerializer }).XMLSerializer =
  window.XMLSerializer as unknown as typeof XMLSerializer;

const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(10, 10) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;

setPlacedImageDecodeHookForTests(async (bytes) => loadImage(bytes) as unknown as CanvasImageSource);

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function detachNode(doc: Doc, node: Node) {
  const list = node.parent ? node.parent.children : doc.roots;
  const idx = list.indexOf(node);
  if (idx >= 0) list.splice(idx, 1);
}

function createMiniJpeg(): Uint8Array {
  const c = createCanvas(4, 4);
  const g = c.getContext('2d')!;
  g.fillStyle = '#cc0000';
  g.fillRect(0, 0, 4, 4);
  return c.toBuffer('image/jpeg');
}

function createMiniPng(color = '#0000ff'): Uint8Array {
  const c = createCanvas(4, 4);
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 4, 4);
  return c.toBuffer('image/png');
}

async function buildTwoImageFixture(): Promise<ArrayBuffer> {
  const jpegBytes = createMiniJpeg();
  const pngBytes = createMiniPng('#0000ff');

  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="sp1" PageCount="1">
    <Page Self="pg1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0" />
    <Rectangle Self="fr1" ContentType="GraphicType" ItemTransform="1 0 0 1 40 40">
      <Properties><PathGeometry PathOpen="false"><GeometryPathType PathOpen="false">
        <PathPointArray>
          <PathPointType Anchor="0 0" /><PathPointType Anchor="160 0" />
          <PathPointType Anchor="160 120" /><PathPointType Anchor="0 120" />
        </PathPointArray>
      </GeometryPathType></PathGeometry></Properties>
      <Image Self="im1" ItemTransform="1 0 0 1 0 0" FitContentToFrame="Proportionally">
        <Properties><GraphicBounds Left="0" Top="0" Right="160" Bottom="120" /><Link LinkResourceURI="file:Links/img1.jpg" StoredState="Normal" /></Properties>
      </Image>
    </Rectangle>
    <Rectangle Self="fr2" ContentType="GraphicType" ItemTransform="1 0 0 1 240 40">
      <Properties><PathGeometry PathOpen="false"><GeometryPathType PathOpen="false">
        <PathPointArray>
          <PathPointType Anchor="0 0" /><PathPointType Anchor="100 0" />
          <PathPointType Anchor="100 80" /><PathPointType Anchor="0 80" />
        </PathPointArray>
      </GeometryPathType></PathGeometry></Properties>
      <Image Self="im2" ItemTransform="1 0 0 1 0 0">
        <Properties><GraphicBounds Left="0" Top="0" Right="100" Bottom="80" /><Link LinkResourceURI="file:Links/img2.png" StoredState="Normal" /></Properties>
      </Image>
    </Rectangle>
    <TextFrame Self="tf1" ParentStory="st1" ItemTransform="1 0 0 1 40 200">
      <Properties><PathGeometry PathOpen="false"><GeometryPathType PathOpen="false">
        <PathPointArray>
          <PathPointType Anchor="0 0" /><PathPointType Anchor="200 0" />
          <PathPointType Anchor="200 60" /><PathPointType Anchor="0 60" />
        </PathPointArray>
      </GeometryPathType></PathGeometry></Properties>
    </TextFrame>
  </Spread>
</idPkg:Spread>`;

  const story = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Story Self="st1"><ParagraphStyleRange><CharacterStyleRange PointSize="12"><Content>Test Story</Content></CharacterStyleRange></ParagraphStyleRange></Story>
</idPkg:Story>`;

  const designmap = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4" Self="d" Length="1">
  <idPkg:Spread src="Spreads/Spread_sp1.xml" />
  <idPkg:Story src="Stories/Story_st1.xml" />
</Document>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE', createFolders: false });
  zip.file('designmap.xml', designmap, { createFolders: false });
  zip.file('Spreads/Spread_sp1.xml', spread, { createFolders: false });
  zip.file('Stories/Story_st1.xml', story, { createFolders: false });
  zip.file('Links/img1.jpg', jpegBytes, { createFolders: false });
  zip.file('Links/img2.png', pngBytes, { createFolders: false });
  return await writeIdmlPackage(zip);
}

async function main() {
  console.log('=== Running Phase 5 Document Integrity & Regression Tests ===\n');

  const realMagPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  const hasRealFixture = fs.existsSync(realMagPath);
  log('real-idml-fixture-present', hasRealFixture, realMagPath);

  // -------------------------------------------------------------------------
  // Scenario 1: Real IDML — Delete Shape → Save → Reload Integrity
  // -------------------------------------------------------------------------
  if (hasRealFixture) {
    const rawBytes = fs.readFileSync(realMagPath);
    const ab = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;

    const doc = await importIdml('mag.idml', ab.slice(0), 'indd');
    const initialLeaves = leaves(doc);
    const victim = initialLeaves.find((n) => n.kind === 'shape' && n.idml?.self === 'u202')!;
    log('scen1-victim-found', Boolean(victim), 'u202');

    detachNode(doc, victim);
    const saved = serializeDoc(doc);
    log('scen1-saved-omits-victim', !saved.nodes.some((n) => n.key === 'u202'), 'u202 absent from saved');

    // Reload
    const reloaded = await importIdml('mag_reload.idml', ab.slice(0), 'indd');
    applySavedDoc(reloaded, saved);
    const reloadedLeaves = leaves(reloaded);

    log('scen1-reload-count-correct', reloadedLeaves.length === initialLeaves.length - 1, `${initialLeaves.length - 1} vs ${reloadedLeaves.length}`);
    log('scen1-reload-victim-absent', !reloadedLeaves.some((n) => n.idml?.self === 'u202'), 'u202 not present');
    log('scen1-reload-unrelated-shape-intact', reloadedLeaves.some((n) => n.idml?.self === 'u204'), 'u204 kept');
    log('scen1-reload-unrelated-text-intact', reloadedLeaves.some((n) => n.idml?.self === 'u1fd'), 'u1fd kept');
  }

  // -------------------------------------------------------------------------
  // Scenario 2: Real IDML — Delete Shape → Export → Re-import Integrity
  // -------------------------------------------------------------------------
  if (hasRealFixture) {
    const rawBytes = fs.readFileSync(realMagPath);
    const ab = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;

    const doc = await importIdml('mag.idml', ab.slice(0), 'indd');
    const initialCount = leaves(doc).length;
    const victim = leaves(doc).find((n) => n.kind === 'shape' && n.idml?.self === 'u202')!;
    const spreadPath = victim.idml!.spreadPath!;

    detachNode(doc, victim);
    const exportedBytes = await exportIdml(doc);
    const z = await JSZip.loadAsync(exportedBytes);
    const spreadXml = await z.file(spreadPath)!.async('string');

    log('scen2-export-spread-no-victim', readPageItemAttribute(spreadXml, 'u202', 'Self') === null, 'u202 removed from XML');
    log('scen2-export-spread-kept-peer', readPageItemAttribute(spreadXml, 'u204', 'ItemTransform') !== null, 'u204 retained in XML');

    // Re-import exported package
    const reimported = await importIdml('reimported.idml', exportedBytes, 'indd');
    const reLeaves = leaves(reimported);

    log('scen2-reimport-count', reLeaves.length === initialCount - 1, `${initialCount - 1} vs ${reLeaves.length}`);
    log('scen2-reimport-no-victim', !reLeaves.some((n) => n.idml?.self === 'u202'), 'u202 remains gone');
    log('scen2-reimport-peer-shape', reLeaves.some((n) => n.idml?.self === 'u204'), 'u204 preserved');
  }

  // -------------------------------------------------------------------------
  // Scenario 3: Real IDML — Delete Text Frame while preserving unrelated stories & objects
  // -------------------------------------------------------------------------
  if (hasRealFixture) {
    const rawBytes = fs.readFileSync(realMagPath);
    const ab = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;

    const doc = await importIdml('mag.idml', ab.slice(0), 'indd');
    const textVictim = leaves(doc).find((n) => n.kind === 'text' && n.idml?.self === 'u1fd')!;
    const textKeeper = leaves(doc).find((n) => n.kind === 'text' && n.idml?.self === 'u222')!;
    const story1 = textVictim.idml!.storyId!;
    const story2 = textKeeper.idml!.storyId!;
    const spreadPath = textVictim.idml!.spreadPath!;

    detachNode(doc, textVictim);
    const exported = await exportIdml(doc);
    const z = await JSZip.loadAsync(exported);
    const struct = validateIdmlPackageStructure(Object.keys(z.files), doc.idml?.designmapXml);

    log('scen3-spreads-preserved', struct.spreadCount === 3, String(struct.spreadCount));
    log('scen3-pages-preserved', struct.pageCount === 5, String(struct.pageCount));

    const spreadXml = await z.file(spreadPath)!.async('string');
    log('scen3-textframe-pruned', readPageItemAttribute(spreadXml, 'u1fd', 'ItemTransform') === null, 'u1fd dropped');
    const keeperSpreadXml = await z.file(textKeeper.idml!.spreadPath!)!.async('string');
    log('scen3-peer-textframe-kept', readPageItemAttribute(keeperSpreadXml, 'u222', 'ItemTransform') !== null, 'u222 kept');

    // Re-import
    const reimported = await importIdml('reimported_text.idml', exported, 'indd');
    log('scen3-reimport-victim-gone', !leaves(reimported).some((n) => n.idml?.self === 'u1fd'), 'u1fd gone');
    const keeperRe = leaves(reimported).find((n) => n.idml?.self === 'u222');
    log('scen3-reimport-keeper-present', Boolean(keeperRe), 'u222 present');
    log('scen3-reimport-keeper-rotation', Math.abs((keeperRe?.rotation ?? 0) - (-90)) < 0.1, String(keeperRe?.rotation));
  }

  // -------------------------------------------------------------------------
  // Scenario 4: Real IDML — Multiple Deletions across multiple spreads
  // -------------------------------------------------------------------------
  if (hasRealFixture) {
    const rawBytes = fs.readFileSync(realMagPath);
    const ab = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;

    const doc = await importIdml('mag.idml', ab.slice(0), 'indd');
    const countBefore = leaves(doc).length;
    // Delete 2 items from spread 1 and 1 from spread 2
    const v1 = leaves(doc).find((n) => n.idml?.self === 'u202')!;
    const v2 = leaves(doc).find((n) => n.idml?.self === 'u204')!;
    const v3 = leaves(doc).find((n) => n.idml?.self === 'u542')!; // on spread 2

    detachNode(doc, v1);
    detachNode(doc, v2);
    detachNode(doc, v3);

    const saved = serializeDoc(doc);
    const reloaded = await importIdml('mag_multi_reload.idml', ab.slice(0), 'indd');
    applySavedDoc(reloaded, saved);

    log('scen4-reload-count', leaves(reloaded).length === countBefore - 3, `${countBefore - 3} vs ${leaves(reloaded).length}`);
    log('scen4-all-3-absent', !leaves(reloaded).some((n) => ['u202', 'u204', 'u542'].includes(n.idml?.self ?? '')), 'all 3 gone');

    const exported = await exportIdml(doc);
    const reimported = await importIdml('mag_multi_reimport.idml', exported, 'indd');
    log('scen4-reimport-count', leaves(reimported).length === countBefore - 3, `${countBefore - 3} vs ${leaves(reimported).length}`);
  }

  // -------------------------------------------------------------------------
  // Scenario 5: Multi-Document Workspace Isolation
  // -------------------------------------------------------------------------
  {
    const sampleBytes = await createSampleIdml();
    const docA = await importIdml('docA.idml', sampleBytes.slice(0), 'idml');
    docA.id = 'docA_unique';
    const docB = await importIdml('docB.idml', sampleBytes.slice(0), 'idml');
    docB.id = 'docB_unique';

    // Delete shape in Doc A
    const shapeA = docA.roots.find((n) => n.kind === 'shape')!;
    detachNode(docA, shapeA);

    // Edit text in Doc B
    const textB = docB.roots.find((n) => n.kind === 'text')!;
    applyIdmlText(textB, { text: 'Doc B Custom Text' });

    // Save both
    const savedA = serializeDoc(docA);
    const savedB = serializeDoc(docB);

    // Reload both
    const reloadedA = await importIdml('docA.idml', sampleBytes.slice(0), 'idml');
    reloadedA.id = 'docA_unique';
    applySavedDoc(reloadedA, savedA);

    const reloadedB = await importIdml('docB.idml', sampleBytes.slice(0), 'idml');
    reloadedB.id = 'docB_unique';
    applySavedDoc(reloadedB, savedB);

    log('scen5-docA-shape-deleted', reloadedA.roots.length === 1 && reloadedA.roots[0].kind === 'text', 'docA has only text');
    log('scen5-docB-shape-kept', reloadedB.roots.length === 2 && reloadedB.roots.some((n) => n.kind === 'shape'), 'docB still has shape');
    log('scen5-docB-text-edited', reloadedB.roots.find((n) => n.kind === 'text')?.src?.text?.text === 'Doc B Custom Text', 'docB text kept');
  }

  // -------------------------------------------------------------------------
  // Scenario 6: Move, Resize, Rotate Shapes & Text Frames → Export → Re-import
  // -------------------------------------------------------------------------
  {
    const sampleBytes = await createSampleIdml();
    const doc = await importIdml('geom.idml', sampleBytes.slice(0), 'idml');
    const rect = doc.roots.find((n) => n.kind === 'shape')!;
    const text = doc.roots.find((n) => n.kind === 'text')!;

    // Transform shape
    rect.x += 40;
    rect.y += 20;
    rect.w += 30;
    rect.h += 15;
    rect.rotation = 45;

    // Transform text
    text.x -= 20;
    text.y += 10;
    text.w += 20;
    text.rotation = -30;

    // Save → Reload
    const saved = serializeDoc(doc);
    const reloaded = await importIdml('geom_reload.idml', sampleBytes.slice(0), 'idml');
    applySavedDoc(reloaded, saved);

    const rRect = reloaded.roots.find((n) => n.kind === 'shape')!;
    const rText = reloaded.roots.find((n) => n.kind === 'text')!;

    log('scen6-reload-rect-geom', rRect.x === rect.x && rRect.w === rect.w && rRect.rotation === 45, `${rRect.x},${rRect.w},${rRect.rotation}`);
    log('scen6-reload-text-geom', rText.x === text.x && rText.rotation === -30, `${rText.x},${rText.rotation}`);

    // Export → Re-import
    const exported = await exportIdml(doc);
    const reimported = await importIdml('geom_reimported.idml', exported, 'idml');
    const riRect = reimported.roots.find((n) => n.kind === 'shape')!;
    const riText = reimported.roots.find((n) => n.kind === 'text')!;

    log('scen6-reimport-rect-pos', Math.abs(riRect.x - rect.x) < 2 && Math.abs(riRect.y - rect.y) < 2, `${riRect.x},${riRect.y}`);
    log('scen6-reimport-rect-rot', Math.abs(riRect.rotation - 45) < 0.5, String(riRect.rotation));
    log('scen6-reimport-text-rot', Math.abs(riText.rotation - (-30)) < 0.5, String(riText.rotation));
  }

  // -------------------------------------------------------------------------
  // Scenario 7: Shape Fill, Stroke Color/Weight & Typography Edits
  // -------------------------------------------------------------------------
  {
    const sampleBytes = await createSampleIdml();
    const doc = await importIdml('style.idml', sampleBytes.slice(0), 'idml');
    const rect = doc.roots.find((n) => n.kind === 'shape')!;
    const text = doc.roots.find((n) => n.kind === 'text')!;

    // Style shape
    applyIdmlShapeColor(rect, { r: 0, g: 180, b: 216 }); // #00b4d8
    applyIdmlShapeBorder(rect, { enabled: true, width: 4, color: { r: 230, g: 57, b: 70 } }); // #e63946

    // Style text
    applyIdmlText(text, {
      text: 'Phase 5 Typography Suite',
      fontSize: 24,
      fontFamily: 'Helvetica',
      bold: true,
      italic: true,
      color: { r: 155, g: 93, b: 229 }, // #9b5de5
      alignment: 'center',
    });

    // Save → Reload
    const saved = serializeDoc(doc);
    const reloaded = await importIdml('style_reload.idml', sampleBytes.slice(0), 'idml');
    applySavedDoc(reloaded, saved);

    const rText = reloaded.roots.find((n) => n.kind === 'text')!;
    const rInfo = getIdmlTextInfo(rText);
    log('scen7-reload-text-size', rInfo?.fontSize === 24, String(rInfo?.fontSize));
    log('scen7-reload-text-bold', rInfo?.bold === true, String(rInfo?.bold));
    log('scen7-reload-text-italic', rInfo?.italic === true, String(rInfo?.italic));
    log('scen7-reload-text-align', rInfo?.alignment === 'center', rInfo?.alignment ?? '');
    log('scen7-reload-text-color', rInfo?.color.r === 155 && rInfo?.color.g === 93 && rInfo?.color.b === 229, JSON.stringify(rInfo?.color));

    // Export → Re-import (export the reloaded document to verify end-to-end flow!)
    const exported = await exportIdml(reloaded);
    const z = await JSZip.loadAsync(exported);
    const graphicXml = await z.file('Resources/Graphic.xml')?.async('string');
    const colorMap = parseGraphicXmlColors(graphicXml ?? '');
    log('scen7-export-graphic-fill-swatch', Boolean(findSwatchRefByHex('#00b4d8', colorMap)), 'fill swatch in Graphic.xml');
    log('scen7-export-graphic-stroke-swatch', Boolean(findSwatchRefByHex('#e63946', colorMap)), 'stroke swatch in Graphic.xml');
    log('scen7-export-graphic-text-swatch', Boolean(findSwatchRefByHex('#9b5de5', colorMap)), 'text swatch in Graphic.xml');

    const storyXml = await z.file('Stories/Story_ud4.xml')?.async('string');
    log('scen7-export-story-pointsize', storyXml?.includes('PointSize="24"') === true, 'PointSize 24');
    log('scen7-export-story-fontstyle', storyXml?.includes('FontStyle="Bold Italic"') === true, 'Bold Italic');
    log('scen7-export-story-justification', storyXml?.includes('Justification="CenterAlign"') === true, 'CenterAlign');

    const reimported = await importIdml('style_reimport.idml', exported, 'idml');
    const riText = reimported.roots.find((n) => n.kind === 'text')!;
    const riInfo = getIdmlTextInfo(riText);
    log('scen7-reimport-text-content', riInfo?.text === 'Phase 5 Typography Suite', riInfo?.text ?? '');
    log('scen7-reimport-text-size', riInfo?.fontSize === 24, String(riInfo?.fontSize));
    log('scen7-reimport-text-bold', riInfo?.bold === true, String(riInfo?.bold));
    log('scen7-reimport-text-italic', riInfo?.italic === true, String(riInfo?.italic));
    log('scen7-reimport-text-align', riInfo?.alignment === 'center', riInfo?.alignment ?? '');

    const riRect = reimported.roots.find((n) => n.kind === 'shape')!;
    log('scen7-reimport-shape-fill', riRect.idml?.fillColor === '#00b4d8', riRect.idml?.fillColor ?? '');
    log('scen7-reimport-shape-stroke', riRect.idml?.strokeEnabled === true && riRect.idml?.strokeWeight === 4, `${riRect.idml?.strokeEnabled}, ${riRect.idml?.strokeWeight}`);
  }

  // -------------------------------------------------------------------------
  // Scenario 8: Placed Image Replace + Transform Preservation
  // -------------------------------------------------------------------------
  {
    const fixtureBytes = await buildTwoImageFixture();
    const doc = await importIdml('images.idml', fixtureBytes, 'idml');
    const fr1 = leaves(doc).find((n) => n.idml?.self === 'fr1')!;

    // Move, resize, and rotate image frame
    fr1.x += 30;
    fr1.y += 15;
    fr1.w = fr1.ow + 40;
    fr1.h = fr1.oh + 20;
    fr1.rotation = 15;

    // Replace fr1 with a new green PNG
    const newCanvas = createCanvas(8, 8);
    const g = newCanvas.getContext('2d')!;
    g.fillStyle = '#00ff00';
    g.fillRect(0, 0, 8, 8);
    await applyIdmlPlacedImageReplace(fr1, newCanvas as unknown as HTMLCanvasElement, { sourceMime: 'image/png' });

    // Save → Reload
    const saved = serializeDoc(doc);
    const reloaded = await importIdml('images_reload.idml', fixtureBytes, 'idml');
    applySavedDoc(reloaded, saved);

    const rFr1 = leaves(reloaded).find((n) => n.idml?.self === 'fr1')!;
    log('scen8-reload-image-bytes-kept', Boolean(rFr1.idml?.placedImage?.replacementBytes?.length), 'replacement bytes kept');
    log('scen8-reload-geom-kept', rFr1.x === fr1.x && rFr1.w === fr1.w && rFr1.rotation === 15, `${rFr1.x},${rFr1.w},${rFr1.rotation}`);

    // Export
    const exported = await exportIdml(doc);
    const z = await JSZip.loadAsync(exported);
    const spreadXml = await z.file('Spreads/Spread_sp1.xml')!.async('string');

    // fr1 was replaced with PNG (originally jpg), so link URI points to PNG
    log('scen8-export-link-uri-updated', spreadXml.includes('Links/img1.png'), 'link URI updated');
    const newLinkBytes = await z.file('Links/img1.png')?.async('uint8array');
    log('scen8-export-png-bytes-written', Boolean(newLinkBytes && sniffImageFormat(newLinkBytes) === 'png'), 'new PNG bytes in package');

    // Re-import
    const reimported = await importIdml('images_reimported.idml', exported, 'idml');
    const riFr1 = leaves(reimported).find((n) => n.idml?.self === 'fr1')!;
    log('scen8-reimport-raster-kind', riFr1.kind === 'raster', riFr1.kind);
    log('scen8-reimport-pos', Math.abs(riFr1.x - fr1.x) < 2 && Math.abs(riFr1.y - fr1.y) < 2, `${riFr1.x},${riFr1.y}`);
    log('scen8-reimport-rot', Math.abs(riFr1.rotation - 15) < 0.5, String(riFr1.rotation));
  }

  // -------------------------------------------------------------------------
  // Scenario 9: Multiple Placed Images with Independent Links
  // -------------------------------------------------------------------------
  {
    const fixtureBytes = await buildTwoImageFixture();
    const doc = await importIdml('two_images.idml', fixtureBytes, 'idml');
    const fr1 = leaves(doc).find((n) => n.idml?.self === 'fr1')!;
    const fr2 = leaves(doc).find((n) => n.idml?.self === 'fr2')!;

    // Replace fr1 only
    const greenCanvas = createCanvas(4, 4);
    greenCanvas.getContext('2d')!.fillStyle = '#00ff00';
    greenCanvas.getContext('2d')!.fillRect(0, 0, 4, 4);
    await applyIdmlPlacedImageReplace(fr1, greenCanvas as unknown as HTMLCanvasElement, { sourceMime: 'image/jpeg' });

    const exported = await exportIdml(doc);
    const z = await JSZip.loadAsync(exported);

    const img1Bytes = await z.file('Links/img1.jpg')?.async('uint8array');
    const img2Bytes = await z.file('Links/img2.png')?.async('uint8array');

    // img1 was replaced
    log('scen9-img1-replaced', Boolean(img1Bytes && img1Bytes[0] === 0xff), 'img1 replaced');
    // img2 was NOT replaced and must be byte-identical to original
    const origZ = await JSZip.loadAsync(fixtureBytes);
    const origImg2 = await origZ.file('Links/img2.png')?.async('uint8array');
    const img2Identical = Boolean(img2Bytes && origImg2 && img2Bytes.length === origImg2.length && img2Bytes.every((b, i) => b === origImg2[i]));
    log('scen9-img2-untouched-identical', img2Identical, 'img2 bytes completely unchanged');
  }

  // -------------------------------------------------------------------------
  // Scenario 10: Unmodified Document Byte-Identical Fidelity
  // -------------------------------------------------------------------------
  if (hasRealFixture) {
    const rawBytes = fs.readFileSync(realMagPath);
    const ab = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;

    const doc = await importIdml('mag.idml', ab.slice(0), 'indd');
    const exported = await exportIdml(doc);

    const zOrig = await JSZip.loadAsync(ab);
    const zExport = await JSZip.loadAsync(exported);

    const origFiles = Object.keys(zOrig.files).filter((k) => !zOrig.files[k].dir);
    const exportFiles = Object.keys(zExport.files).filter((k) => !zExport.files[k].dir);

    log('scen10-member-count-same', origFiles.length === exportFiles.length, `${origFiles.length} vs ${exportFiles.length}`);

    let diffCount = 0;
    for (const f of origFiles) {
      const a = await zOrig.file(f)!.async('uint8array');
      const b = await zExport.file(f)?.async('uint8array');
      if (!b || a.length !== b.length || a.some((val, idx) => val !== b[idx])) {
        diffCount++;
      }
    }
    log('scen10-byte-identical-export', diffCount === 0, `diffCount=${diffCount}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========================================`);
  console.log(`Summary: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`========================================\n`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

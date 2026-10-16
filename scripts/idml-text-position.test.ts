/**
 * IDML import: page ItemTransform + spread → canvas coordinate mapping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

import { importIdml, createSampleIdml, layoutFromPageElement, spreadToCanvas, pageItemDocPlacement } from '../src/idml';
import { parseMatrix6, apply6, rotationDegreesFromMatrix6 } from '../src/idml/matrix';
import { leaves } from '../src/model';
import { rasterizeIdmlTextNode, textGlyphsUprightInCanvas, idmlTextRasterScale } from '../src/idml/rasterText';
import { createCanvas } from '@napi-rs/canvas';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

const near = (a: number, b: number, eps = 1.5) => Math.abs(a - b) <= eps;

async function main() {
  const sample = await createSampleIdml();
  const sampleDoc = await importIdml('sample.idml', sample, 'idml');
  const sampleText = sampleDoc.roots.find((n) => n.kind === 'text');
  log('sample-text-x', sampleText?.x === 100, `x=${sampleText?.x}`);
  log('sample-text-y', sampleText?.y === 100, `y=${sampleText?.y}`);
  log('sample-doc-size', sampleDoc.width === 612 && sampleDoc.height === 792, `${sampleDoc.width}x${sampleDoc.height}`);
  log(
    'sample-spread-origin',
    sampleDoc.idml?.spreadLayout?.originX === 0 && sampleDoc.idml?.spreadLayout?.originY === 0,
    JSON.stringify(sampleDoc.idml?.spreadLayout),
  );

  const shiftedPageSpread = `<?xml version="1.0" encoding="UTF-8"?>
<Spread Self="s1">
  <Page Self="p1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 -420.944881885" />
  <TextFrame Self="tf1" ParentStory="st1" ItemTransform="1 0 0 1 250.8661417322835 -259.3700787401575">
    <Properties>
      <PathGeometry>
        <GeometryPathType PathOpen="false">
          <PathPointArray>
            <PathPointType Anchor="-116.22047244094492 -68.03149606299212" />
            <PathPointType Anchor="-116.22047244094492 68.03149606299215" />
            <PathPointType Anchor="116.22047244094489 68.03149606299215" />
            <PathPointType Anchor="116.22047244094489 -68.03149606299212" />
          </PathPointArray>
        </GeometryPathType>
      </PathGeometry>
    </Properties>
  </TextFrame>
</Spread>`;
  const shiftedStory = `<?xml version="1.0"?><Story Self="st1"><CharacterStyleRange><Content>Text</Content></CharacterStyleRange></Story>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE' });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document><idPkg:Spread src="Spreads/Spread_s1.xml"/></Document>');
  zip.file('Spreads/Spread_s1.xml', shiftedPageSpread);
  zip.file('Stories/Story_st1.xml', shiftedStory);
  const { writeIdmlPackage } = await import('../src/idml/zip');
  const shiftedBytes = await writeIdmlPackage(zip);

  const shiftedDoc = await importIdml('shifted.idml', shiftedBytes, 'idml');
  const text = leaves(shiftedDoc).find((n) => n.kind === 'text');
  log(
    'shifted-page-origin-y',
    near(shiftedDoc.idml?.spreadLayout?.originY ?? 0, -420.944881885),
    String(shiftedDoc.idml?.spreadLayout?.originY),
  );
  log('shifted-text-x', near(text?.x ?? 0, 134.646), `x=${text?.x} (was ~135 spread-only)`);
  log('shifted-text-y', near(text?.y ?? 0, 93.544), `y=${text?.y} (before fix ~-327)`);
  log('shifted-text-w', near(text?.w ?? 0, 233), `w=${text?.w}`);
  log('shifted-text-h', near(text?.h ?? 0, 137), `h=${text?.h}`);

  const pageDoc = new window.DOMParser().parseFromString(
    `<Page GeometricBounds="0 0 841.88976377 595.27559055" ItemTransform="1 0 0 1 0 -420.944881885" />`,
    'application/xml',
  ).documentElement;
  const pageLayout = layoutFromPageElement(pageDoc);
  log('layout-from-page-a4-height', near(pageLayout.height, 841.88976377), String(pageLayout.height));
  log('layout-from-page-a4-width', near(pageLayout.width, 595.27559055), String(pageLayout.width));

  const pocPath = path.join('artifacts', 'poc', 'poc-b', 'step1-exported.idml');
  if (fs.existsSync(pocPath)) {
    const pocBuf = fs.readFileSync(pocPath);
    const pocDoc = await importIdml('poc.idml', pocBuf.buffer.slice(pocBuf.byteOffset, pocBuf.byteOffset + pocBuf.byteLength));
    const pocText = leaves(pocDoc).find((n) => n.kind === 'text');
    log('poc-text-y-positive', (pocText?.y ?? -999) > 0, `y=${pocText?.y}`);
    log('poc-text-y-expected', near(pocText?.y ?? 0, 93.544), `y=${pocText?.y}`);
    log('poc-not-negative-spread-y', (pocText?.y ?? 0) > -200, 'page-relative Y');
  } else {
    log('poc-fixture-skipped', true, 'no step1-exported.idml');
  }

  const m = parseMatrix6('1 0 0 1 250.8661417322835 -259.3700787401575');
  const [sx, sy] = apply6(m, -116.22047244094492, -68.03149606299212);
  const [cx, cy] = spreadToCanvas(sx, sy, { originX: 0, originY: -420.944881885, offsetY: 0 });
  log('manual-corner-canvas-y', near(cy, 93.544), `cy=${cy}`);

  const itemM = parseMatrix6('1 0 0 1 250.8661417322835 -259.3700787401575');
  log('item-rotation-deg', Math.abs(rotationDegreesFromMatrix6(itemM)) < 0.01, String(rotationDegreesFromMatrix6(itemM)));

  const rotM = parseMatrix6('0 1 -1 0 200 300');
  log('rotated-matrix-90deg', near(rotationDegreesFromMatrix6(rotM), 90), String(rotationDegreesFromMatrix6(rotM)));

  const pathPts = [
    { anchor: [-50, -30] as [number, number] },
    { anchor: [-50, 30] as [number, number] },
    { anchor: [50, 30] as [number, number] },
    { anchor: [50, -30] as [number, number] },
  ];
  const rotPlace = pageItemDocPlacement(pathPts, rotM, { originX: 0, originY: 0, offsetY: 0 });
  log('rotated-placement-angle', near(rotPlace.rotation, 90), String(rotPlace.rotation));
  log('rotated-local-w', near(rotPlace.w, 100), `w=${rotPlace.w}`);

  if (text) {
    text.canvas = createCanvas(text.w, text.h) as unknown as HTMLCanvasElement;
    rasterizeIdmlTextNode(text);
    log('shifted-glyphs-upright', textGlyphsUprightInCanvas(text.canvas), 'centroid in upper half');
    log('shifted-raster-scale', idmlTextRasterScale() >= 1, String(idmlTextRasterScale()));
    log('shifted-canvas-pixels', text.canvas.width >= text.w, `${text.canvas.width}x${text.canvas.height}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Cross-format color editing: shared gates, shape fill, text color, export smoke checks.
 */
import fs from 'node:fs';
import { register } from 'node:module';
import { Window } from 'happy-dom';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd } from 'ag-psd';
import { importPsd, exportPsd, createSamplePsd } from '../src/psd/psd';
import JSZip from 'jszip';
import { importIdml, exportIdml, createSampleIdml } from '../src/indd/idml';
import { readPageItemAttribute } from '../src/indd/exportPatch';
import { parseGraphicXmlColors, resolveSwatchRef } from '../src/indd/swatches';
import {
  applyShapeColor,
  applyShapeBorder,
  applyText,
  getShapeColor,
  getTextInfo,
  shapeColorBlockReason,
} from '../src/operations/edit';
import { applyIdmlShapeColor, applyIdmlText } from '../src/indd/idmlEdit';
import { applyAiVectorShapeImport, readFirstPageContentStreamText, pdfRgbFillToken } from '../src/ai/aiVectorShapes';
import { leaves } from '../src/core/model';
import type { Doc } from '../src/core/model';

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const psdDoc = await importPsd('sample.psd', createSamplePsd());
  const badge = leaves(psdDoc).find((n) => n.name === 'Purple badge')!;
  log('psd-vector-fill-layer', badge.kind === 'raster' && Boolean(badge.src.vectorFill), `kind=${badge.kind}`);
  log('psd-shape-not-blocked', shapeColorBlockReason(badge) === null, shapeColorBlockReason(badge) ?? 'ok');
  applyShapeColor(badge, { r: 200, g: 50, b: 50 });
  log('psd-shape-fill-updated', getShapeColor(badge)?.r === 200, String(getShapeColor(badge)?.r));
  const psdOut = exportPsd(psdDoc);
  const psdRound = readPsd(psdOut);
  const flat = (ls: typeof psdRound.children): any[] => {
    const o: any[] = [];
    for (const l of ls ?? []) {
      o.push(l);
      if (l.children) o.push(...flat(l.children));
    }
    return o;
  };
  const badgeLayer = flat(psdRound.children).find((l) => l.name === 'Purple badge');
  const exportedFill = badgeLayer?.vectorFill?.color;
  log(
    'psd-export-vector-fill',
    exportedFill?.r === 200 && exportedFill?.g === 50,
    exportedFill ? `${exportedFill.r},${exportedFill.g}` : 'missing',
  );

  const title = leaves(psdDoc).find((n) => n.name === 'Title')!;
  applyText(title, { color: { r: 255, g: 128, b: 0 } });
  log('psd-text-color-model', getTextInfo(title)?.color.r === 255, String(getTextInfo(title)?.color.r));
  const psdTextOut = exportPsd(psdDoc);
  const psdTextRound = readPsd(psdTextOut);
  const titleLayer = flat(psdTextRound.children).find((l) => l.name === 'Title');
  const exportedTextFill =
    titleLayer?.text?.style?.fillColor ??
    titleLayer?.text?.styleRuns?.[0]?.style?.fillColor;
  log(
    'psd-export-text-fillColor',
    Math.round(exportedTextFill?.r ?? 0) === 255 && Math.round(exportedTextFill?.g ?? 0) === 128,
    exportedTextFill ? `${exportedTextFill.r},${exportedTextFill.g}` : 'missing',
  );
  const psdTextReDoc = await importPsd('psd-text-rt.psd', psdTextOut);
  const titleRe = leaves(psdTextReDoc).find((n) => n.name === 'Title')!;
  log(
    'psd-reimport-text-color',
    getTextInfo(titleRe)?.color.r === 255 && getTextInfo(titleRe)?.color.g === 128,
    `${getTextInfo(titleRe)?.color.r},${getTextInfo(titleRe)?.color.g}`,
  );
  const badgeRe = leaves(psdTextReDoc).find((n) => n.name === 'Purple badge')!;
  log(
    'psd-reimport-vector-fill',
    getShapeColor(badgeRe)?.r === 200,
    String(getShapeColor(badgeRe)?.r),
  );

  const aiPath = 'public/fixtures/ai/simple-shapes.ai';
  const aiBuf = fs.readFileSync(aiPath);
  const aiAb = aiBuf.buffer.slice(aiBuf.byteOffset, aiBuf.byteOffset + aiBuf.byteLength);
  const aiDoc: Doc = {
    id: 'ai',
    name: 'simple-shapes.ai',
    format: 'ai',
    width: 400,
    height: 300,
    offsetX: 0,
    offsetY: 0,
    roots: [],
    original: aiAb.slice(0),
    warnings: [],
    ai: { kind: 'ai', pageCount: 1, hasOcg: false, ocgNames: [], ocgRefs: [], hasExtGStateOpacity: true, extGStateCaAtImport: 1 },
  };
  await applyAiVectorShapeImport(aiDoc);
  const aiShape = aiDoc.roots.find((n) => n.kind === 'shape')!;
  log('ai-shape-not-blocked', shapeColorBlockReason(aiShape) === null, 'ok');
  applyShapeColor(aiShape, { r: 10, g: 200, b: 30 });
  applyShapeBorder(aiShape, { enabled: true, width: 3, color: { r: 200, g: 0, b: 100 } });
  const { exportAi } = await import('../src/ai/ai');
  const aiOut = await exportAi(aiDoc);
  const stream = await readFirstPageContentStreamText(aiOut);
  log('ai-export-fill-token', Boolean(stream?.text.includes(pdfRgbFillToken(10, 200, 30))), pdfRgbFillToken(10, 200, 30));
  log(
    'ai-export-stroke-token',
    Boolean(stream?.text.includes('0.784 0.000 0.392 RG')),
    stream?.text.match(/[\d.]+\s+[\d.]+\s+[\d.]+\s+RG/)?.[0] ?? 'no RG',
  );

  const idmlDoc = await importIdml('sample.idml', await createSampleIdml(), 'idml');
  const idmlRect = idmlDoc.roots.find((n) => n.kind === 'shape')!;
  const idmlText = idmlDoc.roots.find((n) => n.kind === 'text')!;
  log('idml-shape-not-blocked', shapeColorBlockReason(idmlRect) === null, 'ok');
  applyIdmlShapeColor(idmlRect, { r: 0, g: 180, b: 180 });
  applyIdmlText(idmlText, { color: { r: 255, g: 0, b: 128 } });
  const idmlOut = await exportIdml(idmlDoc);
  log('idml-export-bytes', idmlOut.byteLength > 500, String(idmlOut.byteLength));
  const idmlZip = await JSZip.loadAsync(idmlOut);
  const idmlSpread = await idmlZip.file('Spreads/Spread_ud3.xml')!.async('string');
  const idmlFillRef = readPageItemAttribute(idmlSpread, 'uf4', 'FillColor');
  const idmlGraphic = await idmlZip.file('Resources/Graphic.xml')!.async('string');
  const idmlColors = parseGraphicXmlColors(idmlGraphic);
  log(
    'idml-export-shape-fill',
    resolveSwatchRef(idmlFillRef, idmlColors)?.toLowerCase() === '#00b4b4',
    resolveSwatchRef(idmlFillRef, idmlColors) ?? '',
  );
  const idmlStory = await idmlZip.file('Stories/Story_ud4.xml')!.async('string');
  log('idml-export-text-fill', /FillColor="Color\//.test(idmlStory), 'story swatch');

  const strokeOnly = leaves(psdDoc).find((n) => n.name === 'Green circle');
  if (strokeOnly) {
    log('psd-raster-not-shape', shapeColorBlockReason(strokeOnly) === null, strokeOnly.kind);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

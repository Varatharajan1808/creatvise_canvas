/**
 * IDML export: leaf transforms, story content/line breaks, multi-page structure preserved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml, createSampleIdml } from '../src/idml';
import { applyIdmlText, applyIdmlShapeColor } from '../src/idmlEdit';
import { leaves } from '../src/model';
import {
  readPageItemAttribute,
  encodeIdmlStoryContent,
  validateIdmlPackageStructure,
} from '../src/idml/exportPatch';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  log('encode-line-break', encodeIdmlStoryContent('a\nb').includes('\u2028'), 'u2028');

  const sampleBytes = await createSampleIdml();
  let doc = await importIdml('sample.idml', sampleBytes, 'idml');
  const text = doc.roots.find((n) => n.kind === 'text')!;
  const rect = doc.roots.find((n) => n.kind === 'shape')!;
  const spreadBefore = await (await JSZip.loadAsync(sampleBytes)).file('Spreads/Spread_ud3.xml')!.async('string');
  const tfBefore = readPageItemAttribute(spreadBefore, 'uf3', 'ItemTransform')!;

  text.x += 30;
  text.y += 12;
  applyIdmlText(text, { text: 'Edited sample line one\nline two', fontSize: 14 });

  rect.x += 5;
  rect.y -= 3;
  applyIdmlShapeColor(rect, { r: 255, g: 0, b: 0 });

  const exported = await exportIdml(doc);
  const zip = await JSZip.loadAsync(exported);
  const spreadAfter = await zip.file('Spreads/Spread_ud3.xml')!.async('string');
  const tfAfter = readPageItemAttribute(spreadAfter, 'uf3', 'ItemTransform')!;
  const beforeParts = tfBefore.split(/\s+/).map(Number);
  const afterParts = tfAfter.split(/\s+/).map(Number);
  log(
    'sample-text-transform-tx',
    Math.abs(afterParts[4] - (beforeParts[4] + 30)) < 0.02,
    `${beforeParts[4]} -> ${afterParts[4]}`,
  );
  log(
    'sample-text-transform-ty',
    Math.abs(afterParts[5] - (beforeParts[5] + 12)) < 0.02,
    `${beforeParts[5]} -> ${afterParts[5]}`,
  );

  const storyAfter = await zip.file('Stories/Story_ud4.xml')!.async('string');
  log('sample-story-edited', storyAfter.includes('Edited sample line one'), 'content');
  log('sample-story-line-break', storyAfter.includes('\u2028'), 'u2028');
  log('sample-story-font', /PointSize="14"/.test(storyAfter), '14pt');
  const rectFill = readPageItemAttribute(spreadAfter, 'uf4', 'FillColor');
  log('sample-shape-fill-exported', Boolean(rectFill?.startsWith('Color/')), rectFill ?? '');

  const doc2 = await importIdml('re.idml', exported, 'idml');
  const text2 = doc2.roots.find((n) => n.kind === 'text')!;
  log('sample-roundtrip-text', text2.src?.text?.text?.includes('Edited sample'), text2.src?.text?.text ?? '');
  log(
    'sample-roundtrip-pos',
    Math.abs(text2.x - text.x) < 3 && Math.abs(text2.y - text.y) < 3,
    `${text2.x},${text2.y}`,
  );
  const rect2 = doc2.roots.find((n) => n.kind === 'shape')!;
  log('sample-roundtrip-shape-fill', rect2.idml?.fillColor === '#ff0000', rect2.idml?.fillColor ?? '');

  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (fs.existsSync(idmlPath)) {
    const buf = fs.readFileSync(idmlPath);
    doc = await importIdml(
      'magazine.idml',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      'indd',
    );
    log('magazine-import-pages', doc.idml?.pages?.length === 5, String(doc.idml?.pages?.length));

    const u202 = leaves(doc).find((n) => n.idml?.self === 'u202');
    const u1fd = leaves(doc).find((n) => n.idml?.self === 'u1fd');
    const page2Y = doc.idml?.pages?.[1]?.docY ?? 0;
    if (u202) {
      const ox = u202.x;
      u202.x += 20;
      u202.y += 10;
      const spreadPath = u202.idml!.spreadPath!;
      const spreadXmlBefore = await (await JSZip.loadAsync(buf)).file(spreadPath)!.async('string');
      const mBefore = readPageItemAttribute(spreadXmlBefore, 'u202', 'ItemTransform')!;
      const exportedMag = await exportIdml(doc);
      const z2 = await JSZip.loadAsync(exportedMag);
      const names = Object.keys(z2.files);
      const struct = validateIdmlPackageStructure(names, doc.idml?.designmapXml);
      log('magazine-export-5-pages', struct.pageCount === 5, String(struct.pageCount));
      log('magazine-export-spreads', struct.spreadCount === 3, String(struct.spreadCount));
      const spreadAfterMag = await z2.file(spreadPath)!.async('string');
      const mAfter = readPageItemAttribute(spreadAfterMag, 'u202', 'ItemTransform')!;
      const mb = mBefore.split(/\s+/).map(Number);
      const ma = mAfter.split(/\s+/).map(Number);
      log('magazine-u202-moved', Math.abs(ma[4] - mb[4] - 20) < 0.05, `${mb[4]} -> ${ma[4]}`);
      u202.x = ox;
    }
    if (u1fd) {
      applyIdmlText(u1fd, { text: 'Magazine Export Test', fontSize: 60 });
      const exportedMag = await exportIdml(doc);
      const z2 = await JSZip.loadAsync(exportedMag);
      const story = await z2.file(`Stories/Story_${u1fd.idml!.storyId}.xml`)!.async('string');
      log('magazine-story-patch', story.includes('Magazine Export Test'), 'ok');
    }
    log('magazine-page2-unchanged-y', page2Y > 800, String(page2Y));
  } else {
    log('magazine-fixture', false, 'skipped — missing fixture');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * IDML round-trip: import → mutate → export → re-import → verify structural consistency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';

// Provide DOM environment for idml module
const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

import { importIdml, exportIdml, createSampleIdml } from '../src/indd/idml';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  // 1. Generate a sample IDML in-memory
  const sampleBytes = await createSampleIdml();
  log('create-sample', sampleBytes.byteLength > 0, `${sampleBytes.byteLength} bytes`);

  // 2. Verify ZIP structure
  const zip1 = await JSZip.loadAsync(sampleBytes);
  const mimeEntry = zip1.file('mimetype');
  log('has-mimetype', mimeEntry !== null, mimeEntry ? 'present' : 'missing');

  if (mimeEntry) {
    const mimeStr = await mimeEntry.async('string');
    log('mimetype-correct', mimeStr.trim() === 'application/vnd.adobe.indesign-idml-package',
      mimeStr.trim());
  }

  const hasDesignmap = zip1.file('designmap.xml') !== null;
  log('has-designmap', hasDesignmap, hasDesignmap ? 'present' : 'missing');

  const spreadFiles = Object.keys(zip1.files).filter(f => f.startsWith('Spreads/') && f.endsWith('.xml'));
  log('has-spreads', spreadFiles.length > 0, `${spreadFiles.length} spread(s)`);

  const storyFiles = Object.keys(zip1.files).filter(f => f.startsWith('Stories/') && f.endsWith('.xml'));
  log('has-stories', storyFiles.length > 0, `${storyFiles.length} story/stories`);

  // 3. Import
  const doc = await importIdml('sample.idml', sampleBytes, 'idml');
  log('import-name', doc.name === 'sample.idml', doc.name);
  log('import-format', doc.format === 'indd', doc.format);
  log('import-origin', doc.origin === 'idml', String(doc.origin));
  log('import-has-roots', doc.roots.length > 0, `${doc.roots.length} root(s)`);
  log('import-dimensions', doc.width > 0 && doc.height > 0, `${doc.width}x${doc.height}`);

  // 4. Mutate — move first node
  if (doc.roots.length > 0) {
    const node = doc.roots[0];
    const origX = node.x;
    const origY = node.y;
    node.x += 25;
    node.y += 10;
    log('mutate-position', node.x === origX + 25 && node.y === origY + 10,
      `(${origX},${origY}) → (${node.x},${node.y})`);
  }

  // 5. Export
  const exported = await exportIdml(doc);
  log('export-bytes', exported.byteLength > 0, `${exported.byteLength} bytes`);

  // 6. Verify exported ZIP structure
  const zip2 = await JSZip.loadAsync(exported);
  const exportedMime = zip2.file('mimetype');
  log('export-has-mimetype', exportedMime !== null, exportedMime ? 'present' : 'missing');

  const exportedSpreads = Object.keys(zip2.files).filter(f => f.startsWith('Spreads/') && f.endsWith('.xml'));
  log('export-has-spreads', exportedSpreads.length > 0, `${exportedSpreads.length} spread(s)`);

  // 7. Re-import
  const doc2 = await importIdml('sample-re.idml', exported, 'idml');
  log('reimport-has-roots', doc2.roots.length > 0, `${doc2.roots.length} root(s)`);
  log('reimport-root-count-match', doc2.roots.length === doc.roots.length,
    `original=${doc.roots.length} reimport=${doc2.roots.length}`);

  // 8. Verify position survived roundtrip (within tolerance)
  if (doc.roots.length > 0 && doc2.roots.length > 0) {
    const n1 = doc.roots[0];
    const n2 = doc2.roots[0];
    // The re-imported position should reflect the mutation
    const positionOk = Math.abs(n2.x - n1.x) < 2 && Math.abs(n2.y - n1.y) < 2;
    log('roundtrip-position', positionOk,
      `mutated=(${n1.x},${n1.y}) reimported=(${n2.x},${n2.y})`);
  }

  // 9. Same format
  log('reimport-format', doc2.format === 'indd', doc2.format);
  log('reimport-dimensions', doc2.width === doc.width && doc2.height === doc.height,
    `${doc2.width}x${doc2.height}`);

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

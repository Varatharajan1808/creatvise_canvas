/**
 * IDML smoke tests: verify createSampleIdml produces a valid package,
 * importIdml loads it successfully, and basic node properties are correct.
 */
import { Window } from 'happy-dom';
import JSZip from 'jszip';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

import { importIdml, createSampleIdml, childByLocal, elementsLocalCI } from '../src/indd/idml';
import { IDML_MIMETYPE } from '../src/indd/zip';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  // createSampleIdml
  const bytes = await createSampleIdml();
  log('sample-nonzero', bytes.byteLength > 100, `${bytes.byteLength} bytes`);

  // ZIP magic bytes
  const u8 = new Uint8Array(bytes);
  log('zip-magic', u8[0] === 0x50 && u8[1] === 0x4b, `0x${u8[0].toString(16)}${u8[1].toString(16)}`);

  // Load and verify mimetype
  const zip = await JSZip.loadAsync(bytes);
  const mime = await zip.file('mimetype')?.async('string');
  log('mimetype-value', mime?.trim() === IDML_MIMETYPE, String(mime?.trim()));

  // Verify designmap.xml exists and has Document root
  const dm = await zip.file('designmap.xml')?.async('string');
  log('designmap-exists', !!dm, dm ? 'present' : 'missing');
  log('designmap-document-root', !!dm?.includes('<Document'), dm ? 'has <Document' : 'missing');

  // Verify at least one spread references a story
  const spreads = Object.keys(zip.files).filter(f => f.startsWith('Spreads/'));
  log('spread-count', spreads.length > 0, `${spreads.length}`);

  const stories = Object.keys(zip.files).filter(f => f.startsWith('Stories/'));
  log('story-count', stories.length > 0, `${stories.length}`);

  // Import and check document structure
  const doc = await importIdml('smoke.idml', bytes, 'idml');

  log('doc-format', doc.format === 'indd', doc.format);
  log('doc-origin', doc.origin === 'idml', String(doc.origin));
  log('doc-width-positive', doc.width > 0, `${doc.width}`);
  log('doc-height-positive', doc.height > 0, `${doc.height}`);
  log('doc-has-roots', doc.roots.length >= 1, `${doc.roots.length} root(s)`);
  log('doc-has-backing', !!doc.idml, doc.idml ? 'present' : 'missing');

  // Check the sample has expected element types
  const kinds = doc.roots.map(n => n.kind);
  const hasText = kinds.includes('text');
  const hasShape = kinds.includes('shape');
  log('root-has-text', hasText, kinds.join(', '));
  log('root-has-shape', hasShape, kinds.join(', '));

  // Check text node has content from story
  const textNode = doc.roots.find(n => n.kind === 'text');
  if (textNode) {
    log('text-has-name', textNode.name.length > 0, textNode.name);
    log('text-has-canvas', textNode.canvas !== null, textNode.canvas ? 'yes' : 'null');
    log('text-has-idml-meta', !!textNode.idml, textNode.idml ? 'yes' : 'no');
  }

  // Check shape node
  const shapeNode = doc.roots.find(n => n.kind === 'shape');
  if (shapeNode) {
    log('shape-has-name', shapeNode.name.length > 0, shapeNode.name);
    log('shape-dimensions', shapeNode.w > 0 && shapeNode.h > 0, `${shapeNode.w}x${shapeNode.h}`);
  }

  // Check IDML backing data
  if (doc.idml) {
    log('backing-kind', doc.idml.kind === 'idml', doc.idml.kind);
    log('backing-rawZipBytes', doc.idml.rawZipBytes.byteLength > 0, `${doc.idml.rawZipBytes.byteLength}`);
    log('backing-spreads', doc.idml.spreads.length > 0, `${doc.idml.spreads.length}`);
    log('backing-pages', doc.idml.pages.length > 0, `${doc.idml.pages.length}`);
  }

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

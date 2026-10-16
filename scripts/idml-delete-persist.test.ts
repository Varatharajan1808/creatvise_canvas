/**
 * IDML layer delete: workspace restore omits deleted shapes; export prunes spread XML.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { importIdml, exportIdml, createSampleIdml } from '../src/idml';
import { readPageItemAttribute } from '../src/idml/exportPatch';
import { serializeDoc, applySavedDoc } from '../src/workspace';
import { leaves } from '../src/model';
import { sourceRemove } from '../src/sourceTree';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
(globalThis as unknown as { XMLSerializer: typeof XMLSerializer }).XMLSerializer =
  window.XMLSerializer as unknown as typeof XMLSerializer;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function deleteFromModel(doc: Awaited<ReturnType<typeof importIdml>>, node: (typeof doc.roots)[0]) {
  const list = node.parent ? node.parent.children : doc.roots;
  list.splice(list.indexOf(node), 1);
  sourceRemove(doc, node);
}

async function main() {
  const sample = await createSampleIdml();
  let doc = await importIdml('sample.idml', sample, 'idml');
  const rect = doc.roots.find((n) => n.kind === 'shape')!;
  const rectSelf = rect.idml!.self;
  deleteFromModel(doc, rect);
  const saved = serializeDoc(doc);
  log('serialize-omits-deleted', !saved.nodes.some((n) => n.key === rectSelf), rectSelf);

  const reloaded = await importIdml('sample.idml', sample.slice(0), 'idml');
  applySavedDoc(reloaded, saved);
  log(
    'reload-omits-deleted',
    !leaves(reloaded).some((n) => n.idml?.self === rectSelf),
    String(leaves(reloaded).length),
  );
  log(
    'reload-keeps-text',
    leaves(reloaded).some((n) => n.kind === 'text'),
    leaves(reloaded)
      .filter((n) => n.kind === 'text')
      .map((n) => n.idml?.self)
      .join(','),
  );

  doc = await importIdml('sample2.idml', sample.slice(0), 'idml');
  const rect2 = doc.roots.find((n) => n.kind === 'shape')!;
  deleteFromModel(doc, rect2);
  const out = await exportIdml(doc);
  const spread = await JSZip.loadAsync(out).then((z) => z.file('Spreads/Spread_ud3.xml')!.async('string'));
  log('export-spread-no-deleted-rect', readPageItemAttribute(spread, rect2.idml!.self, 'FillColor') === null, rect2.idml!.self);
  log('export-spread-text-kept', readPageItemAttribute(spread, 'uf3', 'ItemTransform') !== null, 'uf3');

  const magPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (fs.existsSync(magPath)) {
    const buf = fs.readFileSync(magPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const mag = await importIdml('mag.idml', ab, 'idml');
    const before = leaves(mag).length;
    const victim = leaves(mag).find((n) => n.kind === 'shape' && n.idml?.self)!;
    const vSelf = victim.idml!.self;
    deleteFromModel(mag, victim);
    const magSaved = serializeDoc(mag);
    const magReload = await importIdml('mag2.idml', ab.slice(0), 'idml');
    applySavedDoc(magReload, magSaved);
    log('magazine-reload-count', leaves(magReload).length === before - 1, `${before - 1} vs ${leaves(magReload).length}`);
    log('magazine-victim-gone', !leaves(magReload).some((n) => n.idml?.self === vSelf), vSelf);
  } else {
    log('magazine-fixture', true, 'skipped');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

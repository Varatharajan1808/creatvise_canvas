/**
 * Multi-page IDML: all designmap spreads/pages imported with vertical doc stacking.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { importIdml } from '../src/indd/idml';
import { leaves } from '../src/core/model';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const near = (a: number, b: number, eps = 2) => Math.abs(a - b) <= eps;
const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function main() {
  const sample = await importIdml('sample.idml', await (await import('../src/indd/idml')).createSampleIdml(), 'idml');
  log('sample-single-page', (sample.idml?.pages?.length ?? 0) === 1, String(sample.idml?.pages?.length));

  const idmlPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (!fs.existsSync(idmlPath)) {
    log('magazine-fixture', false, 'missing');
    process.exit(1);
  }
  const buf = fs.readFileSync(idmlPath);
  const doc = await importIdml(
    'magazine.idml',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    'indd',
  );
  log('magazine-page-count', doc.idml?.pages?.length === 5, String(doc.idml?.pages?.length));
  log('magazine-doc-height', near(doc.height, 841.89 * 5, 5), String(doc.height));
  log('magazine-spread-count', (doc.idml?.spreads?.length ?? 0) === 3, String(doc.idml?.spreads?.length));

  const page5Y = doc.idml?.pages?.[4]?.docY ?? 0;
  log('page5-docY', near(page5Y, 841.89 * 4, 5), String(page5Y));

  const uad5 = leaves(doc).find((n) => n.idml?.self === 'uad5');
  log('uad5-on-page5', uad5?.idml?.pageIndex === 5, `pageIndex=${uad5?.idml?.pageIndex} y=${uad5?.y}`);
  log('uad5-on-page5-stack', (uad5?.y ?? 0) >= page5Y - 15, `y=${uad5?.y} page5Y=${page5Y}`);

  const u1fd = leaves(doc).find((n) => n.idml?.self === 'u1fd');
  log('u1fd-on-page1', u1fd?.idml?.pageIndex === 1, String(u1fd?.idml?.pageIndex));
  log('u1fd-near-top', near(u1fd?.y ?? 0, 223, 3), String(u1fd?.y));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

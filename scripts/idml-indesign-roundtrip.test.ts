/**
 * When InDesign is available: INDD → Canvas export IDML → INDD must preserve spread/page item counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { discoverIndesign } from '../server/indesignDiscover.mjs';
import { runConversion } from '../server/indesignRunner.mjs';
import { importIdml, exportIdml } from '../src/idml';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function layoutStats(idmlBuf: ArrayBuffer) {
  const z = await JSZip.loadAsync(idmlBuf);
  const dm = await z.file('designmap.xml')?.async('string');
  const len = Number(dm?.match(/Length="(\d+)"/)?.[1] ?? 0);
  let rects = 0;
  let tfs = 0;
  let pages = 0;
  for (const p of Object.keys(z.files).filter((k) => k.startsWith('Spreads/') && !z.files[k].dir)) {
    const s = await z.file(p)!.async('string');
    rects += (s.match(/<Rectangle\b/g) || []).length;
    tfs += (s.match(/<TextFrame\b/g) || []).length;
    pages += (s.match(/<Page\b/g) || []).length;
  }
  const dirs = Object.keys(z.files).filter((k) => z.files[k].dir);
  return { len, pages, rects, tfs, dirs: dirs.length };
}

async function main() {
  const install = discoverIndesign();
  const inddPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.indd');
  if (!install.canConvert || !fs.existsSync(inddPath) || (process.platform === 'win32' && !install.comAvailable)) {
    log('indesign-roundtrip', true, 'skipped — InDesign COM or fixture unavailable');
    return;
  }

  const indd = fs.readFileSync(inddPath);
  const idmlFromIndd = await runConversion('indd-to-idml', indd);
  const before = await layoutStats(idmlFromIndd);
  log('indesign-roundtrip-baseline-pages', before.len === 5 && before.pages === 5, JSON.stringify(before));

  const doc = await importIdml(
    'magazine.idml',
    idmlFromIndd.slice(0),
    'indd',
  );
  const exported = await exportIdml(doc);
  const afterExport = await layoutStats(exported);
  log('canvas-export-no-zip-dirs', afterExport.dirs === 0, String(afterExport.dirs));
  log(
    'canvas-export-layout',
    afterExport.len === before.len &&
      afterExport.pages === before.pages &&
      afterExport.rects === before.rects &&
      afterExport.tfs === before.tfs,
    JSON.stringify(afterExport),
  );

  const inddOut = await runConversion('idml-to-indd', exported);
  log('idml-to-indd-bytes', inddOut.byteLength > 100_000, String(inddOut.byteLength));

  const idmlRound = await runConversion('indd-to-idml', inddOut);
  const round = await layoutStats(idmlRound);
  log(
    'indesign-reexport-layout',
    round.len === before.len &&
      round.pages === before.pages &&
      round.rects === before.rects &&
      round.tfs === before.tfs,
    JSON.stringify(round),
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

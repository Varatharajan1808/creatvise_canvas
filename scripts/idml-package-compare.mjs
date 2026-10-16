/**
 * Deep diff of two IDML packages: zip members, page items (Self, ContentType, transforms, links).
 * Usage: npx tsx scripts/idml-package-compare.mjs original.idml exported.idml
 */
import fs from 'fs';
import JSZip from 'jszip';

function extractPageItems(spreadXml, spreadPath) {
  const items = [];
  const re =
    /<(TextFrame|Rectangle|Oval|Polygon|Image|EPS|PDF|Group)\b([^>]*)>([\s\S]*?)(?=<\/\1>|\/>\s*)/gi;
  let m;
  while ((m = re.exec(spreadXml))) {
    const tag = m[1];
    const attrs = m[2];
    const body = m[3];
    const self = attrs.match(/\bSelf="([^"]+)"/)?.[1] ?? '?';
    const ct = attrs.match(/\bContentType="([^"]+)"/)?.[1];
    const tf = attrs.match(/\bItemTransform="([^"]+)"/)?.[1];
    const fill = attrs.match(/\bFillColor="([^"]+)"/)?.[1];
    const links = [...body.matchAll(/\bLinkResourceURI="([^"]+)"/g)].map((x) => x[1]);
    const images = (body.match(/<Image\b/g) || []).length;
    items.push({ spreadPath, tag, self, ct, tf, fill, links, nestedImages: images });
  }
  return items;
}

async function analyze(path) {
  const z = await JSZip.loadAsync(fs.readFileSync(path));
  const names = Object.keys(z.files).filter((n) => !z.files[n].dir).sort();
  const dirs = Object.keys(z.files).filter((n) => z.files[n].dir);
  const links = names.filter((n) => n.startsWith('Links/'));
  const items = [];
  for (const p of names.filter((n) => n.startsWith('Spreads/') || n.startsWith('MasterSpreads/'))) {
    const xml = await z.file(p).async('string');
    items.push(...extractPageItems(xml, p));
  }
  return { path, names, dirs, links, items };
}

function itemKey(it) {
  return `${it.spreadPath}::${it.self}`;
}

const aPath = process.argv[2];
const bPath = process.argv[3];
if (!aPath || !bPath) {
  console.error('Usage: idml-package-compare.mjs <original> <exported>');
  process.exit(2);
}

const a = await analyze(aPath);
const b = await analyze(bPath);

console.log('\n=== Package ===');
console.log('A', a.path, 'files', a.names.length, 'dirs', a.dirs.length, 'Links/', a.links.length);
console.log('B', b.path, 'files', b.names.length, 'dirs', b.dirs.length, 'Links/', b.links.length);

const missingInB = a.names.filter((n) => !b.names.includes(n));
const extraInB = b.names.filter((n) => !a.names.includes(n));
const changedFiles = [];
for (const n of a.names) {
  if (!b.names.includes(n)) continue;
  const za = await JSZip.loadAsync(fs.readFileSync(aPath));
  const zb = await JSZip.loadAsync(fs.readFileSync(bPath));
  const ba = await za.file(n).async('uint8array');
  const bb = await zb.file(n).async('uint8array');
  if (ba.length !== bb.length || ba.some((v, i) => v !== bb[i])) changedFiles.push(n);
}
console.log('missing in B', missingInB.length, missingInB.slice(0, 10));
console.log('extra in B', extraInB.length, extraInB.slice(0, 10));
console.log('changed members', changedFiles.length, changedFiles.slice(0, 15));

const mapA = new Map(a.items.map((it) => [itemKey(it), it]));
const mapB = new Map(b.items.map((it) => [itemKey(it), it]));
const itemDiffs = [];
for (const [k, ia] of mapA) {
  const ib = mapB.get(k);
  if (!ib) {
    itemDiffs.push({ self: k, kind: 'missing-in-B', ia });
    continue;
  }
  const fields = ['tag', 'ct', 'tf', 'fill'];
  for (const f of fields) {
    if (ia[f] !== ib[f]) itemDiffs.push({ self: k, field: f, a: ia[f], b: ib[f] });
  }
  if (ia.links.join('|') !== ib.links.join('|')) {
    itemDiffs.push({ self: k, field: 'links', a: ia.links, b: ib.links });
  }
  if (ia.nestedImages !== ib.nestedImages) {
    itemDiffs.push({ self: k, field: 'nestedImages', a: ia.nestedImages, b: ib.nestedImages });
  }
}
for (const k of mapB.keys()) {
  if (!mapA.has(k)) itemDiffs.push({ self: k, kind: 'extra-in-B' });
}

console.log('\n=== Page items ===');
console.log('A items', a.items.length, 'B items', b.items.length, 'diffs', itemDiffs.length);
const graphicA = a.items.filter((i) => i.ct === 'GraphicType' || i.tag === 'Image' || i.links.length);
const blackA = a.items.filter((i) => i.fill && /Black|black|102324|1e1e1e/i.test(String(i.fill)));
console.log('A GraphicType/Image/link items', graphicA.length);
console.log('A explicit FillColor (incl black swatches)', blackA.length);
for (const d of itemDiffs.slice(0, 25)) console.log(JSON.stringify(d));
if (itemDiffs.length > 25) console.log('...', itemDiffs.length - 25, 'more');

console.log('\n=== GraphicType / linked (A) ===');
for (const it of graphicA.slice(0, 12)) {
  console.log(it.self, it.spreadPath, it.tag, it.ct, 'links', it.links.length, 'nestedImages', it.nestedImages);
}

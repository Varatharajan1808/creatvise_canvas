/**
 * Compositor baseline against the embedded Photoshop composite (the only oracle available, and only
 * at import poses). Reports correctness, redraw time, and allocation pressure. Not a fidelity proof.
 *
 *   1. Dynamic 2D stack (composeDocPreview) vs embedded composite: MAE, percentiles, 4×4 tile MAE.
 *   2. Null edit per leaf (marked changed, not moved): a correct edit path would reproduce the
 *      embedded composite; also asserts the 200px ring outside the footprint is untouched.
 *   3. Move of the largest and the top-most paintable leaf: pixels outside the old and new
 *      footprints must equal the embedded composite exactly.
 *   4. Structural agreement (luminance correlation at 1/8 scale) vs simulated stale composites.
 *
 * Usage: node --expose-gc --import tsx scripts/psd-compositor-baseline.ts [file.psd]
 * Without an argument, runs PSD_TEXT_FIXTURE and PSD_FIXTURE in separate processes.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas } from 'ag-psd';

const defaults = [
  process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd'),
  process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd'),
];

if (!process.argv[2]) {
  let failed = false;
  for (const f of defaults) {
    if (!fs.existsSync(f)) {
      console.log(`SKIP: ${f} not found`);
      continue;
    }
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), f], { stdio: 'inherit' });
    if (r.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

/** Counts canvases at their first getContext call, with their pixel area at that moment. */
const alloc = { canvases: 0, megapixels: 0 };
{
  const proto = Object.getPrototypeOf(createCanvas(1, 1)) as { getContext: (...a: unknown[]) => unknown };
  const seen = new WeakSet<object>();
  const orig = proto.getContext;
  proto.getContext = function (this: { width: number; height: number }, ...args: unknown[]) {
    if (!seen.has(this)) {
      seen.add(this);
      alloc.canvases++;
      alloc.megapixels += (this.width * this.height) / 1e6;
    }
    return orig.apply(this, args);
  };
}
const resetAlloc = () => {
  alloc.canvases = 0;
  alloc.megapixels = 0;
};
const allocText = () => `canvases=${alloc.canvases} allocated=${alloc.megapixels.toFixed(1)}MP (${((alloc.megapixels * 4e6) / 1e6).toFixed(0)}MB RGBA)`;

const { importPsd } = await import('../src/psd/psd');
const { leaves } = await import('../src/core/model');
const C = await import('../src/psd/psdComposite');
const R = await import('../src/psd/psdCompositeRule');
type Node = ReturnType<typeof leaves>[number];

let peakRss = 0;
const settle = async () => {
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise((r) => setImmediate(r));
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};

const file = process.argv[2];
const buf = fs.readFileSync(file);
let t = performance.now();
const doc = importPsd(path.basename(file), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const W = doc.width;
const H = doc.height;
console.log(`\n===== ${path.basename(file)} ${W}x${H} import=${(performance.now() - t).toFixed(0)}ms mode=${doc.psdPreviewMode} fileBase=${!!doc.psdFileCompositeBase} =====`);
if (!doc.fileComposite) {
  console.log('SKIP: no embedded composite to compare against');
  process.exit(0);
}
const choice = C.analyzePsdPreview(doc);
console.log(`unsimulated features: ${JSON.stringify(choice.features)} embedded composite: ${choice.composite ?? 'not evaluated'}`);
const summary: Record<string, unknown> = { file: path.basename(file), size: `${W}x${H}`, mode: doc.psdPreviewMode, features: choice.features };
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};
check('opening-preview-is-embedded-composite', C.isShowingEmbeddedFileComposite(doc) || !doc.psdFileCompositeBase, String(doc.psdPreviewMode));

const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, W, H).data;
const ref = pixels(doc.fileComposite);
type Rect = [number, number, number, number];
const inRect = (x: number, y: number, r: Rect) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];

interface Stats { mae: number; p95: number; p99: number; max: number; gt2: number; gt16: number; gt64: number; n: number }
function stats(a: ArrayLike<number>, rect?: Rect, exclude: Rect[] = []): Stats | null {
  const r = rect ?? [0, 0, W, H];
  const x0 = Math.max(0, r[0]), y0 = Math.max(0, r[1]);
  const x1 = Math.min(W, r[0] + r[2]), y1 = Math.min(H, r[1] + r[3]);
  const hist = new Float64Array(256);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (exclude.some((e) => inRect(x, y, e))) continue;
      const i = (y * W + x) * 4;
      const dr = Math.abs(a[i] - ref[i]), dg = Math.abs(a[i + 1] - ref[i + 1]), db = Math.abs(a[i + 2] - ref[i + 2]), da = Math.abs(a[i + 3] - ref[i + 3]);
      hist[Math.max(dr, dg, db, da)]++;
      sum += dr + dg + db;
      n++;
    }
  }
  if (!n) return null;
  const pct = (q: number) => { let acc = 0; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= q * n) return k; } return 255; };
  const gt = (k: number) => { let c = 0; for (let j = k + 1; j < 256; j++) c += hist[j]; return +((100 * c) / n).toFixed(2); };
  let max = 0;
  for (let k = 255; k >= 0; k--) if (hist[k]) { max = k; break; }
  return { mae: +(sum / (3 * n)).toFixed(2), p95: pct(0.95), p99: pct(0.99), max, gt2: gt(2), gt16: gt(16), gt64: gt(64), n };
}
const fmt = (s: Stats | null) => (s ? `MAE=${s.mae} p95=${s.p95} p99=${s.p99} max=${s.max} >2:${s.gt2}% >16:${s.gt16}% >64:${s.gt64}% (n=${s.n})` : 'empty');
const tiles = (a: ArrayLike<number>) => {
  const rows: string[] = [];
  for (let r = 0; r < 4; r++) {
    const row: string[] = [];
    for (let c = 0; c < 4; c++) row.push(String(stats(a, [Math.floor((c * W) / 4), Math.floor((r * H) / 4), Math.ceil(W / 4), Math.ceil(H / 4)])!.mae).padStart(7));
    rows.push('   ' + row.join(' '));
  }
  return rows.join('\n');
};
const rectOf = (n: Node): Rect => [Math.round(n.ox), Math.round(n.oy), Math.round(n.ow), Math.round(n.oh)];
const curRect = (n: Node): Rect => [Math.round(n.x), Math.round(n.y), Math.round(n.w), Math.round(n.h)];
const grow = (r: Rect, m: number): Rect => [r[0] - m, r[1] - m, r[2] + 2 * m, r[3] + 2 * m];
const label = (n: Node) => `${n.key} "${n.name}"`;

// 1. Dynamic stack
await settle();
resetAlloc();
t = performance.now();
const dynCanvas = C.composeDocPreview(doc);
const dynMs = performance.now() - t;
console.log(`\n[1] Dynamic 2D stack: time=${dynMs.toFixed(0)}ms ${allocText()}`);
const dyn = pixels(dynCanvas);
const dynStats = stats(dyn);
console.log('    whole doc:', fmt(dynStats));
console.log('    MAE per 4x4 tile (rows top to bottom):\n' + tiles(dyn));
summary.dynamic = { ...dynStats, ms: Math.round(dynMs), canvases: alloc.canvases, megapixels: +alloc.megapixels.toFixed(1) };

// 2. Null edits
console.log('\n[2] Null edit per leaf (marked changed, not moved) via composeDocPreviewWithFileBase');
const nullEdits: Record<string, unknown>[] = [];
for (const n of leaves(doc)) {
  if (!n.canvas || n.ow <= 0 || n.oh <= 0) continue;
  C.markNodePreviewContentChanged(n);
  await settle();
  resetAlloc();
  t = performance.now();
  const out = C.composeDocPreviewWithFileBase(doc)!;
  const ms = performance.now() - t;
  const o = pixels(out);
  const r = rectOf(n);
  const inside = stats(o, r);
  const ring = stats(o, grow(r, 200), [r]);
  console.log(`    ${label(n)} rect=${JSON.stringify(r)} blend=${n.src.blendMode} clip=${!!n.src.clipping} time=${ms.toFixed(0)}ms ${allocText()}`);
  console.log(`       inside rect: ${fmt(inside)}`);
  if (ring) check(`null-edit-ring-untouched ${n.key}`, ring.max === 0, fmt(ring));
  const base = C.clipBaseOf(doc, n);
  if (base && base.kind !== 'group' && base.canvas) {
    const outsideBase = stats(o, undefined, [rectOf(base)]);
    check(`null-edit-clipped-no-spill-outside-base ${n.key}`, !!outsideBase && outsideBase.max === 0, `base ${label(base)}: ${fmt(outsideBase)}`);
  }
  nullEdits.push({ key: n.key, insideMae: inside?.mae, insideMax: inside?.max, ms: Math.round(ms), canvases: alloc.canvases, megapixels: +alloc.megapixels.toFixed(1) });
  n.previewContentEpoch = n.importPreviewContentEpoch;
}
check('reset-returns-embedded-composite', !doc.psdFileCompositeBase || C.isShowingEmbeddedFileComposite(doc), String(doc.psdPreviewMode));
summary.nullEdits = nullEdits;

// 3. Moves
const paintable = leaves(doc).filter((n) => n.canvas && n.w > 0 && n.h > 0 && n.opacity > 0.001 && n.visible);
const isFullDoc = (n: Node) => n.w >= W * 0.99 && n.h >= H * 0.99;
const largest = [...paintable].filter((n) => !isFullDoc(n)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
const topMost = paintable[paintable.length - 1];
const moves: Record<string, unknown>[] = [];
console.log('\n[3] Move (+40,+24): pixels outside old and new footprints must equal the embedded composite');
for (const n of [...new Set([largest, topMost].filter(Boolean))]) {
  n.x = n.ox + 40;
  n.y = n.oy + 24;
  await settle();
  resetAlloc();
  t = performance.now();
  const out = C.composeDocPreviewWithFileBase(doc)!;
  const ms = performance.now() - t;
  const o = pixels(out);
  const outside = stats(o, undefined, [rectOf(n), curRect(n)]);
  console.log(`    ${label(n)} redraw=${ms.toFixed(0)}ms ${allocText()}`);
  check(`move-unrelated-region-unchanged ${n.key}`, !!outside && outside.max === 0, fmt(outside));
  moves.push({ key: n.key, ms: Math.round(ms), canvases: alloc.canvases, megapixels: +alloc.megapixels.toFixed(1), outsideMax: outside?.max });
  n.x = n.ox;
  n.y = n.oy;
}
summary.moves = moves;

// 4. Structural agreement (diagnostic; the preview never switches on it)
const fixed = (a: { whole: number; minTile: number }) => ({ whole: +a.whole.toFixed(3), minTile: +a.minTile.toFixed(3) });
console.log(
  `\n[4] Structural agreement with the embedded composite (luminance correlation, 1/8 scale; provisional thresholds whole<${R.AGREEMENT_THRESHOLDS.whole} or minTile<${R.AGREEMENT_THRESHOLDS.minTile} = stale)`,
);
const genuine = R.compositeAgreement(doc.fileComposite, dynCanvas, W, H);
check('agreement-genuine-not-flagged-stale', !R.agreementLooksStale(genuine), JSON.stringify(fixed(genuine)));
const agree: Record<string, unknown> = { genuine: fixed(genuine) };
for (const n of [...new Set([largest, topMost].filter(Boolean))]) {
  n.x = n.ox + 300;
  n.y = n.oy + 200;
  const a = R.compositeAgreement(doc.fileComposite, C.composeDocPreview(doc), W, H);
  agree[`stale:${n.key}`] = fixed(a);
  check(`agreement-simulated-stale-flagged ${n.key} moved (+300,+200)`, R.agreementLooksStale(a), JSON.stringify(fixed(a)));
  n.x = n.ox;
  n.y = n.oy;
  await settle();
}
summary.agreement = agree;
summary.peakRssMB = Math.round(peakRss / 1e6);
console.log(`\npeak rss≈${summary.peakRssMB}MB (includes this script's own pixel copies)`);
console.log('SUMMARY:' + JSON.stringify(summary));
process.exit(checks.some((c) => !c.ok) ? 1 : 0);

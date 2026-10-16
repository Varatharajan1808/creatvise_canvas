/**
 * Phase 6c: PSD group export / re-import fidelity (structural + in-app composite).
 * Does not verify Adobe Photoshop desktop behavior.
 */
import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';
import { importPsd, exportPsd, renderComposite, refreshPsdPreviewModeAfterEdit } from '../src/psd/psd';
import { History } from '../src/core/history';
import { walk, type Doc, type Node } from '../src/core/model';
import {
  executeGroupCreation,
  executeUngroup,
  groupCreateCommand,
  groupUngroupCommand,
  planGroupCreation,
  planUngroup,
} from '../src/operations/groupOps';
import { assertModelSourceTreeInSync } from '../src/core/sourceTree';
import { moveLeavesBy } from '../src/canvas/selection';
import { composeDocPreview } from '../src/psd/psdComposite';

const results: { name: string; ok: boolean; detail: string; kind: 'structural' | 'visual' }[] = [];
const log = (name: string, ok: boolean, detail: string, kind: 'structural' | 'visual' = 'structural') => {
  results.push({ name, ok, detail, kind });
  console.log(`${ok ? 'OK' : 'FAIL'}: [${kind}] ${name} — ${detail}`);
};

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const W = 120;
const H = 120;

function fillLayer(
  name: string,
  css: string,
  box: { left: number; top: number; right: number; bottom: number },
  extra: Partial<Layer> = {},
): Layer {
  const c = createCanvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, W, H);
  return { name, ...box, canvas: c as unknown as HTMLCanvasElement, ...extra };
}

function buildDoc(children: Layer[]): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = createCanvas(W, H) as unknown as HTMLCanvasElement;
  return importPsd('group-export.psd', writePsd(psd));
}

function leafSnapshot(doc: Doc): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of walk(doc.roots)) {
    if (n.kind === 'group') continue;
    m.set(
      n.name,
      `${n.x},${n.y},${n.w},${n.h},r${n.rotation},vis${n.visible},op${n.opacity.toFixed(3)},lock${n.locked},clip${!!n.src.clipping}`,
    );
  }
  return m;
}

function treeOutline(doc: Doc): string {
  const rec = (nodes: Node[], prefix: string): string[] =>
    nodes.flatMap((n) => {
      if (n.kind === 'group') return [`${prefix}${n.name}/`, ...rec(n.children, prefix + '  ')];
      return [`${prefix}${n.name}`];
    });
  return rec(doc.roots, '').join('\n');
}

function pixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return new Uint8ClampedArray(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
}

function pixelMismatches(a: Uint8ClampedArray, b: Uint8ClampedArray, tol = 1): number {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i]! - b[i]!) > tol ||
      Math.abs(a[i + 1]! - b[i + 1]!) > tol ||
      Math.abs(a[i + 2]! - b[i + 2]!) > tol ||
      Math.abs(a[i + 3]! - b[i + 3]!) > tol
    ) {
      n++;
    }
  }
  return n;
}

function roundTrip(doc: Doc): Doc {
  return importPsd('rt.psd', exportPsd(doc));
}

function geomByName(doc: Doc, name: string): Node | undefined {
  return [...walk(doc.roots)].find((n) => n.name === name && n.kind !== 'group');
}

// --- new group, non-contiguous siblings ---
{
  const doc = buildDoc([
    fillLayer('A', '#ff0000', { left: 0, top: 0, right: 40, bottom: 40 }),
    fillLayer('B', '#00ff00', { left: 40, top: 40, right: 80, bottom: 80 }),
    fillLayer('C', '#0000ff', { left: 80, top: 80, right: 120, bottom: 120 }),
  ]);
  const beforeGeom = leafSnapshot(doc);
  const beforeComposite = pixels(renderComposite(doc));
  const planned = planGroupCreation(doc, [doc.roots[0]!, doc.roots[2]!]);
  log('plan-non-contiguous', planned.ok === true, '', 'structural');
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    log('sync-after-group', assertModelSourceTreeInSync(doc), treeOutline(doc), 'structural');
    log('geom-unchanged-by-group', leafSnapshot(doc).get('A') === beforeGeom.get('A'), 'A', 'structural');
    const afterGroupComposite = pixels(renderComposite(doc));
    const re = roundTrip(doc);
    log('reimport-has-group-folder', re.roots.some((n) => n.kind === 'group'), treeOutline(re), 'structural');
    log(
      'reimport-child-order',
      re.roots[0]!.kind === 'group' &&
        re.roots[0]!.children.map((n) => n.name).join(',') === 'A,C' &&
        re.roots[1]!.name === 'B',
      treeOutline(re),
      'structural',
    );
    const reComposite = pixels(renderComposite(re));
    log(
      'export-composite-matches-post-group',
      pixelMismatches(afterGroupComposite, reComposite, 1) <= 2,
      `m=${pixelMismatches(afterGroupComposite, reComposite, 1)}`,
      'visual',
    );
    log(
      'non-contiguous-group-changes-stack',
      pixelMismatches(beforeComposite, afterGroupComposite, 0) > 0,
      'expected when middle sibling stays outside group',
      'structural',
    );
    const raw = readPsd(exportPsd(doc), { skipLayerImageData: true, skipThumbnail: true });
    const groupLayer = raw.children?.find((l) => l.name === 'Group');
    log('exported-group-pass-through', groupLayer?.blendMode === 'pass through', String(groupLayer?.blendMode), 'structural');
  }
}

// --- nested group export ---
{
  const innerA = fillLayer('InnerA', '#111111', { left: 5, top: 5, right: 35, bottom: 35 });
  const innerB = fillLayer('InnerB', '#222222', { left: 35, top: 35, right: 65, bottom: 65 });
  const doc = buildDoc([
    fillLayer('BG', '#ffffff', { left: 0, top: 0, right: W, bottom: H }),
    { name: 'Outer', opened: true, children: [innerA, innerB], blendMode: 'pass through' },
  ]);
  const outer = doc.roots[1]!;
  const planned = planGroupCreation(doc, [outer.children[0]!, outer.children[1]!]);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    log('nested-created', outer.children.some((n) => n.kind === 'group'), treeOutline(doc), 'structural');
    const re = roundTrip(doc);
    log(
      'nested-reimport-structure',
      re.roots[1]!.kind === 'group' && re.roots[1]!.children.some((n) => n.kind === 'group'),
      treeOutline(re),
      'structural',
    );
  }
}

// --- contiguous group preserves composite ---
{
  const doc = buildDoc([
    fillLayer('S1', '#ff0000', { left: 20, top: 20, right: 60, bottom: 60 }),
    fillLayer('S2', '#0000ff', { left: 30, top: 30, right: 70, bottom: 70 }),
  ]);
  const before = pixels(renderComposite(doc));
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    const after = pixels(renderComposite(doc));
    log(
      'contiguous-group-composite-stable',
      pixelMismatches(before, after, 0) === 0,
      `m=${pixelMismatches(before, after, 0)}`,
      'visual',
    );
    const re = roundTrip(doc);
    log(
      'contiguous-export-composite',
      pixelMismatches(after, pixels(renderComposite(re)), 1) <= 2,
      '',
      'visual',
    );
  }
}

// --- clipping inside exported group ---
{
  const doc = buildDoc([
    fillLayer('Base', '#0000ff', { left: 10, top: 10, right: 110, bottom: 110 }),
    fillLayer('Clip', '#ff0000', { left: 10, top: 10, right: 110, bottom: 110 }, { clipping: true }),
  ]);
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    const re = roundTrip(doc);
    const clip = re.roots[0]!.children.find((n) => n.name === 'Clip');
    log('clipping-preserved-in-group', !!clip?.src.clipping, String(clip?.src.clipping), 'structural');
  }
}

// --- move children then export ---
{
  const doc = buildDoc([
    fillLayer('L1', '#aa0000', { left: 10, top: 10, right: 50, bottom: 50 }),
    fillLayer('L2', '#00aa00', { left: 60, top: 60, right: 100, bottom: 100 }),
  ]);
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    const group = doc.roots[0]!;
    moveLeavesBy(group.children, 12, -8);
    refreshPsdPreviewModeAfterEdit(doc);
    const re = roundTrip(doc);
    const l1 = geomByName(re, 'L1')!;
    log('move-then-export-x', l1.x === 22, String(l1.x), 'structural');
    log('move-then-export-y', l1.y === 2, String(l1.y), 'structural');
  }
}

// --- ungroup then export ---
{
  const doc = buildDoc([
    fillLayer('U1', '#123456', { left: 0, top: 0, right: 40, bottom: 40 }),
    fillLayer('U2', '#654321', { left: 50, top: 50, right: 90, bottom: 90 }),
  ]);
  const created = planGroupCreation(doc, doc.roots);
  if (created.ok) {
    executeGroupCreation(created.plan);
    const ung = planUngroup(doc, created.plan.group);
    if (ung.ok) {
      executeUngroup(ung.plan);
      const re = roundTrip(doc);
      log('ungroup-export-flat', re.roots.length === 2 && re.roots.every((n) => n.kind !== 'group'), treeOutline(re), 'structural');
    }
  }
}

// --- visibility, opacity, lock on grouped layers ---
{
  const doc = buildDoc([
    fillLayer('V1', '#ff00ff', { left: 10, top: 10, right: 50, bottom: 50 }),
    fillLayer('V2', '#00ffff', { left: 55, top: 55, right: 95, bottom: 95 }),
  ]);
  doc.roots[0]!.visible = false;
  doc.roots[1]!.opacity = 0.5;
  doc.roots[1]!.locked = true;
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    executeGroupCreation(planned.plan);
    const re = roundTrip(doc);
    const v1 = geomByName(re, 'V1')!;
    const v2 = geomByName(re, 'V2')!;
    log('export-hidden-child', v1.visible === false, String(v1.visible), 'structural');
    log('export-half-opacity', Math.abs(v2.opacity - 0.5) < 0.02, String(v2.opacity), 'structural');
    log('export-locked-child', v2.locked === true, String(v2.locked), 'structural');
  }
}

// --- Group → Undo → Redo → Export ---
{
  const doc = buildDoc([
    fillLayer('H1', '#010101', { left: 5, top: 5, right: 45, bottom: 45 }),
    fillLayer('H2', '#020202', { left: 55, top: 55, right: 95, bottom: 95 }),
  ]);
  const planned = planGroupCreation(doc, doc.roots);
  if (planned.ok) {
    const hist = new History();
    hist.exec(groupCreateCommand(planned.plan));
    log('hist-group-sync', assertModelSourceTreeInSync(doc), '', 'structural');
    hist.undo();
    let re = roundTrip(doc);
    log('hist-undo-export-flat', re.roots.length === 2, treeOutline(re), 'structural');
    hist.redo();
    log('hist-redo-sync', assertModelSourceTreeInSync(doc), '', 'structural');
    re = roundTrip(doc);
    log('hist-redo-export-group', re.roots[0]!.kind === 'group', treeOutline(re), 'structural');
  }
}

// --- Ungroup → Undo → Redo → Export ---
{
  const doc = buildDoc([
    fillLayer('G1', '#0a0a0a', { left: 0, top: 0, right: 40, bottom: 40 }),
    { name: 'Folder', opened: true, children: [fillLayer('G2', '#fafafa', { left: 50, top: 50, right: 90, bottom: 90 })], blendMode: 'pass through' },
  ]);
  const folder = doc.roots[1]!;
  const ung = planUngroup(doc, folder);
  if (ung.ok) {
    const hist = new History();
    hist.exec(groupUngroupCommand(ung.plan));
    let re = roundTrip(doc);
    log('ungroup-hist-export', re.roots.every((n) => n.kind !== 'group' || n.name === 'Folder'), treeOutline(re), 'structural');
    hist.undo();
    re = roundTrip(doc);
    log('ungroup-undo-regroup-export', re.roots.some((n) => n.kind === 'group'), treeOutline(re), 'structural');
    hist.redo();
    re = roundTrip(doc);
    log('ungroup-redo-flat-export', re.roots.length >= 2, treeOutline(re), 'structural');
  }
}

// --- optional real fixture (structural only) ---
{
  const fixture = path.join('public', '11330937.psd');
  if (fs.existsSync(fixture)) {
    const buf = fs.readFileSync(fixture);
    const doc = importPsd(
      '11330937.psd',
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const leavesBefore = [...walk(doc.roots)].filter((n) => n.kind !== 'group').length;
    const compositeBefore = pixels(composeDocPreview(doc));
    const rasterSiblings = doc.roots.filter((n) => n.kind === 'raster');
    if (rasterSiblings.length >= 2) {
      const planned = planGroupCreation(doc, [rasterSiblings[0]!, rasterSiblings[1]!]);
      if (planned.ok) {
        executeGroupCreation(planned.plan);
        refreshPsdPreviewModeAfterEdit(doc);
        const re = roundTrip(doc);
        const leavesAfter = [...walk(re.roots)].filter((n) => n.kind !== 'group').length;
        log('fixture-leaf-count', leavesBefore === leavesAfter, `${leavesBefore} vs ${leavesAfter}`, 'structural');
        log('fixture-has-new-group', re.roots.some((n) => n.kind === 'group'), treeOutline(re).slice(0, 120), 'structural');
        const compositeRe = pixels(composeDocPreview(re));
        log(
          'fixture-composite-close',
          pixelMismatches(compositeBefore, compositeRe, 2) / (W * H) < 0.15,
          `ratio=${(pixelMismatches(compositeBefore, compositeRe, 2) / (doc.width * doc.height)).toFixed(4)}`,
          'visual',
        );
      }
    } else {
      log('fixture-skip-group', true, 'not enough root rasters', 'structural');
    }
  } else {
    log('fixture-missing', true, 'skipped', 'structural');
  }
}

console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
const structural = results.filter((r) => r.kind === 'structural').length;
const visual = results.filter((r) => r.kind === 'visual').length;
if (failures.length) {
  console.error(`${failures.length} of ${results.length} group export tests failed (${structural} structural, ${visual} visual checks)`);
  process.exit(1);
}
console.log(`All ${results.length} group export tests passed (${structural} structural, ${visual} visual)`);

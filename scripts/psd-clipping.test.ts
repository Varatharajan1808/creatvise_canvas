/**
 * Clipping-base tracking: hidden / zero-opacity bases, group boundaries, groups as bases, and the
 * edit path (base or clipped layer edited) leaving unrelated regions of the embedded composite intact.
 * Synthetic PSDs only.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd, refreshPsdPreviewModeAfterEdit } = await import('../src/psd');
const { leaves } = await import('../src/model');
const { composeDocPreview, getDocPreviewCanvas, isShowingEmbeddedFileComposite, clipBaseOf } = await import('../src/psdComposite');
const { History } = await import('../src/history');
type Doc = ReturnType<typeof importPsd>;

const W = 100, H = 100;
function fill(w: number, h: number, css: string) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, w, h);
  return c;
}
const rect = (name: string, x: number, y: number, w: number, h: number, css: string, extra: Partial<Layer> = {}): Layer => ({
  name, left: x, top: y, right: x + w, bottom: y + h, canvas: fill(w, h, css), ...extra,
});
const bg = () => rect('BG', 0, 0, W, H, '#ffffff');
const redClip = (extra: Partial<Layer> = {}) => rect('Red', 0, 0, W, H, '#ff0000', { clipping: true, ...extra });
function build(children: Layer[]): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = fill(W, H, '#ffffff');
  return importPsd('clip.psd', writePsd(psd));
}
const px = (c: HTMLCanvasElement, x: number, y: number) => [...c.getContext('2d')!.getImageData(x, y, 1, 1).data].join();
const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, W, H).data;
const RED = '255,0,0,255', WHITE = '255,255,255,255', BLUE = '0,0,255,255', GREEN = '0,128,0,255';
const byName = (doc: Doc, name: string) => leaves(doc).find((n) => n.name === name)!;

// ---------- full-stack semantics ----------
{
  const doc = build([bg(), rect('Base', 20, 20, 40, 40, '#0000ff'), redClip()]);
  const out = composeDocPreview(doc);
  log('clip-inside-base', px(out, 40, 40) === RED, px(out, 40, 40));
  log('clip-outside-base', px(out, 80, 80) === WHITE, px(out, 80, 80));
  log('clip-base-lookup', clipBaseOf(doc, byName(doc, 'Red'))?.name === 'Base', String(clipBaseOf(doc, byName(doc, 'Red'))?.name));
}
{
  const doc = build([bg(), rect('Base', 20, 20, 40, 40, '#0000ff', { hidden: true }), redClip()]);
  const out = composeDocPreview(doc);
  log('hidden-base-hides-clipped', px(out, 40, 40) === WHITE && px(out, 80, 80) === WHITE, `${px(out, 40, 40)} / ${px(out, 80, 80)}`);
}
{
  const doc = build([bg(), rect('Base', 20, 20, 40, 40, '#0000ff', { opacity: 0 }), redClip()]);
  const out = composeDocPreview(doc);
  log('zero-opacity-base-hides-clipped', px(out, 40, 40) === WHITE && px(out, 80, 80) === WHITE, `${px(out, 40, 40)} / ${px(out, 80, 80)}`);
}
{
  const doc = build([bg(), rect('Base', 20, 20, 40, 40, '#0000ff'), redClip(), rect('Second', 0, 0, W, H, '#008000', { clipping: true, opacity: 0.5 })]);
  const out = composeDocPreview(doc);
  log('stacked-clipped-share-base', px(out, 80, 80) === WHITE && px(out, 40, 40) !== RED && px(out, 40, 40) !== WHITE, `${px(out, 40, 40)} / ${px(out, 80, 80)}`);
}
{
  // The group is the base: clipped layer shows over the union of the group's leaves.
  const doc = build([bg(), { name: 'Group', children: [rect('Left', 5, 40, 20, 20, '#0000ff'), rect('Right', 75, 40, 20, 20, '#0000ff')] }, redClip()]);
  const out = composeDocPreview(doc);
  log('group-base-left', px(out, 15, 50) === RED, px(out, 15, 50));
  log('group-base-right', px(out, 85, 50) === RED, px(out, 85, 50));
  log('group-base-gap', px(out, 50, 50) === WHITE, px(out, 50, 50));
}
{
  // Clip base search stops at the group boundary: the clipped layer in the group uses the group's own base.
  const doc = build([bg(), rect('Outer', 0, 0, 50, 100, '#0000ff'), { name: 'Group', children: [rect('Inner', 50, 0, 50, 100, '#008000'), redClip()] }]);
  const out = composeDocPreview(doc);
  log('group-boundary-uses-inner-base', px(out, 75, 50) === RED && px(out, 25, 50) === BLUE, `${px(out, 75, 50)} / ${px(out, 25, 50)}`);
}
{
  const doc = build([bg(), { name: 'Group', children: [rect('Inner', 50, 0, 50, 100, '#008000', { hidden: true }), redClip()] }, rect('After', 0, 0, 10, 10, '#0000ff')]);
  const out = composeDocPreview(doc);
  log('hidden-base-in-group-does-not-fall-back', px(out, 25, 50) === WHITE && px(out, 75, 50) === WHITE, `${px(out, 25, 50)} / ${px(out, 75, 50)}`);
}

// ---------- edit path over an embedded composite ----------
/** Embedded composite = our own stack at import poses, so the edit path has an exact oracle. */
function editable(children: Layer[]): Doc {
  const doc = build(children);
  doc.fileComposite = composeDocPreview(doc);
  doc.psdFileCompositeBase = true;
  doc.psdStaticComposite = true;
  doc.psdPreviewMode = 'file-composite';
  return doc;
}
const scene = () => [bg(), rect('Unrelated', 70, 70, 25, 25, '#008000'), rect('Base', 10, 10, 30, 30, '#0000ff'), redClip()];
function sameOutside(a: ArrayLike<number>, b: ArrayLike<number>, holes: Array<[number, number, number, number]>) {
  let diffs = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (holes.some(([hx, hy, hw, hh]) => x >= hx && x < hx + hw && y >= hy && y < hy + hh)) continue;
    const i = (y * W + x) * 4;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diffs++;
  }
  return diffs;
}
const equalAll = (a: ArrayLike<number>, b: ArrayLike<number>) => sameOutside(a, b, []);

{
  const doc = editable(scene());
  const base = byName(doc, 'Base');
  base.x += 30;
  refreshPsdPreviewModeAfterEdit(doc);
  const prev = getDocPreviewCanvas(doc)!;
  log('move-base-clipped-follows', px(prev, 55, 25) === RED, px(prev, 55, 25));
  log('move-base-old-spot-cleared', px(prev, 20, 25) === WHITE, px(prev, 20, 25));
  log('move-base-matches-full-stack', equalAll(pixels(prev), pixels(composeDocPreview(doc))) === 0, `${equalAll(pixels(prev), pixels(composeDocPreview(doc)))} px differ`);
  const unrelated = sameOutside(pixels(prev), pixels(doc.fileComposite!), [[10, 10, 30, 30], [40, 10, 30, 30]]);
  log('move-base-unrelated-unchanged', unrelated === 0 && px(prev, 80, 80) === GREEN, `${unrelated} px differ outside old/new base`);
}
{
  const doc = editable(scene());
  const red = byName(doc, 'Red');
  red.x += 7;
  red.y += 3;
  refreshPsdPreviewModeAfterEdit(doc);
  const prev = getDocPreviewCanvas(doc)!;
  log('move-clipped-no-spill', px(prev, 80, 80) === GREEN && px(prev, 50, 50) === WHITE, `${px(prev, 80, 80)} / ${px(prev, 50, 50)}`);
  log('move-clipped-matches-full-stack', equalAll(pixels(prev), pixels(composeDocPreview(doc))) === 0, `${equalAll(pixels(prev), pixels(composeDocPreview(doc)))} px differ`);
  const unrelated = sameOutside(pixels(prev), pixels(doc.fileComposite!), [[10, 10, 30, 30]]);
  log('move-clipped-unrelated-unchanged', unrelated === 0, `${unrelated} px differ outside base footprint`);
}
{
  const doc = editable(scene());
  const base = byName(doc, 'Base');
  base.visible = false;
  refreshPsdPreviewModeAfterEdit(doc);
  const prev = getDocPreviewCanvas(doc)!;
  log('hide-base-hides-clipped', px(prev, 25, 25) === WHITE, px(prev, 25, 25));
  log('hide-base-matches-full-stack', equalAll(pixels(prev), pixels(composeDocPreview(doc))) === 0, `${equalAll(pixels(prev), pixels(composeDocPreview(doc)))} px differ`);
}
{
  const doc = editable(scene());
  const base = byName(doc, 'Base');
  base.opacity = 0;
  refreshPsdPreviewModeAfterEdit(doc);
  const prev = getDocPreviewCanvas(doc)!;
  log('zero-opacity-base-edit-hides-clipped', px(prev, 25, 25) === WHITE, px(prev, 25, 25));
}
{
  const doc = editable(scene());
  const base = byName(doc, 'Base');
  const hist = new History();
  const ox = base.x;
  hist.exec({
    label: 'Move',
    do: () => { base.x = ox + 30; refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { base.x = ox; refreshPsdPreviewModeAfterEdit(doc); },
  });
  const moved = pixels(getDocPreviewCanvas(doc)!);
  hist.undo();
  const undoOk = isShowingEmbeddedFileComposite(doc) && getDocPreviewCanvas(doc) === doc.fileComposite;
  hist.redo();
  const redoOk = equalAll(pixels(getDocPreviewCanvas(doc)!), moved) === 0;
  log('undo-redo-base-move', undoOk && redoOk, `undo-embedded=${undoOk} redo-identical=${redoOk}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log('JSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

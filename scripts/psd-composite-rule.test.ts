/**
 * Embedded-composite selection from metadata, blank / not-real composite checks, and the (diagnostic
 * only) structural agreement check against synthetic stale composites. Synthetic PSDs only.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';

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

const { importPsd, exportPsd, refreshPsdPreviewModeAfterEdit } = await import('../src/psd');
const { leaves } = await import('../src/model');
const C = await import('../src/psdComposite');
const R = await import('../src/psdCompositeRule');
const { History } = await import('../src/history');
type Doc = ReturnType<typeof importPsd>;

const W = 120, H = 90;
function mk(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return c;
}
const fill = (w: number, h: number, css: string) => mk(w, h, (g) => { g.fillStyle = css; g.fillRect(0, 0, w, h); });
const rect = (name: string, x: number, y: number, w: number, h: number, css: string, extra: Partial<Layer> = {}): Layer => ({
  name, left: x, top: y, right: x + w, bottom: y + h, canvas: fill(w, h, css), ...extra,
});
/** Composite that looks like the layers: white page, blue box, orange box. */
const realComposite = () => mk(W, H, (g) => {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#2050d0'; g.fillRect(10, 10, 40, 40);
  g.fillStyle = '#f08030'; g.fillRect(70, 40, 40, 40);
});
const baseLayers = (): Layer[] => [rect('BG', 0, 0, W, H, '#ffffff'), rect('Blue', 10, 10, 40, 40, '#2050d0'), rect('Orange', 70, 40, 40, 40, '#f08030')];
function build(children: Layer[] = baseLayers(), composite: HTMLCanvasElement | null = realComposite()): Doc {
  const psd: Psd = { width: W, height: H, children };
  if (composite) psd.canvas = composite;
  return importPsd('rule.psd', writePsd(psd));
}
const byName = (doc: Doc, name: string) => leaves(doc).find((n) => n.name === name)!;
const features = (doc: Doc) => R.unsimulatedFeatures(doc);
const has = (doc: Doc, f: string) => features(doc).includes(f);

// ---------- feature detection (metadata only) ----------
{
  const doc = build();
  log('plain-file-no-features', features(doc).length === 0 && doc.psdPreviewMode === 'layers', `${JSON.stringify(features(doc))} mode=${doc.psdPreviewMode}`);
}
{
  const doc = build([rect('BG', 0, 0, W, H, '#ffffff'), rect('Mul', 10, 10, 40, 40, '#808080', { blendMode: 'multiply' }), rect('Burn', 70, 40, 40, 40, '#808080', { blendMode: 'linear burn' })]);
  log('exact-blend-modes-stay-dynamic', features(doc).length === 0 && doc.psdPreviewMode === 'composite', `${JSON.stringify(features(doc))} mode=${doc.psdPreviewMode}`);
}
{
  const doc = build([rect('BG', 0, 0, W, H, '#ffffff'), rect('Soft', 10, 10, 40, 40, '#808080', { blendMode: 'soft light' })]);
  log('soft-light-uses-embedded', has(doc, 'soft light blend mode') && doc.psdPreviewMode === 'file-composite' && !!doc.psdFileCompositeBase, `${JSON.stringify(features(doc))} mode=${doc.psdPreviewMode}`);
}
{
  const doc = build();
  const blue = byName(doc, 'Blue');
  blue.src.effects = { dropShadow: [{ enabled: true, opacity: 0.5 }] };
  log('enabled-effect-detected', has(doc, 'layer effects'), JSON.stringify(features(doc)));
  blue.src.effects = { dropShadow: [{ enabled: false }], stroke: [{ enabled: false }] };
  log('disabled-effect-entries-ignored', !has(doc, 'layer effects'), JSON.stringify(features(doc)));
  blue.src.effects = { disabled: true, dropShadow: [{ enabled: true }] };
  log('effects-switched-off-ignored', !has(doc, 'layer effects'), JSON.stringify(features(doc)));
  blue.src.effects = { dropShadow: [{ enabled: true }] };
  blue.visible = false;
  log('hidden-layer-effects-ignored', !has(doc, 'layer effects'), JSON.stringify(features(doc)));
  blue.visible = true;
  blue.opacity = 0;
  log('zero-opacity-layer-effects-ignored', !has(doc, 'layer effects'), JSON.stringify(features(doc)));
}
{
  const doc = build();
  const blue = byName(doc, 'Blue');
  blue.src.fillOpacity = 0.5;
  log('fill-opacity-detected', has(doc, 'fill opacity'), JSON.stringify(features(doc)));
  blue.src.fillOpacity = undefined;
  blue.src.adjustment = { type: 'invert' };
  log('adjustment-detected', has(doc, 'adjustment layers'), JSON.stringify(features(doc)));
  blue.src.adjustment = undefined;
  blue.src.mask = { left: 10, top: 10, right: 50, bottom: 50, defaultColor: 0, userMaskDensity: 0.5 };
  log('mask-density-detected', has(doc, 'mask density/feather'), JSON.stringify(features(doc)));
  blue.src.mask = { left: 10, top: 10, right: 50, bottom: 50, defaultColor: 0, userMaskFeather: 4 };
  log('mask-feather-detected', has(doc, 'mask density/feather'), JSON.stringify(features(doc)));
  blue.src.mask = undefined;
  blue.src.knockout = true;
  log('knockout-detected', has(doc, 'knockout'), JSON.stringify(features(doc)));
  blue.src.knockout = false;
  blue.src.blendingRanges = { compositeGrayBlendSource: [0, 0, 200, 255], compositeGraphBlendDestinationRange: [0, 0, 255, 255], ranges: [] };
  log('blend-if-detected', has(doc, 'Blend If'), JSON.stringify(features(doc)));
  blue.src.blendingRanges = { compositeGrayBlendSource: [0, 0, 255, 255], compositeGraphBlendDestinationRange: [0, 0, 255, 255], ranges: [{ sourceRange: [0, 0, 255, 255], destRange: [0, 0, 255, 255] }] };
  log('default-blend-if-ignored', !has(doc, 'Blend If'), JSON.stringify(features(doc)));
  const vm = { paths: [{ open: false, knots: [] }] } as unknown as NonNullable<Layer['vectorMask']>;
  blue.src.vectorMask = vm;
  log('vector-mask-on-raster-detected', has(doc, 'vector masks'), JSON.stringify(features(doc)));
  blue.src.vectorFill = { type: 'color', color: { r: 32, g: 80, b: 208 } };
  log('shape-layer-outline-not-a-feature', !has(doc, 'vector masks'), JSON.stringify(features(doc)));
}
{
  const doc = build([rect('BG', 0, 0, W, H, '#ffffff'), { name: 'G', blendMode: 'multiply', children: [rect('In', 10, 10, 40, 40, '#808080')] }]);
  log('isolated-group-detected', has(doc, 'isolated group blending'), JSON.stringify(features(doc)));
}
{
  const doc = build([rect('BG', 0, 0, W, H, '#ffffff'), rect('Base', 10, 10, 40, 40, '#2050d0', { opacity: 0.5 }), rect('Clip', 0, 0, W, H, '#ff0000', { clipping: true })]);
  log('clip-base-opacity-detected', has(doc, 'clipping group opacity/blend'), JSON.stringify(features(doc)));
}
{
  const doc = build();
  doc.psd!.bitsPerChannel = 16;
  log('high-bit-depth-detected', has(doc, '16/32-bit color'), JSON.stringify(features(doc)));
}

// ---------- embedded composite status ----------
const withEffects = (): Layer[] => {
  const l = baseLayers();
  l[1].effects = { dropShadow: [{ enabled: true, opacity: 0.6, distance: { units: 'Pixels', value: 4 }, size: { units: 'Pixels', value: 4 }, color: { r: 0, g: 0, b: 0 } }] };
  return l;
};
{
  const doc = build(withEffects());
  log('effects-file-written-and-detected', has(doc, 'layer effects'), JSON.stringify(features(doc)));
  log('effects-file-opens-on-embedded', doc.psdPreviewMode === 'file-composite' && C.isShowingEmbeddedFileComposite(doc), String(doc.psdPreviewMode));
  log('effects-file-warning', doc.warnings.some((w) => w.includes('layer effects') && w.includes('embedded Photoshop composite')), JSON.stringify(doc.warnings));
}
{
  const doc = build(withEffects(), mk(W, H, () => {}));
  const a = C.analyzePsdPreview(doc);
  log('transparent-composite-is-blank', a.composite === 'blank' && doc.psdPreviewMode !== 'file-composite' && !doc.psdFileCompositeBase, `${a.composite} mode=${doc.psdPreviewMode}`);
  log('blank-composite-warning', doc.warnings.some((w) => w.includes('blank embedded composite')), JSON.stringify(doc.warnings));
}
{
  const doc = build(withEffects(), fill(W, H, '#ffffff'));
  log('flat-placeholder-composite-is-blank', C.analyzePsdPreview(doc).composite === 'blank', String(C.analyzePsdPreview(doc).composite));
}
{
  const flat = [rect('BG', 0, 0, W, H, '#ffffff', { effects: { dropShadow: [{ enabled: true }] } })];
  const doc = build(flat, fill(W, H, '#ffffff'));
  log('flat-design-composite-is-usable', C.analyzePsdPreview(doc).composite === 'usable' && doc.psdPreviewMode === 'file-composite', `${C.analyzePsdPreview(doc).composite} mode=${doc.psdPreviewMode}`);
}
{
  const doc = build(withEffects());
  doc.psd!.imageResources = { ...(doc.psd!.imageResources ?? {}), versionInfo: { hasRealMergedData: false, writerName: 'x', readerName: 'x', fileVersion: 1 } };
  log('not-real-composite-rejected', C.analyzePsdPreview(doc).composite === 'not-real' && C.analyzePsdPreview(doc).mode !== 'file-composite', String(C.analyzePsdPreview(doc).composite));
  delete doc.psd!.canvas;
  log('missing-composite-rejected', C.analyzePsdPreview(doc).composite === 'missing' && C.analyzePsdPreview(doc).mode !== 'file-composite', String(C.analyzePsdPreview(doc).composite));
}

// ---------- stale detection: diagnostic only ----------
{
  const doc = build(withEffects());
  const genuine = R.compositeAgreement(C.composeDocPreview(doc), C.composeDocPreview(doc), W, H, 2);
  const orange = byName(doc, 'Orange');
  orange.x -= 55;
  orange.y -= 30;
  const staleRender = C.composeDocPreview(doc);
  orange.x = orange.ox;
  orange.y = orange.oy;
  const stale = R.compositeAgreement(staleRender, C.composeDocPreview(doc), W, H, 2);
  const blank = R.compositeAgreement(fill(W, H, '#ffffff'), C.composeDocPreview(doc), W, H, 2);
  log('agreement-genuine-not-stale', !R.agreementLooksStale(genuine), JSON.stringify(genuine));
  log('agreement-moved-layer-looks-stale', R.agreementLooksStale(stale), JSON.stringify(stale));
  log('agreement-blank-looks-stale', R.agreementLooksStale(blank), JSON.stringify(blank));

  // A stale composite must not switch the preview automatically yet.
  const staleDoc = build(withEffects(), staleRender);
  log('stale-composite-not-auto-switched', staleDoc.psdPreviewMode === 'file-composite' && C.isShowingEmbeddedFileComposite(staleDoc), String(staleDoc.psdPreviewMode));
}

// ---------- edit / undo / export on a file newly routed to the embedded composite ----------
{
  const doc = build(withEffects());
  const orange = byName(doc, 'Orange');
  const hist = new History();
  const ox = orange.x;
  hist.exec({
    label: 'Move',
    do: () => { orange.x = ox - 50; refreshPsdPreviewModeAfterEdit(doc); },
    undo: () => { orange.x = ox; refreshPsdPreviewModeAfterEdit(doc); },
  });
  const prev = C.getDocPreviewCanvas(doc)!;
  const a = prev.getContext('2d')!.getImageData(0, 0, W, H).data;
  const b = doc.fileComposite!.getContext('2d')!.getImageData(0, 0, W, H).data;
  let changedOutside = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inOld = x >= 70 && x < 110 && y >= 40 && y < 80;
    const inNew = x >= 20 && x < 60 && y >= 40 && y < 80;
    if (inOld || inNew) continue;
    const i = (y * W + x) * 4;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changedOutside++;
  }
  log('edit-overlay-mode', doc.psdPreviewMode === 'file-base-overlay', String(doc.psdPreviewMode));
  log('edit-outside-footprints-unchanged', changedOutside === 0, `${changedOutside} px differ`);
  const reread = readPsd(exportPsd(doc), { skipThumbnail: true });
  log('export-keeps-effects', !!reread.children?.find((l) => l.name === 'Blue')?.effects?.dropShadow?.length, 'dropShadow kept');
  const reimport = importPsd('re.psd', exportPsd(doc));
  log('reimport-opens-on-embedded', reimport.psdPreviewMode === 'file-composite', String(reimport.psdPreviewMode));
  hist.undo();
  log('undo-returns-embedded', C.isShowingEmbeddedFileComposite(doc) && C.getDocPreviewCanvas(doc) === doc.fileComposite, String(doc.psdPreviewMode));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log('JSON:' + JSON.stringify(results));
process.exit(failed.length ? 1 : 0);

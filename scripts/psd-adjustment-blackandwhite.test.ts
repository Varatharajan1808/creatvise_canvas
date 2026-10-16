/**
 * Synthetic and regression test suite for Black & White adjustments (Milestone 2F).
 *
 * Validates:
 *   1. Default weights on primary & secondary colors (R:40, Y:60, G:40, C:60, B:20, M:80)
 *   2. Neutral gray, pure black, and pure white preservation
 *   3. Custom channel weighting (reds, yellows, greens, cyans, blues, magentas)
 *   4. Continuous interpolation across hue sectors (e.g. Orange between Red and Yellow)
 *   5. Tint support (default Sepia, custom tint color, black/white anchoring)
 *   6. Boundary values and extreme slider clamping (-50, +150)
 *   7. Stack preview rendering
 *   8. Opacity blending (0%, 50% linear interpolation, 100%)
 *   9. Raster masks (inside rect, defaultColor 0 vs 255 outside, disabled mask)
 *  10. Clipping isolation (clipped adjustment affects clip base ONLY, backdrop untouched)
 *  11. Stack order (layers above adjustment are not affected)
 *  12. Non-destructive export & re-import roundtrip (ag-psd blwh block preserved)
 *  13. Undo/Redo determinism
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import {
  initializeCanvas,
  writePsd,
  type Layer,
  type Psd,
  type BlackAndWhiteAdjustment,
} from 'ag-psd';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

const window = new Window();
(globalThis as unknown as { document: Document }).document =
  window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd, exportPsd } = await import('../src/psd/psd');
const { leaves } = await import('../src/core/model');
const { composeDocPreview } = await import('../src/psd/psdComposite');
const {
  evaluateBlackAndWhitePixel,
  prepareBlackAndWhiteParams,
} = await import('../src/psd/psdAdjustmentBlackAndWhite');
const { History } = await import('../src/core/history');

type Doc = ReturnType<typeof importPsd>;

const W = 100,
  H = 100;
function fill(w: number, h: number, css: string) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, w, h);
  return c;
}

const rect = (
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  css: string,
  extra: Partial<Layer> = {},
): Layer => ({
  name,
  left: x,
  top: y,
  right: x + w,
  bottom: y + h,
  canvas: fill(w, h, css),
  ...extra,
});

function buildDoc(children: Layer[], bgCss = '#808080'): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = fill(W, H, bgCss);
  return importPsd('test-bw.psd', writePsd(psd));
}

const px = (
  c: HTMLCanvasElement,
  x: number,
  y: number,
): [number, number, number, number] => {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

const pxStr = (c: HTMLCanvasElement, x: number, y: number) =>
  px(c, x, y).join(',');

// =========================================================================
// 1. Default Weights on Primary & Secondary Colors
// =========================================================================
{
  const defParams = prepareBlackAndWhiteParams({
    type: 'black & white',
  });

  // Default weights: R:40, Y:60, G:40, C:60, B:20, M:80
  const red = evaluateBlackAndWhitePixel(255, 0, 0, defParams);
  const yellow = evaluateBlackAndWhitePixel(255, 255, 0, defParams);
  const green = evaluateBlackAndWhitePixel(0, 255, 0, defParams);
  const cyan = evaluateBlackAndWhitePixel(0, 255, 255, defParams);
  const blue = evaluateBlackAndWhitePixel(0, 0, 255, defParams);
  const magenta = evaluateBlackAndWhitePixel(255, 0, 255, defParams);

  log('bw-default-red', red[0] === 102 && red[1] === 102 && red[2] === 102, `red got ${red.join(',')}`);
  log('bw-default-yellow', yellow[0] === 153 && yellow[1] === 153 && yellow[2] === 153, `yellow got ${yellow.join(',')}`);
  log('bw-default-green', green[0] === 102 && green[1] === 102 && green[2] === 102, `green got ${green.join(',')}`);
  log('bw-default-cyan', cyan[0] === 153 && cyan[1] === 153 && cyan[2] === 153, `cyan got ${cyan.join(',')}`);
  log('bw-default-blue', blue[0] === 51 && blue[1] === 51 && blue[2] === 51, `blue got ${blue.join(',')}`);
  log('bw-default-magenta', magenta[0] === 204 && magenta[1] === 204 && magenta[2] === 204, `magenta got ${magenta.join(',')}`);
}

// =========================================================================
// 2. Neutral Gray, Black, and White Preservation
// =========================================================================
{
  const defParams = prepareBlackAndWhiteParams({ type: 'black & white' });

  const black = evaluateBlackAndWhitePixel(0, 0, 0, defParams);
  const white = evaluateBlackAndWhitePixel(255, 255, 255, defParams);
  const gray128 = evaluateBlackAndWhitePixel(128, 128, 128, defParams);
  const gray64 = evaluateBlackAndWhitePixel(64, 64, 64, defParams);

  log('bw-neutral-black', black[0] === 0 && black[1] === 0 && black[2] === 0, `black got ${black.join(',')}`);
  log('bw-neutral-white', white[0] === 255 && white[1] === 255 && white[2] === 255, `white got ${white.join(',')}`);
  log('bw-neutral-gray128', gray128[0] === 128 && gray128[1] === 128 && gray128[2] === 128, `gray128 got ${gray128.join(',')}`);
  log('bw-neutral-gray64', gray64[0] === 64 && gray64[1] === 64 && gray64[2] === 64, `gray64 got ${gray64.join(',')}`);
}

// =========================================================================
// 3. Custom Channel Weights (Sliders)
// =========================================================================
{
  // Reds maxed (100)
  const maxRedParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    reds: 100,
  });
  const maxRed = evaluateBlackAndWhitePixel(255, 0, 0, maxRedParams);
  log('bw-custom-red-max', maxRed[0] === 255 && maxRed[1] === 255 && maxRed[2] === 255, `reds=100 got ${maxRed.join(',')}`);

  // Reds zeroed (0)
  const zeroRedParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    reds: 0,
  });
  const zeroRed = evaluateBlackAndWhitePixel(255, 0, 0, zeroRedParams);
  log('bw-custom-red-zero', zeroRed[0] === 0 && zeroRed[1] === 0 && zeroRed[2] === 0, `reds=0 got ${zeroRed.join(',')}`);

  // Blues boosted (100)
  const maxBlueParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    blues: 100,
  });
  const maxBlue = evaluateBlackAndWhitePixel(0, 0, 255, maxBlueParams);
  log('bw-custom-blue-max', maxBlue[0] === 255 && maxBlue[1] === 255 && maxBlue[2] === 255, `blues=100 got ${maxBlue.join(',')}`);

  // Yellows boosted (100)
  const maxYellowParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    yellows: 100,
  });
  const maxYellow = evaluateBlackAndWhitePixel(255, 255, 0, maxYellowParams);
  log('bw-custom-yellow-max', maxYellow[0] === 255 && maxYellow[1] === 255 && maxYellow[2] === 255, `yellows=100 got ${maxYellow.join(',')}`);
}

// =========================================================================
// 4. Continuous Interpolation across Hue Sectors (Orange)
// =========================================================================
{
  // Orange: (255, 128, 0)
  // Has 127 red component (255-128) and 128 yellow component (128-0)
  // With default weights: 127 * 0.40 + 128 * 0.60 = 50.8 + 76.8 = 127.6 -> 128
  const defParams = prepareBlackAndWhiteParams({ type: 'black & white' });
  const orange = evaluateBlackAndWhitePixel(255, 128, 0, defParams);

  log('bw-interp-orange', orange[0] === 128 && orange[1] === 128 && orange[2] === 128, `orange got ${orange.join(',')}`);
}

// =========================================================================
// 5. Tint Support
// =========================================================================
{
  // Default Sepia Tint
  const sepiaParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    useTint: true,
  });

  const sepiaMid = evaluateBlackAndWhitePixel(128, 128, 128, sepiaParams);
  log(
    'bw-tint-sepia-mid',
    sepiaMid[0] > sepiaMid[1] && sepiaMid[1] > sepiaMid[2],
    `sepia mid is warm: ${sepiaMid.join(',')}`,
  );

  // Black and white points anchored
  const sepiaBlack = evaluateBlackAndWhitePixel(0, 0, 0, sepiaParams);
  const sepiaWhite = evaluateBlackAndWhitePixel(255, 255, 255, sepiaParams);
  log('bw-tint-black-anchored', sepiaBlack[0] === 0 && sepiaBlack[1] === 0 && sepiaBlack[2] === 0, `black got ${sepiaBlack.join(',')}`);
  log('bw-tint-white-anchored', sepiaWhite[0] === 255 && sepiaWhite[1] === 255 && sepiaWhite[2] === 255, `white got ${sepiaWhite.join(',')}`);

  // Custom Cyanotype Tint: { r: 150, g: 200, b: 240 } (cool blue/cyan)
  const cyanotypeParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    useTint: true,
    tintColor: { r: 150, g: 200, b: 240 },
  });
  const cyanotypeMid = evaluateBlackAndWhitePixel(128, 128, 128, cyanotypeParams);
  log(
    'bw-tint-cyanotype-mid',
    cyanotypeMid[2] > cyanotypeMid[1] && cyanotypeMid[1] > cyanotypeMid[0],
    `cyanotype mid is cool blue: ${cyanotypeMid.join(',')}`,
  );
}

// =========================================================================
// 6. Boundary Values and Clamping
// =========================================================================
{
  const extremeParams = prepareBlackAndWhiteParams({
    type: 'black & white',
    reds: 150,
    blues: -50,
  });

  const redExt = evaluateBlackAndWhitePixel(255, 0, 0, extremeParams);
  const blueExt = evaluateBlackAndWhitePixel(0, 0, 255, extremeParams);

  log('bw-bounds-clamped-high', redExt[0] === 255 && redExt[1] === 255 && redExt[2] === 255, `red got ${redExt.join(',')}`);
  log('bw-bounds-clamped-low', blueExt[0] === 0 && blueExt[1] === 0 && blueExt[2] === 0, `blue got ${blueExt.join(',')}`);
}

// =========================================================================
// 7. Stack Preview Rendering
// =========================================================================
const defaultBwAdj: BlackAndWhiteAdjustment = {
  type: 'black & white',
  reds: 40,
  yellows: 60,
  greens: 40,
  cyans: 60,
  blues: 20,
  magentas: 80,
};

{
  const cardLayer = rect('Card', 0, 0, W, H, '#ff0000'); // Pure red
  const bwLayer: Layer = {
    name: 'BW Layer',
    adjustment: { ...defaultBwAdj },
  };

  const doc = buildDoc([cardLayer, bwLayer]);
  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);

  log(
    'bw-preview-rendered',
    p[0] === 102 && p[1] === 102 && p[2] === 102,
    `preview pixel: ${p.slice(0, 3).join(',')} (expected 102,102,102)`,
  );
}

// =========================================================================
// 8. Opacity Blending (0%, 50%, 100%)
// =========================================================================
{
  const cardLayer = rect('Card', 0, 0, W, H, '#ff0000'); // Pure red (255, 0, 0)
  const bwLayer: Layer = {
    name: 'Opacity BW',
    opacity: 1.0,
    adjustment: { ...defaultBwAdj },
  };

  // Full opacity (100%): (102, 102, 102)
  const doc100 = buildDoc([cardLayer, bwLayer]);
  const p100 = px(composeDocPreview(doc100), 50, 50);

  // 0% Opacity -> (255, 0, 0)
  const doc0 = buildDoc([cardLayer, { ...bwLayer, opacity: 0.0 }]);
  const p0 = px(composeDocPreview(doc0), 50, 50);

  // 50% Opacity -> midway between (255, 0, 0) and (102, 102, 102)
  // R: (255 + 102) / 2 = 178.5 -> 179
  // G: (0 + 102) / 2 = 51
  // B: (0 + 102) / 2 = 51
  const doc50 = buildDoc([cardLayer, { ...bwLayer, opacity: 0.5 }]);
  const p50 = px(composeDocPreview(doc50), 50, 50);

  log('bw-opacity-0-percent', p0[0] === 255 && p0[1] === 0 && p0[2] === 0, `0% got ${p0.slice(0, 3).join(',')}`);
  log('bw-opacity-100-percent', p100[0] === 102 && p100[1] === 102 && p100[2] === 102, `100% got ${p100.slice(0, 3).join(',')}`);
  log(
    'bw-opacity-50-percent',
    Math.abs(p50[0] - 179) <= 1 && Math.abs(p50[1] - 51) <= 1,
    `50% got ${p50.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 9. Raster Masking
// =========================================================================
{
  const cardLayer = rect('Card', 0, 0, W, H, '#ff0000'); // Pure red
  // Mask covering left half [0, 0, 50, 100]
  const maskCanvas = fill(50, 100, '#ffffff');
  const bwLayer: Layer = {
    name: 'Masked BW',
    mask: {
      left: 0,
      top: 0,
      right: 50,
      bottom: 100,
      canvas: maskCanvas,
      defaultColor: 0, // outside mask is hidden
      disabled: false,
    },
    adjustment: { ...defaultBwAdj },
  };

  const doc = buildDoc([cardLayer, bwLayer]);
  const preview = composeDocPreview(doc);
  const pInside = px(preview, 25, 50); // Inside mask (left)
  const pOutside = px(preview, 75, 50); // Outside mask (right)

  log(
    'bw-mask-inside-applied',
    pInside[0] === 102 && pInside[1] === 102 && pInside[2] === 102,
    `inside got ${pInside.slice(0, 3).join(',')} (monochrome)`,
  );
  log(
    'bw-mask-outside-hidden',
    pOutside[0] === 255 && pOutside[1] === 0 && pOutside[2] === 0,
    `outside got ${pOutside.slice(0, 3).join(',')} (red)`,
  );

  // Disabled mask applies everywhere
  const bwNode = leaves(doc).find((n) => n.name === 'Masked BW')!;
  bwNode.src.mask!.disabled = true;
  const pDisabled = px(composeDocPreview(doc), 75, 50);
  log(
    'bw-mask-disabled-applies-everywhere',
    pDisabled[0] === 102 && pDisabled[1] === 102 && pDisabled[2] === 102,
    `disabled mask outside got ${pDisabled.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 10. Clipping Isolation (Clipped BW modifies Base ONLY)
// =========================================================================
{
  // Backdrop: Blue covering entire 100x100
  const backdrop = rect('Backdrop', 0, 0, W, H, '#0000ff');
  // Base art: Red covering left half [0, 0, 50, 100]
  const baseArt = rect('BaseArt', 0, 0, 50, 100, '#ff0000');
  // Clipped Black & White
  const clippedBw: Layer = {
    name: 'Clipped BW',
    clipping: true,
    adjustment: { ...defaultBwAdj },
  };

  const doc = buildDoc([backdrop, baseArt, clippedBw]);
  const preview = composeDocPreview(doc);
  const pBase = px(preview, 25, 50); // Inside base art (left)
  const pBackdrop = px(preview, 75, 50); // Outside base art (right)

  log(
    'bw-clipping-base-modified',
    pBase[0] === 102 && pBase[1] === 102 && pBase[2] === 102,
    `base art became monochrome: ${pBase.slice(0, 3).join(',')}`,
  );
  log(
    'bw-clipping-backdrop-isolated',
    pBackdrop[0] === 0 && pBackdrop[1] === 0 && pBackdrop[2] === 255,
    `backdrop remained blue: ${pBackdrop.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 11. Stack Order Verification
// =========================================================================
{
  // Bottom: Red #ff0000
  const bottom = rect('Bottom', 0, 0, W, H, '#ff0000');
  // Middle Black & White
  const middleBw: Layer = {
    name: 'Middle BW',
    adjustment: { ...defaultBwAdj },
  };
  // Top: Right half Blue #0000ff
  const top = rect('Top', 50, 0, 50, 100, '#0000ff');

  const doc = buildDoc([bottom, middleBw, top]);
  const preview = composeDocPreview(doc);
  const pLeft = px(preview, 25, 50); // Left: bottom layer shifted Red -> Gray (102)
  const pRight = px(preview, 75, 50); // Right: top layer above BW (untouched Blue)

  log(
    'bw-stack-bottom-affected',
    pLeft[0] === 102 && pLeft[1] === 102 && pLeft[2] === 102,
    `bottom layer turned gray: ${pLeft.slice(0, 3).join(',')}`,
  );
  log(
    'bw-stack-top-unaffected',
    pRight[0] === 0 && pRight[1] === 0 && pRight[2] === 255,
    `top layer remained blue: ${pRight.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 12. Non-Destructive Export & Re-Import Roundtrip
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080');
  const bwAdj: BlackAndWhiteAdjustment = {
    type: 'black & white',
    reds: 55,
    yellows: 65,
    greens: 45,
    cyans: 35,
    blues: 25,
    magentas: 75,
    useTint: true,
    tintColor: { r: 230, g: 215, b: 185 },
  };
  const bwLayer: Layer = {
    name: 'Roundtrip BW',
    adjustment: bwAdj,
  };

  const doc = buildDoc([baseLayer, bwLayer]);
  const exportedBytes = await exportPsd(doc);
  log(
    'bw-export-success',
    exportedBytes.byteLength > 0,
    `bytes=${exportedBytes.byteLength}`,
  );

  const reimported = importPsd('reimported-bw.psd', exportedBytes);
  const reimportedBw = leaves(reimported).find(
    (n) => n.name === 'Roundtrip BW',
  );

  log('bw-reimport-found', !!reimportedBw, 'BW layer found in re-imported PSD');
  const adj = reimportedBw?.src.adjustment as
    | BlackAndWhiteAdjustment
    | undefined;
  log('bw-reimport-type', adj?.type === 'black & white', `type=${adj?.type}`);

  log('bw-reimport-reds', adj?.reds === 55, `reds=${adj?.reds}`);
  log('bw-reimport-yellows', adj?.yellows === 65, `yellows=${adj?.yellows}`);
  log('bw-reimport-greens', adj?.greens === 45, `greens=${adj?.greens}`);
  log('bw-reimport-cyans', adj?.cyans === 35, `cyans=${adj?.cyans}`);
  log('bw-reimport-blues', adj?.blues === 25, `blues=${adj?.blues}`);
  log('bw-reimport-magentas', adj?.magentas === 75, `magentas=${adj?.magentas}`);
  log('bw-reimport-useTint', adj?.useTint === true, `useTint=${adj?.useTint}`);
  log('bw-reimport-tintColor', !!adj?.tintColor, `tintColor=${JSON.stringify(adj?.tintColor)}`);

  // Verify composite preview after reimport
  const reimportedPreview = composeDocPreview(reimported);
  const pReimported = px(reimportedPreview, 50, 50);
  log(
    'bw-reimport-preview-rendered',
    pReimported[3] === 255,
    `reimported preview=${pReimported.join(',')}`,
  );
}

// =========================================================================
// 13. Undo / Redo Determinism
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#ff0000'); // Red
  const bwLayer: Layer = {
    name: 'Undo BW',
    adjustment: { ...defaultBwAdj },
  };

  const doc = buildDoc([baseLayer, bwLayer]);
  const history = new History();
  const bwNode = leaves(doc).find((n) => n.name === 'Undo BW')!;

  const previewBefore = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'bw-undo-initial-state',
    previewBefore === '102,102,102,255',
    `initial: ${previewBefore}`,
  );

  // Modify BW layer visibility via history command
  history.exec({
    label: 'toggle bw visibility',
    do: () => {
      bwNode.visible = false;
    },
    undo: () => {
      bwNode.visible = true;
    },
  });

  const previewHidden = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'bw-undo-after-hide',
    previewHidden === '255,0,0,255',
    `hidden: ${previewHidden}`,
  );

  // Undo: should restore visible BW layer
  history.undo();
  const previewUndone = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'bw-undo-restored',
    previewUndone === previewBefore,
    `undone matches before: ${previewUndone}`,
  );

  // Redo: should hide BW layer again
  history.redo();
  const previewRedone = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'bw-redo-restored',
    previewRedone === previewHidden,
    `redone matches hidden: ${previewRedone}`,
  );
}

// =========================================================================
// Summary
// =========================================================================
console.log('--- Summary ---');
const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed!`);
  process.exit(1);
} else {
  console.log(`All ${results.length} Black & White regression tests passed!`);
}

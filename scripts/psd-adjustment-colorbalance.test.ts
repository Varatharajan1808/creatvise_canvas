/**
 * Synthetic and regression test suite for Color Balance adjustments (Milestone 2E).
 *
 * Validates:
 *   1. Identity behavior (omitted or all-zero shifts preserve colors exactly)
 *   2. Tonal weights partition of unity (ws + wm + wh === 1 everywhere)
 *   3. Positive and negative color shifts along Cyan-Red, Magenta-Green, Yellow-Blue
 *   4. Tonal range isolation (shadows, midtones, highlights affect respective tones)
 *   5. Preserve luminosity behavior (preserves Rec. 709 luminance within 1 level)
 *   6. Boundary values and extreme slider clamping (-100, +100, out of bounds)
 *   7. Stack preview rendering
 *   8. Opacity blending (0%, 50% linear interpolation, 100%)
 *   9. Raster masks (inside rect, defaultColor 0 vs 255 outside, disabled mask)
 *  10. Clipping isolation (clipped adjustment affects clip base ONLY, backdrop untouched)
 *  11. Stack order (layers above adjustment are not affected)
 *  12. Non-destructive export & re-import roundtrip (ag-psd blnc block preserved)
 *  13. Undo/Redo determinism
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import {
  initializeCanvas,
  writePsd,
  type Layer,
  type Psd,
  type ColorBalanceAdjustment,
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
  evaluateColorBalancePixel,
  prepareColorBalanceParams,
  getColorBalanceWeights,
} = await import('../src/psd/psdAdjustmentColorBalance');
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
  return importPsd('test-colorbalance.psd', writePsd(psd));
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

const luma = (r: number, g: number, b: number) =>
  0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);

// =========================================================================
// 1. Identity Math Tests
// =========================================================================
{
  const idParams = prepareColorBalanceParams({
    type: 'color balance',
    shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    midtones: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    preserveLuminosity: false,
  });
  log('cb-identity-flag', idParams.isIdentity === true, 'isIdentity is true');

  const red = evaluateColorBalancePixel(255, 0, 0, idParams);
  const green = evaluateColorBalancePixel(0, 255, 0, idParams);
  const blue = evaluateColorBalancePixel(0, 0, 255, idParams);
  const gray = evaluateColorBalancePixel(128, 128, 128, idParams);
  const custom = evaluateColorBalancePixel(200, 100, 50, idParams);

  log(
    'cb-identity-red',
    red[0] === 255 && red[1] === 0 && red[2] === 0,
    `red got ${red.join(',')}`,
  );
  log(
    'cb-identity-green',
    green[0] === 0 && green[1] === 255 && green[2] === 0,
    `green got ${green.join(',')}`,
  );
  log(
    'cb-identity-blue',
    blue[0] === 0 && blue[1] === 0 && blue[2] === 255,
    `blue got ${blue.join(',')}`,
  );
  log(
    'cb-identity-gray',
    gray[0] === 128 && gray[1] === 128 && gray[2] === 128,
    `gray got ${gray.join(',')}`,
  );
  log(
    'cb-identity-custom',
    custom[0] === 200 && custom[1] === 100 && custom[2] === 50,
    `custom got ${custom.join(',')}`,
  );
}

// =========================================================================
// 2. Partition of Unity & Weight Curve Properties
// =========================================================================
{
  const [w0s, w0m, w0h] = getColorBalanceWeights(0.0);
  log(
    'cb-weights-black',
    w0s === 1.0 && w0m === 0.0 && w0h === 0.0,
    `black: s=${w0s}, m=${w0m}, h=${w0h}`,
  );

  const [w50s, w50m, w50h] = getColorBalanceWeights(0.5);
  log(
    'cb-weights-mid',
    w50s === 0.0 && w50m === 1.0 && w50h === 0.0,
    `mid: s=${w50s}, m=${w50m}, h=${w50h}`,
  );

  const [w100s, w100m, w100h] = getColorBalanceWeights(1.0);
  log(
    'cb-weights-white',
    w100s === 0.0 && w100m === 0.0 && w100h === 1.0,
    `white: s=${w100s}, m=${w100m}, h=${w100h}`,
  );

  let unityOk = true;
  for (let l = 0; l <= 1.0001; l += 0.05) {
    const [ws, wm, wh] = getColorBalanceWeights(l);
    const sum = ws + wm + wh;
    if (Math.abs(sum - 1.0) > 1e-6) {
      unityOk = false;
      break;
    }
  }
  log('cb-weights-partition-of-unity', unityOk, 'weights sum to 1.0 everywhere');
}

// =========================================================================
// 3. Midtone Positive & Negative Color Shifts (Opponent Axes)
// =========================================================================
{
  // Cyan-Red: positive shifts Red, negative shifts Cyan (reduces Red)
  const redShift = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 30, magentaGreen: 0, yellowBlue: 0 },
    preserveLuminosity: false,
  });
  const resRed = evaluateColorBalancePixel(128, 128, 128, redShift);
  log(
    'cb-mid-red-positive',
    resRed[0] > 128 && resRed[1] === 128 && resRed[2] === 128,
    `red increased: ${resRed.join(',')}`,
  );

  const cyanShift = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: -30, magentaGreen: 0, yellowBlue: 0 },
    preserveLuminosity: false,
  });
  const resCyan = evaluateColorBalancePixel(128, 128, 128, cyanShift);
  log(
    'cb-mid-cyan-negative',
    resCyan[0] < 128 && resCyan[1] === 128 && resCyan[2] === 128,
    `red decreased (cyan): ${resCyan.join(',')}`,
  );

  // Magenta-Green: positive shifts Green, negative shifts Magenta (reduces Green)
  const greenShift = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 0, magentaGreen: 30, yellowBlue: 0 },
    preserveLuminosity: false,
  });
  const resGreen = evaluateColorBalancePixel(128, 128, 128, greenShift);
  log(
    'cb-mid-green-positive',
    resGreen[0] === 128 && resGreen[1] > 128 && resGreen[2] === 128,
    `green increased: ${resGreen.join(',')}`,
  );

  const magShift = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 0, magentaGreen: -30, yellowBlue: 0 },
    preserveLuminosity: false,
  });
  const resMag = evaluateColorBalancePixel(128, 128, 128, magShift);
  log(
    'cb-mid-magenta-negative',
    resMag[0] === 128 && resMag[1] < 128 && resMag[2] === 128,
    `green decreased (magenta): ${resMag.join(',')}`,
  );

  // Yellow-Blue: positive shifts Blue, negative shifts Yellow (reduces Blue)
  const blueShift = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 0, magentaGreen: 0, yellowBlue: 30 },
    preserveLuminosity: false,
  });
  const resBlue = evaluateColorBalancePixel(128, 128, 128, blueShift);
  log(
    'cb-mid-blue-positive',
    resBlue[0] === 128 && resBlue[1] === 128 && resBlue[2] > 128,
    `blue increased: ${resBlue.join(',')}`,
  );

  const yellowShift = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 0, magentaGreen: 0, yellowBlue: -30 },
    preserveLuminosity: false,
  });
  const resYellow = evaluateColorBalancePixel(128, 128, 128, yellowShift);
  log(
    'cb-mid-yellow-negative',
    resYellow[0] === 128 && resYellow[1] === 128 && resYellow[2] < 128,
    `blue decreased (yellow): ${resYellow.join(',')}`,
  );
}

// =========================================================================
// 4. Tonal Range Isolation (Shadows vs Highlights)
// =========================================================================
{
  const shadowRedParams = prepareColorBalanceParams({
    type: 'color balance',
    shadows: { cyanRed: 40, magentaGreen: 0, yellowBlue: 0 },
    preserveLuminosity: false,
  });
  const highlightRedParams = prepareColorBalanceParams({
    type: 'color balance',
    highlights: { cyanRed: 40, magentaGreen: 0, yellowBlue: 0 },
    preserveLuminosity: false,
  });

  // Dark pixel (L <= 0.25): shadows should shift, highlights must have 0 effect
  const darkPixel = [32, 32, 32];
  const darkShadowRes = evaluateColorBalancePixel(darkPixel[0], darkPixel[1], darkPixel[2], shadowRedParams);
  const darkHighlightRes = evaluateColorBalancePixel(darkPixel[0], darkPixel[1], darkPixel[2], highlightRedParams);

  log(
    'cb-isolation-shadow-affects-dark',
    darkShadowRes[0] > 32,
    `dark pixel red shifted to ${darkShadowRes[0]}`,
  );
  log(
    'cb-isolation-highlight-leaves-dark-alone',
    darkHighlightRes[0] === 32 && darkHighlightRes[1] === 32 && darkHighlightRes[2] === 32,
    `dark pixel untouched by highlights: ${darkHighlightRes.join(',')}`,
  );

  // Bright pixel (L >= 0.75): highlights should shift, shadows must have 0 effect
  const brightPixel = [224, 224, 224];
  const brightShadowRes = evaluateColorBalancePixel(brightPixel[0], brightPixel[1], brightPixel[2], shadowRedParams);
  const brightHighlightRes = evaluateColorBalancePixel(brightPixel[0], brightPixel[1], brightPixel[2], highlightRedParams);

  log(
    'cb-isolation-highlight-affects-bright',
    brightHighlightRes[0] > 224,
    `bright pixel red shifted to ${brightHighlightRes[0]}`,
  );
  log(
    'cb-isolation-shadow-leaves-bright-alone',
    brightShadowRes[0] === 224 && brightShadowRes[1] === 224 && brightShadowRes[2] === 224,
    `bright pixel untouched by shadows: ${brightShadowRes.join(',')}`,
  );
}

// =========================================================================
// 5. Preserve Luminosity Math
// =========================================================================
{
  // Midtone gray with preserveLuminosity: true
  const preserveRed = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 30, magentaGreen: 0, yellowBlue: 0 },
    preserveLuminosity: true,
  });
  const resPreserveRed = evaluateColorBalancePixel(128, 128, 128, preserveRed);

  const origL = luma(128, 128, 128);
  const newL = luma(resPreserveRed[0], resPreserveRed[1], resPreserveRed[2]);
  const lumaDiffByte = Math.abs(newL - origL) * 255;

  log(
    'cb-preserve-luma-red-shift',
    resPreserveRed[0] > 128 && resPreserveRed[1] < 128 && resPreserveRed[2] < 128,
    `red shifted up (${resPreserveRed[0]}), green/blue down (${resPreserveRed[1]}, ${resPreserveRed[2]})`,
  );
  log(
    'cb-preserve-luma-invariance',
    lumaDiffByte <= 1.0,
    `luminance difference: ${lumaDiffByte.toFixed(3)} levels (<= 1.0)`,
  );

  // Pure black (0, 0, 0) stays 0 with preserveLuminosity
  const blackRes = evaluateColorBalancePixel(0, 0, 0, preserveRed);
  log(
    'cb-preserve-luma-black-stays-black',
    blackRes[0] === 0 && blackRes[1] === 0 && blackRes[2] === 0,
    `black got ${blackRes.join(',')}`,
  );

  // Pure white (255, 255, 255) with highlight adjustment stays high brightness
  const preserveWhiteYellow = prepareColorBalanceParams({
    type: 'color balance',
    highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: -30 }, // Yellow (reduce blue)
    preserveLuminosity: true,
  });
  const whiteRes = evaluateColorBalancePixel(255, 255, 255, preserveWhiteYellow);
  log(
    'cb-preserve-luma-white-yellowed',
    whiteRes[0] === 255 && whiteRes[1] === 255 && whiteRes[2] < 255,
    `white became yellowed: ${whiteRes.join(',')}`,
  );
}

// =========================================================================
// 6. Boundary Values and Clamping
// =========================================================================
{
  const extremeParams = prepareColorBalanceParams({
    type: 'color balance',
    shadows: { cyanRed: 100, magentaGreen: -100, yellowBlue: 100 },
    midtones: { cyanRed: -100, magentaGreen: 100, yellowBlue: -100 },
    highlights: { cyanRed: 100, magentaGreen: 100, yellowBlue: -100 },
    preserveLuminosity: false,
  });

  const resMin = evaluateColorBalancePixel(0, 0, 0, extremeParams);
  const resMid = evaluateColorBalancePixel(128, 128, 128, extremeParams);
  const resMax = evaluateColorBalancePixel(255, 255, 255, extremeParams);

  const inBounds = (c: [number, number, number]) =>
    c.every((v) => Number.isFinite(v) && v >= 0 && v <= 255);

  log('cb-bounds-min', inBounds(resMin), `min got ${resMin.join(',')}`);
  log('cb-bounds-mid', inBounds(resMid), `mid got ${resMid.join(',')}`);
  log('cb-bounds-max', inBounds(resMax), `max got ${resMax.join(',')}`);

  // Out of bounds slider values (e.g. +150, -200) clamped cleanly
  const outOfBounds = prepareColorBalanceParams({
    type: 'color balance',
    midtones: { cyanRed: 150, magentaGreen: -200, yellowBlue: 0 },
  });
  log(
    'cb-bounds-slider-clamp',
    outOfBounds.mCR === 1.0 && outOfBounds.mMG === -1.0,
    `clamped mCR=${outOfBounds.mCR}, mMG=${outOfBounds.mMG}`,
  );
}

// =========================================================================
// 7. Stack Preview Rendering
// =========================================================================
{
  const cardLayer = rect('Card', 0, 0, W, H, '#808080'); // 128 gray
  const cbLayer: Layer = {
    name: 'Color Balance 1',
    adjustment: {
      type: 'color balance',
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 },
      preserveLuminosity: false,
    },
  };

  const doc = buildDoc([cardLayer, cbLayer]);
  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);

  log(
    'cb-preview-rendered',
    p[0] > 128 && p[1] === 128 && p[2] === 128,
    `preview pixel: ${p.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 8. Opacity Blending (0%, 50%, 100%)
// =========================================================================
{
  const cardLayer = rect('Card', 0, 0, W, H, '#808080'); // 128 gray
  const cbLayer: Layer = {
    name: 'Opacity CB',
    opacity: 1.0,
    adjustment: {
      type: 'color balance',
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 },
      preserveLuminosity: false,
    },
  };

  // Full opacity (100%)
  const doc100 = buildDoc([cardLayer, cbLayer]);
  const p100 = px(composeDocPreview(doc100), 50, 50);

  // 0% Opacity -> unchanged
  const doc0 = buildDoc([cardLayer, { ...cbLayer, opacity: 0.0 }]);
  const p0 = px(composeDocPreview(doc0), 50, 50);

  // 50% Opacity -> midway
  const doc50 = buildDoc([cardLayer, { ...cbLayer, opacity: 0.5 }]);
  const p50 = px(composeDocPreview(doc50), 50, 50);

  log(
    'cb-opacity-0-percent',
    p0[0] === 128 && p0[1] === 128 && p0[2] === 128,
    `0% opacity got ${p0.slice(0, 3).join(',')}`,
  );
  log('cb-opacity-100-percent', p100[0] > 128, `100% opacity got ${p100.slice(0, 3).join(',')}`);
  const expectedMidRed = Math.round((p0[0] + p100[0]) / 2);
  log(
    'cb-opacity-50-percent',
    Math.abs(p50[0] - expectedMidRed) <= 1,
    `50% got ${p50[0]}, expected ~${expectedMidRed}`,
  );
}

// =========================================================================
// 9. Raster Masking
// =========================================================================
{
  const cardLayer = rect('Card', 0, 0, W, H, '#808080');
  // Mask covering left half [0, 0, 50, 100] with white (255)
  const maskCanvas = fill(50, 100, '#ffffff');
  const cbLayer: Layer = {
    name: 'Masked CB',
    mask: {
      left: 0,
      top: 0,
      right: 50,
      bottom: 100,
      canvas: maskCanvas,
      defaultColor: 0, // outside mask is hidden
      disabled: false,
    },
    adjustment: {
      type: 'color balance',
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 },
      preserveLuminosity: false,
    },
  };

  const doc = buildDoc([cardLayer, cbLayer]);
  const preview = composeDocPreview(doc);
  const pInside = px(preview, 25, 50); // Inside mask (left)
  const pOutside = px(preview, 75, 50); // Outside mask (right)

  log(
    'cb-mask-inside-applied',
    pInside[0] > 128 && pInside[1] === 128 && pInside[2] === 128,
    `inside got ${pInside.slice(0, 3).join(',')}`,
  );
  log(
    'cb-mask-outside-hidden',
    pOutside[0] === 128 && pOutside[1] === 128 && pOutside[2] === 128,
    `outside got ${pOutside.slice(0, 3).join(',')}`,
  );

  // Disabled mask applies everywhere
  const cbNode = leaves(doc).find((n) => n.name === 'Masked CB')!;
  cbNode.src.mask!.disabled = true;
  const pDisabled = px(composeDocPreview(doc), 75, 50);
  log(
    'cb-mask-disabled-applies-everywhere',
    pDisabled[0] > 128,
    `disabled mask outside got ${pDisabled.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 10. Clipping Isolation (Clipped CB modifies Base ONLY)
// =========================================================================
{
  // Backdrop: Blue covering entire 100x100
  const backdrop = rect('Backdrop', 0, 0, W, H, '#0000ff');
  // Base art: Gray covering left half [0, 0, 50, 100]
  const baseArt = rect('BaseArt', 0, 0, 50, 100, '#808080');
  // Clipped Color Balance: shifts Red +50
  const clippedCb: Layer = {
    name: 'Clipped CB',
    clipping: true,
    adjustment: {
      type: 'color balance',
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 },
      preserveLuminosity: false,
    },
  };

  const doc = buildDoc([backdrop, baseArt, clippedCb]);
  const preview = composeDocPreview(doc);
  const pBase = px(preview, 25, 50); // Inside base art (left)
  const pBackdrop = px(preview, 75, 50); // Outside base art (right)

  log(
    'cb-clipping-base-modified',
    pBase[0] > 128 && pBase[1] === 128 && pBase[2] === 128,
    `base art red-shifted: ${pBase.slice(0, 3).join(',')}`,
  );
  log(
    'cb-clipping-backdrop-isolated',
    pBackdrop[0] === 0 && pBackdrop[1] === 0 && pBackdrop[2] === 255,
    `backdrop remained blue: ${pBackdrop.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 11. Stack Order Verification
// =========================================================================
{
  // Bottom: Gray #808080
  const bottom = rect('Bottom', 0, 0, W, H, '#808080');
  // Middle Color Balance: shifts Red +50
  const middleCb: Layer = {
    name: 'Middle CB',
    adjustment: {
      type: 'color balance',
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 },
      preserveLuminosity: false,
    },
  };
  // Top: Right half Blue #0000ff
  const top = rect('Top', 50, 0, 50, 100, '#0000ff');

  const doc = buildDoc([bottom, middleCb, top]);
  const preview = composeDocPreview(doc);
  const pLeft = px(preview, 25, 50); // Left: bottom layer shifted Gray -> Reddish
  const pRight = px(preview, 75, 50); // Right: top layer above CB (untouched Blue)

  log(
    'cb-stack-bottom-affected',
    pLeft[0] > 128,
    `bottom layer red-shifted: ${pLeft.slice(0, 3).join(',')}`,
  );
  log(
    'cb-stack-top-unaffected',
    pRight[0] === 0 && pRight[1] === 0 && pRight[2] === 255,
    `top layer remained blue: ${pRight.slice(0, 3).join(',')}`,
  );
}

// =========================================================================
// 12. Non-Destructive Export & Re-Import Roundtrip
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080');
  const cbAdj: ColorBalanceAdjustment = {
    type: 'color balance',
    shadows: { cyanRed: -15, magentaGreen: 10, yellowBlue: -20 },
    midtones: { cyanRed: 25, magentaGreen: -30, yellowBlue: 35 },
    highlights: { cyanRed: -10, magentaGreen: 5, yellowBlue: -15 },
    preserveLuminosity: true,
  };
  const cbLayer: Layer = {
    name: 'Roundtrip CB',
    adjustment: cbAdj,
  };

  const doc = buildDoc([baseLayer, cbLayer]);
  const exportedBytes = await exportPsd(doc);
  log(
    'cb-export-success',
    exportedBytes.byteLength > 0,
    `bytes=${exportedBytes.byteLength}`,
  );

  const reimported = importPsd('reimported-colorbalance.psd', exportedBytes);
  const reimportedCb = leaves(reimported).find(
    (n) => n.name === 'Roundtrip CB',
  );

  log('cb-reimport-found', !!reimportedCb, 'CB layer found in re-imported PSD');
  const adj = reimportedCb?.src.adjustment as
    | ColorBalanceAdjustment
    | undefined;
  log('cb-reimport-type', adj?.type === 'color balance', `type=${adj?.type}`);

  log(
    'cb-reimport-shadows',
    adj?.shadows?.cyanRed === -15 &&
      adj?.shadows?.magentaGreen === 10 &&
      adj?.shadows?.yellowBlue === -20,
    `shadows=${JSON.stringify(adj?.shadows)}`,
  );
  log(
    'cb-reimport-midtones',
    adj?.midtones?.cyanRed === 25 &&
      adj?.midtones?.magentaGreen === -30 &&
      adj?.midtones?.yellowBlue === 35,
    `midtones=${JSON.stringify(adj?.midtones)}`,
  );
  log(
    'cb-reimport-highlights',
    adj?.highlights?.cyanRed === -10 &&
      adj?.highlights?.magentaGreen === 5 &&
      adj?.highlights?.yellowBlue === -15,
    `highlights=${JSON.stringify(adj?.highlights)}`,
  );
  log(
    'cb-reimport-preserve-luminosity',
    adj?.preserveLuminosity === true,
    `preserveLuminosity=${adj?.preserveLuminosity}`,
  );

  // Verify composite preview after reimport
  const reimportedPreview = composeDocPreview(reimported);
  const pReimported = px(reimportedPreview, 50, 50);
  log(
    'cb-reimport-preview-rendered',
    pReimported[3] === 255,
    `reimported preview=${pReimported.join(',')}`,
  );
}

// =========================================================================
// 13. Undo / Redo Determinism
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080');
  const cbLayer: Layer = {
    name: 'Undo CB',
    adjustment: {
      type: 'color balance',
      midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 },
      preserveLuminosity: false,
    },
  };

  const doc = buildDoc([baseLayer, cbLayer]);
  const history = new History();
  const cbNode = leaves(doc).find((n) => n.name === 'Undo CB')!;

  const previewBefore = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'cb-undo-initial-state',
    previewBefore !== '128,128,128,255',
    `initial: ${previewBefore}`,
  );

  // Modify CB layer visibility via history command
  history.exec({
    label: 'toggle cb visibility',
    do: () => {
      cbNode.visible = false;
    },
    undo: () => {
      cbNode.visible = true;
    },
  });

  const previewHidden = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'cb-undo-after-hide',
    previewHidden === '128,128,128,255',
    `hidden: ${previewHidden}`,
  );

  // Undo: should restore visible CB layer
  history.undo();
  const previewUndone = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'cb-undo-restored',
    previewUndone === previewBefore,
    `undone matches before: ${previewUndone}`,
  );

  // Redo: should hide CB layer again
  history.redo();
  const previewRedone = pxStr(composeDocPreview(doc), 50, 50);
  log(
    'cb-redo-restored',
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
  console.log(`All ${results.length} Color Balance regression tests passed!`);
}

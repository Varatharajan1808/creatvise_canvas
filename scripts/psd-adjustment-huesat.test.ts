/**
 * Synthetic and regression test suite for Hue/Saturation adjustments (Milestone 2D).
 *
 * Validates:
 *   1. Identity behavior (omitted or 0/0/0 shifts preserve colors exactly)
 *   2. Hue shifts (+60 yellow, +120 green, +180 cyan, -60 magenta, gray neutrality)
 *   3. Saturation increase/decrease (-100 gray, -50 partial, gray neutrality)
 *   4. Lightness changes (+100 white, -100 black, +50 light red, -50 dark red)
 *   5. Targeted sector ranges (reds, blues, trapezoidal falloff weight)
 *   6. Stack preview rendering
 *   7. Raster masks (inside rect, defaultColor 0 vs 255 outside, disabled mask)
 *   8. Opacity blending (0%, 50% linear interpolation, 100%)
 *   9. Clipping isolation (clipped adjustment affects clip base ONLY, backdrop untouched)
 *  10. Stack order (layers above adjustment are not affected)
 *  11. Non-destructive export & re-import roundtrip (ag-psd hue2 block preserved)
 *  12. Undo/Redo determinism
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd, type HueSaturationAdjustment } from 'ag-psd';

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

const { importPsd, exportPsd } = await import('../src/psd');
const { leaves, walk } = await import('../src/model');
const { composeDocPreview } = await import('../src/psdComposite');
const {
  evaluateHueSaturationPixel,
  prepareHueSaturationParams,
  getTrapezoidWeight,
} = await import('../src/psdAdjustmentHueSaturation');
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

function buildDoc(children: Layer[], bgCss = '#808080'): Doc {
  const psd: Psd = { width: W, height: H, children };
  psd.canvas = fill(W, H, bgCss);
  return importPsd('test-huesat.psd', writePsd(psd));
}

const px = (c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] => {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

const pxStr = (c: HTMLCanvasElement, x: number, y: number) => px(c, x, y).join(',');

// =========================================================================
// 1. Identity Math Tests
// =========================================================================
{
  const idParams = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 },
  });
  log('huesat-identity-flag', idParams.isIdentity === true, 'isIdentity is true');

  const red = evaluateHueSaturationPixel(255, 0, 0, idParams);
  const green = evaluateHueSaturationPixel(0, 255, 0, idParams);
  const blue = evaluateHueSaturationPixel(0, 0, 255, idParams);
  const gray = evaluateHueSaturationPixel(128, 128, 128, idParams);
  const custom = evaluateHueSaturationPixel(200, 100, 50, idParams);

  log('huesat-identity-red', red[0] === 255 && red[1] === 0 && red[2] === 0, `red got ${red.join(',')}`);
  log('huesat-identity-green', green[0] === 0 && green[1] === 255 && green[2] === 0, `green got ${green.join(',')}`);
  log('huesat-identity-blue', blue[0] === 0 && blue[1] === 0 && blue[2] === 255, `blue got ${blue.join(',')}`);
  log('huesat-identity-gray', gray[0] === 128 && gray[1] === 128 && gray[2] === 128, `gray got ${gray.join(',')}`);
  log('huesat-identity-custom', custom[0] === 200 && custom[1] === 100 && custom[2] === 50, `custom got ${custom.join(',')}`);
}

// =========================================================================
// 2. Hue Shifts
// =========================================================================
{
  // A. Red [255, 0, 0] + Hue 60 -> Yellow [255, 255, 0]
  const p60 = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 60, saturation: 0, lightness: 0 },
  });
  const yel = evaluateHueSaturationPixel(255, 0, 0, p60);
  log('huesat-shift-60-yellow', yel[0] === 255 && yel[1] === 255 && yel[2] === 0, `got ${yel.join(',')}`);

  // B. Red [255, 0, 0] + Hue 120 -> Green [0, 255, 0]
  const p120 = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 120, saturation: 0, lightness: 0 },
  });
  const grn = evaluateHueSaturationPixel(255, 0, 0, p120);
  log('huesat-shift-120-green', grn[0] === 0 && grn[1] === 255 && grn[2] === 0, `got ${grn.join(',')}`);

  // C. Red [255, 0, 0] + Hue 180 -> Cyan [0, 255, 255]
  const p180 = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 180, saturation: 0, lightness: 0 },
  });
  const cyn = evaluateHueSaturationPixel(255, 0, 0, p180);
  log('huesat-shift-180-cyan', cyn[0] === 0 && cyn[1] === 255 && cyn[2] === 255, `got ${cyn.join(',')}`);

  // D. Red [255, 0, 0] + Hue -60 -> Magenta [255, 0, 255]
  const pNeg60 = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: -60, saturation: 0, lightness: 0 },
  });
  const mag = evaluateHueSaturationPixel(255, 0, 0, pNeg60);
  log('huesat-shift-neg60-magenta', mag[0] === 255 && mag[1] === 0 && mag[2] === 255, `got ${mag.join(',')}`);

  // E. Achromatic neutrality: gray [128, 128, 128] shifted by Hue +60 remains gray
  const grayShift = evaluateHueSaturationPixel(128, 128, 128, p60);
  log('huesat-shift-gray-neutrality', grayShift[0] === 128 && grayShift[1] === 128 && grayShift[2] === 128, `gray got ${grayShift.join(',')}`);
}

// =========================================================================
// 3. Saturation Adjustments
// =========================================================================
{
  // A. Saturation -100 on Red [255, 0, 0] -> Grayscale [128, 128, 128]
  const pDesat = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: -100, lightness: 0 },
  });
  const grayFromRed = evaluateHueSaturationPixel(255, 0, 0, pDesat);
  log('huesat-sat-minus-100-gray', grayFromRed[0] === 128 && grayFromRed[1] === 128 && grayFromRed[2] === 128, `got ${grayFromRed.join(',')}`);

  // B. Saturation -50 on Red [255, 0, 0] -> Partial desaturation [191, 64, 64]
  const pHalfDesat = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: -50, lightness: 0 },
  });
  const halfRed = evaluateHueSaturationPixel(255, 0, 0, pHalfDesat);
  log('huesat-sat-minus-50-partial', Math.abs(halfRed[0] - 191) <= 1 && Math.abs(halfRed[1] - 64) <= 1 && Math.abs(halfRed[2] - 64) <= 1, `got ${halfRed.join(',')}`);

  // C. Saturation boost on muted color [180, 100, 100] (boosts delta)
  const pBoost = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 50, lightness: 0 },
  });
  const boosted = evaluateHueSaturationPixel(180, 100, 100, pBoost);
  log('huesat-sat-plus-50-boosts-chroma', boosted[0] > 180 && boosted[1] < 100 && boosted[2] < 100, `got ${boosted.join(',')}`);

  // D. Saturation boost on neutral gray [128, 128, 128] preserves gray (no color hallucination)
  const grayBoost = evaluateHueSaturationPixel(128, 128, 128, pBoost);
  log('huesat-sat-plus-50-gray-preserved', grayBoost[0] === 128 && grayBoost[1] === 128 && grayBoost[2] === 128, `gray got ${grayBoost.join(',')}`);
}

// =========================================================================
// 4. Lightness Adjustments
// =========================================================================
{
  // A. Lightness +100 on Red [255, 0, 0] -> Pure White [255, 255, 255]
  const pWhite = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 100 },
  });
  const white = evaluateHueSaturationPixel(255, 0, 0, pWhite);
  log('huesat-light-plus-100-white', white[0] === 255 && white[1] === 255 && white[2] === 255, `got ${white.join(',')}`);

  // B. Lightness -100 on Red [255, 0, 0] -> Pure Black [0, 0, 0]
  const pBlack = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: -100 },
  });
  const black = evaluateHueSaturationPixel(255, 0, 0, pBlack);
  log('huesat-light-minus-100-black', black[0] === 0 && black[1] === 0 && black[2] === 0, `got ${black.join(',')}`);

  // C. Lightness +50 on Red [255, 0, 0] -> Light Red [255, 128, 128]
  const pLight50 = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 50 },
  });
  const lightRed = evaluateHueSaturationPixel(255, 0, 0, pLight50);
  log('huesat-light-plus-50-light-red', lightRed[0] === 255 && Math.abs(lightRed[1] - 128) <= 1 && Math.abs(lightRed[2] - 128) <= 1, `got ${lightRed.join(',')}`);

  // D. Lightness -50 on Red [255, 0, 0] -> Dark Red [128, 0, 0]
  const pDark50 = prepareHueSaturationParams({
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: -50 },
  });
  const darkRed = evaluateHueSaturationPixel(255, 0, 0, pDark50);
  log('huesat-light-minus-50-dark-red', Math.abs(darkRed[0] - 128) <= 1 && darkRed[1] === 0 && darkRed[2] === 0, `got ${darkRed.join(',')}`);
}

// =========================================================================
// 5. Targeted Sector Range Channels (Reds, Blues, Falloff)
// =========================================================================
{
  // A. Reds sector adjustment only: hue +60
  const pRedsOnly = prepareHueSaturationParams({
    type: 'hue/saturation',
    reds: { a: 315, b: 345, c: 15, d: 45, hue: 60, saturation: 0, lightness: 0 },
  });
  const redToYel = evaluateHueSaturationPixel(255, 0, 0, pRedsOnly);
  const blueUntouched = evaluateHueSaturationPixel(0, 0, 255, pRedsOnly);
  const greenUntouched = evaluateHueSaturationPixel(0, 255, 0, pRedsOnly);

  log('huesat-sector-red-shifted', redToYel[0] === 255 && redToYel[1] === 255 && redToYel[2] === 0, `red shifted to yellow: ${redToYel.join(',')}`);
  log('huesat-sector-blue-untouched', blueUntouched[0] === 0 && blueUntouched[1] === 0 && blueUntouched[2] === 255, `blue untouched: ${blueUntouched.join(',')}`);
  log('huesat-sector-green-untouched', greenUntouched[0] === 0 && greenUntouched[1] === 255 && greenUntouched[2] === 0, `green untouched: ${greenUntouched.join(',')}`);

  // B. Blues sector adjustment only: lightness +50
  const pBluesOnly = prepareHueSaturationParams({
    type: 'hue/saturation',
    blues: { a: 195, b: 225, c: 255, d: 285, hue: 0, saturation: 0, lightness: 50 },
  });
  const blueBrightened = evaluateHueSaturationPixel(0, 0, 255, pBluesOnly);
  const redUntouched = evaluateHueSaturationPixel(255, 0, 0, pBluesOnly);

  log('huesat-sector-blue-brightened', blueBrightened[0] === 128 && blueBrightened[1] === 128 && blueBrightened[2] === 255, `blue brightened: ${blueBrightened.join(',')}`);
  log('huesat-sector-red-untouched-by-blue', redUntouched[0] === 255 && redUntouched[1] === 0 && redUntouched[2] === 0, `red untouched: ${redUntouched.join(',')}`);

  // C. Falloff weight verification
  const rng = pRedsOnly.ranges[0];
  log('huesat-falloff-center-weight-1', getTrapezoidWeight(0, rng) === 1, 'center hue 0 has weight 1.0');
  log('huesat-falloff-ramp-weight-half', Math.abs(getTrapezoidWeight(330, rng) - 0.5) < 1e-4, 'ramp hue 330 has weight 0.5');
  log('huesat-falloff-outside-weight-zero', getTrapezoidWeight(120, rng) === 0, 'outside hue 120 has weight 0.0');
}

// =========================================================================
// 6. Stack Preview Rendering: Basic Hue/Saturation
// =========================================================================
{
  // Red card [255, 0, 0] shifted +60 to Yellow [255, 255, 0]
  const cardLayer = rect('RedCard', 0, 0, W, H, '#ff0000');
  const hsLayer: Layer = {
    name: 'Hue Shift Layer',
    adjustment: {
      type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 60, saturation: 0, lightness: 0 },
    },
  };

  const doc = buildDoc([cardLayer, hsLayer]);
  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  log('huesat-preview-basic', p[0] === 255 && p[1] === 255 && p[2] === 0, `got ${p.slice(0, 3).join(',')} (expected 255,255,0)`);
}

// =========================================================================
// 7. Opacity Blending (0%, 50%, 100%)
// =========================================================================
{
  const cardLayer = rect('RedCard', 0, 0, W, H, '#ff0000'); // 255, 0, 0
  // Shift Hue +120 -> Green [0, 255, 0]
  const hsLayer: Layer = {
    name: 'Green Shift',
    opacity: 0.5,
    adjustment: {
      type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 120, saturation: 0, lightness: 0 },
    },
  };

  const doc = buildDoc([cardLayer, hsLayer]);
  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  // 50% blend between [255, 0, 0] and [0, 255, 0]: ~[128, 128, 0]
  log('huesat-opacity-50-percent', Math.abs(p[0] - 128) <= 1 && Math.abs(p[1] - 128) <= 1 && p[2] === 0, `got ${p.slice(0, 3).join(',')} (expected ~128,128,0)`);

  // 0% opacity
  const hsNode = leaves(doc).find((n) => n.name === 'Green Shift')!;
  hsNode.opacity = 0;
  const p0 = px(composeDocPreview(doc), 50, 50);
  log('huesat-opacity-zero-percent', p0[0] === 255 && p0[1] === 0 && p0[2] === 0, `got ${p0.slice(0, 3).join(',')} (expected 255,0,0)`);
}

// =========================================================================
// 8. Raster Masks on Hue/Saturation
// =========================================================================
{
  const cardLayer = rect('RedCard', 0, 0, W, H, '#ff0000'); // Red
  const maskCanvas = fill(50, 100, '#ffffff'); // Left half covered
  const hsLayer: Layer = {
    name: 'Masked HueSat',
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
      type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 60, saturation: 0, lightness: 0 }, // Yellow
    },
  };

  const doc = buildDoc([cardLayer, hsLayer]);
  const preview = composeDocPreview(doc);
  const pInside = px(preview, 25, 50); // Inside mask (left)
  const pOutside = px(preview, 75, 50); // Outside mask (right)

  log('huesat-mask-inside-applied', pInside[0] === 255 && pInside[1] === 255 && pInside[2] === 0, `inside got ${pInside.slice(0, 3).join(',')} (yellow)`);
  log('huesat-mask-outside-hidden', pOutside[0] === 255 && pOutside[1] === 0 && pOutside[2] === 0, `outside got ${pOutside.slice(0, 3).join(',')} (red)`);

  // Disabled mask applies everywhere
  const hsNode = leaves(doc).find((n) => n.name === 'Masked HueSat')!;
  hsNode.src.mask!.disabled = true;
  const pDisabled = px(composeDocPreview(doc), 75, 50);
  log('huesat-mask-disabled-applies-everywhere', pDisabled[0] === 255 && pDisabled[1] === 255 && pDisabled[2] === 0, `disabled mask outside got ${pDisabled.slice(0, 3).join(',')} (yellow)`);
}

// =========================================================================
// 9. Clipping Isolation (Clipped HueSat modifies Base ONLY)
// =========================================================================
{
  // Backdrop: Blue covering entire 100x100
  const backdrop = rect('Backdrop', 0, 0, W, H, '#0000ff');
  // Base art: Red covering left half [0, 0, 50, 100]
  const baseArt = rect('BaseArt', 0, 0, 50, 100, '#ff0000');
  // Clipped Hue/Saturation: shifts Hue +60 (Red -> Yellow, Blue -> Magenta)
  const clippedHs: Layer = {
    name: 'Clipped HueSat',
    clipping: true,
    adjustment: {
      type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 60, saturation: 0, lightness: 0 },
    },
  };

  const doc = buildDoc([backdrop, baseArt, clippedHs]);
  const preview = composeDocPreview(doc);
  const pBase = px(preview, 25, 50);     // Inside base art (left)
  const pBackdrop = px(preview, 75, 50); // Outside base art (right)

  log('huesat-clipping-base-modified', pBase[0] === 255 && pBase[1] === 255 && pBase[2] === 0, `base art turned yellow: ${pBase.slice(0, 3).join(',')}`);
  log('huesat-clipping-backdrop-isolated', pBackdrop[0] === 0 && pBackdrop[1] === 0 && pBackdrop[2] === 255, `backdrop remained blue: ${pBackdrop.slice(0, 3).join(',')}`);
}

// =========================================================================
// 10. Stack Order Verification
// =========================================================================
{
  // Bottom: Red #ff0000
  const bottom = rect('Bottom', 0, 0, W, H, '#ff0000');
  // Middle HueSat: shifts Hue +60 (Red -> Yellow)
  const middleHs: Layer = {
    name: 'Middle HueSat',
    adjustment: {
      type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 60, saturation: 0, lightness: 0 },
    },
  };
  // Top: Right half Blue #0000ff
  const top = rect('Top', 50, 0, 50, 100, '#0000ff');

  const doc = buildDoc([bottom, middleHs, top]);
  const preview = composeDocPreview(doc);
  const pLeft = px(preview, 25, 50);  // Left: bottom layer shifted Red -> Yellow
  const pRight = px(preview, 75, 50); // Right: top layer above HueSat (untouched Blue)

  log('huesat-stack-bottom-affected', pLeft[0] === 255 && pLeft[1] === 255 && pLeft[2] === 0, `bottom layer turned yellow: ${pLeft.slice(0, 3).join(',')}`);
  log('huesat-stack-top-unaffected', pRight[0] === 0 && pRight[1] === 0 && pRight[2] === 255, `top layer remained blue: ${pRight.slice(0, 3).join(',')}`);
}

// =========================================================================
// 11. Non-Destructive Export & Re-Import Roundtrip
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#ff0000');
  const hsAdj: HueSaturationAdjustment = {
    type: 'hue/saturation',
    master: { a: 0, b: 0, c: 0, d: 0, hue: 45, saturation: -25, lightness: 15 },
    reds: { a: 315, b: 345, c: 15, d: 45, hue: 10, saturation: 5, lightness: -5 },
  };
  const hsLayer: Layer = {
    name: 'Roundtrip HueSat',
    adjustment: hsAdj,
  };

  const doc = buildDoc([baseLayer, hsLayer]);
  const exportedBytes = await exportPsd(doc);
  log('huesat-export-success', exportedBytes.byteLength > 0, `bytes=${exportedBytes.byteLength}`);

  const reimported = importPsd('reimported-huesat.psd', exportedBytes);
  const reimportedHs = leaves(reimported).find((n) => n.name === 'Roundtrip HueSat');

  log('huesat-reimport-found', !!reimportedHs, 'HueSat layer found in re-imported PSD');
  const adj = reimportedHs?.src.adjustment as HueSaturationAdjustment | undefined;
  log('huesat-reimport-type', adj?.type === 'hue/saturation', `type=${adj?.type}`);

  log('huesat-reimport-master-hue', adj?.master?.hue === 45, `master hue=${adj?.master?.hue}`);
  log('huesat-reimport-master-sat', adj?.master?.saturation === -25, `master sat=${adj?.master?.saturation}`);
  log('huesat-reimport-master-light', adj?.master?.lightness === 15, `master light=${adj?.master?.lightness}`);
  log('huesat-reimport-reds-channel', adj?.reds?.hue === 10 && adj?.reds?.a === 315, `reds=${JSON.stringify(adj?.reds)}`);

  // Verify composite preview after reimport
  const reimportedPreview = composeDocPreview(reimported);
  const pReimported = px(reimportedPreview, 50, 50);
  log('huesat-reimport-preview-rendered', pReimported[0] > 0 && pReimported[3] === 255, `reimported preview=${pReimported.join(',')}`);
}

// =========================================================================
// 12. Undo / Redo Determinism
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#ff0000'); // Red
  const hsLayer: Layer = {
    name: 'Undo HueSat',
    adjustment: {
      type: 'hue/saturation',
      master: { a: 0, b: 0, c: 0, d: 0, hue: 60, saturation: 0, lightness: 0 }, // Yellow
    },
  };

  const doc = buildDoc([baseLayer, hsLayer]);
  const history = new History();
  const hsNode = leaves(doc).find((n) => n.name === 'Undo HueSat')!;

  const previewBefore = pxStr(composeDocPreview(doc), 50, 50);
  log('huesat-undo-initial-state', previewBefore === '255,255,0,255', `initial: ${previewBefore}`);

  // Modify HueSat layer visibility via history command
  history.exec({
    label: 'toggle huesat visibility',
    do: () => {
      hsNode.visible = false;
    },
    undo: () => {
      hsNode.visible = true;
    },
  });

  const previewHidden = pxStr(composeDocPreview(doc), 50, 50);
  log('huesat-undo-after-hide', previewHidden === '255,0,0,255', `hidden: ${previewHidden}`);

  // Undo: should restore visible HueSat layer (Yellow)
  history.undo();
  const previewUndone = pxStr(composeDocPreview(doc), 50, 50);
  log('huesat-undo-restored', previewUndone === '255,255,0,255', `undone: ${previewUndone}`);

  // Redo: should hide HueSat layer again (Red)
  history.redo();
  const previewRedone = pxStr(composeDocPreview(doc), 50, 50);
  log('huesat-redo-restored', previewRedone === '255,0,0,255', `redone: ${previewRedone}`);
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
  console.log(`All ${results.length} Hue/Saturation regression tests passed!`);
}

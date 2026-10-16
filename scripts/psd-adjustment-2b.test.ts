/**
 * Synthetic and regression test suite for Milestone 2B:
 * Color Lookup, Vibrance, and Photo Filter adjustments.
 *
 * Validates:
 *   1. Vibrance analytical math (gray neutrality, skin-tone damping, low vs high sat boost, negative vibrance)
 *   2. Photo Filter analytical math (density scaling, preserveLuminosity: true vs false, black neutrality, Lab conversion)
 *   3. Color Lookup parser & interpolation (.cube parsing, .3dl parsing, identity LUT, trilinear interpolation)
 *   4. Stack preview rendering for all 3 adjustment types
 *   5. Raster masks (ROI bounding, defaultColor 0 vs 255)
 *   6. Opacity blending (50% linear interpolation)
 *   7. Clipping isolation (clipped adjustment affects clip base ONLY, backdrop untouched)
 *   8. Stack order (layers above adjustment are not affected)
 *   9. Non-destructive export & re-import roundtrip for all 3 types
 *  10. Undo/Redo determinism
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

const { importPsd, exportPsd } = await import('../src/psd/psd');
const { leaves, walk } = await import('../src/core/model');
const { composeDocPreview, getDocPreviewCanvas, clipBaseOf } = await import('../src/psd/psdComposite');
const {
  evaluateVibrancePixel,
  prepareVibranceParams,
} = await import('../src/psd/psdAdjustmentVibrance');
const {
  labToRgb,
  extractFilterColorRgb,
  evaluatePhotoFilterPixel,
  preparePhotoFilterParams,
} = await import('../src/psd/psdAdjustmentPhotoFilter');
const {
  parseCubeLut,
  parse3dlLut,
  sample3dLut,
  resolveColorLookupLut,
} = await import('../src/psd/psdAdjustmentColorLookup');
const { History } = await import('../src/core/history');

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
  return importPsd('test-adj-2b.psd', writePsd(psd));
}

const px = (c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] => {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

const pxStr = (c: HTMLCanvasElement, x: number, y: number) => px(c, x, y).join(',');

// =========================================================================
// 1. Vibrance Analytical Math Tests
// =========================================================================
{
  // A. Neutral gray pixel neutrality: saturation/vibrance changes do not alter gray
  const grayOut = evaluateVibrancePixel(128, 128, 128, 50, 50);
  log('vibrance-neutral-gray', grayOut[0] === 128 && grayOut[1] === 128 && grayOut[2] === 128, `got ${grayOut.join(',')}`);

  // B. Low-saturation vs High-saturation boost:
  // Low saturation: [150, 130, 130] (sat ~ 0.13)
  // High saturation: [220, 40, 40] (sat ~ 0.82)
  const lowSatBefore = [150, 130, 130];
  const highSatBefore = [220, 40, 40];
  const lowSatAfter = evaluateVibrancePixel(lowSatBefore[0], lowSatBefore[1], lowSatBefore[2], 50, 0);
  const highSatAfter = evaluateVibrancePixel(highSatBefore[0], highSatBefore[1], highSatBefore[2], 50, 0);

  const lowSatDelta = (lowSatAfter[0] - lowSatAfter[1]) - (lowSatBefore[0] - lowSatBefore[1]);
  const highSatDelta = (highSatAfter[0] - highSatAfter[1]) - (highSatBefore[0] - highSatBefore[1]);
  // Relative boost: low saturation color gets a larger proportional increase in chroma
  const relLow = lowSatDelta / (lowSatBefore[0] - lowSatBefore[1]);
  const relHigh = highSatDelta / (highSatBefore[0] - highSatBefore[1]);
  log('vibrance-low-sat-priority', relLow > relHigh, `relLow: ${relLow.toFixed(3)}, relHigh: ${relHigh.toFixed(3)}`);

  // C. Skin-tone protection:
  // Warm orange/skin hue (~30 deg): [200, 150, 120]
  // Cool cyan hue (~180 deg): [120, 200, 200]
  // Both have similar chroma (~80)
  const warmAfter = evaluateVibrancePixel(200, 150, 120, 60, 0);
  const coolAfter = evaluateVibrancePixel(120, 200, 200, 60, 0);
  const warmChromaDelta = (warmAfter[0] - warmAfter[2]) - (200 - 120);
  const coolChromaDelta = (coolAfter[1] - coolAfter[0]) - (200 - 120);
  log('vibrance-skin-tone-protection', warmChromaDelta < coolChromaDelta, `warm delta: ${warmChromaDelta}, cool delta: ${coolChromaDelta}`);

  // D. Negative vibrance reduces already-saturated colors
  const negVib = evaluateVibrancePixel(220, 50, 50, -50, 0);
  log('vibrance-negative-desaturates', negVib[0] < 220 && negVib[1] > 50, `got ${negVib.join(',')}`);

  // E. Saturation uniform adjustment
  const satPos = evaluateVibrancePixel(180, 100, 100, 0, 50);
  log('saturation-boosts-chroma', satPos[0] > 180 && satPos[1] < 100, `got ${satPos.join(',')}`);
}

// =========================================================================
// 2. Photo Filter Analytical Math Tests
// =========================================================================
{
  // A. Zero density leaves pixels unchanged
  const noChange = evaluatePhotoFilterPixel(100, 150, 200, 236, 138, 0, 0, true);
  log('photofilter-zero-density', noChange[0] === 100 && noChange[1] === 150 && noChange[2] === 200, `got ${noChange.join(',')}`);

  // B. Pure black remains black (optical filtering does not emit light)
  const black = evaluatePhotoFilterPixel(0, 0, 0, 236, 138, 0, 0.5, true);
  log('photofilter-black-neutral', black[0] === 0 && black[1] === 0 && black[2] === 0, `got ${black.join(',')}`);

  // C. Warming filter 85 boosts red and attenuates blue
  const warmWithLum = evaluatePhotoFilterPixel(180, 180, 180, 236, 138, 0, 0.25, true);
  log('photofilter-warming-shift', warmWithLum[0] > warmWithLum[2], `R: ${warmWithLum[0]}, B: ${warmWithLum[2]}`);

  // D. preserveLuminosity: true preserves perceived luminance (within rounding tolerance)
  const origLum = 0.2126 * 180 + 0.7152 * 180 + 0.0722 * 180;
  const filteredLum = 0.2126 * warmWithLum[0] + 0.7152 * warmWithLum[1] + 0.0722 * warmWithLum[2];
  log('photofilter-preserve-luminosity', Math.abs(origLum - filteredLum) < 3.0, `orig: ${origLum.toFixed(2)}, filtered: ${filteredLum.toFixed(2)}`);

  // E. preserveLuminosity: false darkens overall brightness (pure subtractive absorption)
  const warmNoLum = evaluatePhotoFilterPixel(180, 180, 180, 236, 138, 0, 0.25, false);
  const noLumVal = 0.2126 * warmNoLum[0] + 0.7152 * warmNoLum[1] + 0.0722 * warmNoLum[2];
  log('photofilter-no-lum-darkens', noLumVal < origLum - 5, `noLum: ${noLumVal.toFixed(2)}, orig: ${origLum.toFixed(2)}`);

  // F. CIE Lab conversion
  const labRgb = labToRgb(0.5, 0.2, 0.3);
  log('lab-to-rgb-conversion', labRgb.length === 3 && labRgb[0] > 0, `got ${labRgb.join(',')}`);
}

// =========================================================================
// 3. Color Lookup (.cube and .3dl) Parser & Trilinear Interpolation Tests
// =========================================================================
{
  // A. .cube parser & Identity LUT test (2x2x2)
  const identityCube = `
# Identity 2x2x2 3D LUT
TITLE "Identity"
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;
  const lutCube = parseCubeLut(identityCube);
  log('parse-cube-lut-size', lutCube !== null && lutCube.size === 2, `size: ${lutCube?.size}`);

  if (lutCube) {
    const s0 = sample3dLut(lutCube, 0, 0, 0);
    const sMid = sample3dLut(lutCube, 128, 128, 128);
    const s255 = sample3dLut(lutCube, 255, 255, 255);
    log('cube-identity-black', s0[0] === 0 && s0[1] === 0 && s0[2] === 0, `got ${s0.join(',')}`);
    log('cube-identity-white', s255[0] === 255 && s255[1] === 255 && s255[2] === 255, `got ${s255.join(',')}`);
    log('cube-identity-mid', Math.abs(sMid[0] - 128) <= 1 && Math.abs(sMid[1] - 128) <= 1, `got ${sMid.join(',')}`);
  }

  // B. .3dl parser & Trilinear Interpolation test (2x2x2 invert LUT)
  // In .3dl standard BGR order (B changes fastest, then G, then R):
  // R=0, G=0: B=0 -> [1023, 1023, 1023], B=1 -> [1023, 1023, 0]
  // R=0, G=1: B=0 -> [1023, 0, 1023],    B=1 -> [1023, 0, 0]
  // R=1, G=0: B=0 -> [0, 1023, 1023],    B=1 -> [0, 1023, 0]
  // R=1, G=1: B=0 -> [0, 0, 1023],       B=1 -> [0, 0, 0]
  const invert3dl = `
# Autodesk 3D LUT Invert
3DMESH
Mesh 1 10
0 1023
1023 1023 1023
1023 1023 0
1023 0 1023
1023 0 0
0 1023 1023
0 1023 0
0 0 1023
0 0 0
`;
  const lut3dl = parse3dlLut(invert3dl);
  log('parse-3dl-lut-size', lut3dl !== null && lut3dl.size === 2, `size: ${lut3dl?.size}`);

  if (lut3dl) {
    const invBlack = sample3dLut(lut3dl, 0, 0, 0);
    const invWhite = sample3dLut(lut3dl, 255, 255, 255);
    const invRed = sample3dLut(lut3dl, 255, 0, 0);
    log('3dl-invert-black-to-white', invBlack[0] === 255 && invBlack[1] === 255 && invBlack[2] === 255, `got ${invBlack.join(',')}`);
    log('3dl-invert-white-to-black', invWhite[0] === 0 && invWhite[1] === 0 && invWhite[2] === 0, `got ${invWhite.join(',')}`);
    log('3dl-invert-red-to-cyan', invRed[0] === 0 && invRed[1] === 255 && invRed[2] === 255, `got ${invRed.join(',')}`);
  }

  // C. Trilinear interpolation smoothness (4x4x4 cube tint)
  const tintCube = `
LUT_3D_SIZE 2
0.0 0.0 0.0
0.5 0.0 0.0
0.0 1.0 0.0
0.5 1.0 0.0
0.0 0.0 1.0
0.5 0.0 1.0
0.0 1.0 1.0
0.5 1.0 1.0
`;
  const lutTint = parseCubeLut(tintCube)!;
  const interpMid = sample3dLut(lutTint, 128, 0, 0);
  // Red input 128 is ~0.502 normalized, output should interpolate between 0 and 0.5 (~0.25 -> ~64)
  log('cube-trilinear-interpolation', Math.abs(interpMid[0] - 64) <= 2, `expected ~64, got ${interpMid[0]}`);
}

// =========================================================================
// 4. Dynamic Preview Stack Rendering: Vibrance
// =========================================================================
{
  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#804040'), // R=128, G=64, B=64
    {
      name: 'Vibrance 1',
      adjustment: {
        type: 'vibrance',
        vibrance: 50,
        saturation: 20,
      },
    },
  ]);

  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  // Vibrance + Saturation boosts red channel and lowers blue/green
  log('vibrance-stack-preview', p[0] > 128 && p[1] < 64, `BG was 128,64,64; preview got ${p[0]},${p[1]},${p[2]}`);
}

// =========================================================================
// 5. Dynamic Preview Stack Rendering: Photo Filter
// =========================================================================
{
  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#808080'), // 128, 128, 128
    {
      name: 'Photo Filter 1',
      adjustment: {
        type: 'photo filter',
        color: { r: 236, g: 138, b: 0 },
        density: 50,
        preserveLuminosity: true,
      },
    },
  ]);

  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  log('photofilter-stack-preview', p[0] > 128 && p[2] < 128, `BG was 128,128,128; preview got ${p[0]},${p[1]},${p[2]}`);
}

// =========================================================================
// 6. Dynamic Preview Stack Rendering: Color Lookup (.cube)
// =========================================================================
{
  const sepiaCube = `
LUT_3D_SIZE 2
0.0 0.0 0.0
0.8 0.5 0.2
0.0 0.0 0.0
0.8 0.5 0.2
0.0 0.0 0.0
0.8 0.5 0.2
0.0 0.0 0.0
0.8 0.5 0.2
`;
  const lutBytes = new TextEncoder().encode(sepiaCube);

  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#ffffff'),
    {
      name: 'Color Lookup 1',
      adjustment: {
        type: 'color lookup',
        lutFormat: 'cube',
        lut3DFileData: lutBytes,
        lut3DFileName: 'sepia.cube',
      },
    },
  ]);

  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  // White mapped to [0.8*255, 0.5*255, 0.2*255] = [204, 128, 51]
  log('colorlookup-cube-stack-preview', Math.abs(p[0] - 204) <= 2 && Math.abs(p[1] - 128) <= 2 && Math.abs(p[2] - 51) <= 2, `got ${p[0]},${p[1]},${p[2]}`);
}

// =========================================================================
// 7. Raster Masks on Milestone 2B Adjustments
// =========================================================================
{
  // Photo Filter with a 40x40 mask at (10, 10). defaultColor = 0 (outside hidden).
  const maskCanvas = fill(40, 40, '#ffffff');
  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#808080'),
    {
      name: 'Photo Filter Masked',
      mask: {
        left: 10,
        top: 10,
        right: 50,
        bottom: 50,
        defaultColor: 0,
        canvas: maskCanvas,
      },
      adjustment: {
        type: 'photo filter',
        color: { r: 236, g: 138, b: 0 },
        density: 50,
        preserveLuminosity: true,
      },
    },
  ]);

  const preview = composeDocPreview(doc);
  const inside = px(preview, 20, 20);
  const outside = px(preview, 70, 70);

  log('photofilter-mask-inside', inside[0] > 128 && inside[2] < 128, `inside: ${inside.join(',')}`);
  log('photofilter-mask-outside', outside[0] === 128 && outside[1] === 128 && outside[2] === 128, `outside: ${outside.join(',')}`);
}

// =========================================================================
// 8. Opacity Blending (50% Linear Interpolation)
// =========================================================================
{
  const invertCube = `
LUT_3D_SIZE 2
1.0 1.0 1.0
0.0 1.0 1.0
1.0 0.0 1.0
0.0 0.0 1.0
1.0 1.0 0.0
0.0 1.0 0.0
1.0 0.0 0.0
0.0 0.0 0.0
`;
  const lutBytes = new TextEncoder().encode(invertCube);

  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#000000'), // 0, 0, 0
    {
      name: 'Invert 50%',
      opacity: 0.5,
      adjustment: {
        type: 'color lookup',
        lutFormat: 'cube',
        lut3DFileData: lutBytes,
      },
    },
  ]);

  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  // Full invert turns 0 to 255. At 50% opacity, expected is ~128.
  log('colorlookup-50-opacity', Math.abs(p[0] - 128) <= 2, `expected ~128, got ${p.join(',')}`);
}

// =========================================================================
// 9. Clipping Isolation on Milestone 2B Adjustments
// =========================================================================
{
  // Vibrance clipped to a 40x40 card at (10, 10). Backdrop (70, 70) must remain intact.
  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#804040'), // 128, 64, 64
    rect('Card', 10, 10, 40, 40, '#804040'),
    {
      name: 'Clipped Vibrance',
      clipping: true,
      adjustment: {
        type: 'vibrance',
        vibrance: 80,
        saturation: 30,
      },
    },
  ]);

  const preview = composeDocPreview(doc);
  const cardPx = px(preview, 20, 20);
  const bgPx = px(preview, 70, 70);

  log('vibrance-clipping-alters-base', cardPx[0] > 128 && cardPx[1] < 64, `card: ${cardPx.join(',')}`);
  log('vibrance-clipping-isolates-backdrop', bgPx[0] === 128 && bgPx[1] === 64 && bgPx[2] === 64, `bg: ${bgPx.join(',')}`);
}

// =========================================================================
// 10. Stack Order: Layers Above Adjustment Are Unaffected
// =========================================================================
{
  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#808080'),
    {
      name: 'Photo Filter Lower',
      adjustment: {
        type: 'photo filter',
        color: { r: 236, g: 138, b: 0 },
        density: 50,
        preserveLuminosity: true,
      },
    },
    rect('Top Card', 10, 10, 40, 40, '#00ff00'), // pure green above photo filter
  ]);

  const preview = composeDocPreview(doc);
  const topPx = px(preview, 20, 20);
  log('photofilter-stack-order-preserves-above', topPx[0] === 0 && topPx[1] === 255 && topPx[2] === 0, `top card: ${topPx.join(',')}`);
}

// =========================================================================
// 11. Non-Destructive Export & Re-import Roundtrip
// =========================================================================
{
  const lutText = `
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;
  const lutData = new TextEncoder().encode(lutText);

  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#808080'),
    {
      name: 'Vib Layer',
      adjustment: {
        type: 'vibrance',
        vibrance: 45,
        saturation: -15,
      },
    },
    {
      name: 'PhotoFilter Layer',
      adjustment: {
        type: 'photo filter',
        color: { r: 200, g: 100, b: 50 },
        density: 35,
        preserveLuminosity: false,
      },
    },
    {
      name: 'ColorLookup Layer',
      adjustment: {
        type: 'color lookup',
        lutFormat: 'cube',
        lut3DFileData: lutData,
        lut3DFileName: 'test.cube',
      },
    },
  ]);

  const exportedBytes = exportPsd(doc);
  const reimported = importPsd('roundtrip-2b.psd', exportedBytes);

  const reVib = leaves(reimported).find((n) => n.name === 'Vib Layer')?.src.adjustment;
  const rePf = leaves(reimported).find((n) => n.name === 'PhotoFilter Layer')?.src.adjustment;
  const reCl = leaves(reimported).find((n) => n.name === 'ColorLookup Layer')?.src.adjustment;

  const vibOk = reVib && reVib.type === 'vibrance' && (reVib as any).vibrance === 45 && (reVib as any).saturation === -15;
  const pfOk = rePf && rePf.type === 'photo filter' && (rePf as any).density === 35 && (rePf as any).preserveLuminosity === false;
  const clOk = reCl && reCl.type === 'color lookup' && (reCl as any).lutFormat === 'cube' && (reCl as any).lut3DFileData?.length === lutData.length;

  log('export-roundtrip-vibrance', !!vibOk, `vibrance: ${JSON.stringify(reVib)}`);
  log('export-roundtrip-photofilter', !!pfOk, `photo filter: ${JSON.stringify(rePf)}`);
  log('export-roundtrip-colorlookup', !!clOk, `color lookup format: ${(reCl as any)?.lutFormat}`);
}

// =========================================================================
// 12. Undo/Redo Determinism
// =========================================================================
{
  const doc = buildDoc([
    rect('BG', 0, 0, W, H, '#808080'),
    rect('Card', 10, 10, 40, 40, '#0000ff'),
    {
      name: 'Vibrance 1',
      adjustment: {
        type: 'vibrance',
        vibrance: 50,
        saturation: 20,
      },
    },
  ]);

  const history = new History();
  const card = leaves(doc).find((n) => n.name === 'Card')!;

  const previewBefore = pxStr(composeDocPreview(doc), 15, 15);

  const ox = card.x;
  const oy = card.y;
  history.exec({
    label: 'move card',
    do: () => {
      card.x = 20;
      card.y = 20;
    },
    undo: () => {
      card.x = ox;
      card.y = oy;
    },
  });

  const previewEdited = pxStr(composeDocPreview(doc), 15, 15);
  log('2b-edit-changes-preview', previewEdited !== previewBefore, `before: ${previewBefore}, edited: ${previewEdited}`);

  // Undo
  history.undo();
  const previewUndone = pxStr(composeDocPreview(doc), 15, 15);
  log('2b-undo-restores-exact-preview', previewUndone === previewBefore, `undone: ${previewUndone}`);

  // Redo
  history.redo();
  const previewRedone = pxStr(composeDocPreview(doc), 15, 15);
  log('2b-redo-restores-edited-preview', previewRedone === previewEdited, `redone: ${previewRedone}`);
}

const allPassed = results.every((r) => r.ok);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
console.log('JSON:' + JSON.stringify(results));
process.exit(allPassed ? 0 : 1);

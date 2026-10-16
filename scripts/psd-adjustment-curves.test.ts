/**
 * Synthetic and regression test suite for Curves adjustments.
 *
 * Validates:
 *   1. Identity curves math (rgb omitted, empty, or 2-point identity)
 *   2. Master RGB curves math (contrast S-curve, gamma shift, inversion)
 *   3. Individual Red, Green, Blue channel curves math
 *   4. Channel + Master composite interaction (channel first, then master)
 *   5. Natural cubic spline interpolation (knot accuracy, smoothness, clamping)
 *   6. Stack preview rendering for Curves adjustment
 *   7. Raster masks (inside rect, defaultColor 0 vs 255 outside, disabled mask)
 *   8. Opacity blending (0%, 50% linear interpolation, 100%)
 *   9. Clipping isolation (clipped Curves affects clip base ONLY, backdrop untouched)
 *  10. Stack order (layers above adjustment are not affected)
 *  11. Non-destructive export & re-import roundtrip (ag-psd curv block preserved)
 *  12. Undo/Redo determinism
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd, type CurvesAdjustment } from 'ag-psd';

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
const { composeDocPreview, getDocPreviewCanvas, clipBaseOf } = await import('../src/psdComposite');
const {
  evaluateCurveChannel,
  buildCurveChannelLut,
  buildCurvesLut,
  solveNaturalCubicSpline,
} = await import('../src/psdAdjustmentCurves');
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
  return importPsd('test-curves.psd', writePsd(psd));
}

const px = (c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] => {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

const pxStr = (c: HTMLCanvasElement, x: number, y: number) => px(c, x, y).join(',');

// =========================================================================
// 1. Identity Curves Analytical Math Tests
// =========================================================================
{
  // A. Empty / undefined channel is exact identity
  const idLutEmpty = buildCurveChannelLut(undefined);
  let idEmptyOk = true;
  for (let i = 0; i < 256; i++) {
    if (idLutEmpty[i] !== i) { idEmptyOk = false; break; }
  }
  log('curves-empty-channel-identity', idEmptyOk, 'all 256 byte values preserved');

  // B. Explicit 2-point identity: (0,0) to (255, 255)
  const idLut2Pt = buildCurveChannelLut([
    { input: 0, output: 0 },
    { input: 255, output: 255 },
  ]);
  let id2PtOk = true;
  for (let i = 0; i < 256; i++) {
    if (idLut2Pt[i] !== i) { id2PtOk = false; break; }
  }
  log('curves-2pt-channel-identity', id2PtOk, 'all 256 byte values preserved');

  // C. Full adjustment with identity channels
  const fullId = buildCurvesLut({
    type: 'curves',
    rgb: [{ input: 0, output: 0 }, { input: 255, output: 255 }],
  });
  let fullIdOk = true;
  for (let i = 0; i < 256; i++) {
    if (fullId.lutR[i] !== i || fullId.lutG[i] !== i || fullId.lutB[i] !== i) {
      fullIdOk = false;
      break;
    }
  }
  log('curves-full-adjustment-identity', fullIdOk, 'R, G, B LUTs identical to identity');
}

// =========================================================================
// 2. Master RGB Curves Analytical Math Tests
// =========================================================================
{
  // A. Inversion curve: (0, 255) to (255, 0)
  const invAdj: CurvesAdjustment = {
    type: 'curves',
    rgb: [{ input: 0, output: 255 }, { input: 255, output: 0 }],
  };
  const invLut = buildCurvesLut(invAdj);
  log('curves-master-inversion', invLut.lutR[0] === 255 && invLut.lutR[128] === 127 && invLut.lutR[255] === 0, `0->${invLut.lutR[0]}, 128->${invLut.lutR[128]}, 255->${invLut.lutR[255]}`);

  // B. Midtone lift curve: (0,0), (128, 170), (255, 255)
  const liftAdj: CurvesAdjustment = {
    type: 'curves',
    rgb: [{ input: 0, output: 0 }, { input: 128, output: 170 }, { input: 255, output: 255 }],
  };
  const liftLut = buildCurvesLut(liftAdj);
  log('curves-master-midtone-lift-knot', liftLut.lutR[128] === 170, `knot 128->${liftLut.lutR[128]}`);
  log('curves-master-midtone-lift-smooth', liftLut.lutR[64] > 64 && liftLut.lutR[192] > 192, `64->${liftLut.lutR[64]}, 192->${liftLut.lutR[192]}`);

  // C. S-curve contrast boost: (0,0), (64, 40), (192, 215), (255, 255)
  const sCurveAdj: CurvesAdjustment = {
    type: 'curves',
    rgb: [
      { input: 0, output: 0 },
      { input: 64, output: 40 },
      { input: 192, output: 215 },
      { input: 255, output: 255 },
    ],
  };
  const sLut = buildCurvesLut(sCurveAdj);
  log('curves-master-s-curve-knots', sLut.lutR[64] === 40 && sLut.lutR[192] === 215, `64->${sLut.lutR[64]} (exp 40), 192->${sLut.lutR[192]} (exp 215)`);
  log('curves-master-s-curve-contrast', sLut.lutR[32] < 32 && sLut.lutR[224] > 224, `shadow 32->${sLut.lutR[32]} darkened, highlight 224->${sLut.lutR[224]} brightened`);
}

// =========================================================================
// 3. Individual Channel Curves Math Tests
// =========================================================================
{
  // A. Red channel boost only
  const redAdj: CurvesAdjustment = {
    type: 'curves',
    red: [{ input: 0, output: 0 }, { input: 128, output: 180 }, { input: 255, output: 255 }],
  };
  const redLut = buildCurvesLut(redAdj);
  log('curves-red-channel-boost', redLut.lutR[128] === 180, `R 128->${redLut.lutR[128]} boosted`);
  log('curves-red-channel-green-blue-untouched', redLut.lutG[128] === 128 && redLut.lutB[128] === 128, `G=${redLut.lutG[128]}, B=${redLut.lutB[128]} untouched`);

  // B. Blue channel reduction only
  const blueAdj: CurvesAdjustment = {
    type: 'curves',
    blue: [{ input: 0, output: 0 }, { input: 128, output: 80 }, { input: 255, output: 255 }],
  };
  const blueLut = buildCurvesLut(blueAdj);
  log('curves-blue-channel-reduced', blueLut.lutB[128] === 80, `B 128->${blueLut.lutB[128]} reduced`);
  log('curves-blue-channel-red-green-untouched', blueLut.lutR[128] === 128 && blueLut.lutG[128] === 128, `R=${blueLut.lutR[128]}, G=${blueLut.lutG[128]} untouched`);

  // C. Combined channel + master interaction
  // Red channel: 100 -> 150
  // Master RGB: 150 -> 200
  // Composite result for input 100 on Red should be 200!
  const combinedAdj: CurvesAdjustment = {
    type: 'curves',
    red: [{ input: 0, output: 0 }, { input: 100, output: 150 }, { input: 255, output: 255 }],
    rgb: [{ input: 0, output: 0 }, { input: 150, output: 200 }, { input: 255, output: 255 }],
  };
  const combLut = buildCurvesLut(combinedAdj);
  log('curves-channel-master-pipeline-order', combLut.lutR[100] === 200, `R 100->${combLut.lutR[100]} (expected 200 via red->rgb pipe)`);
  log('curves-channel-master-other-channels', combLut.lutG[150] === 200, `G 150->${combLut.lutG[150]} (only master rgb applied to green)`);
}

// =========================================================================
// 4. Cubic Spline Knot Clamping and Boundary Tests
// =========================================================================
{
  // A. Truncated input range: [30, 220] -> [0, 255]
  const truncAdj: CurvesAdjustment = {
    type: 'curves',
    rgb: [{ input: 30, output: 0 }, { input: 220, output: 255 }],
  };
  const truncLut = buildCurvesLut(truncAdj);
  log('curves-boundary-clamp-left', truncLut.lutR[10] === 0, `val 10->${truncLut.lutR[10]} clamped to 0`);
  log('curves-boundary-clamp-right', truncLut.lutR[240] === 255, `val 240->${truncLut.lutR[240]} clamped to 255`);

  // B. Deduplication of identical input knots
  const dupAdj: CurvesAdjustment = {
    type: 'curves',
    rgb: [
      { input: 0, output: 0 },
      { input: 128, output: 140 },
      { input: 128, output: 160 }, // duplicate input, last wins
      { input: 255, output: 255 },
    ],
  };
  const dupLut = buildCurvesLut(dupAdj);
  log('curves-knot-deduplication', dupLut.lutR[128] === 160, `128->${dupLut.lutR[128]} (last duplicate 160 wins without crash)`);
}

// =========================================================================
// 5. Stack Preview Rendering: Basic Curves Adjustment
// =========================================================================
{
  // Base backdrop: #808080 (128, 128, 128)
  // Curves: midtone lift 128 -> 170 on RGB
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080');
  const curvesLayer: Layer = {
    name: 'Curves Lift',
    adjustment: {
      type: 'curves',
      rgb: [{ input: 0, output: 0 }, { input: 128, output: 170 }, { input: 255, output: 255 }],
    },
  };

  const doc = buildDoc([baseLayer, curvesLayer]);
  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  log('curves-preview-basic', p[0] === 170 && p[1] === 170 && p[2] === 170, `got ${p.slice(0, 3).join(',')} (expected 170,170,170)`);
}

// =========================================================================
// 6. Opacity Blending (0%, 50%, 100%)
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080'); // 128, 128, 128
  // Curves inverts colors: 128 -> 127, but let's use an extreme curve: 128 -> 200
  const curvesLayer: Layer = {
    name: 'Curves 200',
    opacity: 0.5,
    adjustment: {
      type: 'curves',
      rgb: [{ input: 0, output: 0 }, { input: 128, output: 200 }, { input: 255, output: 255 }],
    },
  };

  const doc = buildDoc([baseLayer, curvesLayer]);
  const preview = composeDocPreview(doc);
  const p = px(preview, 50, 50);
  // 50% blend between 128 and 200: (128 + 200)/2 = 164
  log('curves-opacity-50-percent', Math.abs(p[0] - 164) <= 1, `got ${p[0]} (expected ~164)`);

  // 0% opacity
  const cNode = leaves(doc).find((n) => n.name === 'Curves 200')!;
  cNode.opacity = 0;
  const p0 = px(composeDocPreview(doc), 50, 50);
  log('curves-opacity-zero-percent', p0[0] === 128 && p0[1] === 128 && p0[2] === 128, `got ${p0[0]} (expected 128)`);
}

// =========================================================================
// 7. Raster Masks on Curves Adjustment
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080'); // 128, 128, 128
  // Mask covers left half [0, 0, 50, 100], right half outside
  const maskCanvas = fill(50, 100, '#ffffff');
  const curvesLayer: Layer = {
    name: 'Curves Masked',
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
      type: 'curves',
      rgb: [{ input: 0, output: 0 }, { input: 128, output: 200 }, { input: 255, output: 255 }],
    },
  };

  const doc = buildDoc([baseLayer, curvesLayer]);
  const preview = composeDocPreview(doc);
  const pInside = px(preview, 25, 50); // x=25 inside mask
  const pOutside = px(preview, 75, 50); // x=75 outside mask
  log('curves-mask-inside-applied', pInside[0] === 200, `inside got ${pInside[0]} (expected 200)`);
  log('curves-mask-outside-hidden', pOutside[0] === 128, `outside got ${pOutside[0]} (expected 128)`);

  // Disabled mask applies everywhere
  const cNode = leaves(doc).find((n) => n.name === 'Curves Masked')!;
  cNode.src.mask!.disabled = true;
  const pDisabled = px(composeDocPreview(doc), 75, 50);
  log('curves-mask-disabled-applies-everywhere', pDisabled[0] === 200, `with disabled mask got ${pDisabled[0]} (expected 200)`);
}

// =========================================================================
// 8. Clipping Isolation (Clipped Curves modifies Base ONLY)
// =========================================================================
{
  // Backdrop: #404040 (64, 64, 64) covering entire 100x100
  const backdrop = rect('Backdrop', 0, 0, W, H, '#404040');
  // Base art layer: #808080 (128, 128, 128) covering left half [0, 0, 50, 100]
  const baseArt = rect('BaseArt', 0, 0, 50, 100, '#808080');
  // Curves layer clipped to BaseArt, lifting 128 -> 210 and 64 -> 120
  const clippedCurves: Layer = {
    name: 'Clipped Curves',
    clipping: true,
    adjustment: {
      type: 'curves',
      rgb: [{ input: 0, output: 0 }, { input: 64, output: 120 }, { input: 128, output: 210 }, { input: 255, output: 255 }],
    },
  };

  const doc = buildDoc([backdrop, baseArt, clippedCurves]);
  const preview = composeDocPreview(doc);
  const pBase = px(preview, 25, 50); // Inside base art (left half)
  const pBackdrop = px(preview, 75, 50); // Outside base art (right half)

  log('curves-clipping-base-modified', pBase[0] === 210, `base got ${pBase[0]} (expected 210)`);
  log('curves-clipping-backdrop-isolated', pBackdrop[0] === 64, `backdrop got ${pBackdrop[0]} (expected 64, untouched)`);
}

// =========================================================================
// 9. Stack Order Verification
// =========================================================================
{
  // Layer 1 (bottom): #404040 (64)
  const layer1 = rect('Bottom', 0, 0, W, H, '#404040');
  // Curves adjustment: 64 -> 150
  const curvesLayer: Layer = {
    name: 'Middle Curves',
    adjustment: {
      type: 'curves',
      rgb: [{ input: 0, output: 0 }, { input: 64, output: 150 }, { input: 255, output: 255 }],
    },
  };
  // Layer 3 (top): right half rect #202020 (32)
  const layer3 = rect('Top', 50, 0, 50, 100, '#202020');

  const doc = buildDoc([layer1, curvesLayer, layer3]);
  const preview = composeDocPreview(doc);
  const pBottomAdjusted = px(preview, 25, 50); // Left half: bottom layer adjusted
  const pTopUntouched = px(preview, 75, 50);   // Right half: top layer above curves

  log('curves-stack-bottom-affected', pBottomAdjusted[0] === 150, `bottom layer got ${pBottomAdjusted[0]} (expected 150)`);
  log('curves-stack-top-unaffected', pTopUntouched[0] === 32, `top layer got ${pTopUntouched[0]} (expected 32, unaffected)`);
}

// =========================================================================
// 10. Non-Destructive Export & Re-Import Roundtrip
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080');
  const curvesAdj: CurvesAdjustment = {
    type: 'curves',
    rgb: [{ input: 0, output: 0 }, { input: 128, output: 175 }, { input: 255, output: 255 }],
    red: [{ input: 0, output: 10 }, { input: 255, output: 245 }],
  };
  const curvesLayer: Layer = {
    name: 'Roundtrip Curves',
    adjustment: curvesAdj,
  };

  const doc = buildDoc([baseLayer, curvesLayer]);
  const exportedBytes = await exportPsd(doc);
  log('curves-export-success', exportedBytes.byteLength > 0, `bytes=${exportedBytes.byteLength}`);

  const reimported = importPsd('reimported-curves.psd', exportedBytes);
  const reimportedCurves = leaves(reimported).find((n) => n.name === 'Roundtrip Curves');

  log('curves-reimport-found', !!reimportedCurves, 'Curves layer found in re-imported PSD');
  const adj = reimportedCurves?.src.adjustment as CurvesAdjustment | undefined;
  log('curves-reimport-type', adj?.type === 'curves', `type=${adj?.type}`);

  const rgbPts = adj?.rgb ?? [];
  const redPts = adj?.red ?? [];
  const rgbMatch = rgbPts.length === 3 && rgbPts[1].input === 128 && rgbPts[1].output === 175;
  const redMatch = redPts.length === 2 && redPts[0].output === 10 && redPts[1].output === 245;

  log('curves-reimport-rgb-points', rgbMatch, `rgb points=${JSON.stringify(rgbPts)}`);
  log('curves-reimport-red-points', redMatch, `red points=${JSON.stringify(redPts)}`);

  // Verify composite preview after reimport
  const reimportedPreview = composeDocPreview(reimported);
  const pReimported = px(reimportedPreview, 50, 50);
  // Red channel: 128 -> (10 + (245-10)*128/255) = 128. Then RGB: 128 -> 175
  log('curves-reimport-preview-rendered', pReimported[0] === 175, `reimported preview R=${pReimported[0]} (expected 175)`);
}

// =========================================================================
// 11. Undo / Redo Determinism
// =========================================================================
{
  const baseLayer = rect('Backdrop', 0, 0, W, H, '#808080');
  const curvesLayer: Layer = {
    name: 'Undo Curves',
    adjustment: {
      type: 'curves',
      rgb: [{ input: 0, output: 0 }, { input: 128, output: 200 }, { input: 255, output: 255 }],
    },
  };

  const doc = buildDoc([baseLayer, curvesLayer]);
  const history = new History();
  const cNode = leaves(doc).find((n) => n.name === 'Undo Curves')!;

  const previewBefore = pxStr(composeDocPreview(doc), 50, 50);
  log('curves-undo-initial-state', previewBefore === '200,200,200,255', `initial: ${previewBefore}`);

  // Modify curves layer visibility via history command
  history.exec({
    label: 'toggle curves visibility',
    do: () => {
      cNode.visible = false;
    },
    undo: () => {
      cNode.visible = true;
    },
  });

  const previewHidden = pxStr(composeDocPreview(doc), 50, 50);
  log('curves-undo-after-hide', previewHidden === '128,128,128,255', `hidden: ${previewHidden}`);

  // Undo: should restore visible Curves layer
  history.undo();
  const previewUndone = pxStr(composeDocPreview(doc), 50, 50);
  log('curves-undo-restored', previewUndone === '200,200,200,255', `undone: ${previewUndone}`);

  // Redo: should hide Curves layer again
  history.redo();
  const previewRedone = pxStr(composeDocPreview(doc), 50, 50);
  log('curves-redo-restored', previewRedone === '128,128,128,255', `redone: ${previewRedone}`);
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
  console.log(`All ${results.length} Curves regression tests passed!`);
}

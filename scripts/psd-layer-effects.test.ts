/**
 * Layer effects tests: Drop Shadow and Outer Glow are drawn in composeDocPreview
 * without baking into layer pixels, and metadata is preserved on export.
 */
import { register } from 'node:module';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'data:text/javascript,export%20default%20%22%22', shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const window = new Window();
(globalThis as unknown as { window: Window }).window = window;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} - ${detail}`);
};

function mkLayerCanvas(fillCss = '#3366cc'): HTMLCanvasElement {
  const c = createCanvas(80, 80);
  const g = c.getContext('2d')!;
  g.fillStyle = fillCss;
  g.fillRect(10, 10, 60, 60);
  return c as unknown as HTMLCanvasElement;
}

function mkShadowPsd(): ArrayBuffer {
  const layer: Layer = {
    name: 'Box',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      dropShadow: [
        {
          enabled: true,
          blendMode: 'multiply',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.8,
          angle: 120,
          distance: { value: 10, units: 'Pixels' },
          size: { value: 8, units: 'Pixels' },
        },
      ],
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function mkOuterGlowPsd(glowOverrides: Partial<NonNullable<Layer['effects']>['outerGlow']> = {}): ArrayBuffer {
  const layer: Layer = {
    name: 'Box',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      outerGlow: {
        enabled: true,
        blendMode: 'screen',
        color: { r: 255, g: 204, b: 0 },
        opacity: 0.85,
        size: { value: 12, units: 'Pixels' },
        choke: { value: 0, units: 'Pixels' },
        ...glowOverrides,
      },
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function mkComboPsd(): ArrayBuffer {
  const layer: Layer = {
    name: 'Combo',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      dropShadow: [
        {
          enabled: true,
          blendMode: 'multiply',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.8,
          angle: 120,
          distance: { value: 10, units: 'Pixels' },
          size: { value: 8, units: 'Pixels' },
        },
      ],
      outerGlow: {
        enabled: true,
        blendMode: 'screen',
        color: { r: 255, g: 204, b: 0 },
        opacity: 0.85,
        size: { value: 12, units: 'Pixels' },
        choke: { value: 0, units: 'Pixels' },
      },
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function mkStrokePsd(strokeOverrides: Partial<NonNullable<Layer['effects']>['stroke'] extends (infer E)[] ? E : never> = {}): ArrayBuffer {
  const layer: Layer = {
    name: 'Box',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      stroke: [
        {
          enabled: true,
          blendMode: 'normal',
          color: { r: 255, g: 51, b: 51 },
          opacity: 1,
          size: { value: 6, units: 'Pixels' },
          position: 'outside',
          fillType: 'color',
          ...strokeOverrides,
        },
      ],
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function mkStrokeDropShadowPsd(): ArrayBuffer {
  const layer: Layer = {
    name: 'StrokeDropShadow',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      stroke: [
        {
          enabled: true,
          blendMode: 'normal',
          color: { r: 255, g: 51, b: 51 },
          opacity: 1,
          size: { value: 6, units: 'Pixels' },
          position: 'outside',
        },
      ],
      dropShadow: [
        {
          enabled: true,
          blendMode: 'multiply',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.8,
          angle: 120,
          distance: { value: 10, units: 'Pixels' },
          size: { value: 8, units: 'Pixels' },
        },
      ],
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function mkStrokeOuterGlowPsd(): ArrayBuffer {
  const layer: Layer = {
    name: 'StrokeOuterGlow',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      stroke: [
        {
          enabled: true,
          blendMode: 'normal',
          color: { r: 255, g: 51, b: 51 },
          opacity: 1,
          size: { value: 6, units: 'Pixels' },
          position: 'outside',
        },
      ],
      outerGlow: {
        enabled: true,
        blendMode: 'screen',
        color: { r: 255, g: 204, b: 0 },
        opacity: 0.85,
        size: { value: 16, units: 'Pixels' },
        choke: { value: 0, units: 'Pixels' },
      },
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

function mkAllThreePsd(): ArrayBuffer {
  const layer: Layer = {
    name: 'AllThree',
    left: 100,
    top: 100,
    right: 180,
    bottom: 180,
    canvas: mkLayerCanvas(),
    effects: {
      stroke: [
        {
          enabled: true,
          blendMode: 'normal',
          color: { r: 255, g: 51, b: 51 },
          opacity: 1,
          size: { value: 6, units: 'Pixels' },
          position: 'outside',
        },
      ],
      outerGlow: {
        enabled: true,
        blendMode: 'screen',
        color: { r: 255, g: 204, b: 0 },
        opacity: 0.85,
        size: { value: 16, units: 'Pixels' },
        choke: { value: 0, units: 'Pixels' },
      },
      dropShadow: [
        {
          enabled: true,
          blendMode: 'multiply',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.8,
          angle: 120,
          distance: { value: 10, units: 'Pixels' },
          size: { value: 8, units: 'Pixels' },
        },
      ],
    },
  };
  const psd: Psd = { width: 400, height: 400, children: [layer] };
  psd.canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  return writePsd(psd);
}

async function run() {
  const { importPsd, exportPsd } = await import('../src/psd');
  const { composeDocPreview } = await import('../src/psdComposite');
  const { leaves } = await import('../src/model');
  const { hasUnsupportedLayerEffects, activeDropShadow, activeOuterGlow, activeStroke } = await import('../src/psdLayerEffects');
  const { describeUnsupportedLayer } = await import('../src/psdLayerInfo');

  // --- 1. Drop shadow tests ---
  {
    const doc = importPsd('shadow.psd', mkShadowPsd());
    const leaf = leaves(doc)[0]!;
    const before = leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data;
    const preview = composeDocPreview(doc);
    const ctx = preview.getContext('2d')!;
    let shadowSample = 255;
    for (const [x, y] of [
      [108, 118],
      [112, 122],
      [105, 125],
    ]) {
      const a = ctx.getImageData(x, y, 1, 1).data[0]!;
      if (a < shadowSample) shadowSample = a;
    }
    const nearLayer = ctx.getImageData(140, 140, 1, 1).data;
    log('shadow-layer-pixels-unchanged', before[3] === 255, `alpha=${before[3]}`);
    log('shadow-darkens-offset', shadowSample < 120, `minGray=${shadowSample}`);
    log('shadow-layer-still-visible', nearLayer[2] > 200, `blue=${nearLayer[2]}`);

    const out = exportPsd(doc);
    const reread = readPsd(out, { skipThumbnail: true });
    log('export-keeps-drop-shadow', !!reread.children?.[0]?.effects?.dropShadow?.length, 'metadata kept');
  }

  // --- 2. Outer glow tests ---
  {
    const doc = importPsd('glow.psd', mkOuterGlowPsd());
    const leaf = leaves(doc)[0]!;
    const beforeLayerPx = [...leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data];

    // Check preview rendering
    const preview = composeDocPreview(doc);
    const ctx = preview.getContext('2d')!;

    // Probe 1: Glow pixels appear outside the original layer bounds
    // Box content is from 110 to 170. Probing 6px outside box:
    const glowSamples: number[][] = [];
    for (const [x, y] of [
      [104, 140], // left
      [176, 140], // right
      [140, 104], // top
      [140, 176], // bottom
    ]) {
      const px = [...ctx.getImageData(x, y, 1, 1).data];
      glowSamples.push(px);
    }
    const allHaveGlow = glowSamples.every((px) => px[3] > 0 && px[0] > 180 && px[1] > 140);
    log('glow-pixels-outside-bounds', allHaveGlow, JSON.stringify(glowSamples));

    // Probe 2: The original layer pixels remain unchanged
    const afterLayerPx = [...leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data];
    const sourceUnchanged =
      beforeLayerPx[0] === afterLayerPx[0] &&
      beforeLayerPx[1] === afterLayerPx[1] &&
      beforeLayerPx[2] === afterLayerPx[2] &&
      beforeLayerPx[3] === 255;
    log('glow-original-layer-pixels-unchanged', sourceUnchanged, `sourceAlpha=${afterLayerPx[3]}`);

    // Probe 3: Layer content on canvas is blue and not corrupted by glow
    const centerSample = [...ctx.getImageData(140, 140, 1, 1).data];
    log('glow-layer-content-blue', centerSample[2] > 180 && centerSample[0] < 100, `rgba=${centerSample.join(',')}`);

    // Probe 4: Far away pixels have no glow
    const farSample = [...ctx.getImageData(40, 40, 1, 1).data];
    log('glow-far-pixels-transparent', farSample[3] === 0, `rgba=${farSample.join(',')}`);

    // Probe 5: Hidden layers do not render their glow
    leaf.visible = false;
    const hiddenPreview = composeDocPreview(doc);
    const hiddenSample = [...hiddenPreview.getContext('2d')!.getImageData(104, 140, 1, 1).data];
    log('glow-hidden-layer-no-glow', hiddenSample[3] === 0, `alpha=${hiddenSample[3]}`);

    // Probe 6: Zero-opacity layers do not render visible effects
    leaf.visible = true;
    leaf.opacity = 0;
    const zeroOpPreview = composeDocPreview(doc);
    const zeroOpSample = [...zeroOpPreview.getContext('2d')!.getImageData(104, 140, 1, 1).data];
    log('glow-zero-opacity-no-glow', zeroOpSample[3] === 0, `alpha=${zeroOpSample[3]}`);

    // Probe 7: Opacity influences glow strength
    leaf.opacity = 1.0;
    const highOp = composeDocPreview(doc).getContext('2d')!.getImageData(104, 140, 1, 1).data[3];
    leaf.opacity = 0.3;
    const lowOp = composeDocPreview(doc).getContext('2d')!.getImageData(104, 140, 1, 1).data[3];
    log('glow-opacity-influences-render', highOp > lowOp && lowOp > 0, `high=${highOp} low=${lowOp}`);

    // Restore opacity
    leaf.opacity = 0.85;

    // Probe 8: Export/re-import preserves outer glow metadata
    const outBuf = exportPsd(doc);
    const reread = readPsd(outBuf, { skipThumbnail: true });
    const rereadGlow = reread.children?.[0]?.effects?.outerGlow;
    const glowPreserved =
      !!rereadGlow &&
      rereadGlow.enabled !== false &&
      rereadGlow.size?.value === 12 &&
      rereadGlow.color?.r === 255 &&
      rereadGlow.color?.g === 204;
    log('export-keeps-outer-glow', glowPreserved, JSON.stringify(rereadGlow));
  }

  // --- 3. Glow size influence test ---
  {
    const smallDoc = importPsd('glow-small.psd', mkOuterGlowPsd({ size: { value: 4, units: 'Pixels' } }));
    const largeDoc = importPsd('glow-large.psd', mkOuterGlowPsd({ size: { value: 24, units: 'Pixels' } }));
    // At probe distance 102, 140 (8px outside):
    const smallAlpha = composeDocPreview(smallDoc).getContext('2d')!.getImageData(102, 140, 1, 1).data[3];
    const largeAlpha = composeDocPreview(largeDoc).getContext('2d')!.getImageData(102, 140, 1, 1).data[3];
    log('glow-size-influences-render', largeAlpha > smallAlpha, `smallAlpha=${smallAlpha} largeAlpha=${largeAlpha}`);
  }

  // --- 4. Coexistence: Drop Shadow + Outer Glow ---
  {
    const doc = importPsd('combo.psd', mkComboPsd());
    const leaf = leaves(doc)[0]!;
    log('combo-has-both-effects', !!activeDropShadow(leaf.src.effects) && !!activeOuterGlow(leaf.src.effects), 'both active');
    const preview = composeDocPreview(doc);
    const ctx = preview.getContext('2d')!;

    // Check shadow probe: top-left (108, 118) has shadow
    const shadowPx = [...ctx.getImageData(108, 118, 1, 1).data];
    // Check glow probe: bottom-left (104, 176) where shadow does not reach: pure glow
    const glowPx = [...ctx.getImageData(104, 176, 1, 1).data];
    // Check layer center: blue
    const centerPx = [...ctx.getImageData(140, 140, 1, 1).data];

    log('combo-shadow-present', shadowPx[3] > 0, `shadowRGBA=${shadowPx.join(',')}`);
    log('combo-glow-present', glowPx[3] > 0 && glowPx[0] > 150, `glowRGBA=${glowPx.join(',')}`);
    log('combo-layer-center-blue', centerPx[2] > 180, `centerRGBA=${centerPx.join(',')}`);

    // Export/reimport combo
    const out = exportPsd(doc);
    const reread = readPsd(out, { skipThumbnail: true });
    const rereadFx = reread.children?.[0]?.effects;
    const comboPreserved = !!rereadFx?.dropShadow?.length && !!rereadFx?.outerGlow?.enabled;
    log('combo-export-reimport-both-kept', comboPreserved, 'both metadata entries present');
  }

  // --- 5. Stroke tests ---
  {
    // Outside stroke
    const docOutside = importPsd('stroke-outside.psd', mkStrokePsd({ position: 'outside', size: { value: 6, units: 'Pixels' } }));
    const leaf = leaves(docOutside)[0]!;
    const beforeLayerPx = [...leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data];
    const previewOutside = composeDocPreview(docOutside);
    const ctxOut = previewOutside.getContext('2d')!;

    // Probe outside: 4px outside left edge (106, 140)
    const outStrokePx = [...ctxOut.getImageData(106, 140, 1, 1).data];
    log('stroke-outside-probe-red', outStrokePx[0] > 200 && outStrokePx[1] < 100 && outStrokePx[2] < 100, `rgba=${outStrokePx.join(',')}`);

    // Probe inside layer: (140, 140) should be untouched blue
    const centerPx = [...ctxOut.getImageData(140, 140, 1, 1).data];
    log('stroke-outside-center-blue', centerPx[2] > 180 && centerPx[0] < 100, `rgba=${centerPx.join(',')}`);

    // Probe far outside: (40, 40) is transparent
    const farPx = [...ctxOut.getImageData(40, 40, 1, 1).data];
    log('stroke-far-pixels-transparent', farPx[3] === 0, `rgba=${farPx.join(',')}`);

    // Source pixels untouched
    const afterLayerPx = [...leaf.canvas!.getContext('2d')!.getImageData(40, 40, 1, 1).data];
    const sourceUnchanged =
      beforeLayerPx[0] === afterLayerPx[0] &&
      beforeLayerPx[1] === afterLayerPx[1] &&
      beforeLayerPx[2] === afterLayerPx[2] &&
      beforeLayerPx[3] === afterLayerPx[3];
    log('stroke-source-pixels-unchanged', sourceUnchanged, `alpha=${afterLayerPx[3]}`);

    // Hidden layer suppresses stroke
    leaf.visible = false;
    const hiddenPx = [...composeDocPreview(docOutside).getContext('2d')!.getImageData(106, 140, 1, 1).data];
    log('stroke-hidden-layer-no-stroke', hiddenPx[3] === 0, `alpha=${hiddenPx[3]}`);

    // Zero opacity layer suppresses stroke
    leaf.visible = true;
    leaf.opacity = 0;
    const zeroOpPx = [...composeDocPreview(docOutside).getContext('2d')!.getImageData(106, 140, 1, 1).data];
    log('stroke-zero-opacity-no-stroke', zeroOpPx[3] === 0, `alpha=${zeroOpPx[3]}`);

    // Inside stroke
    const docInside = importPsd('stroke-inside.psd', mkStrokePsd({ position: 'inside', size: { value: 6, units: 'Pixels' } }));
    const previewInside = composeDocPreview(docInside);
    const ctxIn = previewInside.getContext('2d')!;
    // Probe 3px inside edge (113, 140) -> stroke red
    const inStrokePx = [...ctxIn.getImageData(113, 140, 1, 1).data];
    log('stroke-inside-probe-red', inStrokePx[0] > 200 && inStrokePx[1] < 100, `rgba=${inStrokePx.join(',')}`);
    // Probe 4px outside edge (106, 140) -> transparent because inside stroke does not bleed outside
    const inOutsidePx = [...ctxIn.getImageData(106, 140, 1, 1).data];
    log('stroke-inside-outside-transparent', inOutsidePx[3] === 0, `rgba=${inOutsidePx.join(',')}`);
    // Probe layer center (140, 140) -> blue
    const inCenterPx = [...ctxIn.getImageData(140, 140, 1, 1).data];
    log('stroke-inside-center-blue', inCenterPx[2] > 180, `rgba=${inCenterPx.join(',')}`);

    // Center stroke
    const docCenter = importPsd('stroke-center.psd', mkStrokePsd({ position: 'center', size: { value: 6, units: 'Pixels' } }));
    const previewCenter = composeDocPreview(docCenter);
    const ctxCenter = previewCenter.getContext('2d')!;
    // Probe 2px outside edge (108, 140) -> stroke red
    const centerOutPx = [...ctxCenter.getImageData(108, 140, 1, 1).data];
    log('stroke-center-outer-half-red', centerOutPx[0] > 200 && centerOutPx[1] < 100, `rgba=${centerOutPx.join(',')}`);
    // Probe 2px inside edge (112, 140) -> stroke red
    const centerInPx = [...ctxCenter.getImageData(112, 140, 1, 1).data];
    log('stroke-center-inner-half-red', centerInPx[0] > 200 && centerInPx[1] < 100, `rgba=${centerInPx.join(',')}`);
    // Probe 5px outside edge (105, 140) -> transparent
    const centerFarPx = [...ctxCenter.getImageData(105, 140, 1, 1).data];
    log('stroke-center-outside-transparent', centerFarPx[3] === 0, `rgba=${centerFarPx.join(',')}`);

    // Size influence: 2px vs 10px outside
    const docSmall = importPsd('stroke-small.psd', mkStrokePsd({ position: 'outside', size: { value: 2, units: 'Pixels' } }));
    const docLarge = importPsd('stroke-large.psd', mkStrokePsd({ position: 'outside', size: { value: 10, units: 'Pixels' } }));
    // Probe at 104, 140 (6px outside edge): 2px stroke has alpha 0, 10px stroke has alpha 255
    const smallAlpha = composeDocPreview(docSmall).getContext('2d')!.getImageData(104, 140, 1, 1).data[3];
    const largeAlpha = composeDocPreview(docLarge).getContext('2d')!.getImageData(104, 140, 1, 1).data[3];
    log('stroke-size-influences-render', smallAlpha === 0 && largeAlpha > 200, `smallAlpha=${smallAlpha} largeAlpha=${largeAlpha}`);

    // Opacity influence
    const docFullOp = importPsd('stroke-full.psd', mkStrokePsd({ position: 'outside', opacity: 1 }));
    const docLowOp = importPsd('stroke-low.psd', mkStrokePsd({ position: 'outside', opacity: 0.35 }));
    const fullAlpha = composeDocPreview(docFullOp).getContext('2d')!.getImageData(106, 140, 1, 1).data[3];
    const lowAlpha = composeDocPreview(docLowOp).getContext('2d')!.getImageData(106, 140, 1, 1).data[3];
    log('stroke-opacity-influences-render', fullAlpha > lowAlpha && lowAlpha > 0, `fullAlpha=${fullAlpha} lowAlpha=${lowAlpha}`);

    // Custom color test: green stroke
    const docGreen = importPsd('stroke-green.psd', mkStrokePsd({ position: 'outside', color: { r: 50, g: 220, b: 60 } }));
    const greenPx = [...composeDocPreview(docGreen).getContext('2d')!.getImageData(106, 140, 1, 1).data];
    log('stroke-custom-color-renders', greenPx[1] > 200 && greenPx[0] < 80, `rgba=${greenPx.join(',')}`);

    // Export/reimport preserves stroke metadata
    const outBuf = exportPsd(docOutside);
    const reread = readPsd(outBuf, { skipThumbnail: true });
    const rereadStroke = reread.children?.[0]?.effects?.stroke?.[0];
    const strokePreserved =
      !!rereadStroke &&
      rereadStroke.enabled !== false &&
      rereadStroke.size?.value === 6 &&
      rereadStroke.position === 'outside' &&
      rereadStroke.color?.r === 255 &&
      rereadStroke.color?.g === 51;
    log('export-keeps-stroke', strokePreserved, JSON.stringify(rereadStroke));
  }

  // --- 6. Stroke coexistence tests ---
  {
    // Stroke + Drop Shadow
    const docStrokeShadow = importPsd('stroke-shadow.psd', mkStrokeDropShadowPsd());
    const leafSS = leaves(docStrokeShadow)[0]!;
    log('combo-stroke-shadow-both-active', !!activeStroke(leafSS.src.effects) && !!activeDropShadow(leafSS.src.effects), 'both active');
    const ctxSS = composeDocPreview(docStrokeShadow).getContext('2d')!;
    // Stroke probe (106, 140) is red
    const ssStrokePx = [...ctxSS.getImageData(106, 140, 1, 1).data];
    // Shadow probe (108, 118) is dark shadow
    const ssShadowPx = [...ctxSS.getImageData(108, 118, 1, 1).data];
    log('combo-stroke-shadow-stroke-present', ssStrokePx[0] > 200 && ssStrokePx[1] < 100, `rgba=${ssStrokePx.join(',')}`);
    log('combo-stroke-shadow-shadow-present', ssShadowPx[3] > 0, `rgba=${ssShadowPx.join(',')}`);

    const outSS = exportPsd(docStrokeShadow);
    const rereadSS = readPsd(outSS, { skipThumbnail: true });
    log('combo-stroke-shadow-export-kept', !!rereadSS.children?.[0]?.effects?.stroke?.length && !!rereadSS.children?.[0]?.effects?.dropShadow?.length, 'both preserved');

    // Stroke + Outer Glow
    const docStrokeGlow = importPsd('stroke-glow.psd', mkStrokeOuterGlowPsd());
    const leafSG = leaves(docStrokeGlow)[0]!;
    log('combo-stroke-glow-both-active', !!activeStroke(leafSG.src.effects) && !!activeOuterGlow(leafSG.src.effects), 'both active');
    const ctxSG = composeDocPreview(docStrokeGlow).getContext('2d')!;
    // Stroke probe (106, 140) is dominated by stroke red (on top of glow)
    const sgStrokePx = [...ctxSG.getImageData(106, 140, 1, 1).data];
    // Glow probe further outside at (98, 140) (12px outside layer, past the 6px stroke): yellow glow
    const sgGlowPx = [...ctxSG.getImageData(98, 140, 1, 1).data];
    log('combo-stroke-glow-stroke-present', sgStrokePx[0] > 200, `rgba=${sgStrokePx.join(',')}`);
    log('combo-stroke-glow-glow-present', sgGlowPx[3] > 0 && sgGlowPx[0] > 180 && sgGlowPx[1] > 140, `rgba=${sgGlowPx.join(',')}`);

    const outSG = exportPsd(docStrokeGlow);
    const rereadSG = readPsd(outSG, { skipThumbnail: true });
    log('combo-stroke-glow-export-kept', !!rereadSG.children?.[0]?.effects?.stroke?.length && !!rereadSG.children?.[0]?.effects?.outerGlow, 'both preserved');

    // All Three: Stroke + Outer Glow + Drop Shadow
    const docAll = importPsd('all-three.psd', mkAllThreePsd());
    const leafAll = leaves(docAll)[0]!;
    log('all-three-active', !!activeStroke(leafAll.src.effects) && !!activeOuterGlow(leafAll.src.effects) && !!activeDropShadow(leafAll.src.effects), 'all three active');
    const ctxAll = composeDocPreview(docAll).getContext('2d')!;
    const allStrokePx = [...ctxAll.getImageData(106, 140, 1, 1).data];
    const allGlowPx = [...ctxAll.getImageData(98, 140, 1, 1).data];
    const allCenterPx = [...ctxAll.getImageData(140, 140, 1, 1).data];
    log('all-three-stroke-present', allStrokePx[0] > 180, `rgba=${allStrokePx.join(',')}`);
    log('all-three-glow-present', allGlowPx[3] > 0, `rgba=${allGlowPx.join(',')}`);
    log('all-three-center-blue', allCenterPx[2] > 180, `rgba=${allCenterPx.join(',')}`);

    const outAll = exportPsd(docAll);
    const rereadAll = readPsd(outAll, { skipThumbnail: true });
    const rereadAllFx = rereadAll.children?.[0]?.effects;
    log('all-three-export-kept', !!rereadAllFx?.stroke?.length && !!rereadAllFx?.outerGlow && !!rereadAllFx?.dropShadow?.length, 'all 3 metadata entries preserved');
  }

  // --- 7. Unsupported effects reporting and preservation ---
  {
    // A) Solid stroke + outer glow: Both simulated!
    const supportedLayer: Layer = {
      name: 'SupportedFx',
      left: 10,
      top: 10,
      right: 90,
      bottom: 90,
      canvas: mkLayerCanvas(),
      effects: {
        outerGlow: { enabled: true, color: { r: 255, g: 204, b: 0 }, size: { value: 10, units: 'Pixels' } },
        stroke: [{ enabled: true, fillType: 'color', color: { r: 255, g: 0, b: 0 }, size: { value: 2, units: 'Pixels' } }],
      },
    };
    const suppPsd: Psd = { width: 100, height: 100, children: [supportedLayer] };
    const docSupp = importPsd('supported-fx.psd', writePsd(suppPsd));
    const leafSupp = leaves(docSupp)[0]!;
    log('solid-stroke-not-unsupported', !hasUnsupportedLayerEffects(leafSupp.src.effects), 'solid stroke is supported');
    const suppDesc = describeUnsupportedLayer(leafSupp.src);
    const strokePreviewDescribed = suppDesc.some((d) => d.includes('Stroke: drawn in the 2D layer preview'));
    const glowPreviewDescribed = suppDesc.some((d) => d.includes('Outer glow: drawn in the 2D layer preview'));
    log('supported-effects-reported-as-drawn', strokePreviewDescribed && glowPreviewDescribed, JSON.stringify(suppDesc));

    // B) Gradient stroke: Unsupported!
    const gradLayer: Layer = {
      name: 'GradStroke',
      left: 10,
      top: 10,
      right: 90,
      bottom: 90,
      canvas: mkLayerCanvas(),
      effects: {
        stroke: [{ enabled: true, fillType: 'gradient', size: { value: 4, units: 'Pixels' } }],
      },
    };
    const gradPsd: Psd = { width: 100, height: 100, children: [gradLayer] };
    const docGrad = importPsd('grad-stroke.psd', writePsd(gradPsd));
    const leafGrad = leaves(docGrad)[0]!;
    log('gradient-stroke-detected-unsupported', hasUnsupportedLayerEffects(leafGrad.src.effects), 'gradient stroke flagged');
    const gradDesc = describeUnsupportedLayer(leafGrad.src);
    const gradReported = gradDesc.some((d) => d.includes('Layer effects (stroke: gradient)') && d.includes('kept in the file'));
    log('gradient-stroke-reported-honestly', gradReported, JSON.stringify(gradDesc));

    const outGrad = exportPsd(docGrad);
    const rereadGrad = readPsd(outGrad, { skipThumbnail: true });
    log('gradient-stroke-preserved-on-export', rereadGrad.children?.[0]?.effects?.stroke?.[0]?.fillType === 'gradient', 'metadata preserved');

    // C) Pattern stroke: Unsupported!
    const patLayer: Layer = {
      name: 'PatternStroke',
      left: 10,
      top: 10,
      right: 90,
      bottom: 90,
      canvas: mkLayerCanvas(),
      effects: {
        stroke: [{ enabled: true, fillType: 'pattern', size: { value: 4, units: 'Pixels' } }],
      },
    };
    const patPsd: Psd = { width: 100, height: 100, children: [patLayer] };
    const docPat = importPsd('pat-stroke.psd', writePsd(patPsd));
    const leafPat = leaves(docPat)[0]!;
    log('pattern-stroke-detected-unsupported', hasUnsupportedLayerEffects(leafPat.src.effects), 'pattern stroke flagged');
    const patDesc = describeUnsupportedLayer(leafPat.src);
    const patReported = patDesc.some((d) => d.includes('Layer effects (stroke: pattern)') && d.includes('kept in the file'));
    log('pattern-stroke-reported-honestly', patReported, JSON.stringify(patDesc));

    const outPat = exportPsd(docPat);
    const rereadPat = readPsd(outPat, { skipThumbnail: true });
    log('pattern-stroke-preserved-on-export', rereadPat.children?.[0]?.effects?.stroke?.[0]?.fillType === 'pattern', 'metadata preserved');
  }

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} layer effect tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} layer effect tests passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

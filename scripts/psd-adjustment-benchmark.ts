/**
 * Benchmark measuring redraw time, canvas allocations, peak memory, and visual error (MAE)
 * for Milestone 2A and Milestone 2B adjustments against baked composites.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsd, type Layer, type Psd } from 'ag-psd';

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd } = await import('../src/psd/psd');
const C = await import('../src/psd/psdComposite');
const {
  evaluateLevelsChannel,
  evaluateLegacyBrightnessContrast,
} = await import('../src/psd/psdAdjustment');
const { evaluateVibrancePixel } = await import('../src/psd/psdAdjustmentVibrance');
const { evaluatePhotoFilterPixel } = await import('../src/psd/psdAdjustmentPhotoFilter');
const { parseCubeLut, sample3dLut } = await import('../src/psd/psdAdjustmentColorLookup');

// Tracking canvas allocations
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

const W = 800, H = 600;

function runBenchSuite(name: string, doc: ReturnType<typeof importPsd>) {
  console.log(`\n===== Benchmark: ${name} (${W}x${H}) =====`);
  console.log(`Mode: ${doc.psdPreviewMode}, FileCompositeBase: ${!!doc.psdFileCompositeBase}`);

  // Warmup
  C.composeDocPreview(doc);

  // Measure Dynamic 2D Stack (multiple iterations for stable timing)
  resetAlloc();
  const iterations = 5;
  const times: number[] = [];
  let dyn: HTMLCanvasElement = doc.fileComposite!;

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    dyn = C.composeDocPreview(doc);
    times.push(performance.now() - t0);
  }

  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const minMs = Math.min(...times);
  console.log(`Dynamic 2D Compose Redraw Time: avg ${avgMs.toFixed(2)} ms (min ${minMs.toFixed(2)} ms)`);
  console.log(`Canvas Allocations: ${alloc.canvases} canvases, ${alloc.megapixels.toFixed(2)} MP (${((alloc.megapixels * 4e6) / 1e6).toFixed(1)} MB RGBA)`);

  // Compare preview against baked composite
  const ref = doc.fileComposite!.getContext('2d')!.getImageData(0, 0, W, H).data;
  const act = dyn.getContext('2d')!.getImageData(0, 0, W, H).data;

  let totalDiff = 0;
  let maxDiff = 0;
  let diffCount = 0;
  const n = W * H;

  for (let i = 0; i < act.length; i += 4) {
    const dr = Math.abs(act[i] - ref[i]);
    const dg = Math.abs(act[i + 1] - ref[i + 1]);
    const db = Math.abs(act[i + 2] - ref[i + 2]);
    const d = Math.max(dr, dg, db);
    totalDiff += dr + dg + db;
    if (d > maxDiff) maxDiff = d;
    if (d > 0) diffCount++;
  }

  const mae = totalDiff / (3 * n);
  console.log(`Visual Parity against Embedded Composite:`);
  console.log(`  MAE (Mean Absolute Error): ${mae.toFixed(4)}`);
  console.log(`  Max Pixel Error: ${maxDiff}`);
  console.log(`  Pixel Match Rate: ${(((n - diffCount) / n) * 100).toFixed(2)}% exact match`);
  console.log(`  RSS Memory: ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(1)} MB`);
}

// -------------------------------------------------------------
// Suite 1: Milestone 2A (Levels + Brightness/Contrast)
// -------------------------------------------------------------
function createSuite2ADoc(): ReturnType<typeof importPsd> {
  const bg = createCanvas(W, H);
  const bctx = bg.getContext('2d');
  const grad = bctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#203050');
  grad.addColorStop(1, '#a0b0d0');
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, W, H);

  const card = createCanvas(400, 300);
  const cctx = card.getContext('2d');
  cctx.fillStyle = '#906040';
  cctx.fillRect(0, 0, 400, 300);

  const levelsAdj: any = {
    type: 'levels',
    rgb: { shadowInput: 50, highlightInput: 200, shadowOutput: 10, highlightOutput: 240, midtoneInput: 1.2 },
  };

  const bcAdj: any = {
    type: 'brightness/contrast',
    brightness: 30,
    contrast: 20,
    useLegacy: true,
  };

  const comp = createCanvas(W, H);
  const g = comp.getContext('2d');
  g.drawImage(bg, 0, 0);

  const adjCard = createCanvas(400, 300);
  const actx = adjCard.getContext('2d');
  actx.drawImage(card, 0, 0);
  const cardData = actx.getImageData(0, 0, 400, 300);
  for (let i = 0; i < cardData.data.length; i += 4) {
    cardData.data[i] = evaluateLevelsChannel(cardData.data[i], levelsAdj.rgb);
    cardData.data[i + 1] = evaluateLevelsChannel(cardData.data[i + 1], levelsAdj.rgb);
    cardData.data[i + 2] = evaluateLevelsChannel(cardData.data[i + 2], levelsAdj.rgb);
  }
  actx.putImageData(cardData, 0, 0);
  g.drawImage(adjCard, 200, 150);

  const compData = g.getImageData(0, 0, W, H);
  for (let i = 0; i < compData.data.length; i += 4) {
    compData.data[i] = evaluateLegacyBrightnessContrast(compData.data[i], 30, 20, 127);
    compData.data[i + 1] = evaluateLegacyBrightnessContrast(compData.data[i + 1], 30, 20, 127);
    compData.data[i + 2] = evaluateLegacyBrightnessContrast(compData.data[i + 2], 30, 20, 127);
  }
  g.putImageData(compData, 0, 0);

  const psd: Psd = {
    width: W,
    height: H,
    children: [
      { name: 'Background', left: 0, top: 0, right: W, bottom: H, canvas: bg },
      { name: 'Card', left: 200, top: 150, right: 600, bottom: 450, canvas: card },
      { name: 'Card Levels', clipping: true, adjustment: levelsAdj },
      { name: 'Global Brightness', adjustment: bcAdj },
    ],
    canvas: comp,
  };

  return importPsd('bench-2a.psd', writePsd(psd));
}

// -------------------------------------------------------------
// Suite 2: Milestone 2B (Vibrance + Photo Filter + Color Lookup)
// -------------------------------------------------------------
function createSuite2BDoc(): ReturnType<typeof importPsd> {
  const bg = createCanvas(W, H);
  const bctx = bg.getContext('2d');
  const grad = bctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#502030');
  grad.addColorStop(1, '#d0a0b0');
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, W, H);

  const card = createCanvas(400, 300);
  const cctx = card.getContext('2d');
  cctx.fillStyle = '#806040';
  cctx.fillRect(0, 0, 400, 300);

  const vibAdj: any = {
    type: 'vibrance',
    vibrance: 50,
    saturation: 20,
  };

  const pfAdj: any = {
    type: 'photo filter',
    color: { r: 236, g: 138, b: 0 },
    density: 30,
    preserveLuminosity: true,
  };

  const lutCubeText = `
LUT_3D_SIZE 2
0.0 0.0 0.0
0.9 0.1 0.1
0.1 0.9 0.1
1.0 1.0 0.2
0.1 0.1 0.9
1.0 0.2 1.0
0.2 1.0 1.0
1.0 1.0 1.0
`;
  const lutCube = parseCubeLut(lutCubeText)!;
  const lutData = new TextEncoder().encode(lutCubeText);

  const clAdj: any = {
    type: 'color lookup',
    lutFormat: 'cube',
    lut3DFileData: lutData,
  };

  // Pre-bake reference composite
  const comp = createCanvas(W, H);
  const g = comp.getContext('2d');
  g.drawImage(bg, 0, 0);

  // Apply clipped Vibrance to card
  const adjCard = createCanvas(400, 300);
  const actx = adjCard.getContext('2d');
  actx.drawImage(card, 0, 0);
  const cardData = actx.getImageData(0, 0, 400, 300);
  for (let i = 0; i < cardData.data.length; i += 4) {
    const [r, gr, b] = evaluateVibrancePixel(cardData.data[i], cardData.data[i + 1], cardData.data[i + 2], 50, 20);
    cardData.data[i] = r;
    cardData.data[i + 1] = gr;
    cardData.data[i + 2] = b;
  }
  actx.putImageData(cardData, 0, 0);
  g.drawImage(adjCard, 200, 150);

  // Apply global Photo Filter then Color Lookup
  const compData = g.getImageData(0, 0, W, H);
  for (let i = 0; i < compData.data.length; i += 4) {
    const [r1, g1, b1] = evaluatePhotoFilterPixel(compData.data[i], compData.data[i + 1], compData.data[i + 2], 236, 138, 0, 0.3, true);
    const [r2, g2, b2] = sample3dLut(lutCube, r1, g1, b1);
    compData.data[i] = r2;
    compData.data[i + 1] = g2;
    compData.data[i + 2] = b2;
  }
  g.putImageData(compData, 0, 0);

  const psd: Psd = {
    width: W,
    height: H,
    children: [
      { name: 'Background', left: 0, top: 0, right: W, bottom: H, canvas: bg },
      { name: 'Card', left: 200, top: 150, right: 600, bottom: 450, canvas: card },
      { name: 'Card Vibrance', clipping: true, adjustment: vibAdj },
      { name: 'Global Photo Filter', adjustment: pfAdj },
      { name: 'Global Color Lookup', adjustment: clAdj },
    ],
    canvas: comp,
  };

  return importPsd('bench-2b.psd', writePsd(psd));
}

runBenchSuite('Milestone 2A (Levels + Brightness/Contrast)', createSuite2ADoc());
runBenchSuite('Milestone 2B (Vibrance + Photo Filter + Color Lookup 3D LUT)', createSuite2BDoc());

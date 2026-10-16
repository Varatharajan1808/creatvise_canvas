/**
 * Detailed profiler for PSD Milestone 2B adjustments.
 * Breaks down execution times of:
 *  - Canvas getImageData / putImageData
 *  - LUT parsing / resolution vs caching
 *  - Inner pixel loop calculation (Vibrance, Photo Filter, Color Lookup 3D LUT)
 *  - Overall stack compose
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

const { importPsd } = await import('../src/psd');
const C = await import('../src/psdComposite');
const { applyAdjustmentToCanvas } = await import('../src/psdAdjustment');
const { evaluateVibranceInto } = await import('../src/psdAdjustmentVibrance');
const { evaluatePhotoFilterInto } = await import('../src/psdAdjustmentPhotoFilter');
const { parseCubeLut, sample3dLutInto, resolveColorLookupLut } = await import('../src/psdAdjustmentColorLookup');

const W = 800, H = 600;

// Setup test adjustments
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
const lutData = new TextEncoder().encode(lutCubeText);
const clAdj: any = {
  type: 'color lookup',
  lutFormat: 'cube',
  lut3DFileData: lutData,
};

// Target canvas
const target = createCanvas(W, H) as unknown as HTMLCanvasElement;
const ctx = target.getContext('2d')!;
ctx.fillStyle = '#607080';
ctx.fillRect(0, 0, W, H);

const iterations = 10;

console.log(`\n================ PROFILING Milestone 2B (${W}x${H} = ${W * H} pixels) ================`);

// 1. Profiling Color Lookup resolve / parse time
{
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    resolveColorLookupLut(clAdj);
  }
  const totalMs = performance.now() - t0;
  console.log(`[1] Color Lookup resolve & parse 1,000 times: ${totalMs.toFixed(2)} ms (${(totalMs / 1000).toFixed(4)} ms/call)`);
}

// 2. Profiling Canvas getImageData vs putImageData
{
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const imgData = ctx.getImageData(0, 0, W, H);
  }
  const getMs = (performance.now() - t0) / iterations;

  const imgData = ctx.getImageData(0, 0, W, H);
  const t1 = performance.now();
  for (let i = 0; i < iterations; i++) {
    ctx.putImageData(imgData, 0, 0);
  }
  const putMs = (performance.now() - t1) / iterations;
  console.log(`[2] Canvas getImageData: ${getMs.toFixed(2)} ms | putImageData: ${putMs.toFixed(2)} ms`);
}

// 3. Isolated Pixel Iterations (480,000 pixels in Uint8ClampedArray)
{
  const imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;
  const outTriplet: [number, number, number] = [0, 0, 0];

  // A. Vibrance pixel loop
  const tVib0 = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < data.length; i += 4) {
      evaluateVibranceInto(outTriplet, data[i], data[i + 1], data[i + 2], 50, 20);
      data[i] = outTriplet[0];
      data[i + 1] = outTriplet[1];
      data[i + 2] = outTriplet[2];
    }
  }
  const vibLoopMs = (performance.now() - tVib0) / iterations;
  console.log(`[3A] Vibrance 480k pixels raw loop: ${vibLoopMs.toFixed(2)} ms`);

  // B. Photo Filter pixel loop
  const tPf0 = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < data.length; i += 4) {
      evaluatePhotoFilterInto(outTriplet, data[i], data[i + 1], data[i + 2], 236, 138, 0, 0.3, true);
      data[i] = outTriplet[0];
      data[i + 1] = outTriplet[1];
      data[i + 2] = outTriplet[2];
    }
  }
  const pfLoopMs = (performance.now() - tPf0) / iterations;
  console.log(`[3B] Photo Filter 480k pixels raw loop: ${pfLoopMs.toFixed(2)} ms`);

  // C. Color Lookup pixel loop
  const lut = resolveColorLookupLut(clAdj)!;
  const tCl0 = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < data.length; i += 4) {
      sample3dLutInto(outTriplet, lut, data[i], data[i + 1], data[i + 2]);
      data[i] = outTriplet[0];
      data[i + 1] = outTriplet[1];
      data[i + 2] = outTriplet[2];
    }
  }
  const clLoopMs = (performance.now() - tCl0) / iterations;
  console.log(`[3C] Color Lookup 3D LUT 480k pixels raw loop: ${clLoopMs.toFixed(2)} ms`);
}

// 4. Overall applyAdjustmentToCanvas on 800x600 canvas
{
  const tVib = performance.now();
  for (let i = 0; i < iterations; i++) {
    applyAdjustmentToCanvas(target, vibAdj, { docW: W, docH: H, opacity: 1 });
  }
  const vibTotalMs = (performance.now() - tVib) / iterations;

  const tPf = performance.now();
  for (let i = 0; i < iterations; i++) {
    applyAdjustmentToCanvas(target, pfAdj, { docW: W, docH: H, opacity: 1 });
  }
  const pfTotalMs = (performance.now() - tPf) / iterations;

  const tCl = performance.now();
  for (let i = 0; i < iterations; i++) {
    applyAdjustmentToCanvas(target, clAdj, { docW: W, docH: H, opacity: 1 });
  }
  const clTotalMs = (performance.now() - tCl) / iterations;

  console.log(`[4] applyAdjustmentToCanvas(800x600):`);
  console.log(`    Vibrance:     ${vibTotalMs.toFixed(2)} ms`);
  console.log(`    Photo Filter: ${pfTotalMs.toFixed(2)} ms`);
  console.log(`    Color Lookup: ${clTotalMs.toFixed(2)} ms`);
  console.log(`    Total sum of 3 full-screen passes: ${(vibTotalMs + pfTotalMs + clTotalMs).toFixed(2)} ms`);
}

import fs from 'fs';
import path from 'path';
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, type Layer } from 'ag-psd';

const window = new Window();
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;
initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const { importPsd, exportPsd, inspectDocLayers } = await import('../src/psd');
const { leaves, walk } = await import('../src/model');
const { composeDocPreview, getDocPreviewCanvas } = await import('../src/psdComposite');
const { unsimulatedFeatures } = await import('../src/psdCompositeRule');

const candidatePaths = [
  'C:\\Users\\T Varatharajan\\Downloads\\2469.edited.psd',
  'C:\\Users\\T Varatharajan\\Downloads\\Kerfin7_NEA_2552.edited.psd',
  'C:\\Users\\T Varatharajan\\Downloads\\Kerfin7_NEA_2552.edited (1).psd',
  path.join(process.cwd(), '.audit-out', 'e2e-roundtrip.psd'),
  path.join(process.cwd(), '.audit-out', 'exported.edited.psd'),
  path.join(process.cwd(), '.audit-out', 'rotated.psd'),
];

console.log('=== REAL PSD FIXTURE AUDIT ===');

for (const p of candidatePaths) {
  if (!fs.existsSync(p)) {
    console.log(`[NOT FOUND] ${p}`);
    continue;
  }
  const stat = fs.statSync(p);
  console.log(`\n--- Inspecting: ${path.basename(p)} (${(stat.size / 1024).toFixed(1)} KB) ---`);
  try {
    const buf = fs.readFileSync(p);
    const doc = importPsd(path.basename(p), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    console.log(`  Dimensions: ${doc.width}x${doc.height}`);
    console.log(`  Preview Mode: ${doc.psdPreviewMode}`);
    console.log(`  Total Nodes: ${[...walk(doc.roots)].length}, Leaf Layers: ${leaves(doc).length}`);

    const unsim = unsimulatedFeatures(doc);
    console.log(`  Unsimulated Features: ${unsim.length > 0 ? unsim.join(', ') : 'None (fully simulated)'}`);

    const inspected = inspectDocLayers(doc);
    for (const l of inspected.slice(0, 10)) {
      console.log(`    Layer: "${l.name}" | Kind: ${l.kind} | Visible: ${l.visible} | Opacity: ${l.opacity}`);
    }
    if (inspected.length > 10) {
      console.log(`    ... and ${inspected.length - 10} more layers`);
    }

    // Compose preview
    const t0 = performance.now();
    const preview = composeDocPreview(doc);
    const dt = performance.now() - t0;
    console.log(`  Preview Render: OK (${dt.toFixed(1)}ms, canvas ${preview.width}x${preview.height})`);

    // Test Move & Rotate
    const firstLeaf = leaves(doc).find((n) => n.kind === 'pixel' || n.kind === 'shape');
    if (firstLeaf) {
      const origX = firstLeaf.x;
      const origY = firstLeaf.y;
      firstLeaf.x += 25;
      firstLeaf.y += 15;
      firstLeaf.rotation = 15;
      const previewMoved = composeDocPreview(doc);
      console.log(`  Transform Edit (move+rotate on "${firstLeaf.name}"): OK`);
      // Restore
      firstLeaf.x = origX;
      firstLeaf.y = origY;
      firstLeaf.rotation = 0;
    }

    // Export round-trip
    const tExp0 = performance.now();
    const exportedBytes = await exportPsd(doc);
    const dtExp = performance.now() - tExp0;
    console.log(`  Export: OK (${dtExp.toFixed(1)}ms, ${exportedBytes.byteLength} bytes)`);

    // Re-import exported
    const reimported = importPsd(`reimport-${path.basename(p)}`, exportedBytes);
    console.log(`  Re-import: OK (nodes: ${[...walk(reimported.roots)].length})`);
  } catch (err) {
    console.error(`  ERROR on ${path.basename(p)}:`, err);
  }
}

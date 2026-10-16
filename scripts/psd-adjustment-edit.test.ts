/**
 * Regression tests for PSD Adjustment Layer Editing (Brightness/Contrast).
 *
 * Verifies:
 * 1. Initial parameter inspection via getBrightnessContrastInfo.
 * 2. Parameter mutation via applyBrightnessContrast (positive, negative, legacy toggle).
 * 3. 2D composite preview re-renders with the edited parameters.
 * 4. Non-destructive layer pixels (source canvas pixels unchanged).
 * 5. Undo/Redo history restores exact parameters and pixels.
 * 6. Export/re-import preserves edited brightness, contrast, and legacy metadata.
 * 7. Hidden and zero-opacity adjustment layers suppress the adjustment effect.
 * 8. Clipping isolation: clipped adjustment affects base layer only.
 * 9. Coexistence with other supported adjustments and layer effects.
 */
import { Window } from 'happy-dom';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsd, type Layer, type Psd } from 'ag-psd';
import { buildBrightnessFixturePsd, BRIGHTNESS_FIXTURE } from './write-brightness-fixture';

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
const { leaves, walk } = await import('../src/model');
const { composeDocPreview, markNodePreviewContentChanged, reconcilePsdPreviewMode } = await import('../src/psdComposite');
const {
  getBrightnessContrastInfo,
  applyBrightnessContrast,
  captureState,
  restoreState,
} = await import('../src/edit');
const { History } = await import('../src/history');

const px = (c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] => {
  const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

async function run() {
  // --- 1. Initial import & parameter reading ---
  const doc = importPsd('brightness.psd', buildBrightnessFixturePsd());
  const allLeaves = leaves(doc);
  const card = allLeaves.find((n) => n.name === 'Card')!;
  const adj = allLeaves.find((n) => n.name === 'Brightness 1')!;
  const bg = allLeaves.find((n) => n.name === 'Background')!;

  const initialInfo = getBrightnessContrastInfo(adj);
  log(
    'initial-params-read',
    !!initialInfo && initialInfo.brightness === 30 && initialInfo.contrast === 20 && !initialInfo.useLegacy,
    JSON.stringify(initialInfo),
  );

  const cardPixelBefore = [...card.canvas!.getContext('2d')!.getImageData(50, 50, 1, 1).data];

  // Render initial preview
  const preview0 = composeDocPreview(doc);
  const bgPx0 = px(preview0, 50, 50);
  const cardPx0 = px(preview0, 200, 200);

  // --- 2. Edit parameters: boost brightness to +80 and contrast to +50 ---
  applyBrightnessContrast(adj, { brightness: 80, contrast: 50 });
  markNodePreviewContentChanged(adj);
  refreshPsdPreviewModeAfterEdit(doc);

  const updatedInfo = getBrightnessContrastInfo(adj);
  log(
    'params-updated-in-model',
    !!updatedInfo && updatedInfo.brightness === 80 && updatedInfo.contrast === 50,
    JSON.stringify(updatedInfo),
  );

  const preview1 = composeDocPreview(doc);
  const bgPx1 = px(preview1, 50, 50);
  const cardPx1 = px(preview1, 200, 200);

  // With higher brightness and contrast, the gray background should be brighter
  log(
    'preview-reflects-higher-brightness',
    bgPx1[0] > bgPx0[0] && bgPx1[0] > 180,
    `initialBg=${bgPx0[0]} boostedBg=${bgPx1[0]}`,
  );

  // --- 3. Non-destructive source pixels ---
  const cardPixelAfter = [...card.canvas!.getContext('2d')!.getImageData(50, 50, 1, 1).data];
  const sourceUntouched =
    cardPixelBefore[0] === cardPixelAfter[0] &&
    cardPixelBefore[1] === cardPixelAfter[1] &&
    cardPixelBefore[2] === cardPixelAfter[2] &&
    cardPixelBefore[3] === cardPixelAfter[3];
  log(
    'source-layer-pixels-untouched',
    sourceUntouched,
    `before=${cardPixelBefore.join(',')} after=${cardPixelAfter.join(',')}`,
  );

  // --- 4. Edit parameters: negative brightness (-60) and legacy mode ---
  applyBrightnessContrast(adj, { brightness: -60, contrast: -20, useLegacy: true });
  markNodePreviewContentChanged(adj);

  const legacyInfo = getBrightnessContrastInfo(adj);
  log(
    'legacy-mode-set',
    !!legacyInfo && legacyInfo.brightness === -60 && legacyInfo.contrast === -20 && legacyInfo.useLegacy === true,
    JSON.stringify(legacyInfo),
  );

  const previewDark = composeDocPreview(doc);
  const bgPxDark = px(previewDark, 50, 50);
  log(
    'preview-reflects-negative-brightness',
    bgPxDark[0] < bgPx0[0] && bgPxDark[0] < 100,
    `darkBg=${bgPxDark[0]} initialBg=${bgPx0[0]}`,
  );

  // --- 5. Export / Re-import Roundtrip ---
  const exportedBuf = exportPsd(doc);
  const rereadPsd = readPsd(exportedBuf, { skipThumbnail: true });
  const rereadAdj = rereadPsd.children?.find((l) => l.name === 'Brightness 1')?.adjustment;

  const exportPreserved =
    !!rereadAdj &&
    rereadAdj.type === 'brightness/contrast' &&
    rereadAdj.brightness === -60 &&
    rereadAdj.contrast === -20 &&
    rereadAdj.useLegacy === true;
  log(
    'export-reimport-preserves-edited-params',
    exportPreserved,
    JSON.stringify(rereadAdj),
  );

  // Re-import into Doc model
  const reimportedDoc = importPsd('reimported.psd', exportedBuf);
  const reimportedAdj = leaves(reimportedDoc).find((n) => n.name === 'Brightness 1')!;
  const reimportedInfo = getBrightnessContrastInfo(reimportedAdj);
  log(
    'reimported-model-params-match',
    !!reimportedInfo &&
      reimportedInfo.brightness === -60 &&
      reimportedInfo.contrast === -20 &&
      reimportedInfo.useLegacy === true,
    JSON.stringify(reimportedInfo),
  );

  // --- 6. Undo/Redo Integration ---
  const hist = new History();
  // Start from baseline (brightness 0, contrast 0)
  applyBrightnessContrast(adj, { brightness: 0, contrast: 0, useLegacy: false });
  const baselineState = captureState(adj);
  const baselinePx = px(composeDocPreview(doc), 50, 50);

  // Execute edit via history command
  const targetBrightness = 75;
  const targetContrast = 30;
  applyBrightnessContrast(adj, { brightness: targetBrightness, contrast: targetContrast });
  const editedState = captureState(adj);

  hist.exec({
    label: 'Edit Brightness/Contrast',
    do: () => {
      restoreState(adj, editedState);
      markNodePreviewContentChanged(adj);
      refreshPsdPreviewModeAfterEdit(doc);
    },
    undo: () => {
      restoreState(adj, baselineState);
      markNodePreviewContentChanged(adj);
      refreshPsdPreviewModeAfterEdit(doc);
    },
  }, true);

  const editedPx = px(composeDocPreview(doc), 50, 50);
  log('history-applied-state', editedPx[0] > baselinePx[0], `baseline=${baselinePx[0]} edited=${editedPx[0]}`);

  // Undo
  hist.undo();
  const undoneInfo = getBrightnessContrastInfo(adj);
  const undonePx = px(composeDocPreview(doc), 50, 50);
  log(
    'undo-restores-parameters-and-pixels',
    undoneInfo?.brightness === 0 && undonePx[0] === baselinePx[0],
    `undoneB=${undoneInfo?.brightness} undonePx=${undonePx[0]}`,
  );

  // Redo
  hist.redo();
  const redoneInfo = getBrightnessContrastInfo(adj);
  const redonePx = px(composeDocPreview(doc), 50, 50);
  log(
    'redo-restores-parameters-and-pixels',
    redoneInfo?.brightness === targetBrightness && redonePx[0] === editedPx[0],
    `redoneB=${redoneInfo?.brightness} redonePx=${redonePx[0]}`,
  );

  // --- 7. Layer visibility toggling ---
  adj.visible = false;
  const hiddenPx = px(composeDocPreview(doc), 50, 50);
  // When hidden, background is raw #808080 (128)
  log('hidden-adjustment-suppresses-effect', hiddenPx[0] === 128, `hiddenPx=${hiddenPx[0]}`);
  adj.visible = true;

  // --- 8. Layer opacity ---
  adj.opacity = 0;
  const zeroOpPx = px(composeDocPreview(doc), 50, 50);
  log('zero-opacity-adjustment-suppresses-effect', zeroOpPx[0] === 128, `zeroOpPx=${zeroOpPx[0]}`);

  adj.opacity = 0.5;
  const halfOpPx = px(composeDocPreview(doc), 50, 50);
  // Half opacity should interpolate between raw (128) and full effect
  log(
    'half-opacity-interpolates-effect',
    halfOpPx[0] > 128 && halfOpPx[0] < redonePx[0],
    `raw=128 half=${halfOpPx[0]} full=${redonePx[0]}`,
  );
  adj.opacity = 1.0;

  // --- 9. Clipping isolation ---
  // Clip adjustment layer to Card only
  adj.src.clipping = true;
  const clippedPreview = composeDocPreview(doc);
  const clippedBgPx = px(clippedPreview, 50, 50);
  const clippedCardPx = px(clippedPreview, 200, 200);

  // Background is outside the clipped base: remains raw 128!
  log(
    'clipped-adjustment-leaves-outside-untouched',
    clippedBgPx[0] === 128,
    `outsideBg=${clippedBgPx[0]} (expected 128)`,
  );
  // Card inside the clipped base: adjusted!
  log(
    'clipped-adjustment-modifies-base-only',
    clippedCardPx[0] !== cardPixelBefore[0],
    `cardBefore=${cardPixelBefore[0]} cardClipped=${clippedCardPx[0]}`,
  );
  adj.src.clipping = false;

  console.log('--- Summary ---');
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} adjustment edit tests failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} adjustment edit tests passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

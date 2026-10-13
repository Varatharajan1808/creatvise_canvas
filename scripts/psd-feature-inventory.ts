/**
 * Read-only metadata inventory: per layer adjustment type, Color Lookup format, enabled effects,
 * mask fields and gray statistics, clipping, layer/group blend modes, fill opacity, knockout,
 * Blend If, smart filters. Uses ag-psd image data only (no canvas), so it is cheap on large files.
 *
 * Usage: npx tsx scripts/psd-feature-inventory.ts [file.psd ...]
 * Defaults to PSD_TEXT_FIXTURE and PSD_FIXTURE.
 */
import fs from 'fs';
import path from 'path';
import { initializeCanvas, readPsd, type Layer, type LayerMaskData, type LayerEffectsInfo } from 'ag-psd';

initializeCanvas(
  () => {
    throw new Error('inventory reads image data only');
  },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' }) as ImageData,
);

const defaults = [
  process.env.PSD_TEXT_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', 'slice-photo-frame-effect', '9015560.psd'),
  process.env.PSD_FIXTURE ?? path.join('C:', 'Users', 'Dwinzo', 'Downloads', '10960916.psd'),
];
const files = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

function maskInfo(m: LayerMaskData | undefined) {
  if (!m) return undefined;
  const left = m.left ?? 0;
  const top = m.top ?? 0;
  const info: Record<string, unknown> = {
    rect: [left, top, (m.right ?? left) - left, (m.bottom ?? top) - top],
    defaultColor: m.defaultColor,
    disabled: !!m.disabled,
    fromVector: m.fromVectorData,
    density: m.userMaskDensity,
    feather: m.userMaskFeather,
  };
  const d = m.imageData?.data;
  if (d) {
    let zero = 0, full = 0, part = 0, sum = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i];
      sum += v;
      if (v === 0) zero++;
      else if (v === 255) full++;
      else part++;
    }
    info.gray = { mean: +(sum / n).toFixed(1), pctZero: +((100 * zero) / n).toFixed(1), pctFull: +((100 * full) / n).toFixed(1), pctPartial: +((100 * part) / n).toFixed(1) };
  }
  return info;
}

function adjustmentInfo(l: Layer) {
  const a = l.adjustment;
  if (!a) return undefined;
  if (a.type === 'color lookup') {
    return { type: a.type, lookupType: a.lookupType, lutFormat: a.lutFormat, lutBytes: a.lut3DFileData?.length ?? 0, profileBytes: a.profile?.length ?? 0 };
  }
  const { type, ...params } = a as { type: string } & Record<string, unknown>;
  return { type, params: JSON.stringify(params).slice(0, 200) };
}

function effectsInfo(e: LayerEffectsInfo | undefined) {
  if (!e) return undefined;
  const list: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'disabled' || k === 'scale') continue;
    for (const x of ([] as Array<{ enabled?: boolean; blendMode?: string }>).concat(v as never)) {
      list.push(`${k}${x.enabled === false ? '(off)' : ''}${x.blendMode ? ':' + x.blendMode : ''}`);
    }
  }
  return { disabled: !!e.disabled, scale: e.scale, list };
}

const defaultRanges = (l: Layer) =>
  !l.blendingRanges ||
  [l.blendingRanges.compositeGrayBlendSource, l.blendingRanges.compositeGraphBlendDestinationRange, ...l.blendingRanges.ranges.flatMap((r) => [r.sourceRange, r.destRange])].every(
    (r) => r.join() === '0,0,255,255',
  );

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`SKIP: ${file} not found`);
    continue;
  }
  const psd = readPsd(fs.readFileSync(file), { skipThumbnail: true, useImageData: true, skipCompositeImageData: true });
  const vi = psd.imageResources?.versionInfo;
  console.log(`\n===== ${path.basename(file)} ${psd.width}x${psd.height} bits=${psd.bitsPerChannel} colorMode=${psd.colorMode} hasRealMergedData=${vi?.hasRealMergedData} writer=${vi?.writerName ?? '?'} =====`);
  const walk = (ls: Layer[] | undefined, parentKey: string, depth: number) =>
    (ls ?? []).forEach((l, i) => {
      const key = parentKey === '' ? String(i) : `${parentKey}/${i}`;
      const isGroup = !!l.children;
      const row: Record<string, unknown> = {
        key,
        name: l.name,
        kind: isGroup ? 'group' : l.adjustment ? 'adjustment' : l.text ? 'text' : l.placedLayer ? 'smart' : l.vectorFill || l.vectorStroke ? 'shape' : 'raster',
        hidden: !!l.hidden || undefined,
        opacity: l.opacity,
        fill: l.fillOpacity,
        blend: l.blendMode,
        clip: l.clipping || undefined,
        bounds: isGroup ? undefined : [l.left, l.top, (l.right ?? 0) - (l.left ?? 0), (l.bottom ?? 0) - (l.top ?? 0)],
        pixels: isGroup ? undefined : !!l.imageData,
        knockout: l.knockout || undefined,
        blendClipped: l.blendClippendElements === false ? false : undefined,
        blendInterior: l.blendInteriorElements || undefined,
        blendIf: defaultRanges(l) ? undefined : 'non-default',
        mask: maskInfo(l.mask),
        realMask: maskInfo(l.realMask),
        vectorMask: l.vectorMask ? { paths: l.vectorMask.paths?.length ?? 0, disabled: !!l.vectorMask.disable } : undefined,
        adjustment: adjustmentInfo(l),
        effects: effectsInfo(l.effects),
        smart: l.placedLayer
          ? { type: l.placedLayer.type, filters: l.placedLayer.filter?.list?.map((f) => (f as { name?: string }).name ?? 'filter'), warp: !!l.placedLayer.warp }
          : undefined,
      };
      for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
      console.log('  '.repeat(depth) + JSON.stringify(row));
      walk(l.children, key, depth + 1);
    });
  walk(psd.children, '', 0);
}

import { applyFillTint, resolveSwatchRef, type IdmlColorMap } from './swatches';

export type IdmlObjectStyleFillMap = Map<string, string>;

function localName(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || '';
}

/** Map ObjectStyle Self → resolved fill hex from Styles.xml. */
export function parseStylesXmlObjectFills(xml: string, colors: IdmlColorMap): IdmlObjectStyleFillMap {
  const map: IdmlObjectStyleFillMap = new Map();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const styles = root.getElementsByTagName('*');
  for (let i = 0; i < styles.length; i++) {
    const el = styles[i];
    if (localName(el).toLowerCase() !== 'objectstyle') continue;
    const self = el.getAttribute('Self');
    if (!self) continue;
    const enableFill = el.getAttribute('EnableFill');
    if (enableFill === 'false') continue;
    const fillRef = el.getAttribute('FillColor');
    let hex = resolveSwatchRef(fillRef, colors);
    if (hex) {
      const tintRaw = el.getAttribute('FillTint');
      const tint = tintRaw !== null && tintRaw !== '' ? Number(tintRaw) : 100;
      if (Number.isFinite(tint) && tint >= 0 && tint < 100) {
        const paper = resolveSwatchRef('Color/Paper', colors) ?? '#ffffff';
        hex = applyFillTint(hex, tint, paper);
      }
      map.set(self, hex);
    }
  }
  return map;
}

export function resolveItemFillHex(
  itemEl: Element,
  colors: IdmlColorMap,
  objectFills: IdmlObjectStyleFillMap,
): string | null {
  const direct = itemEl.getAttribute('FillColor');
  if (direct) {
    let h = resolveSwatchRef(direct, colors);
    if (h) {
      const tintRaw = itemEl.getAttribute('FillTint');
      const tint = tintRaw !== null && tintRaw !== '' ? Number(tintRaw) : 100;
      if (Number.isFinite(tint) && tint >= 0 && tint < 100) {
        const paper = resolveSwatchRef('Color/Paper', colors) ?? '#ffffff';
        h = applyFillTint(h, tint, paper);
      }
      return h;
    }
  }
  const styleRef = itemEl.getAttribute('AppliedObjectStyle');
  if (styleRef && objectFills.has(styleRef)) return objectFills.get(styleRef)!;
  if (styleRef) {
    const fromStyle = resolveSwatchRef(styleRef, colors);
    if (fromStyle) return fromStyle;
  }
  return null;
}

export function resolveItemStrokeFromSpread(
  itemEl: Element,
  colors: IdmlColorMap,
): {
  hex: string | null;
  swatchRef: string | null;
  weight: number;
  tint: number;
  enabled: boolean;
} {
  const direct = itemEl.getAttribute('StrokeColor');
  if (!direct || direct === 'n') {
    return { hex: null, swatchRef: null, weight: 0, tint: 100, enabled: false };
  }
  let hex = resolveSwatchRef(direct, colors);
  const tintRaw = itemEl.getAttribute('StrokeTint');
  const tint = tintRaw !== null && tintRaw !== '' ? Number(tintRaw) : 100;
  if (hex && Number.isFinite(tint) && tint >= 0 && tint < 100) {
    const paper = resolveSwatchRef('Color/Paper', colors) ?? '#ffffff';
    hex = applyFillTint(hex, tint, paper);
  }
  const weightRaw = itemEl.getAttribute('StrokeWeight');
  const weight = weightRaw !== null && weightRaw !== '' ? Number(weightRaw) : 1;
  const w = Number.isFinite(weight) ? weight : 1;
  return {
    hex,
    swatchRef: direct,
    weight: w,
    tint: Number.isFinite(tint) ? tint : 100,
    enabled: w > 0 && Boolean(hex),
  };
}

import { resolveSwatchRef, type IdmlColorMap } from './swatches';

export interface IdmlTextStyleAttrs {
  pointSize?: number;
  fillColorRef?: string;
  appliedFont?: string;
  fontStyle?: string;
  leading?: number;
  tracking?: number;
  justification?: string;
}

export type IdmlParagraphStyleMap = Map<string, IdmlTextStyleAttrs>;
export type IdmlCharacterStyleMap = Map<string, IdmlTextStyleAttrs>;

export interface IdmlTextStyleResources {
  paragraphStyles: IdmlParagraphStyleMap;
  characterStyles: IdmlCharacterStyleMap;
}

function localName(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || '';
}

function readBasedOnRef(styleEl: Element): string | null {
  const props = styleEl.getElementsByTagName('*');
  for (let i = 0; i < props.length; i++) {
    const el = props[i];
    if (localName(el).toLowerCase() !== 'basedon') continue;
    const t = el.textContent?.trim();
    if (!t || t.startsWith('$ID/')) return null;
    return t;
  }
  return null;
}

function readAppliedFontFromEl(styleEl: Element): string | undefined {
  const props = styleEl.getElementsByTagName('*');
  for (let i = 0; i < props.length; i++) {
    const el = props[i];
    if (localName(el).toLowerCase() !== 'appliedfont') continue;
    const t = el.textContent?.trim();
    if (t) return t;
  }
  return undefined;
}

function readLeadingFromProperties(styleEl: Element): number | undefined {
  const props = styleEl.getElementsByTagName('*');
  for (let i = 0; i < props.length; i++) {
    const el = props[i];
    if (localName(el).toLowerCase() !== 'leading') continue;
    const n = Number(el.textContent?.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function attrsFromStyleElement(styleEl: Element): IdmlTextStyleAttrs {
  const attrs: IdmlTextStyleAttrs = {};
  const ps = styleEl.getAttribute('PointSize') || styleEl.getAttribute('FontSize');
  if (ps) {
    const n = Number(ps);
    if (Number.isFinite(n) && n > 0) attrs.pointSize = n;
  }
  const fill = styleEl.getAttribute('FillColor');
  if (fill && fill !== 'n') attrs.fillColorRef = fill;
  const font = readAppliedFontFromEl(styleEl);
  if (font) attrs.appliedFont = font;
  const fontStyle = styleEl.getAttribute('FontStyle');
  if (fontStyle) attrs.fontStyle = fontStyle;
  const tracking = styleEl.getAttribute('Tracking');
  if (tracking) {
    const n = Number(tracking);
    if (Number.isFinite(n)) attrs.tracking = n;
  }
  const justification = styleEl.getAttribute('Justification');
  if (justification) attrs.justification = justification;
  const leading = readLeadingFromProperties(styleEl);
  if (leading) attrs.leading = leading;
  return attrs;
}

function mergeTextStyleAttrs(base: IdmlTextStyleAttrs, override: IdmlTextStyleAttrs): IdmlTextStyleAttrs {
  return {
    pointSize: override.pointSize ?? base.pointSize,
    fillColorRef: override.fillColorRef ?? base.fillColorRef,
    appliedFont: override.appliedFont ?? base.appliedFont,
    fontStyle: override.fontStyle ?? base.fontStyle,
    leading: override.leading ?? base.leading,
    tracking: override.tracking ?? base.tracking,
    justification: override.justification ?? base.justification,
  };
}

type RawStyleRow = { attrs: IdmlTextStyleAttrs; basedOn: string | null };

function resolveStyleChain(self: string | null | undefined, raw: Map<string, RawStyleRow>): IdmlTextStyleAttrs {
  if (!self || self.startsWith('$ID/') || /\[No (paragraph|character) style\]/i.test(self)) {
    return {};
  }
  const visited = new Set<string>();
  let merged: IdmlTextStyleAttrs = {};
  let cur: string | null = self;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const row = raw.get(cur);
    if (row) merged = mergeTextStyleAttrs(row.attrs, merged);
    cur = row?.basedOn ?? null;
  }
  return merged;
}

function indexRawStyles(xml: string, tagLocal: string): Map<string, RawStyleRow> {
  const map = new Map<string, RawStyleRow>();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const all = doc.documentElement.getElementsByTagName('*');
  const want = tagLocal.toLowerCase();
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (localName(el).toLowerCase() !== want) continue;
    const self = el.getAttribute('Self');
    if (!self) continue;
    map.set(self, {
      attrs: attrsFromStyleElement(el),
      basedOn: readBasedOnRef(el),
    });
  }
  return map;
}

function buildResolvedMap(raw: Map<string, RawStyleRow>): Map<string, IdmlTextStyleAttrs> {
  const resolved = new Map<string, IdmlTextStyleAttrs>();
  for (const self of raw.keys()) {
    resolved.set(self, resolveStyleChain(self, raw));
  }
  return resolved;
}

/** Parse Resources/Styles.xml paragraph + character styles (with BasedOn inheritance). */
export function parseStylesXmlTextStyles(xml: string): IdmlTextStyleResources {
  const paraRaw = indexRawStyles(xml, 'ParagraphStyle');
  const charRaw = indexRawStyles(xml, 'CharacterStyle');
  return {
    paragraphStyles: buildResolvedMap(paraRaw),
    characterStyles: buildResolvedMap(charRaw),
  };
}

function isNoCharacterStyle(ref: string | null | undefined): boolean {
  return !ref || ref.startsWith('$ID/') || /\[No character style\]/i.test(ref);
}

export function resolveStoryTypography(
  paragraphStyleRef: string | null | undefined,
  characterStyleRef: string | null | undefined,
  charRangeEl: Element | null,
  resources: IdmlTextStyleResources,
  colors: IdmlColorMap,
): { fontSize: number; fontFamily: string; textColorHex: string; fontStyle?: string } {
  const paraResolved =
    paragraphStyleRef && !paragraphStyleRef.startsWith('$ID/')
      ? resources.paragraphStyles.get(paragraphStyleRef) ?? {}
      : {};
  const charResolved = isNoCharacterStyle(characterStyleRef)
    ? {}
    : resources.characterStyles.get(characterStyleRef!) ?? {};

  const inlineSize = charRangeEl
    ? Number(charRangeEl.getAttribute('PointSize') || charRangeEl.getAttribute('FontSize'))
    : NaN;
  const inlineFill = charRangeEl?.getAttribute('FillColor') || charRangeEl?.getAttribute('StrokeColor');
  const appliedFontInline = charRangeEl ? readAppliedFontFromEl(charRangeEl) : undefined;

  const fontSize =
    (Number.isFinite(inlineSize) && inlineSize > 0 ? inlineSize : undefined) ??
    charResolved.pointSize ??
    paraResolved.pointSize ??
    12;

  const fillRef =
    (inlineFill && inlineFill !== 'n' ? inlineFill : undefined) ??
    charResolved.fillColorRef ??
    paraResolved.fillColorRef;

  const fontFamily = appliedFontInline ?? charResolved.appliedFont ?? paraResolved.appliedFont ?? 'sans-serif';

  const textColorHex = resolveSwatchRef(fillRef, colors) ?? '#1e1e1e';

  const inlineFontStyle = charRangeEl?.getAttribute('FontStyle') ?? undefined;
  const fontStyle = inlineFontStyle ?? charResolved.fontStyle ?? paraResolved.fontStyle;

  return { fontSize, fontFamily, textColorHex, fontStyle };
}

export function resolveParagraphTypography(
  paragraphStyleRef: string | null | undefined,
  resources: IdmlTextStyleResources,
): Pick<IdmlTextStyleAttrs, 'leading' | 'tracking' | 'justification' | 'pointSize'> {
  if (!paragraphStyleRef || paragraphStyleRef.startsWith('$ID/')) return {};
  return resources.paragraphStyles.get(paragraphStyleRef) ?? {};
}

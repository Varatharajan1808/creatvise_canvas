/** Resolve IDML Resources/Graphic.xml colors to CSS hex. */

export type IdmlColorMap = Map<string, string>;

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function cmykToRgbHex(c: number, m: number, y: number, k: number): string {
  const cc = c / 100;
  const mm = m / 100;
  const yy = y / 100;
  const kk = k / 100;
  const r = 255 * (1 - cc) * (1 - kk);
  const g = 255 * (1 - mm) * (1 - kk);
  const b = 255 * (1 - yy) * (1 - kk);
  return (
    '#' +
    [clamp255(r), clamp255(g), clamp255(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

function rgbComponentsToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [clamp255(r), clamp255(g), clamp255(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return null;
  const r = Number.parseInt(s.slice(0, 2), 16);
  const g = Number.parseInt(s.slice(2, 4), 16);
  const b = Number.parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  return [r, g, b];
}

/**
 * InDesign fill tint: mix swatch color toward Paper (0 = paper, 100 = solid swatch).
 * FillTint -1 is treated as solid (no tint).
 */
export function applyFillTint(colorHex: string, tintPercent: number, paperHex: string): string {
  if (tintPercent < 0 || tintPercent >= 100) return colorHex;
  const color = parseHexRgb(colorHex);
  const paper = parseHexRgb(paperHex);
  if (!color || !paper) return colorHex;
  const t = tintPercent / 100;
  return rgbComponentsToHex(
    paper[0] + (color[0] - paper[0]) * t,
    paper[1] + (color[1] - paper[1]) * t,
    paper[2] + (color[2] - paper[2]) * t,
  );
}

function localName(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || '';
}

export function parseGraphicXmlColors(xml: string): IdmlColorMap {
  const map: IdmlColorMap = new Map();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const colors = root.getElementsByTagName('*');
  for (let i = 0; i < colors.length; i++) {
    const el = colors[i];
    if (localName(el).toLowerCase() !== 'color') continue;
    const self = el.getAttribute('Self');
    if (!self) continue;
    const space = (el.getAttribute('Space') || 'CMYK').toUpperCase();
    const raw = el.getAttribute('ColorValue');
    if (!raw) continue;
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.some((n) => !Number.isFinite(n))) continue;
    let hex: string | null = null;
    if (space === 'CMYK' && parts.length >= 4) {
      hex = cmykToRgbHex(parts[0], parts[1], parts[2], parts[3]);
    } else if (space === 'RGB' && parts.length >= 3) {
      const scale = parts.every((p) => p <= 1) ? 255 : parts.every((p) => p <= 100) ? 2.55 : 1;
      hex = rgbComponentsToHex(parts[0] * scale, parts[1] * scale, parts[2] * scale);
    }
    if (hex) map.set(self, hex);
  }
  return map;
}

/** Built-in swatch names when Graphic.xml has no entry. */
export function builtinSwatchHex(ref: string | null | undefined): string | null {
  if (!ref || ref === 'n' || /None/i.test(ref)) return null;
  if (/Black/i.test(ref)) return '#000000';
  if (/Paper|White/i.test(ref)) return '#ffffff';
  if (/Registration/i.test(ref)) return '#000000';
  return null;
}

export function resolveSwatchRef(ref: string | null | undefined, colors: IdmlColorMap): string | null {
  if (!ref || ref === 'n' || /None/i.test(ref)) return null;
  const direct = colors.get(ref);
  if (direct) return direct;
  if (ref.startsWith('Swatch/')) {
    const alt = ref.replace(/^Swatch\//, 'Color/');
    if (colors.has(alt)) return colors.get(alt)!;
  }
  return builtinSwatchHex(ref);
}

/** Find an existing Graphic.xml swatch ref whose resolved RGB hex matches (case-insensitive). */
export function findSwatchRefByHex(hex: string, colors: IdmlColorMap): string | null {
  const h = hex.toLowerCase();
  for (const [ref, value] of colors) {
    if (value.toLowerCase() === h) return ref;
  }
  return null;
}

export function rgbHexToCmykColorValue(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) return '0 0 0 100';
  const [r, g, b] = rgb.map((v) => v / 255);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-6) return '0 0 0 100';
  const c = (1 - r - k) / (1 - k);
  const m = (1 - g - k) / (1 - k);
  const y = (1 - b - k) / (1 - k);
  const pct = (v: number) => Math.round(Math.max(0, Math.min(100, v * 100)) * 100) / 100;
  return `${pct(c)} ${pct(m)} ${pct(y)} ${pct(k)}`;
}

function collectColorSelfIds(graphicXml: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bSelf="(Color\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(graphicXml))) ids.add(m[1]);
  return ids;
}

/** Allocate a unique `Color/Canvas …` Self id not present in Graphic.xml. */
export function allocateCanvasColorSelf(graphicXml: string): string {
  const taken = collectColorSelfIds(graphicXml);
  let n = 1;
  while (taken.has(`Color/Canvas ${n}`)) n++;
  return `Color/Canvas ${n}`;
}

/** Append a process CMYK color swatch before the Graphic root closing tag. */
export function appendProcessCmykColorToGraphicXml(graphicXml: string, self: string, hex: string): string {
  const cv = rgbHexToCmykColorValue(hex);
  const name = self.replace(/^Color\//, '').replace(/"/g, '');
  const el = `\t<Color Self="${self}" Model="Process" Space="CMYK" ColorValue="${cv}" Name="${name}" ColorOverride="Normal" Visible="true" />`;
  const closeRe = /(\s*)(<\/(?:idPkg:)?Graphic\s*>)/i;
  if (closeRe.test(graphicXml)) {
    return graphicXml.replace(closeRe, `${el}\n$1$2`);
  }
  return `${graphicXml}\n${el}\n`;
}

export function ensureSwatchRefForHex(
  hex: string,
  graphicXml: string,
  colors: IdmlColorMap,
): { ref: string; graphicXml: string; colors: IdmlColorMap; added: boolean } {
  const normalized = hex.toLowerCase();
  const existing = findSwatchRefByHex(normalized, colors);
  if (existing) return { ref: existing, graphicXml, colors, added: false };

  const self = allocateCanvasColorSelf(graphicXml);
  const nextXml = appendProcessCmykColorToGraphicXml(graphicXml, self, normalized);
  const nextColors = new Map(colors);
  nextColors.set(self, normalized);
  return { ref: self, graphicXml: nextXml, colors: nextColors, added: true };
}

/** Patch IDML Story XML from Canvas text edits while preserving range structure when possible. */

import type { Node } from '../core/model';
import { rgbToHex } from '../operations/edit';
import { escapeIdmlXmlText } from './exportPatch';
import { decodeIdmlTextContent, sanitizeIdmlStoryXml } from './storyParse';

/** Plain text for DOM `<Content>` (serializer escapes XML; line breaks use U+2028). */
function plainTextForContentElement(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\u2028');
}
import {
  ensureSwatchRefForHex,
  type IdmlColorMap,
} from './swatches';

function getDOMParser(): DOMParser {
  const g = globalThis as unknown as { DOMParser?: typeof DOMParser };
  if (typeof g.DOMParser !== 'undefined') return new g.DOMParser();
  throw new Error('No DOMParser available');
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serializeElement(el: Element): string {
  const attrs: string[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]!;
    attrs.push(`${a.name}="${escapeXmlText(a.value)}"`);
  }
  const open = attrs.length ? `<${el.nodeName} ${attrs.join(' ')}>` : `<${el.nodeName}>`;
  let inner = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]!;
    if (node.nodeType === 3) {
      inner += escapeXmlText(node.textContent ?? '');
    } else if (node.nodeType === 1) {
      inner += serializeElement(node as Element);
    }
  }
  return `${open}${inner}</${el.nodeName}>`;
}

function serializeStoryDocument(doc: Document, originalXml: string): string {
  const g = globalThis as unknown as { XMLSerializer?: typeof XMLSerializer };
  if (typeof g.XMLSerializer !== 'undefined') {
    return new g.XMLSerializer().serializeToString(doc);
  }
  const prefixMatch = originalXml.match(/^<\?xml[^?]*\?\>\s*/);
  const prefix = prefixMatch?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return prefix + serializeElement(doc.documentElement);
}

function localName(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || '';
}

function storyContentElement(root: Element): Element {
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (localName(el).toLowerCase() === 'story') return el;
  }
  return root;
}

function collectContentElements(storyEl: Element): Element[] {
  const out: Element[] = [];
  const all = storyEl.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (localName(el).toLowerCase() === 'content') out.push(el);
  }
  return out;
}

function collectCharacterStyleRanges(storyEl: Element): Element[] {
  const out: Element[] = [];
  const all = storyEl.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (localName(el).toLowerCase() === 'characterstylerange') out.push(el);
  }
  return out;
}

function collectParagraphStyleRanges(storyEl: Element): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < storyEl.childNodes.length; i++) {
    const node = storyEl.childNodes[i];
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (localName(el).toLowerCase() === 'paragraphstylerange') out.push(el);
  }
  return out;
}

/** Redistribute plain text across `<Content>` nodes using prior chunk lengths (last chunk absorbs remainder). */
export function patchStoryTextPreservingContentNodes(storyEl: Element, newText: string): void {
  const contents = collectContentElements(storyEl);
  if (contents.length === 0) return;

  const oldParts = contents.map((el) => decodeIdmlTextContent(el.textContent ?? ''));
  const oldFull = oldParts.join('');
  if (oldFull === newText) return;

  let pos = 0;
  for (let i = 0; i < contents.length; i++) {
    const isLast = i === contents.length - 1;
    const oldLen = oldParts[i]!.length;
    let take: number;
    if (isLast) {
      take = Math.max(0, newText.length - pos);
    } else if (pos >= newText.length) {
      take = 0;
    } else {
      take = Math.min(oldLen, newText.length - pos);
    }
    const chunk = newText.slice(pos, pos + take);
    pos += take;
    contents[i]!.textContent = plainTextForContentElement(chunk);
  }
}

function findOrCreateProperties(charRange: Element): Element {
  for (let i = 0; i < charRange.childNodes.length; i++) {
    const node = charRange.childNodes[i];
    if (node.nodeType === 1 && localName(node as Element).toLowerCase() === 'properties') {
      return node as Element;
    }
  }
  const doc = charRange.ownerDocument!;
  const props = doc.createElement('Properties');
  charRange.insertBefore(props, charRange.firstChild);
  return props;
}

function setAppliedFont(charRange: Element, fontFamily: string): void {
  const props = findOrCreateProperties(charRange);
  let applied: Element | null = null;
  for (let i = 0; i < props.childNodes.length; i++) {
    const node = props.childNodes[i];
    if (node.nodeType === 1 && localName(node as Element).toLowerCase() === 'appliedfont') {
      applied = node as Element;
      break;
    }
  }
  if (!applied) {
    applied = props.ownerDocument!.createElement('AppliedFont');
    applied.setAttribute('type', 'string');
    props.appendChild(applied);
  }
  applied.textContent = fontFamily;
}

function fontStyleFromFlags(bold: boolean, italic: boolean): string {
  if (bold && italic) return 'Bold Italic';
  if (bold) return 'Bold';
  if (italic) return 'Italic';
  return 'Regular';
}

function applyCharacterStyleFromCanvas(
  charRange: Element,
  style: {
    fontSize?: number;
    font?: { name?: string };
    fillColor?: { r?: number; g?: number; b?: number };
    fauxBold?: boolean;
    fauxItalic?: boolean;
  },
  fillSwatchRef: string | undefined,
): void {
  if (style.fontSize && style.fontSize > 0) {
    charRange.setAttribute('PointSize', String(Math.round(style.fontSize)));
  }
  if (fillSwatchRef) {
    charRange.setAttribute('FillColor', fillSwatchRef);
  }
  const fontName = style.font?.name?.trim();
  if (fontName) setAppliedFont(charRange, fontName);
  const bold = Boolean(style.fauxBold);
  const italic = Boolean(style.fauxItalic);
  charRange.setAttribute('FontStyle', fontStyleFromFlags(bold, italic));
}

export function canvasAlignmentToIdmlJustification(alignment: 'left' | 'center' | 'right'): string {
  if (alignment === 'center') return 'CenterAlign';
  if (alignment === 'right') return 'RightAlign';
  return 'LeftAlign';
}

export function idmlJustificationToCanvasAlignment(just?: string): 'left' | 'center' | 'right' {
  const j = (just ?? 'LeftAlign').toLowerCase();
  if (j.includes('center') || j.includes('centre')) return 'center';
  if (j.includes('right')) return 'right';
  return 'left';
}

export interface StoryPatchResult {
  storyXml: string;
  graphicXml: string;
  colors: IdmlColorMap;
  graphicChanged: boolean;
}

export function patchStoryXmlForNode(
  storyXml: string,
  node: Node,
  colors: IdmlColorMap,
  graphicXml: string,
): StoryPatchResult {
  if (!node.src?.text) {
    return { storyXml, graphicXml, colors, graphicChanged: false };
  }

  let nextGraphic = graphicXml;
  let nextColors = colors;
  let graphicChanged = false;

  const doc = getDOMParser().parseFromString(sanitizeIdmlStoryXml(storyXml), 'application/xml');
  const storyEl = storyContentElement(doc.documentElement);

  patchStoryTextPreservingContentNodes(storyEl, node.src.text.text);

  const style = node.src.text.style ?? {};
  const snap = node.idml?.importTextSnapshot;
  const fill = style.fillColor as { r?: number; g?: number; b?: number } | undefined;
  const colorHex = fill
    ? rgbToHex({ r: fill.r ?? 0, g: fill.g ?? 0, b: fill.b ?? 0 }).toLowerCase()
    : '';
  const styleDirty =
    !snap ||
    snap.fontSize !== (style.fontSize ?? snap.fontSize) ||
    snap.fontFamily !== (style.font?.name ?? snap.fontFamily) ||
    snap.colorHex.toLowerCase() !== colorHex ||
    snap.bold !== Boolean(style.fauxBold) ||
    snap.italic !== Boolean(style.fauxItalic) ||
    (node.idml?.storyJustification ?? snap.justification) !== snap.justification;

  if (styleDirty) {
    let fillSwatchRef: string | undefined;
    if (fill) {
      const ensured = ensureSwatchRefForHex(colorHex, nextGraphic, nextColors);
      nextGraphic = ensured.graphicXml;
      nextColors = ensured.colors;
      if (ensured.added) graphicChanged = true;
      fillSwatchRef = ensured.ref;
    }

    const stylePatch = style as {
      fontSize?: number;
      font?: { name?: string };
      fillColor?: { r?: number; g?: number; b?: number };
      fauxBold?: boolean;
      fauxItalic?: boolean;
    };
    for (const charRange of collectCharacterStyleRanges(storyEl)) {
      applyCharacterStyleFromCanvas(charRange, stylePatch, fillSwatchRef);
    }

    const just = node.idml?.storyJustification;
    if (just) {
      for (const para of collectParagraphStyleRanges(storyEl)) {
        para.setAttribute('Justification', just);
      }
    }
  }

  const storyXmlOut = serializeStoryDocument(doc, storyXml);

  return {
    storyXml: storyXmlOut,
    graphicXml: nextGraphic,
    colors: nextColors,
    graphicChanged,
  };
}

/** Escape attribute values when building regex patches (legacy helpers). */
export function escapeIdmlXmlAttribute(value: string): string {
  return escapeIdmlXmlText(value);
}

/** Targeted IDML XML patches for Canvas → IDML export (preserve unrelated package content). */

import type { Doc, Node } from '../core/model';
import { leaves } from '../core/model';
import {
  invert6,
  multiply6,
  parseMatrix6,
  matrix6ToString,
  type Matrix2D,
} from './matrix';
import type { IdmlCanvasCtx } from './types';

function canvasToSpreadFromCtx(dx: number, dy: number, c: IdmlCanvasCtx): [number, number] {
  return [dx + c.originX, dy + c.originY - (c.offsetY ?? 0)];
}
import { ensureSwatchRefForHex, type IdmlColorMap } from './swatches';
import {
  commitPlacedImageTransformBaselines,
  exportImageItemTransformForPlacedFrame,
  placedImageTransformDirty,
} from './placedImage';

export function escapeIdmlXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** InDesign line breaks in `<Content>` often use U+2028. */
export function encodeIdmlStoryContent(text: string): string {
  return escapeIdmlXmlText(text.replace(/\r\n/g, '\n').replace(/\n/g, '\u2028'));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function patchPageItemAttribute(
  spreadXml: string,
  self: string,
  attr: string,
  value: string,
): string {
  const tags = 'TextFrame|Rectangle|Oval|Polygon|Group';
  const esc = escapeRegExp(self);
  const forward = new RegExp(
    `(<(?:${tags})\\b[^>]*\\bSelf="${esc}"[^>]*\\b${attr}=")([^"]*)(")`,
    'i',
  );
  if (forward.test(spreadXml)) return spreadXml.replace(forward, `$1${value}$3`);
  const backward = new RegExp(
    `(<(?:${tags})\\b[^>]*\\b${attr}=")([^"]*)("[^>]*\\bSelf="${esc}")`,
    'i',
  );
  return spreadXml.replace(backward, `$1${value}$3`);
}

export function patchNestedImageAttribute(
  spreadXml: string,
  imageSelf: string,
  attr: string,
  value: string,
): string {
  const esc = escapeRegExp(imageSelf);
  const forward = new RegExp(`(<Image\\b[^>]*\\bSelf="${esc}"[^>]*\\b${attr}=")([^"]*)(")`, 'i');
  if (forward.test(spreadXml)) return spreadXml.replace(forward, `$1${value}$3`);
  const backward = new RegExp(`(<Image\\b[^>]*\\b${attr}=")([^"]*)("[^>]*\\bSelf="${esc}")`, 'i');
  if (backward.test(spreadXml)) return spreadXml.replace(backward, `$1${value}$3`);
  return spreadXml;
}

export function readNestedImageAttribute(spreadXml: string, imageSelf: string, attr: string): string | null {
  const esc = escapeRegExp(imageSelf);
  const forward = new RegExp(`<Image\\b[^>]*\\bSelf="${esc}"[^>]*\\b${attr}="([^"]*)"`, 'i');
  const m = forward.exec(spreadXml);
  if (m) return m[1];
  const backward = new RegExp(`<Image\\b[^>]*\\b${attr}="([^"]*)"[^>]*\\bSelf="${esc}"`, 'i');
  return backward.exec(spreadXml)?.[1] ?? null;
}

export function patchImageLinkResourceUri(spreadXml: string, imageSelf: string, uri: string): string {
  const esc = escapeRegExp(imageSelf);
  const blockRe = new RegExp(
    `(<Image\\b[^>]*\\bSelf="${esc}"[\\s\\S]*?<Link\\b[^>]*\\bLinkResourceURI=")([^"]*)(")`,
    'i',
  );
  if (blockRe.test(spreadXml)) return spreadXml.replace(blockRe, `$1${uri}$3`);
  return spreadXml;
}

export function readPageItemAttribute(spreadXml: string, self: string, attr: string): string | null {
  const tags = 'TextFrame|Rectangle|Oval|Polygon|Group';
  const esc = escapeRegExp(self);
  const forward = new RegExp(
    `<(?:${tags})\\b[^>]*\\bSelf="${esc}"[^>]*\\b${attr}="([^"]*)"`,
    'i',
  );
  const m = forward.exec(spreadXml);
  if (m) return m[1];
  const backward = new RegExp(
    `<(?:${tags})\\b[^>]*\\b${attr}="([^"]*)"[^>]*\\bSelf="${esc}"`,
    'i',
  );
  return backward.exec(spreadXml)?.[1] ?? null;
}

export function spreadMatrixFromXml(spreadXml: string): Matrix2D {
  const m = spreadXml.match(/<Spread\b[^>]*\bItemTransform="([^"]+)"/i);
  return parseMatrix6(m?.[1]);
}

/** Map doc-space move (same page stack) to spread translation delta. */
export function docPositionDelta(node: Node): { dx: number; dy: number } {
  return { dx: node.x - node.ox, dy: node.y - node.oy };
}

export function exportItemTransformForMove(
  itemTransform: Matrix2D,
  spreadM: Matrix2D,
  dx: number,
  dy: number,
): Matrix2D {
  const worldM = multiply6(spreadM, itemTransform);
  const movedWorld: Matrix2D = [worldM[0], worldM[1], worldM[2], worldM[3], worldM[4] + dx, worldM[5] + dy];
  return multiply6(invert6(spreadM), movedWorld);
}

function defaultLocalBounds(node: Node): { minX: number; minY: number; maxX: number; maxY: number } {
  const lb = node.idml?.localBounds;
  if (lb) return lb;
  return { minX: 0, minY: 0, maxX: Math.max(1, node.ow), maxY: Math.max(1, node.oh) };
}

/** Spread-space matrix mapping item path coordinates to pasteboard (parent chain × item). */
export function worldMatrixFromDocBox(
  node: Node,
  local: { minX: number; minY: number; maxX: number; maxY: number },
  canvasCtx: IdmlCanvasCtx,
): Matrix2D {
  const localW = Math.max(1e-6, local.maxX - local.minX);
  const localH = Math.max(1e-6, local.maxY - local.minY);
  const lcX = (local.minX + local.maxX) / 2;
  const lcY = (local.minY + local.maxY) / 2;

  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const [spreadCx, spreadCy] = canvasToSpreadFromCtx(cx, cy, canvasCtx);

  const sx = node.w / localW;
  const sy = node.h / localH;
  const rad = (node.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const a = sx * cos;
  const b = sx * sin;
  const c = -sy * sin;
  const d = sy * cos;
  const tx = spreadCx - (a * lcX + c * lcY);
  const ty = spreadCy - (b * lcX + d * lcY);
  return [a, b, c, d, tx, ty];
}

export function exportItemTransformFromDocState(
  node: Node,
  spreadM: Matrix2D,
): Matrix2D | null {
  if (!node.idml?.itemTransform) return null;
  const parentM = parseMatrix6(node.idml.parentTransform?.join(' ') ?? matrix6ToString(spreadM));
  const canvasCtx = node.idml.canvasCtx;
  if (!canvasCtx) return null;
  const worldTarget = worldMatrixFromDocBox(node, defaultLocalBounds(node), canvasCtx);
  return multiply6(invert6(parentM), worldTarget);
}

export function idmlGeometryExportDirty(node: Node): boolean {
  if (!node.idml?.itemTransform) return false;
  const { dx, dy } = docPositionDelta(node);
  const moved = Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3;
  const resized = Math.abs(node.w - node.ow) > 1e-3 || Math.abs(node.h - node.oh) > 1e-3;
  const baseRot = node.idml.exportRotation ?? node.idml.importRotation ?? 0;
  const rotated = Math.abs(node.rotation - baseRot) > 1e-2;
  return moved || resized || rotated;
}

export function commitIdmlGeometryExportBaselines(node: Node): void {
  node.ox = node.x;
  node.oy = node.y;
  node.ow = node.w;
  node.oh = node.h;
  if (node.idml) node.idml.exportRotation = node.rotation;
}

export function patchStoryContent(storyXml: string, newText: string): string {
  const encoded = encodeIdmlStoryContent(newText);
  const re = /(<Content>)[\s\S]*?(<\/Content>)/;
  if (!re.test(storyXml)) return storyXml;
  return storyXml.replace(re, `$1${encoded}$2`);
}

export function patchFirstCharacterStyleRangeAttribute(
  storyXml: string,
  attr: string,
  value: string,
): string {
  const re = new RegExp(
    `(<CharacterStyleRange\\b[^>]*\\b${attr}=")([^"]*)(")`,
    'i',
  );
  if (re.test(storyXml)) return storyXml.replace(re, `$1${value}$3`);
  return storyXml.replace(
    /(<CharacterStyleRange\b)([^>]*>)/i,
    `$1 ${attr}="${value}"$2`,
  );
}

export function setPageItemAttribute(
  spreadXml: string,
  self: string,
  attr: string,
  value: string,
): string {
  if (readPageItemAttribute(spreadXml, self, attr) !== null) {
    return patchPageItemAttribute(spreadXml, self, attr, value);
  }
  const tags = 'TextFrame|Rectangle|Oval|Polygon|Group';
  const esc = escapeRegExp(self);
  const tagRe = new RegExp(`(<(?:${tags})\\b[^>]*\\bSelf="${esc}"[^>]*)(>)`, 'i');
  return spreadXml.replace(tagRe, `$1 ${attr}="${value}"$2`);
}

export function prepareShapeFillSwatchesForExport(
  spreadNodes: Map<string, Node[]>,
  graphicXml: string,
  colors: IdmlColorMap,
): { graphicXml: string; colors: IdmlColorMap; graphicChanged: boolean } {
  let xml = graphicXml;
  let map = colors;
  let graphicChanged = false;
  for (const nodes of spreadNodes.values()) {
    for (const node of nodes) {
      if (node.kind !== 'shape' || !node.idml?.exportFillDirty || !node.idml.fillColor) continue;
      const ensured = ensureSwatchRefForHex(node.idml.fillColor, xml, map);
      xml = ensured.graphicXml;
      map = ensured.colors;
      if (ensured.added) graphicChanged = true;
      node.idml.fillSwatchRef = ensured.ref;
    }
  }
  return { graphicXml: xml, colors: map, graphicChanged };
}

export function prepareShapeStrokeSwatchesForExport(
  spreadNodes: Map<string, Node[]>,
  graphicXml: string,
  colors: IdmlColorMap,
): { graphicXml: string; colors: IdmlColorMap; graphicChanged: boolean } {
  let xml = graphicXml;
  let map = colors;
  let graphicChanged = false;
  for (const nodes of spreadNodes.values()) {
    for (const node of nodes) {
      if (node.kind !== 'shape' || !node.idml?.exportStrokeDirty || !node.idml.strokeEnabled) continue;
      if (!node.idml.strokeColor) continue;
      const ensured = ensureSwatchRefForHex(node.idml.strokeColor, xml, map);
      xml = ensured.graphicXml;
      map = ensured.colors;
      if (ensured.added) graphicChanged = true;
      node.idml.strokeSwatchRef = ensured.ref;
    }
  }
  return { graphicXml: xml, colors: map, graphicChanged };
}

export interface ExportIdmlPatchResult {
  spreadPathsTouched: string[];
  storiesTouched: string[];
}

export function collectIdmlExportPatches(doc: Doc): {
  spreadNodes: Map<string, Node[]>;
  storyNodes: Map<string, Node[]>;
} {
  const spreadNodes = new Map<string, Node[]>();
  const storyNodes = new Map<string, Node[]>();
  for (const node of leaves(doc)) {
    if (!node.idml?.spreadPath) continue;
    const fillDirty = node.kind === 'shape' && node.idml.exportFillDirty && Boolean(node.idml.fillColor);
    const strokeDirty =
      node.kind === 'shape' &&
      (node.idml.exportStrokeDirty || node.idml.exportStrokeSettingsDirty);
    const linkDirty = Boolean(node.idml.placedImage?.exportLinkDirty);
    const linkUriDirty = Boolean(node.idml.placedImage?.exportLinkUriDirty);
    const placedImageTfDirty = placedImageTransformDirty(node);
    const geomDirty = idmlGeometryExportDirty(node);
    if (geomDirty || fillDirty || strokeDirty || linkDirty || linkUriDirty || placedImageTfDirty) {
      const list = spreadNodes.get(node.idml.spreadPath) ?? [];
      list.push(node);
      spreadNodes.set(node.idml.spreadPath, list);
    }
    if (node.idml.storyId && node.textEdited && node.src?.text) {
      const sl = storyNodes.get(node.idml.storyId) ?? [];
      sl.push(node);
      storyNodes.set(node.idml.storyId, sl);
    }
  }
  return { spreadNodes, storyNodes };
}

export function patchSpreadXmlForNodes(spreadXml: string, nodes: Node[]): string {
  const spreadM = spreadMatrixFromXml(spreadXml);
  let xml = spreadXml;
  for (const node of nodes) {
    if (!node.idml?.self) continue;
    const pi = node.idml.placedImage;
    const syncPlacedImageTransform = Boolean(pi && placedImageTransformDirty(node));
    if (idmlGeometryExportDirty(node)) {
      const { dx, dy } = docPositionDelta(node);
      const moved = Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3;
      const resized = Math.abs(node.w - node.ow) > 1e-3 || Math.abs(node.h - node.oh) > 1e-3;
      const baseRot = node.idml.exportRotation ?? node.idml.importRotation ?? 0;
      const rotated = Math.abs(node.rotation - baseRot) > 1e-2;
      let newM: Matrix2D | null = null;
      if ((resized || rotated) && node.idml.canvasCtx) {
        newM = exportItemTransformFromDocState(node, spreadM);
      } else if (moved && node.idml.itemTransform) {
        const oldM = parseMatrix6(node.idml.itemTransform.join(' '));
        newM = exportItemTransformForMove(oldM, spreadM, dx, dy);
      }
      if (newM) {
        xml = patchPageItemAttribute(xml, node.idml.self, 'ItemTransform', matrix6ToString(newM));
        node.idml.itemTransform = [...newM];
        commitIdmlGeometryExportBaselines(node);
      }
    }

    if (syncPlacedImageTransform && pi) {
      const imgM = exportImageItemTransformForPlacedFrame(node);
      if (imgM) {
        xml = patchNestedImageAttribute(xml, pi.imageSelf, 'ItemTransform', matrix6ToString(imgM));
        pi.imageItemTransform = [...imgM];
        commitPlacedImageTransformBaselines(node);
      }
    }
    if (pi?.exportLinkUriDirty && pi.pendingLinkResourceUri) {
      xml = patchImageLinkResourceUri(xml, pi.imageSelf, pi.pendingLinkResourceUri);
    }

    const fillRef = node.idml.fillSwatchRef;
    if (node.idml.exportFillDirty && fillRef && node.kind === 'shape' && node.idml.fillColor) {
      xml = setPageItemAttribute(xml, node.idml.self, 'FillColor', fillRef);
      node.idml.exportFillDirty = false;
    }

    if (node.idml.exportStrokeSettingsDirty && node.kind === 'shape') {
      if (!node.idml.strokeEnabled) {
        xml = setPageItemAttribute(xml, node.idml.self, 'StrokeColor', 'n');
      } else if (node.idml.strokeSwatchRef) {
        xml = setPageItemAttribute(xml, node.idml.self, 'StrokeColor', node.idml.strokeSwatchRef);
      }
      if (node.idml.strokeEnabled && node.idml.strokeWeight !== undefined) {
        xml = setPageItemAttribute(xml, node.idml.self, 'StrokeWeight', String(node.idml.strokeWeight));
      }
      node.idml.exportStrokeSettingsDirty = false;
    }

    if (node.idml.exportStrokeDirty && node.kind === 'shape') {
      if (!node.idml.strokeEnabled) {
        xml = setPageItemAttribute(xml, node.idml.self, 'StrokeColor', 'n');
      } else if (node.idml.strokeSwatchRef) {
        xml = setPageItemAttribute(xml, node.idml.self, 'StrokeColor', node.idml.strokeSwatchRef);
      }
      node.idml.exportStrokeDirty = false;
    }
  }
  return xml;
}

export { patchStoryXmlForNode, type StoryPatchResult } from './storyExport';

const SPREAD_PAGE_ITEM_LEAF = /^(TextFrame|Rectangle|Oval|Polygon)$/i;

function serializeElementForExport(el: Element): string {
  const attrs: string[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]!;
    attrs.push(`${a.name}="${escapeIdmlXmlText(a.value)}"`);
  }
  const open = attrs.length ? `<${el.nodeName} ${attrs.join(' ')}>` : `<${el.nodeName}>`;
  let inner = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]!;
    if (node.nodeType === 3) {
      inner += escapeIdmlXmlText(node.textContent ?? '');
    } else if (node.nodeType === 1) {
      inner += serializeElementForExport(node as Element);
    }
  }
  return `${open}${inner}</${el.nodeName}>`;
}

function serializeSpreadDocument(doc: Document, originalXml: string): string {
  const g = globalThis as { XMLSerializer?: typeof XMLSerializer };
  if (typeof g.XMLSerializer !== 'undefined') {
    return new g.XMLSerializer().serializeToString(doc);
  }
  const prefixMatch = originalXml.match(/^<\?xml[^?]*\?\>\s*/);
  const prefix = prefixMatch?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return prefix + serializeElementForExport(doc.documentElement);
}

function pageItemLocalName(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || el.nodeName;
}

/** Drop spread page items removed from the Canvas model (delete is model-only until export). */
export function pruneSpreadPageItemsNotInModel(
  spreadXml: string,
  liveSelves: ReadonlySet<string>,
  importedSelves?: ReadonlySet<string>,
): string {
  const parsed = new DOMParser().parseFromString(spreadXml, 'text/xml');
  const all = parsed.getElementsByTagName('*');
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i] as Element;
    const tag = pageItemLocalName(el);
    if (!SPREAD_PAGE_ITEM_LEAF.test(tag)) continue;
    const self = el.getAttribute('Self') ?? '';
    if (!self) continue;
    const shouldPrune = importedSelves
      ? importedSelves.has(self) && !liveSelves.has(self)
      : !liveSelves.has(self);
    if (shouldPrune) el.parentNode?.removeChild(el);
  }
  return serializeSpreadDocument(parsed, spreadXml);
}

export function liveIdmlSelvesOnSpread(doc: Doc, spreadPath: string): Set<string> {
  const out = new Set<string>();
  for (const n of leaves(doc)) {
    if (n.idml?.spreadPath === spreadPath && n.idml.self) out.add(n.idml.self);
  }
  return out;
}

export function validateIdmlPackageStructure(
  fileNames: string[],
  designmapXml: string | undefined,
): { pageCount: number; spreadCount: number; storyCount: number } {
  const spreadCount = fileNames.filter((f) => f.startsWith('Spreads/Spread_') && f.endsWith('.xml')).length;
  const storyCount = fileNames.filter((f) => f.startsWith('Stories/Story_') && f.endsWith('.xml')).length;
  let pageCount = 0;
  if (designmapXml) {
    const lengthMatch = designmapXml.match(/Length="(\d+)"/);
    if (lengthMatch) pageCount = Number(lengthMatch[1]);
  }
  return { pageCount, spreadCount, storyCount };
}

export function backingDesignmap(doc: Doc): string | undefined {
  return doc.idml?.designmapXml;
}

import type { Doc, Node } from './model';
import type { IdmlDocBacking, IdmlNodeMeta, IdmlSpreadLayout } from './idml/types';
import {
  apply6,
  identity6,
  multiply6,
  parseMatrix6,
  rotationDegreesFromMatrix6,
  uniformScaleFromMatrix6,
  type Matrix2D,
} from './idml/matrix';
import { readIdmlPackage, writeIdmlPackage } from './idml/zip';
import { parseStoryFromXml } from './idml/storyParse';
import { parseGraphicXmlColors, resolveSwatchRef, type IdmlColorMap } from './idml/swatches';
import {
  parseStylesXmlObjectFills,
  resolveItemFillHex,
  resolveItemStrokeFromSpread,
  type IdmlObjectStyleFillMap,
} from './idml/objectStyles';
import { parseStylesXmlTextStyles, type IdmlTextStyleResources } from './idml/textStyles';
import { rasterizeIdmlTextNode } from './idml/rasterText';
import { parseTextFrameLayout } from './idml/textFrameParse';
import {
  collectIdmlExportPatches,
  liveIdmlSelvesOnSpread,
  patchSpreadXmlForNodes,
  patchStoryXmlForNode,
  prepareShapeFillSwatchesForExport,
  prepareShapeStrokeSwatchesForExport,
  pruneSpreadPageItemsNotInModel,
} from './idml/exportPatch';
import { hexToRgb } from './edit';
import { drawPlacedImagePlaceholder, parsePlacedImageFromFrame, hydrateIdmlPlacedImagePreviews } from './idml/placedImage';
import { leaves } from './model';

export interface SpreadCanvasCtx {
  originX: number;
  originY: number;
  offsetY: number;
}

function getDOMParser(): any {
  if (typeof DOMParser !== 'undefined') return new DOMParser();
  if (typeof (globalThis as any).DOMParser !== 'undefined') return new (globalThis as any).DOMParser();
  if (typeof (globalThis as any).window !== 'undefined' && (globalThis as any).window.DOMParser) {
    return new (globalThis as any).window.DOMParser();
  }
  throw new Error('No DOMParser available in this environment');
}



function parseXml(xmlStr: string): Document {
  const parser = getDOMParser();
  return parser.parseFromString(xmlStr, 'application/xml');
}

export function childByLocal(el: Element, localName: string): Element | null {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.localName === localName || c.nodeName.endsWith(`:${localName}`)) {
      return c;
    }
  }
  return null;
}

export function elementsLocalCI(root: Element, localName: string): Element[] {
  const out: Element[] = [];
  const target = localName.toLowerCase();
  function walk(el: Element) {
    if (el.localName?.toLowerCase() === target || el.nodeName?.toLowerCase().endsWith(`:${target}`)) {
      out.push(el);
    }
    for (let i = 0; i < el.children.length; i++) {
      walk(el.children[i]);
    }
  }
  walk(root);
  return out;
}

// ADD — do not use spreadDoc.querySelector('Spread') on package root
export function unpackIdPkgContent(doc: Document, contentLocalName: string): Element | null {
  const root = doc.documentElement;
  if (root.nodeName === `idPkg:${contentLocalName}`) {
    return childByLocal(root, contentLocalName);
  }
  if (root.localName === contentLocalName && !root.prefix) return root;
  return elementsLocalCI(root, contentLocalName)[0] ?? null;
}

export function spreadContainerElement(doc: Document): Element | null {
  return unpackIdPkgContent(doc, 'Spread');
}

/** Content spreads listed in designmap (excludes master spreads). */
export function contentSpreadPathsFromDesignmap(designmapXml: string): string[] {
  const paths: string[] = [];
  const re = /idPkg:Spread\s+src="(Spreads\/Spread_[^"]+\.xml)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(designmapXml)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

export function spreadToCanvas(sx: number, sy: number, c: SpreadCanvasCtx): [number, number] {
  return [sx - c.originX, sy - c.originY + c.offsetY];
}

export function canvasToSpread(dx: number, dy: number, c: SpreadCanvasCtx): [number, number] {
  return [dx + c.originX, dy + c.originY - (c.offsetY ?? 0)];
}

/** Page rectangle in spread (pasteboard) coordinates. */
export function pageRectInSpread(
  pageEl: Element,
  spreadM: Matrix2D = identity6(),
): { minX: number; minY: number; maxX: number; maxY: number } {
  const geoBounds = pageEl.getAttribute('GeometricBounds');
  let y1 = 0;
  let x1 = 0;
  let y2 = 792;
  let x2 = 612;
  if (geoBounds) {
    const parts = geoBounds.trim().split(/\s+/).map(Number);
    if (parts.length >= 4 && parts.every((n) => Number.isFinite(n))) {
      [y1, x1, y2, x2] = parts;
    }
  }
  const pageM = parseMatrix6(pageEl.getAttribute('ItemTransform'));
  const worldM = multiply6(spreadM, pageM);
  const corners: [number, number][] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of corners) {
    const [sx, sy] = apply6(worldM, px, py);
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }
  return { minX, minY, maxX, maxY };
}

export interface IdmlPageImportSlot {
  pageSelf: string;
  pageIndex: number;
  spreadPath: string;
  canvasCtx: SpreadCanvasCtx;
  spreadBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function pickPageSlotForSpreadPoint(
  slots: IdmlPageImportSlot[],
  sx: number,
  sy: number,
): IdmlPageImportSlot {
  for (const s of slots) {
    const b = s.spreadBounds;
    if (sx >= b.minX - 1 && sx <= b.maxX + 1 && sy >= b.minY - 1 && sy <= b.maxY + 1) return s;
  }
  let best = slots[0];
  let bestD = Infinity;
  for (const s of slots) {
    const cx = (s.spreadBounds.minX + s.spreadBounds.maxX) / 2;
    const cy = (s.spreadBounds.minY + s.spreadBounds.maxY) / 2;
    const d = (sx - cx) ** 2 + (sy - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

function spreadRectOverlapArea(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return 0;
  return (maxX - minX) * (maxY - minY);
}

/** Assign page by maximum overlap of item spread AABB with page bounds (not center-only). */
export function pickPageSlotForSpreadBounds(
  slots: IdmlPageImportSlot[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): IdmlPageImportSlot {
  let best = slots[0];
  let bestArea = -1;
  for (const s of slots) {
    const area = spreadRectOverlapArea(bounds, s.spreadBounds);
    if (area > bestArea) {
      bestArea = area;
      best = s;
    }
  }
  if (bestArea > 0) return best;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return pickPageSlotForSpreadPoint(slots, cx, cy);
}

export function pageItemSpreadBounds(
  parentM: Matrix2D,
  itemM: Matrix2D,
  points: PathPoint[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  const worldM = multiply6(parentM, itemM);
  const local = localPathBounds(points);
  const corners: [number, number][] =
    points.length > 0
      ? [
          [local.minX, local.minY],
          [local.maxX, local.minY],
          [local.maxX, local.maxY],
          [local.minX, local.maxY],
        ]
      : [
          [0, 0],
          [1, 1],
        ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of corners) {
    const [sx, sy] = apply6(worldM, px, py);
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }
  return { minX, minY, maxX, maxY };
}

function canvasCtxForPageItem(
  pageSlots: IdmlPageImportSlot[],
  parentM: Matrix2D,
  itemM: Matrix2D,
  points: PathPoint[],
): { ctx: SpreadCanvasCtx; pageSelf: string; pageIndex: number } {
  const spreadBounds = pageItemSpreadBounds(parentM, itemM, points);
  const slot = pickPageSlotForSpreadBounds(pageSlots, spreadBounds);
  return { ctx: slot.canvasCtx, pageSelf: slot.pageSelf, pageIndex: slot.pageIndex };
}

/**
 * Page `GeometricBounds` are in page space; `ItemTransform` maps the page onto spread (pasteboard) space.
 * Document (0,0) is the page top-left in spread coordinates — not raw bounds mins without the page matrix.
 */
export function layoutFromPageElement(pageEl: Element, spreadM: Matrix2D = identity6()): IdmlSpreadLayout {
  const geoBounds = pageEl.getAttribute('GeometricBounds');
  const pageM = parseMatrix6(pageEl.getAttribute('ItemTransform'));
  const worldPageM = multiply6(spreadM, pageM);
  let y1 = 0;
  let x1 = 0;
  let y2 = 792;
  let x2 = 612;
  if (geoBounds) {
    const parts = geoBounds.trim().split(/\s+/).map(Number);
    if (parts.length >= 4 && parts.every((n) => Number.isFinite(n))) {
      [y1, x1, y2, x2] = parts;
    }
  }
  const [originX, originY] = apply6(worldPageM, x1, y1);
  return {
    originX,
    originY,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
    offsetY: 0,
  };
}

export interface PathPoint {
  anchor: [number, number];
  leftDirection?: [number, number];
  rightDirection?: [number, number];
}

/** Draw item path in layer canvas space (unrotated); mesh applies doc rotation/scale. */
export function plotPathInItemLocalCanvas(
  g: CanvasRenderingContext2D,
  points: PathPoint[],
  open: boolean,
  local: { minX: number; minY: number; maxX: number; maxY: number },
  canvasW: number,
  canvasH: number,
) {
  if (points.length === 0) return;
  const localW = Math.max(1e-6, local.maxX - local.minX);
  const localH = Math.max(1e-6, local.maxY - local.minY);
  const mapPt = (ax: number, ay: number): [number, number] => [
    ((ax - local.minX) / localW) * canvasW,
    ((ay - local.minY) / localH) * canvasH,
  ];

  g.beginPath();
  const [startX, startY] = mapPt(points[0].anchor[0], points[0].anchor[1]);
  g.moveTo(startX, startY);

  for (let i = 1; i < points.length; i++) {
    const pt = points[i];
    const prev = points[i - 1];
    const [ax, ay] = mapPt(pt.anchor[0], pt.anchor[1]);

    if (prev.rightDirection && pt.leftDirection) {
      const [cp1x, cp1y] = mapPt(prev.rightDirection[0], prev.rightDirection[1]);
      const [cp2x, cp2y] = mapPt(pt.leftDirection[0], pt.leftDirection[1]);
      g.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ax, ay);
    } else {
      g.lineTo(ax, ay);
    }
  }

  if (!open) {
    if (points.length > 2 && points[points.length - 1].rightDirection && points[0].leftDirection) {
      const last = points[points.length - 1];
      const first = points[0];
      const [cp1x, cp1y] = mapPt(last.rightDirection![0], last.rightDirection![1]);
      const [cp2x, cp2y] = mapPt(first.leftDirection![0], first.leftDirection![1]);
      g.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, startX, startY);
    }
    g.closePath();
  }
}

export function plotPathOnCanvas(
  g: CanvasRenderingContext2D,
  points: PathPoint[],
  open: boolean,
  worldM: Matrix2D,
  canvasCtx: SpreadCanvasCtx,
  nodeX: number,
  nodeY: number,
) {
  if (points.length === 0) return;

  const toLocal = (lx: number, ly: number): [number, number] => {
    const [sx, sy] = apply6(worldM, lx, ly);
    const [cx, cy] = spreadToCanvas(sx, sy, canvasCtx);
    return [cx - nodeX, cy - nodeY];
  };

  g.beginPath();
  const [startX, startY] = toLocal(points[0].anchor[0], points[0].anchor[1]);
  g.moveTo(startX, startY);

  for (let i = 1; i < points.length; i++) {
    const pt = points[i];
    const prev = points[i - 1];
    const [ax, ay] = toLocal(pt.anchor[0], pt.anchor[1]);

    if (prev.rightDirection && pt.leftDirection) {
      const [cp1x, cp1y] = toLocal(prev.rightDirection[0], prev.rightDirection[1]);
      const [cp2x, cp2y] = toLocal(pt.leftDirection[0], pt.leftDirection[1]);
      g.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ax, ay);
    } else {
      g.lineTo(ax, ay);
    }
  }

  if (!open) {
    if (points.length > 2 && points[points.length - 1].rightDirection && points[0].leftDirection) {
      const last = points[points.length - 1];
      const first = points[0];
      const [cp1x, cp1y] = toLocal(last.rightDirection![0], last.rightDirection![1]);
      const [cp2x, cp2y] = toLocal(first.leftDirection![0], first.leftDirection![1]);
      g.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, startX, startY);
    }
    g.closePath();
  }
}

function parsePathGeometry(el: Element): { points: PathPoint[]; open: boolean } {
  const points: PathPoint[] = [];
  let open = false;

  const geo = elementsLocalCI(el, 'PathGeometry')[0] ?? el;
  const pathPointTypeEls = elementsLocalCI(geo, 'PathPointType');

  for (const ptEl of pathPointTypeEls) {
    const anchorStr = ptEl.getAttribute('Anchor');
    if (!anchorStr) continue;
    const [ax, ay] = anchorStr.trim().split(/\s+/).map(Number);
    const pt: PathPoint = { anchor: [ax, ay] };

    const leftStr = ptEl.getAttribute('LeftDirection');
    if (leftStr) {
      const [lx, ly] = leftStr.trim().split(/\s+/).map(Number);
      pt.leftDirection = [lx, ly];
    }
    const rightStr = ptEl.getAttribute('RightDirection');
    if (rightStr) {
      const [rx, ry] = rightStr.trim().split(/\s+/).map(Number);
      pt.rightDirection = [rx, ry];
    }
    points.push(pt);
  }

  const pathOpenAttr = geo.getAttribute('PathOpen');
  if (pathOpenAttr === 'true') open = true;

  return { points, open };
}

function createCanvasElement(w: number, h: number): HTMLCanvasElement {
  const doc = typeof document !== 'undefined' ? document : (globalThis as any).document;
  if (doc && typeof doc.createElement === 'function') {
    const c = doc.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  return { width: w, height: h, getContext: () => null } as unknown as HTMLCanvasElement;
}


function localPathBounds(points: PathPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    minX = Math.min(minX, pt.anchor[0]);
    minY = Math.min(minY, pt.anchor[1]);
    maxX = Math.max(maxX, pt.anchor[0]);
    maxY = Math.max(maxY, pt.anchor[1]);
  }
  return { minX, minY, maxX, maxY };
}

/** Axis-aligned doc bounds after applying `worldM` and page origin (for tests / diagnostics). */
export function docAabbFromLocalBounds(
  local: { minX: number; minY: number; maxX: number; maxY: number },
  worldM: Matrix2D,
  canvasCtx: SpreadCanvasCtx,
): { x: number; y: number; w: number; h: number } {
  const corners: [number, number][] = [
    [local.minX, local.minY],
    [local.maxX, local.minY],
    [local.maxX, local.maxY],
    [local.minX, local.maxY],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of corners) {
    const [sx, sy] = apply6(worldM, lx, ly);
    const [dx, dy] = spreadToCanvas(sx, sy, canvasCtx);
    minX = Math.min(minX, dx);
    minY = Math.min(minY, dy);
    maxX = Math.max(maxX, dx);
    maxY = Math.max(maxY, dy);
  }
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

/**
 * Map IDML path + transforms to doc-space layer box (page-relative).
 * Position uses the transformed local center so viewport rotation pivots match InDesign.
 */
export function pageItemDocPlacement(
  points: PathPoint[],
  itemM: Matrix2D,
  canvasCtx: SpreadCanvasCtx,
  parentM: Matrix2D = identity6(),
): { x: number; y: number; w: number; h: number; rotation: number; localBounds: { minX: number; minY: number; maxX: number; maxY: number } } {
  const worldM = multiply6(parentM, itemM);
  const local = localPathBounds(points);
  const localW = Math.max(1, local.maxX - local.minX);
  const localH = Math.max(1, local.maxY - local.minY);
  const rotation = rotationDegreesFromMatrix6(worldM);
  const scaleX = Math.hypot(worldM[0], worldM[1]);
  const scaleY = Math.hypot(worldM[2], worldM[3]);
  const lcX = (local.minX + local.maxX) / 2;
  const lcY = (local.minY + local.maxY) / 2;

  const [spreadCx, spreadCy] = apply6(worldM, lcX, lcY);
  const [cx, cy] = spreadToCanvas(spreadCx, spreadCy, canvasCtx);
  const w = Math.max(10, Math.ceil(localW * (scaleX || 1)));
  const h = Math.max(10, Math.ceil(localH * (scaleY || 1)));

  return {
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    w,
    h,
    rotation,
    localBounds: local,
  };
}

export interface IdmlImportResources {
  colors: IdmlColorMap;
  objectFills: IdmlObjectStyleFillMap;
  textStyles: IdmlTextStyleResources;
}

const PAGE_ITEM_TAGS = /^(TextFrame|Rectangle|Oval|Polygon|Group|Image|EPS|PDF)$/i;

export function importPageItemForTest(
  itemEl: Element,
  pageSlots: IdmlPageImportSlot[],
  stories: Map<string, string>,
  spreadPath = 'Spreads/Spread_1.xml',
  spreadM: Matrix2D = identity6(),
  resources?: IdmlImportResources,
): Node | null {
  const tag = itemEl.localName;
  const self = itemEl.getAttribute('Self') || `item_${Math.random().toString(36).slice(2, 8)}`;
  const itemTransformStr = itemEl.getAttribute('ItemTransform');
  const m = parseMatrix6(itemTransformStr);

  const { points, open } = parsePathGeometry(itemEl);
  const { ctx: canvasCtx, pageSelf, pageIndex } = canvasCtxForPageItem(pageSlots, spreadM, m, points);
  const worldM = multiply6(spreadM, m);

  const placedMeta = parsePlacedImageFromFrame(itemEl);
  const kind = tag === 'TextFrame' ? 'text' : tag === 'Group' ? 'group' : placedMeta ? 'raster' : 'shape';
  const placement = pageItemDocPlacement(points, m, canvasCtx, spreadM);
  const nodeX = placement.x;
  const nodeY = placement.y;
  const w = placement.w;
  const h = placement.h;
  const itemRotation = placement.rotation;
  const fillSwatchRef = itemEl.getAttribute('FillColor') || undefined;
  const fillHex = resources
    ? resolveItemFillHex(itemEl, resources.colors, resources.objectFills)
    : resolveSwatchRef(fillSwatchRef, new Map());
  const frameFillHex = kind === 'text' ? fillHex : fillHex;
  const shapeFillHex = kind === 'shape' ? fillHex ?? undefined : undefined;
  const strokeInfo =
    kind === 'shape' && resources
      ? resolveItemStrokeFromSpread(itemEl, resources.colors)
      : { hex: null, swatchRef: null, weight: 0, tint: 100, enabled: false };

  const canvas = createCanvasElement(w, h);
  if (placedMeta && kind === 'raster') {
    const g = canvas.getContext('2d');
    if (g) drawPlacedImagePlaceholder(g, w, h, 'Loading…');
  } else if (kind !== 'text') {
    const g = canvas.getContext('2d');
    if (g) {
      if (shapeFillHex) {
        g.fillStyle = shapeFillHex;
        if (points.length > 0) {
          plotPathInItemLocalCanvas(g, points, open, placement.localBounds, w, h);
          g.fill();
        } else {
          g.fillRect(0, 0, w, h);
        }
      }
      if (strokeInfo.enabled && strokeInfo.hex && points.length > 0) {
        const lb = placement.localBounds;
        const localW = Math.max(1e-6, lb.maxX - lb.minX);
        const linePx = Math.max(1, (strokeInfo.weight / localW) * w);
        g.strokeStyle = strokeInfo.hex;
        g.lineWidth = linePx;
        g.lineJoin = 'round';
        g.lineCap = 'round';
        plotPathInItemLocalCanvas(g, points, open, lb, w, h);
        g.stroke();
      }
    }
  }

  let textContent = '';
  let textFontSize = 12;
  let textFontFamily = 'sans-serif';
  let textColorHex = '#1e1e1e';
  let storyLeading: number | undefined;
  let storyTracking: number | undefined;
  let storyJustification: string | undefined;
  let importFauxBold = false;
  let importFauxItalic = false;
  const parentStory = itemEl.getAttribute('ParentStory');
  if (parentStory && stories.has(parentStory)) {
    const parsed = parseStoryFromXml(
      stories.get(parentStory)!,
      resources?.colors ?? new Map(),
      resources?.textStyles,
    );
    textContent = parsed.text;
    textFontSize = parsed.fontSize;
    textFontFamily = parsed.fontFamily;
    textColorHex = parsed.textColorHex;
    const firstPara = parsed.paragraphs[0];
    storyLeading = firstPara?.leading;
    storyTracking = firstPara?.tracking;
    storyJustification = firstPara?.justification;
    const firstRun = firstPara?.runs?.[0];
    const fontStyleLower = (firstRun?.fontStyle ?? '').toLowerCase();
    importFauxBold = fontStyleLower.includes('bold');
    importFauxItalic = fontStyleLower.includes('italic');
  }

  const textFrameLayout = kind === 'text' ? parseTextFrameLayout(itemEl) : undefined;

  const idmlMeta: IdmlNodeMeta = {
    self,
    tag,
    storyId: parentStory || undefined,
    spreadPath,
    itemTransform: [...m],
    parentTransform: [...spreadM],
    canvasCtx: { originX: canvasCtx.originX, originY: canvasCtx.originY, offsetY: canvasCtx.offsetY ?? 0 },
    localBounds: placement.localBounds,
    pathPoints: kind === 'shape' && points.length > 0 ? points : undefined,
    pathOpen: kind === 'shape' ? open : undefined,
    localFrameW: kind === 'text' ? Math.max(1, placement.localBounds.maxX - placement.localBounds.minX) : undefined,
    localFrameH: kind === 'text' ? Math.max(1, placement.localBounds.maxY - placement.localBounds.minY) : undefined,
    pageSelf,
    pageIndex,
    fillColor: kind === 'shape' ? shapeFillHex : frameFillHex ?? textColorHex,
    fillSwatchRef: fillSwatchRef && fillSwatchRef !== 'n' ? fillSwatchRef : undefined,
    importRotation: itemRotation,
    exportRotation: itemRotation,
    frameFillColor: frameFillHex ?? undefined,
    textFrameLayout,
    storyLeading,
    storyTracking,
    storyJustification,
    importTextSnapshot:
      kind === 'text'
        ? {
            fontSize: textFontSize,
            fontFamily: textFontFamily,
            colorHex: textColorHex,
            bold: importFauxBold,
            italic: importFauxItalic,
            justification: storyJustification,
          }
        : undefined,
    strokeColor: kind === 'shape' && strokeInfo.hex ? strokeInfo.hex : undefined,
    strokeSwatchRef:
      kind === 'shape' && strokeInfo.swatchRef && strokeInfo.swatchRef !== 'n'
        ? strokeInfo.swatchRef
        : undefined,
    importStrokeSwatchRef:
      kind === 'shape' && strokeInfo.swatchRef && strokeInfo.swatchRef !== 'n'
        ? strokeInfo.swatchRef
        : undefined,
    strokeWeight: kind === 'shape' ? strokeInfo.weight : undefined,
    strokeTint: kind === 'shape' ? strokeInfo.tint : undefined,
    strokeEnabled: kind === 'shape' ? strokeInfo.enabled : undefined,
    contentType: placedMeta?.contentType ?? itemEl.getAttribute('ContentType') ?? undefined,
    placedImage: placedMeta
      ? {
          ...placedMeta,
          frameSelf: self,
          missingLink: true,
        }
      : undefined,
    rawAttributes: {},
  };

  const linkName = placedMeta?.packagePath.split('/').pop() ?? '';
  const node: Node = {
    id: `idml_${self}`,
    key: self,
    name: textContent ? textContent.slice(0, 24) : placedMeta ? linkName || 'Placed image' : `${tag} ${self}`,
    kind,
    visible: true,
    locked: false,
    opacity: 1,
    importOpacity: 1,
    importVisible: true,
    x: nodeX,
    y: nodeY,
    w,
    h,
    rotation: itemRotation,
    ow: w,
    oh: h,
    ox: nodeX,
    oy: nodeY,
    canvas,
    children: [],
    parent: null,
    unsupported: [],
    src: {
      name: placedMeta ? linkName || `${tag} ${self}` : `${tag} ${self}`,
      canvas: placedMeta ? canvas : undefined,
      text:
        kind === 'text'
          ? {
              text: textContent || self,
              transform: [...m],
              style: {
                fontSize: textFontSize,
                font: { name: textFontFamily },
                fillColor: hexToRgb(textColorHex) as any,
                fauxBold: importFauxBold,
                fauxItalic: importFauxItalic,
              },
            }
          : undefined,
    } as any,
    idml: idmlMeta,
  };

  if (kind === 'shape' && shapeFillHex) {
    node.src.vectorFill = { type: 'color', color: hexToRgb(shapeFillHex) as any };
  }

  if (placedMeta) {
    node.unsupported.push('Placed image: frame geometry and link export are supported; advanced fitting/crop may differ from InDesign.');
  }

  if (kind === 'text') {
    rasterizeIdmlTextNode(node);
  }

  return node;
}

function appendSpreadPageItems(
  container: Element,
  parentM: Matrix2D,
  roots: Node[],
  pageSlots: IdmlPageImportSlot[],
  stories: Map<string, string>,
  spreadPath: string,
  resources: IdmlImportResources,
): void {
  for (let i = 0; i < container.children.length; i++) {
    const itemEl = container.children[i];
    const tag = itemEl.localName;
    if (!PAGE_ITEM_TAGS.test(tag)) continue;
    if (/^Group$/i.test(tag)) {
      const groupM = parseMatrix6(itemEl.getAttribute('ItemTransform'));
      appendSpreadPageItems(
        itemEl,
        multiply6(parentM, groupM),
        roots,
        pageSlots,
        stories,
        spreadPath,
        resources,
      );
      continue;
    }
    const node = importPageItemForTest(itemEl, pageSlots, stories, spreadPath, parentM, resources);
    if (node) roots.push(node);
  }
}

export async function importIdml(name: string, bytes: ArrayBuffer, origin: 'indd' | 'idml' = 'idml'): Promise<Doc> {
  const zip = await readIdmlPackage(bytes);

  const graphicXml = (await zip.file('Resources/Graphic.xml')?.async('string')) ?? '';
  const stylesXml = (await zip.file('Resources/Styles.xml')?.async('string')) ?? '';
  const colors = graphicXml ? parseGraphicXmlColors(graphicXml) : new Map();
  const objectFills = stylesXml ? parseStylesXmlObjectFills(stylesXml, colors) : new Map();
  const textStyles = stylesXml
    ? parseStylesXmlTextStyles(stylesXml)
    : { paragraphStyles: new Map(), characterStyles: new Map() };
  const resources: IdmlImportResources = { colors, objectFills, textStyles };

  const linkAssets = new Map<string, Uint8Array>();
  for (const filename of Object.keys(zip.files)) {
    if (!filename.startsWith('Links/') || zip.files[filename].dir) continue;
    linkAssets.set(filename, await zip.file(filename)!.async('uint8array'));
  }

  const stories = new Map<string, string>();

  for (const filename of Object.keys(zip.files)) {
    if (filename.startsWith('Stories/Story_') && filename.endsWith('.xml')) {
      const match = filename.match(/Story_([^\.]+)\.xml/);
      if (match) {
        const xml = await zip.file(filename)!.async('string');
        stories.set(match[1], xml);
      }
    }
  }

  const designmapXml = (await zip.file('designmap.xml')?.async('string')) ?? '';
  let spreadFiles = contentSpreadPathsFromDesignmap(designmapXml);
  if (spreadFiles.length === 0) {
    spreadFiles = Object.keys(zip.files)
      .filter((f) => f.startsWith('Spreads/Spread_') && f.endsWith('.xml'))
      .sort();
  }

  const spreadsData: Array<{ path: string; xml: string; layout?: IdmlSpreadLayout }> = [];
  const roots: Node[] = [];
  const docPages: IdmlDocBacking['pages'] = [];
  const spreadPageSlots = new Map<string, IdmlPageImportSlot[]>();

  let docWidth = 0;
  let docHeight = 792;
  let masterLayout: IdmlSpreadLayout = { originX: 0, originY: 0, width: 612, height: 792 };
  let docStackY = 0;
  let pageIndex = 0;

  for (const spreadPath of spreadFiles) {
    const entry = zip.file(spreadPath);
    if (!entry) continue;
    const xml = await entry.async('string');
    const spreadDoc = parseXml(xml);
    const spreadEl = spreadContainerElement(spreadDoc);
    if (!spreadEl) continue;

    const spreadM = parseMatrix6(spreadEl.getAttribute('ItemTransform'));
    const pageEls = elementsLocalCI(spreadEl, 'Page');
    const slots: IdmlPageImportSlot[] = [];

    for (const pageEl of pageEls) {
      const layout = layoutFromPageElement(pageEl, spreadM);
      const pageSelf = pageEl.getAttribute('Self') || `page_${pageIndex + 1}`;
      pageIndex++;
      docWidth = Math.max(docWidth, layout.width);
      const canvasCtx: SpreadCanvasCtx = {
        originX: layout.originX,
        originY: layout.originY,
        offsetY: docStackY,
      };
      slots.push({
        pageSelf,
        pageIndex,
        spreadPath,
        canvasCtx,
        spreadBounds: pageRectInSpread(pageEl, spreadM),
      });
      docPages.push({
        id: `page_${pageIndex}`,
        width: layout.width,
        height: layout.height,
        docY: docStackY,
        pageSelf,
        spreadPath,
      });
      docStackY += layout.height;
      if (pageIndex === 1) masterLayout = layout;
    }

    const spreadLayout: IdmlSpreadLayout =
      pageEls.length > 0 ? layoutFromPageElement(pageEls[0], spreadM) : masterLayout;
    spreadsData.push({ path: spreadPath, xml, layout: spreadLayout });
    if (slots.length > 0) spreadPageSlots.set(spreadPath, slots);
  }

  docHeight = Math.max(1, docStackY);
  if (docWidth <= 0) docWidth = 612;

  for (const spreadPath of spreadFiles) {
    const entry = zip.file(spreadPath);
    if (!entry) continue;
    const xml = await entry.async('string');
    const spreadDoc = parseXml(xml);
    const spreadEl = spreadContainerElement(spreadDoc);
    if (!spreadEl) continue;
    const slots = spreadPageSlots.get(spreadPath);
    if (!slots?.length) continue;
    const spreadM = parseMatrix6(spreadEl.getAttribute('ItemTransform'));
    appendSpreadPageItems(spreadEl, spreadM, roots, slots, stories, spreadPath, resources);
  }

  const backing: IdmlDocBacking = {
    kind: 'idml',
    rawZipBytes: bytes.slice(0),
    spreads: spreadsData,
    stories,
    graphicXml: graphicXml || undefined,
    stylesXml: stylesXml || undefined,
    designmapXml: designmapXml || undefined,
    pages: docPages.length > 0 ? docPages : [{ id: 'page_1', width: docWidth, height: docHeight, docY: 0 }],
    spreadLayout: masterLayout,
  };

  const doc: Doc = {
    id: `doc_${Math.random().toString(36).slice(2, 9)}`,
    name,
    format: 'indd',
    origin,
    width: Math.round(docWidth),
    height: Math.round(docHeight),
    offsetX: 0,
    offsetY: 0,
    roots,
    original: bytes.slice(0),
    uploadedBytes: bytes.slice(0),
    warnings: [],
    idml: backing,
  };

  await hydrateIdmlPlacedImagePreviews(leaves(doc), linkAssets);

  return doc;
}

export async function exportIdml(doc: Doc): Promise<ArrayBuffer> {
  const zip = await readIdmlPackage(doc.idml?.rawZipBytes ?? doc.original);
  let graphicXml = doc.idml?.graphicXml ?? (await zip.file('Resources/Graphic.xml')?.async('string')) ?? '';
  if (!graphicXml.trim()) {
    graphicXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Graphic>\n</Graphic>';
  }
  let colors = parseGraphicXmlColors(graphicXml);

  const { spreadNodes, storyNodes } = collectIdmlExportPatches(doc);

  const fillPrep = prepareShapeFillSwatchesForExport(spreadNodes, graphicXml, colors);
  graphicXml = fillPrep.graphicXml;
  colors = fillPrep.colors;
  let graphicChanged = fillPrep.graphicChanged;

  const strokePrep = prepareShapeStrokeSwatchesForExport(spreadNodes, graphicXml, colors);
  graphicXml = strokePrep.graphicXml;
  colors = strokePrep.colors;
  if (strokePrep.graphicChanged) graphicChanged = true;

  for (const spreadInfo of doc.idml?.spreads ?? []) {
    const spreadXmlOriginal = await zip.file(spreadInfo.path)?.async('string');
    if (!spreadXmlOriginal) continue;
    let spreadXml = spreadXmlOriginal;
    const nodes = spreadNodes.get(spreadInfo.path);
    if (nodes?.length) {
      spreadXml = patchSpreadXmlForNodes(spreadXml, nodes);
    }
    const liveSelves = liveIdmlSelvesOnSpread(doc, spreadInfo.path);
    const importCount = (spreadInfo.xml.match(/<(TextFrame|Rectangle|Oval|Polygon)\b/gi) || []).length;
    if (liveSelves.size < importCount) {
      spreadXml = pruneSpreadPageItemsNotInModel(spreadXml, liveSelves);
    }
    if (spreadXml !== spreadXmlOriginal) zip.file(spreadInfo.path, spreadXml);
  }

  for (const [storyId, nodes] of storyNodes) {
    const storyPath = `Stories/Story_${storyId}.xml`;
    let storyXml = await zip.file(storyPath)?.async('string');
    if (!storyXml) continue;
    for (const node of nodes) {
      const patched = patchStoryXmlForNode(storyXml, node, colors, graphicXml);
      storyXml = patched.storyXml;
      colors = patched.colors;
      graphicXml = patched.graphicXml;
      if (patched.graphicChanged) graphicChanged = true;
    }
    zip.file(storyPath, storyXml);
  }
  if (graphicChanged) {
    zip.file('Resources/Graphic.xml', graphicXml);
    if (doc.idml) doc.idml.graphicXml = graphicXml;
  }

  const { syncIdmlPlacedImageExportBytes } = await import('./idml/placedImage');
  syncIdmlPlacedImageExportBytes(leaves(doc), zip);

  const out = await writeIdmlPackage(zip);
  if (doc.idml) {
    doc.idml.rawZipBytes = out.slice(0);
  }
  return out;
}

export async function createSampleIdml(): Promise<ArrayBuffer> {
  const minimalMimetype = 'application/vnd.adobe.indesign-idml-package';
  const minimalDesignmap = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4" Self="d">
  <idPkg:Spread src="Spreads/Spread_ud3.xml" />
  <idPkg:Story src="Stories/Story_ud4.xml" />
</Document>`;

  const minimalSpread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="ud3" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 792 612" />
    <TextFrame Self="uf3" ParentStory="ud4" ItemTransform="1 0 0 1 100 100">
      <Properties>
        <PathGeometry PathOpen="false">
          <GeometryPathType PathOpen="false">
            <PathPointType Anchor="0 0" />
            <PathPointType Anchor="300 0" />
            <PathPointType Anchor="300 80" />
            <PathPointType Anchor="0 80" />
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </TextFrame>
    <Rectangle Self="uf4" ItemTransform="1 0 0 1 100 220" FillColor="Color/Black">
      <Properties>
        <PathGeometry PathOpen="false">
          <GeometryPathType PathOpen="false">
            <PathPointType Anchor="0 0" />
            <PathPointType Anchor="200 0" />
            <PathPointType Anchor="200 120" />
            <PathPointType Anchor="0 120" />
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </Rectangle>
  </Spread>
</idPkg:Spread>`;

  const minimalStory = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Story Self="ud4">
    <ParagraphStyleRange>
      <CharacterStyleRange>
        <Content>Creatvise Canvas InDesign Sample</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>`;

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('mimetype', minimalMimetype, { compression: 'STORE' });
  zip.file('designmap.xml', minimalDesignmap);
  zip.file('Spreads/Spread_ud3.xml', minimalSpread);
  zip.file('Stories/Story_ud4.xml', minimalStory);

  return await writeIdmlPackage(zip);
}

import type { Doc, Node } from './model';
import type { IdmlDocBacking, IdmlNodeMeta, IdmlSpreadLayout } from './idml/types';
import { apply6, identity6, parseMatrix6, matrix6ToString, type Matrix2D } from './idml/matrix';
import { readIdmlPackage, writeIdmlPackage } from './idml/zip';

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

export function spreadToCanvas(sx: number, sy: number, c: SpreadCanvasCtx): [number, number] {
  return [sx - c.originX, sy - c.originY + c.offsetY];
}

export interface PathPoint {
  anchor: [number, number];
  leftDirection?: [number, number];
  rightDirection?: [number, number];
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


export function importPageItemForTest(
  itemEl: Element,
  canvasCtx: SpreadCanvasCtx,
  stories: Map<string, string>,
  spreadPath = 'Spreads/Spread_1.xml',
): Node | null {
  const tag = itemEl.localName;
  const self = itemEl.getAttribute('Self') || `item_${Math.random().toString(36).slice(2, 8)}`;
  const itemTransformStr = itemEl.getAttribute('ItemTransform');
  const m = parseMatrix6(itemTransformStr);

  const { points, open } = parsePathGeometry(itemEl);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  if (points.length > 0) {
    for (const pt of points) {
      const [cx, cy] = spreadToCanvas(apply6(m, pt.anchor[0], pt.anchor[1])[0], apply6(m, pt.anchor[0], pt.anchor[1])[1], canvasCtx);
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
    }
  } else {
    const [cx, cy] = spreadToCanvas(m[4], m[5], canvasCtx);
    minX = cx;
    minY = cy;
    maxX = cx + 100;
    maxY = cy + 50;
  }

  const w = Math.max(10, Math.ceil(maxX - minX));
  const h = Math.max(10, Math.ceil(maxY - minY));
  const nodeX = Math.round(minX);
  const nodeY = Math.round(minY);

  const kind = tag === 'TextFrame' ? 'text' : tag === 'Group' ? 'group' : 'shape';
  const fillColorAttr = itemEl.getAttribute('FillColor') || '';
  const hexColor = fillColorAttr.includes('Black') ? '#000000' : '#4f6bff';

  const canvas = createCanvasElement(w, h);
  const g = canvas.getContext('2d');
  if (g) {
    g.fillStyle = hexColor;
    if (points.length > 0) {
      plotPathOnCanvas(g, points, open, m, canvasCtx, nodeX, nodeY);
      g.fill();
    } else {
      g.fillRect(0, 0, w, h);
    }
  }

  let textContent = '';
  const parentStory = itemEl.getAttribute('ParentStory');
  if (parentStory && stories.has(parentStory)) {
    const storyXml = stories.get(parentStory)!;
    const contentMatches = storyXml.match(/<Content>([\s\S]*?)<\/Content>/g);
    if (contentMatches) {
      textContent = contentMatches.map((c) => c.replace(/<\/?Content>/g, '')).join(' ');
    }
  }

  const idmlMeta: IdmlNodeMeta = {
    self,
    tag,
    storyId: parentStory || undefined,
    spreadPath,
    itemTransform: [...m],
    fillColor: hexColor,
    rawAttributes: {},
  };

  const node: Node = {
    id: `idml_${self}`,
    key: self,
    name: textContent ? textContent.slice(0, 24) : `${tag} ${self}`,
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
    rotation: 0,
    ow: w,
    oh: h,
    ox: nodeX,
    oy: nodeY,
    canvas,
    children: [],
    parent: null,
    unsupported: [],
    src: {
      name: `${tag} ${self}`,
      text: kind === 'text' ? { text: textContent || self, transform: [...m] } : undefined,
    } as any,
    idml: idmlMeta,
  };

  return node;
}

export async function importIdml(name: string, bytes: ArrayBuffer, origin: 'indd' | 'idml' = 'idml'): Promise<Doc> {
  const zip = await readIdmlPackage(bytes);
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

  const spreadFiles = Object.keys(zip.files)
    .filter((f) => f.startsWith('Spreads/Spread_') && f.endsWith('.xml'))
    .sort();

  const spreadsData: Array<{ path: string; xml: string; layout?: IdmlSpreadLayout }> = [];
  const roots: Node[] = [];

  let docWidth = 612;
  let docHeight = 792;
  let masterLayout: IdmlSpreadLayout = { originX: 0, originY: 0, width: 612, height: 792 };

  for (const spreadPath of spreadFiles) {
    const xml = await zip.file(spreadPath)!.async('string');
    const spreadDoc = parseXml(xml);
    const spreadEl = spreadContainerElement(spreadDoc);
    if (!spreadEl) continue;

    const pageEls = elementsLocalCI(spreadEl, 'Page');
    let minPx = Infinity;
    let minPy = Infinity;
    let maxPx = -Infinity;
    let maxPy = -Infinity;

    for (const pageEl of pageEls) {
      const geoBounds = pageEl.getAttribute('GeometricBounds');
      if (geoBounds) {
        const [y1, x1, y2, x2] = geoBounds.trim().split(/\s+/).map(Number);
        minPx = Math.min(minPx, x1);
        minPy = Math.min(minPy, y1);
        maxPx = Math.max(maxPx, x2);
        maxPy = Math.max(maxPy, y2);
      }
    }

    const originX = Number.isFinite(minPx) ? minPx : 0;
    const originY = Number.isFinite(minPy) ? minPy : 0;
    const sWidth = Number.isFinite(maxPx) && Number.isFinite(minPx) ? Math.max(100, maxPx - minPx) : 612;
    const sHeight = Number.isFinite(maxPy) && Number.isFinite(minPy) ? Math.max(100, maxPy - minPy) : 792;

    const layout: IdmlSpreadLayout = {
      originX,
      originY,
      width: sWidth,
      height: sHeight,
      offsetY: 0,
    };
    masterLayout = layout;
    docWidth = sWidth;
    docHeight = sHeight;

    spreadsData.push({ path: spreadPath, xml, layout });

    const canvasCtx: SpreadCanvasCtx = { originX, originY, offsetY: 0 };

    for (let i = 0; i < spreadEl.children.length; i++) {
      const itemEl = spreadEl.children[i];
      if (/^(TextFrame|Rectangle|Oval|Polygon|Group)$/i.test(itemEl.localName)) {
        const node = importPageItemForTest(itemEl, canvasCtx, stories, spreadPath);
        if (node) roots.push(node);
      }
    }
  }

  const backing: IdmlDocBacking = {
    kind: 'idml',
    rawZipBytes: bytes.slice(0),
    spreads: spreadsData,
    stories,
    pages: [{ id: 'page_1', width: docWidth, height: docHeight }],
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

  return doc;
}

export async function exportIdml(doc: Doc): Promise<ArrayBuffer> {
  const zip = await readIdmlPackage(doc.idml?.rawZipBytes ?? doc.original);

  const canvasCtx: SpreadCanvasCtx = {
    originX: doc.idml?.spreadLayout?.originX ?? 0,
    originY: doc.idml?.spreadLayout?.originY ?? 0,
    offsetY: doc.idml?.spreadLayout?.offsetY ?? 0,
  };

  for (const spreadInfo of doc.idml?.spreads ?? []) {
    let spreadXml = await zip.file(spreadInfo.path)?.async('string');
    if (!spreadXml) continue;

    for (const node of doc.roots) {
      if (node.idml && node.idml.spreadPath === spreadInfo.path) {
        if (node.x !== node.ox || node.y !== node.oy) {
          const dx = node.x - node.ox;
          const dy = node.y - node.oy;
          const oldM = node.idml.itemTransform || [1, 0, 0, 1, 0, 0];
          const newM: Matrix2D = [oldM[0], oldM[1], oldM[2], oldM[3], oldM[4] + dx, oldM[5] + dy];
          const matrixStr = matrix6ToString(newM);

          const re = new RegExp(
            `(<(?:TextFrame|Rectangle|Oval|Polygon|Group)\\b[^>]*\\bSelf="${node.idml.self}"[^>]*\\bItemTransform=")([^"]+)(")`,
          );
          spreadXml = spreadXml.replace(re, `$1${matrixStr}$3`);
        }
      }
    }
    zip.file(spreadInfo.path, spreadXml);
  }

  for (const node of doc.roots) {
    if (node.idml?.storyId && node.textEdited && node.src.text) {
      const storyPath = `Stories/Story_${node.idml.storyId}.xml`;
      let storyXml = await zip.file(storyPath)?.async('string');
      if (storyXml) {
        storyXml = storyXml.replace(/<Content>[\s\S]*?<\/Content>/, `<Content>${node.src.text.text}</Content>`);
        zip.file(storyPath, storyXml);
      }
    }
  }

  return await writeIdmlPackage(zip);
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

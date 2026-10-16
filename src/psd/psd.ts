import { readPsd, writePsd, type Layer, type Psd } from 'ag-psd';
import { type Doc, type Node, walk, leaves, effVisible, effOpacity } from '../core/model';
import {
  analyzePsdPreview,
  copyFileComposite,
  docNeedsCompositePreview,
  getDocPreviewCanvas,
  reconcilePsdPreviewMode,
} from './psdComposite';
import { classifyPsdNodeKind, describeUnsupportedLayer } from './psdLayerInfo';
import { requirePsdDoc } from '../core/sourceTree';

export { inspectDocLayers, countUnsupportedLayers, psdLayerType } from './psdLayerInfo';
export {
  composeDocPreview,
  docNeedsCompositePreview,
  getDocPreviewCanvas,
  markNodePreviewContentChanged,
} from './psdComposite';

let uid = 0;
const nextId = () => `n${++uid}`;
/** Files keep their id across reloads, so it must be unique beyond one session. (randomUUID needs https/localhost) */
const newDocId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

const describeUnsupported = describeUnsupportedLayer;

function build(l: Layer, parent: Node | null, key: string): Node {
  const isGroup = !!l.children;
  const left = l.left ?? 0;
  const top = l.top ?? 0;
  const w = isGroup ? 0 : (l.right ?? left) - left;
  const h = isGroup ? 0 : (l.bottom ?? top) - top;
  const kind = classifyPsdNodeKind(l, isGroup);

  const node: Node = {
    id: nextId(),
    key,
    name: l.name ?? 'Layer',
    kind,
    visible: !l.hidden,
    locked: !!l.protected?.position,
    opacity: l.opacity ?? 1,
    importOpacity: l.opacity ?? 1,
    importVisible: !l.hidden,
    x: left,
    y: top,
    w,
    h,
    rotation: 0,
    ow: w,
    oh: h,
    ox: left,
    oy: top,
    canvas: (l.canvas as HTMLCanvasElement | undefined) ?? null,
    children: [],
    parent,
    src: l,
    textTransform: l.text?.transform ? [...l.text.transform] : undefined,
    unsupported: describeUnsupported(l),
    importPreviewContentEpoch: 0,
    previewContentEpoch: 0,
  };
  node.children = (l.children ?? []).map((c, i) => build(c, node, `${key}/${i}`));
  return node;
}

export function importPsd(name: string, buf: ArrayBuffer): Doc {
  let psd: Psd;
  try {
    psd = readPsd(buf, { skipThumbnail: true });
  } catch (e) {
    throw new Error(`"${name}" could not be read as a PSD (${(e as Error).message}). The file may be damaged.`);
  }
  const doc: Doc = {
    id: newDocId(),
    name,
    format: 'psd',
    width: psd.width,
    height: psd.height,
    offsetX: 0,
    offsetY: 0,
    roots: [],
    psd,
    original: buf.slice(0),
    warnings: [],
  };
  doc.roots = (psd.children ?? []).map((l, i) => build(l, null, String(i)));
  doc.psdImportLeafCount = leaves(doc).length;
  if (doc.roots.length === 0) {
    doc.warnings.push('This PSD has no separate layers, so there is nothing to edit.');
  }
  const missing = [...walk(doc.roots)].filter((n) => n.kind !== 'group' && !n.canvas && n.unsupported.length === 0);
  if (missing.length) {
    doc.warnings.push(`${missing.length} layer(s) have no pixel data and are not drawn (they are kept on export).`);
  }

  const choice = analyzePsdPreview(doc);
  doc.psdPreviewMode = choice.mode;
  doc.fileComposite = copyFileComposite(doc);
  doc.psdStaticComposite = doc.psdPreviewMode === 'file-composite';
  doc.psdFileCompositeBase = doc.psdPreviewMode === 'file-composite' && !!doc.fileComposite;

  if (choice.features.length) {
    const list = choice.features.join(', ');
    if (doc.psdFileCompositeBase) {
      doc.warnings.push(
        `The editor cannot redraw ${list}. Preview uses the embedded Photoshop composite until you edit a layer; edited areas are redrawn without them.`,
      );
    } else {
      const why = { missing: 'has no embedded composite', 'not-real': 'was saved without a real composite', blank: 'has a blank embedded composite', usable: '' }[choice.composite ?? 'missing'];
      doc.warnings.push(`The editor cannot redraw ${list}, and this file ${why}, so the preview is approximate.`);
    }
  } else if (docNeedsCompositePreview(doc)) {
    doc.warnings.push(
      'This file uses blend modes, clipping, masks, and/or layer effects (drop shadow, outer glow, stroke). Preview redraws them from the layers in 2D.',
    );
  }

  return doc;
}

/** After any layer edit, sync preview mode (restores embedded composite when model matches import). */
export function refreshPsdPreviewModeAfterEdit(doc: Doc) {
  reconcilePsdPreviewMode(doc);
}

export function isTransformed(n: Node): boolean {
  return Math.round(n.w) !== n.ow || Math.round(n.h) !== n.oh || Math.abs(n.rotation) > 0.01;
}

/** ag-psd writePsd prefers imageData/rawData over canvas; drop these when pixels or bounds change. */
function clearLayerWriteCache(s: Layer) {
  delete s.imageData;
  delete s.rawData;
  const extra = s as Layer & { imageDataRaw?: unknown; imageDataRawCompression?: unknown };
  delete extra.imageDataRaw;
  delete extra.imageDataRawCompression;
}

/**
 * PSD raster layers have no scale/rotate setting: Photoshop stores the transformed pixels.
 * So resize/rotate is baked into a new canvas (always from the untouched original pixels, so repeated exports don't lose quality).
 * Only the PSD layer receives the result; the editor's layer keeps its pixels and transform so undo/redo stay valid.
 */
function bakeTransform(n: Node) {
  const s = n.src;
  const th = (n.rotation * Math.PI) / 180;
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const ex = Math.abs((n.w / 2) * Math.cos(th)) + Math.abs((n.h / 2) * Math.sin(th));
  const ey = Math.abs((n.w / 2) * Math.sin(th)) + Math.abs((n.h / 2) * Math.cos(th));
  const left = Math.floor(cx - ex);
  const top = Math.floor(cy - ey);
  const right = Math.ceil(cx + ex);
  const bottom = Math.ceil(cy + ey);
  const bw = Math.max(1, right - left);
  const bh = Math.max(1, bottom - top);
  if (bw > 16384 || bh > 16384) throw new Error(`"${n.name}" is too large after resizing (${bw}×${bh}px). Make it smaller and export again.`);
  const c = document.createElement('canvas');
  c.width = bw;
  c.height = bh;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.translate(cx - left, cy - top);
  g.rotate(th);
  g.drawImage(n.canvas!, -n.w / 2, -n.h / 2, n.w, n.h);
  s.canvas = c;
  s.left = left;
  s.top = top;
  s.right = left + bw;
  s.bottom = top + bh;
  clearLayerWriteCache(s);
}

function drawLayerOnComposite(g: CanvasRenderingContext2D, n: Node) {
  if (!n.canvas) return;
  const rot = n.rotation;
  if (Math.abs(rot) < 0.01) {
    g.drawImage(n.canvas, n.x, n.y, n.w, n.h);
    return;
  }
  const th = (rot * Math.PI) / 180;
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  g.save();
  g.translate(cx, cy);
  g.rotate(th);
  g.drawImage(n.canvas, -n.w / 2, -n.h / 2, n.w, n.h);
  g.restore();
}

/** Copy edits from the model back onto the original ag-psd tree (patch, don't regenerate). */
function syncToPsd(doc: Doc) {
  for (const n of walk(doc.roots)) {
    const s = n.src;
    s.name = n.name;
    s.hidden = !n.visible;
    s.opacity = n.opacity;
    s.protected = { ...(s.protected ?? {}), position: n.locked, composite: n.locked };
    if (n.kind === 'group') {
      if (!s.blendMode) s.blendMode = 'pass through';
      continue;
    }
    if (n.kind === 'raster' && n.canvas && isTransformed(n)) {
      bakeTransform(n);
      continue;
    }
    if (n.canvas) s.canvas = n.canvas; // back to the original pixels if a transform was undone
    const dx = Math.round(n.x - n.ox);
    const dy = Math.round(n.y - n.oy);
    s.left = n.ox + dx;
    s.top = n.oy + dy;
    s.right = s.left + n.w;
    s.bottom = s.top + n.h;
    clearLayerWriteCache(s);
    // textTransform is the anchor at (ox, oy); s.text.transform holds the previous export, so it must not be the base.
    if (n.kind === 'text' && s.text && n.textTransform) {
      const t = [...n.textTransform];
      t[4] += dx;
      t[5] += dy;
      s.text.transform = t;
    }
  }
}

/** Flattened preview of the visible layers, so the PSD's composite image matches the edits. */
export function renderComposite(doc: Doc): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = doc.width;
  c.height = doc.height;
  const g = c.getContext('2d')!; // stays transparent where no layer paints, same as the canvas
  for (const n of leaves(doc)) {
    if (!n.canvas || !effVisible(n)) continue;
    g.globalAlpha = effOpacity(n);
    drawLayerOnComposite(g, n);
  }
  g.globalAlpha = 1;
  return c;
}

/** Embedded composite to write: the on-canvas preview when it is built on the file's own composite. */
function exportComposite(doc: Doc): HTMLCanvasElement {
  if (doc.psdFileCompositeBase && doc.fileComposite) return getDocPreviewCanvas(doc) ?? doc.fileComposite;
  return renderComposite(doc);
}

export function exportPsd(doc: Doc): ArrayBuffer {
  const psd = requirePsdDoc(doc);
  const composite = exportComposite(doc);
  syncToPsd(doc);
  psd.canvas = composite;
  delete psd.imageData;
  // Photoshop must redraw text we edited, because our own drawing of it is only an approximation
  const textEdited = [...walk(doc.roots)].some((n) => n.textEdited);
  return writePsd(psd, { generateThumbnail: true, invalidateTextLayers: textEdited });
}

function mk(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return c;
}

/** Builds a small PSD in the browser so the app can be tried without a sample file. */
export function createSamplePsd(): ArrayBuffer {
  const W = 800;
  const H = 600;
  const layer = (name: string, x: number, y: number, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, extra: Partial<Layer> = {}): Layer => ({
    name, left: x, top: y, right: x + w, bottom: y + h, canvas: mk(w, h, draw), ...extra,
  });
  const psd: Psd = {
    width: W,
    height: H,
    children: [
      layer('Background', 0, 0, W, H, (g) => { g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, W, H); }),
      {
        name: 'Header group',
        opened: true,
        children: [
          layer('Blue card', 60, 60, 420, 200, (g) => { g.fillStyle = '#3b6fd8'; g.beginPath(); g.roundRect(0, 0, 420, 200, 16); g.fill(); }),
          layer('Title', 90, 100, 360, 60, (g) => { g.fillStyle = '#ffffff'; g.font = 'bold 40px Arial'; g.textBaseline = 'alphabetic'; g.fillText('Hello Creatvise', 0, 40); }, {
            text: {
              text: 'Hello Creatvise',
              shapeType: 'point',
              transform: [1, 0, 0, 1, 90, 140],
              style: { font: { name: 'Arial-BoldMT' }, fontSize: 40, fillColor: { r: 255, g: 255, b: 255 } },
            },
          }),
        ],
      },
      layer('Green circle', 520, 200, 200, 200, (g) => { g.fillStyle = '#2fb67c'; g.beginPath(); g.arc(100, 100, 100, 0, Math.PI * 2); g.fill(); }),
      layer('Purple badge', 560, 60, 160, 90, (g) => { g.fillStyle = '#7b61ff'; g.fillRect(0, 0, 160, 90); }, {
        vectorFill: { type: 'color', color: { r: 123, g: 97, b: 255 } },
        vectorMask: {
          paths: [{
            open: false,
            fillRule: 'non-zero',
            knots: [[560, 60], [720, 60], [720, 150], [560, 150]].map(([x, y]) => ({ linked: true, points: [x, y, x, y, x, y] })),
          }],
        },
      }),
      layer('Orange bar', 80, 380, 340, 70, (g) => { g.fillStyle = '#f0883e'; g.fillRect(0, 0, 340, 70); }, { opacity: 0.85 }),
      layer('Hidden layer', 300, 300, 160, 160, (g) => { g.fillStyle = '#d9534f'; g.fillRect(0, 0, 160, 160); }, { hidden: true }),
    ],
  };
  psd.canvas = mk(W, H, (g) => { g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, W, H); });
  return writePsd(psd);
}

/** Fetch a public sample `.psd` from public/. */
export async function fetchPublicPsd(path: string, displayName: string): Promise<Doc> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return importPsd(displayName, await res.arrayBuffer());
}

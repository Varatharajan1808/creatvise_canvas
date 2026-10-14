import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFString,
  PDFBool,
  PDFNumber,
  PDFRef,
} from 'pdf-lib';
import { inflate } from 'pako';
import { type Doc, type Node, walk } from './model';
import { patchAiShapeColorsInStream } from './aiVectorShapes';

export interface ExportAiResult {
  bytes: ArrayBuffer;
  notes: string[];
}

function pageExtGStateDict(pdfDoc: PDFDocument): PDFDict | null {
  if (pdfDoc.getPageCount() < 1) return null;
  const page = pdfDoc.getPage(0);
  const res = pdfDoc.context.lookup(page.node.get(PDFName.of('Resources')));
  if (!(res instanceof PDFDict)) return null;
  const ext = pdfDoc.context.lookup(res.get(PDFName.of('ExtGState')));
  return ext instanceof PDFDict ? ext : null;
}

function extGStateCa(gs: PDFDict): number | null {
  const ca = gs.get(PDFName.of('ca'));
  if (ca instanceof PDFNumber) {
    const v = ca.asNumber();
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
  }
  return null;
}

/**
 * Page ExtGState /ca (prefers /GS0, the graphics state sample.ai already invokes).
 * Reads object streams that a latin1 scan of the file cannot see.
 */
export async function readPageExtGStateOpacity(buf: ArrayBuffer): Promise<number | null> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const ext = pageExtGStateDict(pdfDoc);
  if (!ext) return null;
  const gs0 = pdfDoc.context.lookup(ext.get(PDFName.of('GS0')));
  if (gs0 instanceof PDFDict) {
    const ca = extGStateCa(gs0);
    if (ca != null) return ca;
  }
  for (const key of ext.keys()) {
    const gs = pdfDoc.context.lookup(ext.get(key));
    if (gs instanceof PDFDict) {
      const ca = extGStateCa(gs);
      if (ca != null) return ca;
    }
  }
  return null;
}

/** Copy of `buf` with every page ExtGState /ca and /CA set to 1 so the preview raster is not pre-multiplied. */
export async function neutralizePageExtGStateOpacity(buf: ArrayBuffer): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
  const ext = pageExtGStateDict(pdfDoc);
  if (!ext) return new Uint8Array(buf.slice(0));
  for (const key of ext.keys()) {
    const gs = pdfDoc.context.lookup(ext.get(key));
    if (!(gs instanceof PDFDict)) continue;
    if (gs.has(PDFName.of('ca'))) gs.set(PDFName.of('ca'), PDFNumber.of(1));
    if (gs.has(PDFName.of('CA'))) gs.set(PDFName.of('CA'), PDFNumber.of(1));
  }
  const saved = await pdfDoc.save({ useObjectStreams: false });
  return new Uint8Array(saved);
}

/**
 * Format a number cleanly for PDF operators (up to 4 decimal places, no trailing zeros).
 */
export function formatPdfNumber(n: number): string {
  if (Math.abs(n) < 1e-6) return '0';
  const rounded = Math.round(n * 10000) / 10000;
  return Number(rounded.toFixed(4)).toString();
}

/**
 * Compute the 6-parameter affine transformation matrix for PDF content streams:
 * [a b c d e f cm]
 *
 * Accounts for coordinate system differences:
 * - Canvas: origin top-left, Y goes down, rotation clockwise in degrees.
 * - PDF: origin bottom-left, Y goes up, counter-clockwise radians.
 */
export function computePdfTransformMatrix(
  ox: number,
  oy: number,
  ow: number,
  oh: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rotationDeg: number,
  pageHeight: number,
): { a: number; b: number; c: number; d: number; e: number; f: number; isIdentity: boolean } {
  const isIdentity =
    Math.abs(x - ox) < 1e-3 &&
    Math.abs(y - oy) < 1e-3 &&
    Math.abs(w - ow) < 1e-3 &&
    Math.abs(h - oh) < 1e-3 &&
    Math.abs(rotationDeg) < 1e-3;

  if (isIdentity) {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, isIdentity: true };
  }

  const sx = ow > 0 ? w / ow : 1;
  const sy = oh > 0 ? h / oh : 1;

  // In canvas: clockwise rotation.
  // In PDF (Cartesian): clockwise rotation corresponds to negative angle (-theta).
  const rad = (rotationDeg * Math.PI) / 180;
  const alpha = -rad;
  const cos = Math.cos(alpha);
  const sin = Math.sin(alpha);

  // Centers in PDF coordinates (Y flipped)
  const c0x = ox + ow / 2;
  const c0y = pageHeight - (oy + oh / 2);
  const c1x = x + w / 2;
  const c1y = pageHeight - (y + h / 2);

  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const e = c1x - (a * c0x + c * c0y);
  const f = c1y - (b * c0x + d * c0y);

  return { a, b, c, d, e, f, isIdentity: false };
}

/**
 * Inverse of `computePdfTransformMatrix`: the placement (canvas box + clockwise rotation) that
 * `m` gives to `frame`. Null when `m` has skew or a flip, which this app never writes.
 */
export function decomposePdfTransformMatrix(
  m: readonly number[],
  frame: { x: number; y: number; w: number; h: number },
  pageHeight: number,
): { x: number; y: number; w: number; h: number; rotation: number } | null {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (sx < 1e-6 || sy < 1e-6) return null;
  if (a * d - b * c <= 0) return null;
  if (Math.abs(a * c + b * d) > 1e-3 * sx * sy) return null;
  const c0x = frame.x + frame.w / 2;
  const c0y = pageHeight - (frame.y + frame.h / 2);
  const c1x = a * c0x + c * c0y + e;
  const c1y = b * c0x + d * c0y + f;
  const w = frame.w * sx;
  const h = frame.h * sy;
  let rotation = (-Math.atan2(b, a) * 180) / Math.PI;
  if (rotation <= -180) rotation += 360;
  if (Math.abs(rotation) < 1e-6) rotation = 0;
  return { x: c1x - w / 2, y: pageHeight - c1y - h / 2, w, h, rotation };
}

function isPlacementMatrix(m: readonly number[]): boolean {
  return decomposePdfTransformMatrix(m, { x: 0, y: 0, w: 1, h: 1 }, 0) !== null;
}

/** Untransformed artwork rectangle (doc px) for a re-imported AI layer whose file already carried an export transform. */
export interface AiArtFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function aiArtFrame(n: Node): AiArtFrame | undefined {
  return (n.src as { aiArtFrame?: AiArtFrame }).aiArtFrame;
}

function ocgIndexForNode(n: Node): number | null {
  const m = /^ocg-(\d+)$/.exec(n.key);
  if (m) return parseInt(m[1], 10);
  if (n.key === '0' || n.key === 'artwork-0') return 0;
  return null;
}

/** PDF affine matrix `[a b c d e f]`: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type PdfMatrix = [number, number, number, number, number, number];

interface LayerBlock {
  layerIndex: number;
  bdcStart: number;
  bdcEnd: number;
  emcStart: number;
  emcEnd: number;
}

const PDF_NUM = '-?\\d+(?:\\.\\d+)?';
const PDF_CM = `(?:(${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) (${PDF_NUM}) cm\\n)?`;
/** Exact wrapper written by `patchStreamLayers` inside a layer block / around a stream without blocks. */
const INJECTED_IN_BLOCK_RE = new RegExp(`^\\nq\\n(/GS_L_\\d+ gs\\n)?${PDF_CM}([\\s\\S]*)\\nQ\\n$`);
const INJECTED_IN_STREAM_RE = new RegExp(`^q\\n(/GS_L_\\d+ gs\\n)?${PDF_CM}([\\s\\S]*)\\nQ$`);

/** Strip a transform/opacity wrapper previously written by this exporter, if present. */
function parseInjectedWrapper(
  segment: string,
  inBlock: boolean,
): { matrix: PdfMatrix | null; body: string } | null {
  const m = (inBlock ? INJECTED_IN_BLOCK_RE : INJECTED_IN_STREAM_RE).exec(segment);
  if (!m || (!m[1] && m[2] === undefined)) return null;
  const matrix =
    m[2] === undefined ? null : (m.slice(2, 8).map(Number) as PdfMatrix);
  if (matrix && !isPlacementMatrix(matrix)) return null;
  return { matrix, body: m[8] };
}

function findLayerBlocks(text: string): LayerBlock[] {
  const bdcRegex = /(?:\/(?:OC|Layer)\s+\/MC(\d+)\s+BDC)/g;
  const blocks: LayerBlock[] = [];

  let match: RegExpExecArray | null;
  while ((match = bdcRegex.exec(text)) !== null) {
    const layerIndex = parseInt(match[1], 10);
    const bdcStart = match.index;
    const bdcEnd = bdcRegex.lastIndex;

    // Find matching EMC (taking into account any nested BDC/EMC pairs)
    let depth = 1;
    const subRegex = /(?:\/(?:[A-Za-z0-9_]+)\s+\/(?:[A-Za-z0-9_]+)\s+BDC)|(EMC)/g;
    subRegex.lastIndex = bdcEnd;
    let subMatch: RegExpExecArray | null;
    let emcStart = -1;
    let emcEnd = -1;

    while ((subMatch = subRegex.exec(text)) !== null) {
      if (subMatch[1] === 'EMC' || subMatch[0] === 'EMC') {
        depth--;
        if (depth === 0) {
          emcStart = subMatch.index;
          emcEnd = subRegex.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }

    if (emcStart !== -1) {
      blocks.push({ layerIndex, bdcStart, bdcEnd, emcStart, emcEnd });
      bdcRegex.lastIndex = emcEnd;
    }
  }
  return blocks;
}

/**
 * Layer transforms written by a previous export of this app, keyed by layer index
 * (layer 0 for streams without layer blocks).
 */
export function readInjectedLayerTransforms(text: string): {
  transforms: Map<number, PdfMatrix>;
  blockCount: number;
} {
  const transforms = new Map<number, PdfMatrix>();
  const blocks = findLayerBlocks(text);
  if (blocks.length === 0) {
    const w = parseInjectedWrapper(text, false);
    if (w?.matrix) transforms.set(0, w.matrix);
  }
  for (const b of blocks) {
    const w = parseInjectedWrapper(text.slice(b.bdcEnd, b.emcStart), true);
    if (w?.matrix && !transforms.has(b.layerIndex)) transforms.set(b.layerIndex, w.matrix);
  }
  return { transforms, blockCount: blocks.length };
}

/**
 * Patch layer marked content blocks in a decompressed PDF content stream.
 * Every layer present in `layerPatches` has any earlier export wrapper replaced, not nested.
 */
function patchStreamLayers(
  text: string,
  layerPatches: Map<number, { cm?: string; gsName?: string }>,
): string {
  const blocks = findLayerBlocks(text);

  if (blocks.length === 0) {
    // Single layer / no marked content tags: apply layer 0 patch to entire stream
    const p0 = layerPatches.get(0);
    if (!p0) return text;
    const inner = parseInjectedWrapper(text, false)?.body ?? text;
    let prefix = '';
    let suffix = '';
    if (p0.cm || p0.gsName) {
      prefix += 'q\n';
      suffix = '\nQ';
    }
    if (p0.gsName) prefix += `/${p0.gsName} gs\n`;
    if (p0.cm) prefix += `${p0.cm}\n`;
    return prefix + inner + suffix;
  }

  // Patch blocks from end to beginning so indices remain valid
  let result = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const patch = layerPatches.get(block.layerIndex);
    if (!patch) continue;

    const before = result.slice(0, block.bdcEnd);
    const segment = result.slice(block.bdcEnd, block.emcStart);
    const inner = parseInjectedWrapper(segment, true)?.body ?? segment;
    const after = result.slice(block.emcStart);

    if (!patch.gsName && !patch.cm) {
      result = before + inner + after;
      continue;
    }
    let prefix = 'q\n';
    if (patch.gsName) {
      prefix += `/${patch.gsName} gs\n`;
    }
    if (patch.cm) {
      prefix += `${patch.cm}\n`;
    }

    result = before + '\n' + prefix + inner + '\nQ' + '\n' + after;
  }

  return result;
}

/**
 * Export an Illustrator (.ai) document using pdf-lib clean stream patching.
 * Writes transforms (move, resize, rotate), layer names, layer visibility, and opacities.
 */
export async function exportAiWithPdfLib(doc: Doc): Promise<ExportAiResult> {
  if (doc.format !== 'ai' || !doc.ai) {
    throw new Error('Export to .ai requires an imported Illustrator document.');
  }
  if (!doc.original?.byteLength) {
    throw new Error('This document has no original file bytes to export.');
  }

  const notes: string[] = [];
  const pdfDoc = await PDFDocument.load(doc.original.slice(0), { ignoreEncryption: true });

  if (pdfDoc.getPageCount() < 1) {
    throw new Error('Document has no pages.');
  }

  const page = pdfDoc.getPage(0);
  const { height: pageH } = page.getSize();

  // Synchronize stub layer properties
  for (const n of walk(doc.roots)) {
    n.src.name = n.name;
    n.src.hidden = !n.visible;
    n.src.opacity = n.opacity;
  }

  const leafNodes = [...walk(doc.roots)].filter((n) => n.kind !== 'group');
  const leavesByIndex = new Map<number, Node>();
  for (const n of leafNodes) {
    const idx = ocgIndexForNode(n);
    if (idx !== null) {
      leavesByIndex.set(idx, n);
    }
  }

  let hasGeometryEdits = false;
  const layerPatches = new Map<number, { cm?: string; gsName?: string }>();

  // Ensure Resources dict exists
  let resDict = pdfDoc.context.lookup(page.node.get(PDFName.of('Resources'))) as PDFDict | undefined;
  if (!resDict || !(resDict instanceof PDFDict)) {
    resDict = pdfDoc.context.obj({});
    page.node.set(PDFName.of('Resources'), resDict);
  }

  // Ensure ExtGState dict exists
  let extGStateDict = pdfDoc.context.lookup(resDict.get(PDFName.of('ExtGState'))) as PDFDict | undefined;
  if (!extGStateDict || !(extGStateDict instanceof PDFDict)) {
    extGStateDict = pdfDoc.context.obj({});
    resDict.set(PDFName.of('ExtGState'), extGStateDict);
  }

  // Update top-level GS0 opacity if present
  const firstLeaf = leafNodes[0];
  const gs0Ref = extGStateDict.get(PDFName.of('GS0'));
  if (gs0Ref) {
    const gs0 = pdfDoc.context.lookup(gs0Ref);
    if (gs0 instanceof PDFDict && firstLeaf) {
      gs0.set(PDFName.of('ca'), PDFNumber.of(firstLeaf.opacity));
      gs0.set(PDFName.of('CA'), PDFNumber.of(firstLeaf.opacity));
    }
  }

  // Process leaf nodes for transforms and opacity
  for (let i = 0; i < leafNodes.length; i++) {
    const node = leavesByIndex.get(i) ?? leafNodes[i];
    const nodeIndex = leavesByIndex.has(i) ? i : ocgIndexForNode(node) ?? i;

    // 1. Transform Matrix (from the untransformed artwork frame to the node's current placement)
    const frame = aiArtFrame(node) ?? { x: node.ox, y: node.oy, w: node.ow, h: node.oh };
    const t = computePdfTransformMatrix(
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      node.x,
      node.y,
      node.w,
      node.h,
      node.rotation,
      pageH,
    );

    let cm: string | undefined;
    if (!t.isIdentity) {
      hasGeometryEdits = true;
      cm = `${formatPdfNumber(t.a)} ${formatPdfNumber(t.b)} ${formatPdfNumber(t.c)} ${formatPdfNumber(t.d)} ${formatPdfNumber(t.e)} ${formatPdfNumber(t.f)} cm`;
    }

    // 2. Opacity (per-layer GS_L only when the file has no GS0 — otherwise GS0 above carries opacity)
    let gsName: string | undefined;
    if (Math.abs(node.opacity - 1.0) > 1e-3 && !gs0Ref) {
      gsName = `GS_L_${nodeIndex}`;
      const gsDict = pdfDoc.context.obj({
        Type: 'ExtGState',
        ca: node.opacity,
        CA: node.opacity,
      });
      extGStateDict.set(PDFName.of(gsName), pdfDoc.context.register(gsDict));
    }

    if (cm || gsName || ocgIndexForNode(node) !== null) {
      layerPatches.set(nodeIndex, { cm, gsName });
    }
  }

  // 3. Patch Document Catalog OCProperties (OCGs, ON, OFF)
  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as PDFDict;
  const ocPropsRef = catalog.get(PDFName.of('OCProperties'));
  const ocProps = pdfDoc.context.lookup(ocPropsRef);

  if (ocProps instanceof PDFDict) {
    const ocgs = pdfDoc.context.lookup(ocProps.get(PDFName.of('OCGs')));
    if (ocgs instanceof PDFArray) {
      for (let i = 0; i < ocgs.size(); i++) {
        const ocgRef = ocgs.get(i);
        const ocg = pdfDoc.context.lookup(ocgRef);
        const node = leavesByIndex.get(i) ?? leafNodes[i];
        if (ocg instanceof PDFDict && node) {
          // Rename layer in OCG
          ocg.set(PDFName.of('Name'), PDFString.of(node.name));
          if (doc.ai.ocgNames[i] !== undefined) {
            doc.ai.ocgNames[i] = node.name;
          }
        }
      }
    }

    // Patch /D default view config: /ON and /OFF arrays
    const d = pdfDoc.context.lookup(ocProps.get(PDFName.of('D')));
    if (d instanceof PDFDict && ocgs instanceof PDFArray) {
      let onArray = pdfDoc.context.lookup(d.get(PDFName.of('ON')));
      if (!(onArray instanceof PDFArray)) {
        onArray = pdfDoc.context.obj([]);
        d.set(PDFName.of('ON'), onArray);
      }
      let offArray = pdfDoc.context.lookup(d.get(PDFName.of('OFF')));
      if (!(offArray instanceof PDFArray)) {
        offArray = pdfDoc.context.obj([]);
        d.set(PDFName.of('OFF'), offArray);
      }

      for (let i = 0; i < ocgs.size(); i++) {
        const ocgRef = ocgs.get(i);
        const node = leavesByIndex.get(i) ?? leafNodes[i];
        if (!node || !(ocgRef instanceof PDFRef)) continue;

        // Remove from both lists first
        removeRefFromArray(onArray as PDFArray, ocgRef);
        removeRefFromArray(offArray as PDFArray, ocgRef);

        if (node.visible) {
          (onArray as PDFArray).push(ocgRef);
        } else {
          (offArray as PDFArray).push(ocgRef);
        }
      }
    }
  }

  // 4. Patch Adobe Illustrator Layer property dictionaries under /Resources /Properties
  const propsRef = resDict.get(PDFName.of('Properties'));
  const propsDict = pdfDoc.context.lookup(propsRef);
  if (propsDict instanceof PDFDict) {
    for (let i = 0; i < leafNodes.length; i++) {
      const node = leavesByIndex.get(i) ?? leafNodes[i];
      const propVal = propsDict.get(PDFName.of(`MC${i}`));
      const propDict = pdfDoc.context.lookup(propVal);
      if (propDict instanceof PDFDict && node) {
        if (propDict.has(PDFName.of('Title'))) {
          propDict.set(PDFName.of('Title'), PDFString.of(node.name));
        }
        if (propDict.has(PDFName.of('Visible'))) {
          propDict.set(PDFName.of('Visible'), node.visible ? PDFBool.True : PDFBool.False);
        }
      }
    }
  }

  // 5. Patch Content Stream with transforms and opacities
  const contentsRef = page.node.get(PDFName.of('Contents'));
  if (contentsRef) {
    const contentsObj = pdfDoc.context.lookup(contentsRef);
    let originalRaw: Uint8Array | null = null;

    if (contentsObj && 'getContents' in contentsObj) {
      originalRaw = (contentsObj as any).getContents();
    } else if (contentsObj instanceof PDFArray) {
      // Multiple content streams: concatenate decompressed streams
      const parts: Uint8Array[] = [];
      for (let i = 0; i < contentsObj.size(); i++) {
        const stream = pdfDoc.context.lookup(contentsObj.get(i));
        if (stream && 'getContents' in stream) {
          const raw = (stream as any).getContents();
          try {
            parts.push(inflate(raw));
          } catch {
            parts.push(raw);
          }
        }
      }
      if (parts.length > 0) {
        let total = parts.reduce((acc, p) => acc + p.length, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) {
          joined.set(p, offset);
          offset += p.length;
        }
        originalRaw = joined;
      }
    }

    if (originalRaw) {
      let decompressed: Uint8Array;
      try {
        decompressed = inflate(originalRaw);
      } catch {
        decompressed = originalRaw;
      }

      const originalText = new TextDecoder('latin1').decode(decompressed);
      const shapePatch = patchAiShapeColorsInStream(originalText, doc);
      notes.push(...shapePatch.notes);
      const patchedText = patchStreamLayers(shapePatch.text, layerPatches);

      if (patchedText !== originalText) {
        const newStream = pdfDoc.context.flateStream(new TextEncoder().encode(patchedText));
        const newRef = pdfDoc.context.register(newStream);
        page.node.set(PDFName.of('Contents'), newRef);
      }
    }
  }

  // 6. Handle AIPrivateData / PieceInfo when geometry changed
  if (hasGeometryEdits) {
    page.node.delete(PDFName.of('PieceInfo'));
    catalog.delete(PDFName.of('PieceInfo'));
    notes.push(
      'Layer moves, resizing, or rotations were applied to the PDF vector stream. Illustrator AIPrivateData cache was cleared so Illustrator opens the edited layout directly.',
    );
  }

  const savedBytes = await pdfDoc.save({ useObjectStreams: false });
  return {
    bytes: savedBytes.buffer as ArrayBuffer,
    notes,
  };
}

function removeRefFromArray(arr: PDFArray, ref: PDFRef) {
  for (let i = arr.size() - 1; i >= 0; i--) {
    const item = arr.get(i);
    if (item instanceof PDFRef && item.tag === ref.tag) {
      // PDFArray in pdf-lib doesn't have remove(), we reconstruct elements if needed
      // Check if arr.asArray() exists
      const list = arr.asArray();
      const idx = list.findIndex((x) => x instanceof PDFRef && x.tag === ref.tag);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      return;
    }
  }
}

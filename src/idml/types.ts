export interface IdmlSpreadLayout {
  originX: number;
  originY: number;
  width: number;
  height: number;
  offsetY?: number;
  pages?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
}

/** Page-relative doc ↔ spread mapping captured at import (for export). */
export interface IdmlCanvasCtx {
  originX: number;
  originY: number;
  offsetY: number;
}

export interface IdmlNodeMeta {
  self: string;
  tag: string; // 'TextFrame' | 'Rectangle' | 'Oval' | 'Polygon' | 'Group' | etc.
  storyId?: string;
  spreadPath: string;
  itemTransform?: number[]; // [a, b, c, d, tx, ty]
  /** Path bounds in item local space (before ItemTransform). */
  localBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Item path geometry for shape fill repaint (import). */
  pathPoints?: Array<{ anchor: [number, number]; leftDirection?: [number, number]; rightDirection?: [number, number] }>;
  pathOpen?: boolean;
  /** Unrotated frame size in item local space (text). */
  localFrameW?: number;
  localFrameH?: number;
  /** Page `Self` this item belongs to (multi-page import). */
  pageSelf?: string;
  pageIndex?: number;
  /** Text/frame swatch from IDML FillColor when explicitly set. */
  fillColor?: string;
  /** Original IDML FillColor swatch ref (for export patch). */
  fillSwatchRef?: string;
  /** Set when user edits shape fill in Canvas (export patch only). */
  exportFillDirty?: boolean;
  /** Resolved stroke hex (after StrokeTint) for Canvas preview / edits. */
  strokeColor?: string;
  /** StrokeColor swatch ref for export (updated when stroke color is edited). */
  strokeSwatchRef?: string;
  /** Original spread StrokeColor at import (unchanged unless user edits stroke). */
  importStrokeSwatchRef?: string;
  /** Stroke weight in points from spread (preserved on color-only edits). */
  strokeWeight?: number;
  /** Raw StrokeTint from spread (-1 = solid). */
  strokeTint?: number;
  /** Whether the item has a visible stroke on import or after user enable. */
  strokeEnabled?: boolean;
  /** User edited stroke color → patch StrokeColor on export. */
  exportStrokeDirty?: boolean;
  /** User edited stroke weight or enable → patch StrokeWeight / StrokeColor on export. */
  exportStrokeSettingsDirty?: boolean;
  /** Rotation at import (degrees) for export delta checks. */
  importRotation?: number;
  /** Rotation baseline after last successful geometry export. */
  exportRotation?: number;
  /** Parent chain transform in spread space (spread × groups, excluding this item). */
  parentTransform?: number[];
  /** Doc-space origin mapping for this item's page slot. */
  canvasCtx?: IdmlCanvasCtx;
  /** Text frame background only (not glyph color). */
  frameFillColor?: string;
  /** TextFramePreference insets / column width (local points). */
  textFrameLayout?: {
    insetTop: number;
    insetLeft: number;
    insetBottom: number;
    insetRight: number;
    columnWidth?: number;
    verticalJustification?: string;
  };
  /** Resolved paragraph typography from story (first paragraph). */
  storyLeading?: number;
  storyTracking?: number;
  storyJustification?: string;
  /** Typography at import (detect style-only export patches vs content-only). */
  importTextSnapshot?: {
    fontSize: number;
    fontFamily: string;
    colorHex: string;
    bold: boolean;
    italic: boolean;
    justification?: string;
  };
  contentType?: string;
  /** Linked image inside a graphic frame (frame `self` is `IdmlNodeMeta.self`). */
  placedImage?: IdmlPlacedImageMeta;
  rawAttributes?: Record<string, string>;
}

/** Graphic frame + nested `<Image>` link (distinct from frame fill). */
export type IdmlLinkImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'unknown';

export interface IdmlPlacedImageMeta {
  frameSelf: string;
  imageSelf: string;
  linkResourceUri: string;
  packagePath: string;
  imageItemTransform?: number[];
  /** Baseline nested `<Image ItemTransform>` at import (for resize sync). */
  importImageItemTransform?: number[];
  importFrameOw?: number;
  importFrameOh?: number;
  graphicBounds?: { left: number; top: number; right: number; bottom: number };
  fitContentToFrame?: string;
  fittingOnEmptyFrame?: string;
  contentType?: string;
  linkMediaFormat?: IdmlLinkImageFormat;
  importBytesLength?: number;
  missingLink?: boolean;
  replacementBytes?: Uint8Array;
  replacementFormat?: IdmlLinkImageFormat;
  exportLinkDirty?: boolean;
  /** When replacement uses a new Links/ member, patch LinkResourceURI on export. */
  exportLinkUriDirty?: boolean;
  pendingLinkResourceUri?: string;
  pendingPackagePath?: string;
}

export interface IdmlDocBacking {
  readonly kind: 'idml';
  rawZipBytes: ArrayBuffer;
  spreads: Array<{ path: string; xml: string; layout?: IdmlSpreadLayout }>;
  stories: Map<string, string>; // storyId -> xml
  designmapXml?: string;
  graphicXml?: string;
  fontsXml?: string;
  stylesXml?: string;
  pages: Array<{ id: string; width: number; height: number; docY: number; pageSelf?: string; spreadPath?: string }>;
  spreadLayout?: IdmlSpreadLayout;
}

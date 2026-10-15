export interface IdmlSpreadLayout {
  originX: number;
  originY: number;
  width: number;
  height: number;
  offsetY?: number;
  pages?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
}

export interface IdmlNodeMeta {
  self: string;
  tag: string; // 'TextFrame' | 'Rectangle' | 'Oval' | 'Polygon' | 'Group' | etc.
  storyId?: string;
  spreadPath: string;
  itemTransform?: number[]; // [a, b, c, d, tx, ty]
  fillColor?: string;
  strokeColor?: string;
  strokeWeight?: number;
  contentType?: string;
  rawAttributes?: Record<string, string>;
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
  pages: Array<{ id: string; width: number; height: number }>;
  spreadLayout?: IdmlSpreadLayout;
}

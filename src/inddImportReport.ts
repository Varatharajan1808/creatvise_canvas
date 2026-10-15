import type { Doc } from './model';

export interface InddImportReport {
  timestamp: string;
  fileName: string;
  origin: 'indd' | 'idml';
  width: number;
  height: number;
  pageCount?: number;
  layerCount: number;
  spreadCount?: number;
  textCount: number;
  shapeCount: number;
  rasterCount: number;
  groupCount: number;
  warnings: string[];
  timingMs?: number;
}

let _activeInddDoc: Doc | null = null;

export function activeInddDoc(): Doc | null {
  return _activeInddDoc;
}

export function setActiveInddDoc(doc: Doc | null): void {
  _activeInddDoc = doc;
}

export function buildInddImportReport(doc: Doc, meta?: Partial<InddImportReport>): InddImportReport {
  let textCount = 0;
  let shapeCount = 0;
  let rasterCount = 0;
  let groupCount = 0;
  let layerCount = 0;

  function count(nodes: any[]) {
    for (const n of nodes) {
      layerCount++;
      if (n.kind === 'text') textCount++;
      else if (n.kind === 'shape') shapeCount++;
      else if (n.kind === 'raster') rasterCount++;
      else if (n.kind === 'group') groupCount++;
      if (n.children && n.children.length) count(n.children);
    }
  }
  count(doc.roots);

  const report: InddImportReport = {
    timestamp: new Date().toISOString(),
    fileName: doc.name,
    origin: doc.origin ?? (doc.name.endsWith('.idml') ? 'idml' : 'indd'),
    width: doc.width,
    height: doc.height,
    pageCount: doc.idml?.pages?.length ?? 1,
    layerCount,
    spreadCount: doc.idml?.spreads?.length ?? 1,
    textCount,
    shapeCount,
    rasterCount,
    groupCount,
    warnings: [...doc.warnings],
    ...meta,
  };
  return report;
}

export function logInddImportReport(report: InddImportReport): void {
  console.group(`[INDD/IDML Import Report] ${report.fileName}`);
  console.log(`Origin: ${report.origin} | Dimensions: ${report.width}x${report.height}`);
  console.log(
    `Layers: ${report.layerCount} (Text: ${report.textCount}, Shape: ${report.shapeCount}, Raster: ${report.rasterCount}, Group: ${report.groupCount})`,
  );
  if (report.warnings.length) {
    console.warn(`Warnings (${report.warnings.length}):`, report.warnings);
  }
  console.groupEnd();
}

export function downloadBytes(filename: string, bytes: ArrayBuffer | Uint8Array, mime = 'application/octet-stream'): void {
  const blob = new Blob([bytes as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

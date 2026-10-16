/** Detect / encode linked image bytes for IDML Links/ package members. */

import type { IdmlLinkImageFormat } from './types';

export function sniffImageFormat(bytes: Uint8Array | undefined): IdmlLinkImageFormat {
  if (!bytes || bytes.length < 4) return 'unknown';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
  return 'unknown';
}

export function formatFromPackagePath(path: string): IdmlLinkImageFormat {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe') return 'jpeg';
  if (ext === 'png') return 'png';
  if (ext === 'gif') return 'gif';
  if (ext === 'webp') return 'webp';
  return 'unknown';
}

export function packagePathForFormat(baseName: string, format: IdmlLinkImageFormat): string {
  const stem = baseName.replace(/\.[^.]+$/, '') || 'CanvasLink';
  switch (format) {
    case 'jpeg':
      return `Links/${stem}.jpg`;
    case 'png':
      return `Links/${stem}.png`;
    case 'gif':
      return `Links/${stem}.gif`;
    case 'webp':
      return `Links/${stem}.webp`;
    default:
      return `Links/${stem}.png`;
  }
}

export function linkUriFromPackagePath(packagePath: string): string {
  return `file:${packagePath}`;
}

export function mimeToLinkFormat(mime: string | undefined): IdmlLinkImageFormat | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  return null;
}

export async function encodeCanvasToFormat(
  canvas: HTMLCanvasElement,
  format: IdmlLinkImageFormat,
): Promise<Uint8Array> {
  const anyCanvas = canvas as HTMLCanvasElement & { toBuffer?: (mime: string) => Uint8Array };
  if (format === 'jpeg') {
    if (typeof anyCanvas.toBuffer === 'function') {
      return anyCanvas.toBuffer('image/jpeg');
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    if (!dataUrl.startsWith('data:image/jpeg')) {
      throw new Error('JPEG encoding is not supported in this browser.');
    }
    return dataUrlToBytes(dataUrl);
  }
  if (format === 'png') {
    if (typeof anyCanvas.toBuffer === 'function') {
      return anyCanvas.toBuffer('image/png');
    }
    return dataUrlToBytes(canvas.toDataURL('image/png'));
  }
  if (format === 'gif' || format === 'webp') {
    throw new Error(`${format.toUpperCase()} link export is not supported in the browser. Use PNG or JPEG.`);
  }
  throw new Error('Unknown image format for IDML link export.');
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1] ?? '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function resolveReplacementFormat(
  packagePath: string,
  linkMediaFormat: IdmlLinkImageFormat | undefined,
  sourceMime?: string,
): IdmlLinkImageFormat {
  const fromMime = mimeToLinkFormat(sourceMime);
  if (fromMime) return fromMime;
  const fromPath = formatFromPackagePath(packagePath);
  if (fromPath !== 'unknown') return fromPath;
  if (linkMediaFormat && linkMediaFormat !== 'unknown') return linkMediaFormat;
  return 'png';
}

import JSZip from 'jszip';

export const IDML_MIMETYPE = 'application/vnd.adobe.indesign-idml-package';

export async function readIdmlPackage(bytes: ArrayBuffer | Uint8Array): Promise<JSZip> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return await JSZip.loadAsync(buf);
}

export async function writeIdmlPackage(zip: JSZip): Promise<ArrayBuffer> {
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const ordered = ['mimetype', ...names.filter((n) => n !== 'mimetype').sort()];

  const outZip = new JSZip();
  for (const name of ordered) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const data = await entry.async('uint8array');
    const fileOpts = {
      // InDesign IDML packages omit implicit folder entries; extra dirs break open/save fidelity.
      createFolders: false as const,
      ...(name === 'mimetype'
        ? { compression: 'STORE' as const }
        : { compression: 'DEFLATE' as const, compressionOptions: { level: 6 } }),
    };
    outZip.file(name, data, fileOpts);
  }

  const uint8 = await outZip.generateAsync({
    type: 'uint8array',
    platform: 'UNIX',
    streamFiles: false,
  });

  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength) as ArrayBuffer;
}


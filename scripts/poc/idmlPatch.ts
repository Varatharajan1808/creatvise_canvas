/**
 * Phase 0 PoC — minimal IDML read / patch / write (not wired into production app).
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const IDML_MIME = 'application/vnd.adobe.indesign-idml-package';

export interface IdmlPatchResult {
  ok: boolean;
  spreadPath: string;
  elementSelf: string;
  property: 'ItemTransform';
  before: string;
  after: string;
  notes: string[];
}

export interface IdmlStructureCheck {
  ok: boolean;
  errors: string[];
  spreadCount: number;
  mimetype: string;
}

/** Load IDML bytes (ZIP package). */
export async function loadIdmlPackage(bytes: Buffer | ArrayBuffer): Promise<JSZip> {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return JSZip.loadAsync(buf);
}

/** Validate package basics (automated stand-in until InDesign open test). */
export async function validateIdmlStructure(bytes: Buffer): Promise<IdmlStructureCheck> {
  const errors: string[] = [];
  let mimetype = '';
  let spreadCount = 0;
  try {
    const zip = await loadIdmlPackage(bytes);
    const mimeEntry = zip.file('mimetype');
    if (!mimeEntry) errors.push('missing mimetype entry');
    else { 
      mimetype = await mimeEntry.async('string');
      if (mimetype.trim() !== IDML_MIME) errors.push(`mimetype mismatch: "${mimetype.trim()}"`);
    }
    const container = zip.file('META-INF/container.xml');
    if (!container) errors.push('missing META-INF/container.xml');
    const designmap = zip.file('designmap.xml');
    if (!designmap) errors.push('missing designmap.xml');
    else {
      const dm = await designmap.async('string');
      if (!dm.includes('<Document')) errors.push('designmap.xml has no Document root');
    }
    for (const name of Object.keys(zip.files)) {
      if (name.startsWith('Spreads/') && name.endsWith('.xml') && !zip.files[name].dir) spreadCount++;
    }
    if (spreadCount === 0) errors.push('no Spreads/*.xml parts');
  } catch (e) {
    errors.push(`zip parse failed: ${(e as Error).message}`);
  }
  return { ok: errors.length === 0, errors, spreadCount, mimetype };
}

const ITEM_TRANSFORM_RE =
  /(<TextFrame\b[^>]*\bSelf="([^"]+)"[^>]*\bItemTransform=")([^"]+)(")/;

/**
 * Patch the first TextFrame ItemTransform: add `deltaTx` / `deltaTy` to translation (last two matrix values).
 */
export async function patchFirstTextFrameTranslation(
  bytes: Buffer,
  deltaTx = 20,
  deltaTy = 15,
): Promise<{ bytes: Buffer; result: IdmlPatchResult }> {
  const notes: string[] = [];
  const zip = await loadIdmlPackage(bytes);
  const spreadPaths = Object.keys(zip.files)
    .filter((p) => p.startsWith('Spreads/') && p.endsWith('.xml') && !zip.files[p].dir)
    .sort();

  if (spreadPaths.length === 0) {
    return {
      bytes,
      result: {
        ok: false,
        spreadPath: '',
        elementSelf: '',
        property: 'ItemTransform',
        before: '',
        after: '',
        notes: ['no spread xml found'],
      },
    };
  }

  for (const spreadPath of spreadPaths) {
    const xml = await zip.file(spreadPath)!.async('string');
    const m = xml.match(ITEM_TRANSFORM_RE);
    if (!m) continue;

    const before = m[3];
    const parts = before.trim().split(/\s+/).map(Number);
    if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) {
      notes.push(`${spreadPath}: ItemTransform not 6 numbers`);
      continue;
    }
    parts[4] += deltaTx;
    parts[5] += deltaTy;
    const after = parts.map((n) => String(n)).join(' ');
    const patched = xml.replace(ITEM_TRANSFORM_RE, `$1${after}$4`);
    zip.file(spreadPath, patched);
    notes.push(`patched TextFrame Self="${m[2]}" in ${spreadPath}`);

    const out = await writeIdmlZip(zip);
    return {
      bytes: out,
      result: {
        ok: true,
        spreadPath,
        elementSelf: m[2],
        property: 'ItemTransform',
        before,
        after,
        notes,
      },
    };
  }

  return {
    bytes,
    result: {
      ok: false,
      spreadPath: spreadPaths[0] ?? '',
      elementSelf: '',
      property: 'ItemTransform',
      before: '',
      after: '',
      notes: ['no TextFrame ItemTransform found in spreads', ...notes],
    },
  };
}

/** Re-pack ZIP with IDML rules: mimetype first, stored uncompressed. */
export async function writeIdmlZip(zip: JSZip): Promise<Buffer> {
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const ordered = ['mimetype', ...names.filter((n) => n !== 'mimetype').sort()];

  const outZip = new JSZip();
  for (const name of ordered) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const data = await entry.async('nodebuffer');
    if (name === 'mimetype') {
      outZip.file(name, data, { compression: 'STORE' });
    } else {
      outZip.file(name, data, { compression: 'DEFLATE', compressionOptions: { level: 6 } });
    }
  }

  const raw = await outZip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    streamFiles: false,
  });

  if (!raw.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error('generated zip invalid');
  }
  return raw;
}

export function readFixture(relFromRepoRoot: string): Buffer {
  const p = path.join(process.cwd(), relFromRepoRoot);
  if (!fs.existsSync(p)) throw new Error(`fixture missing: ${p}`);
  return fs.readFileSync(p);
}

export function writeArtifact(relFromRepoRoot: string, data: Buffer): string {
  const p = path.join(process.cwd(), relFromRepoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

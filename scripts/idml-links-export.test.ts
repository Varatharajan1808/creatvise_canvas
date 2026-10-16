/**
 * IDML export must preserve Links/ binaries and spread XML for graphic frames unchanged (no-edit).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import { loadImage } from '@napi-rs/canvas';
import { importIdml, exportIdml, createSampleIdml } from '../src/idml';
import { setPlacedImageDecodeHookForTests } from '../src/idml/placedImage';
import { writeIdmlPackage } from '../src/idml/zip';

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

async function buildIdmlWithLink(): Promise<ArrayBuffer> {
  const linkBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // JPEG-ish header
  const spread = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="sp1" PageCount="1">
    <Page Self="pg1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0" />
    <Rectangle Self="fr1" ContentType="GraphicType" ItemTransform="1 0 0 1 50 50">
      <Properties>
        <PathGeometry PathOpen="false">
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType Anchor="0 0" />
              <PathPointType Anchor="200 0" />
              <PathPointType Anchor="200 150" />
              <PathPointType Anchor="0 150" />
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
      <Image Self="im1" ItemTransform="1 0 0 1 0 0">
        <Properties>
          <Link LinkResourceURI="file:Links/photo.jpg" StoredState="Normal" />
        </Properties>
      </Image>
    </Rectangle>
  </Spread>
</idPkg:Spread>`;
  const designmap = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4" Self="d" Length="1">
  <idPkg:Spread src="Spreads/Spread_sp1.xml" />
</Document>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE', createFolders: false });
  zip.file('designmap.xml', designmap, { createFolders: false });
  zip.file('Spreads/Spread_sp1.xml', spread, { createFolders: false });
  zip.file('Links/photo.jpg', linkBytes, { createFolders: false });
  return await writeIdmlPackage(zip);
}

async function main() {
  setPlacedImageDecodeHookForTests(async (bytes) => loadImage(bytes) as unknown as CanvasImageSource);
  const sample = await createSampleIdml();
  const doc = await importIdml('s.idml', sample, 'idml');
  const out = await exportIdml(doc);
  const z1 = await JSZip.loadAsync(out);
  const dirs = Object.keys(z1.files).filter((n) => z1.files[n].dir);
  log('sample-export-no-zip-dirs', dirs.length === 0, String(dirs.length));

  const withLink = await buildIdmlWithLink();
  const doc2 = await importIdml('link.idml', withLink, 'idml');
  const exported = await exportIdml(doc2);
  const zL = await JSZip.loadAsync(exported);
  const linkFile = await zL.file('Links/photo.jpg')?.async('uint8array');
  const spreadXml = await zL.file('Spreads/Spread_sp1.xml')?.async('string');
  log('links-member-kept', Boolean(linkFile && linkFile.length === 8), String(linkFile?.length));
  log('link-uri-kept', Boolean(spreadXml?.includes('LinkResourceURI="file:Links/photo.jpg"')), 'uri');
  log('nested-image-kept', Boolean(spreadXml?.includes('<Image Self="im1"')), 'Image');

  const magPath = path.join('artifacts', 'fixtures', 'free_317277841', 'free_317277841.idml');
  if (fs.existsSync(magPath)) {
    const buf = fs.readFileSync(magPath);
    const magDoc = await importIdml('mag.idml', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'idml');
    const magOut = await exportIdml(magDoc);
    const zA = await JSZip.loadAsync(buf);
    const zB = await JSZip.loadAsync(magOut);
    let changed = 0;
    for (const n of Object.keys(zA.files).filter((k) => !zA.files[k].dir)) {
      const a = await zA.file(n)!.async('uint8array');
      const b = await zB.file(n)!.async('uint8array');
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) changed++;
    }
    log('magazine-no-edit-byte-identical', changed === 0, String(changed));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

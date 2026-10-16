/**
 * IDML placed images: format-preserving replace, fitting metadata, transform sync.
 */
import { Window } from 'happy-dom';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { importIdml, exportIdml } from '../src/idml';
import {
  patchImageLinkResourceUri,
  readNestedImageAttribute,
  readPageItemAttribute,
} from '../src/idml/exportPatch';
import { sniffImageFormat } from '../src/idml/linkImageFormat';
import {
  applyIdmlPlacedImageReplace,
  linkUriToPackagePath,
  setPlacedImageDecodeHookForTests,
} from '../src/idml/placedImage';
import { leaves } from '../src/model';
import { writeIdmlPackage } from '../src/idml/zip';

const RED_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const BLUE_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
);
function createMiniJpeg(): Uint8Array {
  const c = createCanvas(2, 2);
  const g = c.getContext('2d')!;
  g.fillStyle = '#cc0000';
  g.fillRect(0, 0, 2, 2);
  return c.toBuffer('image/jpeg');
}
let MINI_JPEG: Uint8Array;

const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;
(globalThis as unknown as { document: Document }).document = window.document as unknown as Document;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: unknown) => {
  if (tag === 'canvas') return createCanvas(1, 1) as unknown as HTMLElement;
  return origCreate(tag, options as never);
}) as typeof window.document.createElement;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + ' — ' + detail);
};

function spreadXml(opts: {
  second?: boolean;
  missingLink?: boolean;
  withFitting?: boolean;
} = {}) {
  const linkUri = opts.missingLink ? 'file:Links/missing.jpg' : 'file:Links/photo.jpg';
  const imageAttrs = opts.withFitting
    ? ' ItemTransform="1 0 0 1 10 5" FitContentToFrame="Proportionally"'
    : ' ItemTransform="1 0 0 1 0 0"';
  const graphicBounds = opts.withFitting
    ? '<GraphicBounds Left="0" Top="0" Right="120" Bottom="90" />'
    : '';
  const second = opts.second
    ? `
    <Rectangle Self="fr2" ContentType="GraphicType" ItemTransform="1 0 0 1 280 50">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointArray>
          <PathPointType Anchor="0 0" /><PathPointType Anchor="100 0" />
          <PathPointType Anchor="100 80" /><PathPointType Anchor="0 80" />
        </PathPointArray>
      </GeometryPathType></PathGeometry></Properties>
      <Image Self="im2" ItemTransform="1 0 0 1 0 0">
        <Properties>${graphicBounds}<Link LinkResourceURI="file:Links/photo2.png" StoredState="Normal" /></Properties>
      </Image>
    </Rectangle>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" DOMVersion="20.4">
  <Spread Self="sp1" PageCount="1">
    <Page Self="pg1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0" />
    <Rectangle Self="fr1" ContentType="GraphicType" ItemTransform="1 0 0 1 50 50">
      <Properties><PathGeometry><GeometryPathType PathOpen="false">
        <PathPointArray>
          <PathPointType Anchor="0 0" /><PathPointType Anchor="200 0" />
          <PathPointType Anchor="200 150" /><PathPointType Anchor="0 150" />
        </PathPointArray>
      </GeometryPathType></PathGeometry></Properties>
      <Image Self="im1"${imageAttrs}>
        <Properties>${graphicBounds}<Link LinkResourceURI="${linkUri}" StoredState="Normal" /></Properties>
      </Image>
    </Rectangle>${second}
  </Spread>
</idPkg:Spread>`;
}

async function buildFixture(two = false, missing = false, withFitting = false): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', { compression: 'STORE', createFolders: false });
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document xmlns:idPkg="http://schemas.adobe.com/idml/1.0/packaging" Self="d" Length="1"><idPkg:Spread src="Spreads/Spread_sp1.xml"/></Document>',
    { createFolders: false },
  );
  zip.file('Spreads/Spread_sp1.xml', spreadXml({ second: two, missingLink: missing, withFitting }), {
    createFolders: false,
  });
  if (!missing) {
    zip.file('Links/photo.jpg', MINI_JPEG, { createFolders: false });
    if (two) zip.file('Links/photo2.png', BLUE_PNG, { createFolders: false });
  }
  return writeIdmlPackage(zip);
}

async function main() {
  MINI_JPEG = createMiniJpeg();
  setPlacedImageDecodeHookForTests(async (bytes) => loadImage(bytes) as unknown as CanvasImageSource);
  log('link-uri-parse', linkUriToPackagePath('file:Links/photo.jpg') === 'Links/photo.jpg', 'uri');
  log('jpeg-sniff', sniffImageFormat(MINI_JPEG) === 'jpeg', sniffImageFormat(MINI_JPEG));

  const bytes = await buildFixture(false, false, true);
  const doc = await importIdml('placed.idml', bytes, 'idml');
  const fr1 = leaves(doc).find((n) => n.idml?.self === 'fr1')!;

  log('import-kind-raster', fr1.kind === 'raster', fr1.kind);
  log('import-jpeg-format', fr1.idml?.placedImage?.linkMediaFormat === 'jpeg', fr1.idml?.placedImage?.linkMediaFormat ?? '');
  log('graphic-bounds-import', fr1.idml?.placedImage?.graphicBounds?.right === 120, String(fr1.idml?.placedImage?.graphicBounds?.right));
  log('fit-mode-import', fr1.idml?.placedImage?.fitContentToFrame === 'Proportionally', fr1.idml?.placedImage?.fitContentToFrame ?? '');
  log('import-image-transform', fr1.idml?.placedImage?.importImageItemTransform?.[4] === 10, String(fr1.idml?.placedImage?.importImageItemTransform?.[4]));

  fr1.w = fr1.ow + 40;
  fr1.h = fr1.oh + 20;
  const sizedOut = await exportIdml(doc);
  const spSized = await JSZip.loadAsync(sizedOut).then((z) => z.file('Spreads/Spread_sp1.xml')!.async('string'));
  const imgTfAfter = readNestedImageAttribute(spSized, 'im1', 'ItemTransform')!;
  log('resize-updates-image-transform', imgTfAfter !== '1 0 0 1 10 5', imgTfAfter);
  log('graphic-bounds-preserved', spSized.includes('GraphicBounds Left="0"'), 'bounds');

  const noEditDoc = await importIdml('noedit.idml', bytes, 'idml');
  const unchangedLink = await exportIdml(noEditDoc).then(async (out) =>
    JSZip.loadAsync(out).then((z) => z.file('Links/photo.jpg')!.async('uint8array')),
  );
  log(
    'unchanged-link-bytes',
    unchangedLink.length === MINI_JPEG.length && unchangedLink.every((b, i) => b === MINI_JPEG[i]),
    String(unchangedLink.length),
  );

  const jpegCanvas = createCanvas(4, 4);
  jpegCanvas.getContext('2d')!.fillStyle = '#00ff00';
  jpegCanvas.getContext('2d')!.fillRect(0, 0, 4, 4);
  await applyIdmlPlacedImageReplace(fr1, jpegCanvas as unknown as HTMLCanvasElement, { sourceMime: 'image/jpeg' });
  const jpegOut = await exportIdml(doc);
  const jpegLink = await JSZip.loadAsync(jpegOut).then((z) => z.file('Links/photo.jpg')!.async('uint8array'));
  log('jpeg-replace-magic', jpegLink[0] === 0xff && jpegLink[1] === 0xd8, `${jpegLink[0]},${jpegLink[1]}`);
  log('jpeg-replace-sniff', sniffImageFormat(jpegLink) === 'jpeg', sniffImageFormat(jpegLink));
  const jpegSpread = await JSZip.loadAsync(jpegOut).then((z) => z.file('Spreads/Spread_sp1.xml')!.async('string'));
  log('jpeg-uri-kept', jpegSpread.includes('Links/photo.jpg'), 'uri');

  const reDoc = await importIdml('reimport.idml', jpegOut, 'idml');
  const reFr = leaves(reDoc).find((n) => n.idml?.self === 'fr1')!;
  log('reimport-raster-kind', reFr.kind === 'raster', reFr.kind);
  log('reimport-fit-mode', reFr.idml?.placedImage?.fitContentToFrame === 'Proportionally', reFr.idml?.placedImage?.fitContentToFrame ?? '');
  const reLink = await JSZip.loadAsync(jpegOut).then((z) => z.file('Links/photo.jpg')!.async('uint8array'));
  log('reimport-jpeg-bytes', sniffImageFormat(reLink) === 'jpeg' && reLink[0] === 0xff, sniffImageFormat(reLink));

  const twoBytes = await buildFixture(true);
  const doc2 = await importIdml('two.idml', twoBytes, 'idml');
  const fr2 = leaves(doc2).find((n) => n.idml?.self === 'fr2')!;
  const pngCanvas = createCanvas(3, 3);
  pngCanvas.getContext('2d')!.fillStyle = '#ff0000';
  pngCanvas.getContext('2d')!.fillRect(0, 0, 3, 3);
  await applyIdmlPlacedImageReplace(fr2, pngCanvas as unknown as HTMLCanvasElement, { sourceMime: 'image/png' });
  const twoOut = await exportIdml(doc2);
  const z2 = await JSZip.loadAsync(twoOut);
  const pngLink = await z2.file('Links/photo2.png')!.async('uint8array');
  log('png-replace-sniff', sniffImageFormat(pngLink) === 'png', sniffImageFormat(pngLink));
  const jpgUntouched = await z2.file('Links/photo.jpg')!.async('uint8array');
  log('independent-jpeg-untouched', jpgUntouched.every((b, i) => b === MINI_JPEG[i]), String(jpgUntouched.length));

  let patched = patchImageLinkResourceUri(spSized, 'im1', 'file:Links/photo.jpg');
  log('link-uri-patch-helper', patched.includes('LinkResourceURI="file:Links/photo.jpg"'), 'ok');

  const missDoc = await importIdml('miss.idml', await buildFixture(false, true), 'idml');
  const missFr = leaves(missDoc).find((n) => n.idml?.self === 'fr1')!;
  log('missing-link-flag', missFr.idml?.placedImage?.missingLink === true, String(missFr.idml?.placedImage?.missingLink));

  fr1.rotation = 20;
  const rotOut = await exportIdml(doc);
  const rotTf = readPageItemAttribute(
    await JSZip.loadAsync(rotOut).then((z) => z.file('Spreads/Spread_sp1.xml')!.async('string')),
    'fr1',
    'ItemTransform',
  )!;
  log('rotate-frame-export', rotTf.split(' ').length === 6, rotTf);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

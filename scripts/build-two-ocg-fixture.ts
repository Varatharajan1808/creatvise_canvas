/**
 * Writes public/fixtures/ai/two-ocg-layers.ai — synthetic 2-OCG / 2-MC PDF for reorder tests.
 */
import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFName, PDFString, PDFBool } from 'pdf-lib';

const outPath = path.join('public', 'fixtures', 'ai', 'two-ocg-layers.ai');

/** Path fills (not `re` rectangles) so shape promotion leaves raster OCG layers for reorder tests. */
const streamBody =
  '/OC /MC0 BDC\n' +
  'q\n' +
  '1 0 0 rg\n' +
  '0 0 m 200 0 l 200 200 l 0 200 h f\n' +
  'Q\n' +
  'EMC\n' +
  '/OC /MC1 BDC\n' +
  'q\n' +
  '0 0 1 rg\n' +
  '0 100 m 200 100 l 200 200 l 0 200 h f\n' +
  'Q\n' +
  'EMC\n';

async function main() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);

  const ocgBottom = pdfDoc.context.obj({ Type: 'OCG', Name: PDFString.of('Bottom') });
  const ocgTop = pdfDoc.context.obj({ Type: 'OCG', Name: PDFString.of('Top') });
  const refBottom = pdfDoc.context.register(ocgBottom);
  const refTop = pdfDoc.context.register(ocgTop);

  const ocProps = pdfDoc.context.obj({
    OCGs: [refBottom, refTop],
    D: {
      Name: PDFString.of('Default'),
      Order: [refBottom, refTop],
      ON: [refBottom, refTop],
      OFF: [],
      RBGroups: [],
    },
  });
  const ocPropsRef = pdfDoc.context.register(ocProps);

  const catalog = pdfDoc.context.lookup(pdfDoc.catalog) as import('pdf-lib').PDFDict;
  catalog.set(PDFName.of('OCProperties'), ocPropsRef);

  const contentsStream = pdfDoc.context.flateStream(new TextEncoder().encode(streamBody));
  const contentsRef = pdfDoc.context.register(contentsStream);

  const resources = pdfDoc.context.obj({
    Properties: {
      MC0: refBottom,
      MC1: refTop,
    },
  });

  page.node.set(PDFName.of('Contents'), contentsRef);
  page.node.set(PDFName.of('Resources'), resources);

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(bytes));
  console.log(`Wrote ${outPath} (${bytes.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

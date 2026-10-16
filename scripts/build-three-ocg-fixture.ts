/**
 * Writes public/fixtures/ai/three-ocg-layers.ai — synthetic 3-OCG / 3-MC PDF for OCG Order spike.
 */
import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const outPath = path.join('public', 'fixtures', 'ai', 'three-ocg-layers.ai');

const streamBody =
  '/OC /MC0 BDC\n' +
  'q\n' +
  '1 0 0 rg\n' +
  '0 0 m 80 0 l 80 80 l 0 80 h f\n' +
  'Q\n' +
  'EMC\n' +
  '/OC /MC1 BDC\n' +
  'q\n' +
  '0 1 0 rg\n' +
  '20 20 m 100 20 l 100 100 l 20 100 h f\n' +
  'Q\n' +
  'EMC\n' +
  '/OC /MC2 BDC\n' +
  'q\n' +
  '0 0 1 rg\n' +
  '40 40 m 120 40 l 120 120 l 40 120 h f\n' +
  'Q\n' +
  'EMC\n';

async function main() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([160, 160]);

  const ocgA = pdfDoc.context.obj({ Type: 'OCG', Name: PDFString.of('RedSquare') });
  const ocgB = pdfDoc.context.obj({ Type: 'OCG', Name: PDFString.of('GreenSquare') });
  const ocgC = pdfDoc.context.obj({ Type: 'OCG', Name: PDFString.of('BlueSquare') });
  const refA = pdfDoc.context.register(ocgA);
  const refB = pdfDoc.context.register(ocgB);
  const refC = pdfDoc.context.register(ocgC);

  const ocProps = pdfDoc.context.obj({
    OCGs: [refA, refB, refC],
    D: {
      Name: PDFString.of('Default'),
      Order: [refA, refB, refC],
      ON: [refA, refB, refC],
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
      MC0: refA,
      MC1: refB,
      MC2: refC,
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

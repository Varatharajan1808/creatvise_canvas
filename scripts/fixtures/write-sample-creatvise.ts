/**
 * Generate sample-creatvise.idml fixture for test consumption.
 * Writes to artifacts/fixtures/sample-creatvise.idml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { createSampleIdml } from '../../src/idml';

// Provide DOMParser for the idml module
const window = new Window();
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  window.DOMParser as unknown as typeof DOMParser;

async function main() {
  const bytes = await createSampleIdml();
  const outPath = path.join(process.cwd(), 'artifacts', 'fixtures', 'sample-creatvise.idml');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(bytes));
  console.log(`OK: wrote sample-creatvise.idml (${bytes.byteLength} bytes) → ${outPath}`);
}

main().catch((e) => {
  console.error('FAIL: write-sample-creatvise', e);
  process.exit(1);
});

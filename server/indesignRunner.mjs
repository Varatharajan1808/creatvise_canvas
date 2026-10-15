import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { discoverIndesign } from './indesignDiscover.mjs';

export async function runConversion(action, inputBytes) {
  const install = discoverIndesign();
  if (!install.installed) {
    throw new Error('Adobe InDesign is not installed or available on this machine.');
  }

  const tmpDir = path.join(os.tmpdir(), 'creatvise-conversion-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    if (action === 'indd-to-idml') {
      const inddPath = path.join(tmpDir, 'input.indd');
      const idmlPath = path.join(tmpDir, 'output.idml');
      fs.writeFileSync(inddPath, Buffer.from(inputBytes));

      const scriptContent = `
        var doc = app.open(File("${inddPath.replace(/\\/g, '/')}"));
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File("${idmlPath.replace(/\\/g, '/')}"));
        doc.close(SaveOptions.NO);
      `;
      const scriptPath = path.join(tmpDir, 'convert.jsx');
      fs.writeFileSync(scriptPath, scriptContent);

      execSync(`"${install.path}" "${scriptPath}"`, { timeout: 120_000, stdio: 'pipe' });

      if (!fs.existsSync(idmlPath)) {
        throw new Error('IDML output file was not produced by InDesign.');
      }
      return fs.readFileSync(idmlPath);
    } else if (action === 'idml-to-indd') {
      const idmlPath = path.join(tmpDir, 'input.idml');
      const inddPath = path.join(tmpDir, 'output.indd');
      fs.writeFileSync(idmlPath, Buffer.from(inputBytes));

      const scriptContent = `
        var doc = app.open(File("${idmlPath.replace(/\\/g, '/')}"));
        doc.save(File("${inddPath.replace(/\\/g, '/')}"));
        doc.close(SaveOptions.NO);
      `;
      const scriptPath = path.join(tmpDir, 'convert.jsx');
      fs.writeFileSync(scriptPath, scriptContent);

      execSync(`"${install.path}" "${scriptPath}"`, { timeout: 120_000, stdio: 'pipe' });

      if (!fs.existsSync(inddPath)) {
        throw new Error('INDD output file was not produced by InDesign.');
      }
      return fs.readFileSync(inddPath);
    } else {
      throw new Error(`Unsupported conversion action: ${action}`);
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

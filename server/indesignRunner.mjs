import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverIndesign } from './indesignDiscover.mjs';
import { runIndesignScript } from './runIndesignExtendScript.mjs';

function jsxPathLiteral(filePath) {
  return filePath.replace(/\\/g, '/');
}

function writeConversionScript(tmpDir, action, paths) {
  const lines = [
    'app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;',
  ];
  if (action === 'indd-to-idml') {
    lines.push(
      `var doc = app.open(File("${jsxPathLiteral(paths.input)}"), false);`,
      'try {',
      `  doc.exportFile(ExportFormat.INDESIGN_MARKUP, File("${jsxPathLiteral(paths.output)}"));`,
      '} finally {',
      '  doc.close(SaveOptions.NO);',
      '}',
    );
  } else if (action === 'idml-to-indd') {
    lines.push(
      `var doc = app.open(File("${jsxPathLiteral(paths.input)}"), false);`,
      'try {',
      `  doc.save(File("${jsxPathLiteral(paths.output)}"));`,
      '} finally {',
      '  doc.close(SaveOptions.NO);',
      '}',
    );
  } else {
    throw new Error(`Unsupported conversion action: ${action}`);
  }
  const scriptPath = path.join(tmpDir, 'convert.jsx');
  fs.writeFileSync(scriptPath, lines.join('\n'), 'utf8');
  return scriptPath;
}

export async function runConversion(action, inputBytes) {
  const install = discoverIndesign();
  if (!install.canConvert || !install.path) {
    const detail =
      install.diagnostics?.join(' ') ||
      'Set INDESIGN_PATH to the full path of InDesign.exe and restart the conversion server.';
    throw new Error(`Conversion unavailable: ${detail}`);
  }

  const tmpDir = path.join(os.tmpdir(), 'creatvise-conversion-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    if (action === 'indd-to-idml') {
      const inddPath = path.join(tmpDir, 'input.indd');
      const idmlPath = path.join(tmpDir, 'output.idml');
      fs.writeFileSync(inddPath, Buffer.from(inputBytes));

      const scriptPath = writeConversionScript(tmpDir, action, { input: inddPath, output: idmlPath });
      runIndesignScript(install.path, scriptPath, tmpDir);

      if (!fs.existsSync(idmlPath)) {
        const launchLog = path.join(tmpDir, 'convert-launch.log');
        const logHint = fs.existsSync(launchLog)
          ? fs.readFileSync(launchLog, 'utf8').trim()
          : 'No launch log written.';
        throw new Error(`IDML output file was not produced by InDesign. ${logHint}`);
      }
      return fs.readFileSync(idmlPath);
    }

    if (action === 'idml-to-indd') {
      const idmlPath = path.join(tmpDir, 'input.idml');
      const inddPath = path.join(tmpDir, 'output.indd');
      fs.writeFileSync(idmlPath, Buffer.from(inputBytes));

      const scriptPath = writeConversionScript(tmpDir, action, { input: idmlPath, output: inddPath });
      runIndesignScript(install.path, scriptPath, tmpDir);

      if (!fs.existsSync(inddPath)) {
        const launchLog = path.join(tmpDir, 'convert-launch.log');
        const logHint = fs.existsSync(launchLog)
          ? fs.readFileSync(launchLog, 'utf8').trim()
          : 'No launch log written.';
        throw new Error(`INDD output file was not produced by InDesign. ${logHint}`);
      }
      return fs.readFileSync(inddPath);
    }

    throw new Error(`Unsupported conversion action: ${action}`);
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith('Conversion unavailable')) {
      throw e;
    }
    throw e;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* keep tmpDir on failure for debugging when rm fails */
    }
  }
}

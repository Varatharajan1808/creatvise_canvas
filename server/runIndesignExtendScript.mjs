import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** ExtendScript language id for app.DoScript (ScriptLanguage.JAVASCRIPT). */
export const INDESIGN_SCRIPT_LANGUAGE_JAVASCRIPT = 1246973031;

export function progIdsFromExe(exePath) {
  const defaults = [
    'InDesign.Application.2026',
    'InDesign.Application.2025',
    'InDesign.Application.2024',
    'InDesign.Application',
  ];
  if (!exePath) return defaults;
  const folder = path.basename(path.dirname(exePath));
  const match = folder.match(/InDesign\s+(\d{4})/i);
  if (!match) return defaults;
  const versioned = `InDesign.Application.${match[1]}`;
  return [versioned, ...defaults.filter((id) => id !== versioned)];
}

export function buildWindowsDoScriptVbs(jsxAbsolutePath, progIds) {
  const scriptPathLiteral = jsxAbsolutePath.replace(/"/g, '""');
  const idList = progIds.map((id) => `"${id.replace(/"/g, '""')}"`).join(', ');
  return `Option Explicit
Dim app, ids, i, scriptPath
scriptPath = "${scriptPathLiteral}"
ids = Array(${idList})
Set app = Nothing
For i = 0 To UBound(ids)
  On Error Resume Next
  Err.Clear
  Set app = CreateObject(ids(i))
  If Err.Number = 0 Then Exit For
  Set app = Nothing
Next
On Error Goto 0
If app Is Nothing Then
  WScript.StdErr.WriteLine "InDesign COM failed: no InDesign.Application ProgID registered (tried: " & Join(ids, ", ") & ")"
  WScript.Quit 2
End If
On Error Resume Next
app.DoScript scriptPath, ${INDESIGN_SCRIPT_LANGUAGE_JAVASCRIPT}
If Err.Number <> 0 Then
  WScript.StdErr.WriteLine "DoScript failed (" & Err.Number & "): " & Err.Description
  WScript.Quit 1
End If
WScript.StdOut.WriteLine "DoScript OK"
WScript.Quit 0
`;
}

function formatLaunchFailure(jsxPath, launchLogPath, errDetail) {
  const parts = [`ExtendScript launch failed for ${jsxPath}`, errDetail];
  if (fs.existsSync(launchLogPath)) {
    parts.push(`Launch log (${launchLogPath}):\n${fs.readFileSync(launchLogPath, 'utf8').trim()}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Run a .jsx through InDesign (COM DoScript on Windows, AppleScript on macOS).
 * Passing .jsx to InDesign.exe opens it as a document; that is not supported.
 */
export function runIndesignScript(exePath, jsxPath, outDir) {
  const jsx = path.resolve(jsxPath);
  if (!fs.existsSync(jsx)) {
    throw new Error(`jsx missing: ${jsx}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const slug = path.basename(jsx, '.jsx');
  const launchLogPath = path.join(outDir, `${slug}-launch.log`);

  if (process.platform === 'win32') {
    const vbsPath = path.join(outDir, `_launch-${slug}.vbs`);
    const vbs = buildWindowsDoScriptVbs(jsx, progIdsFromExe(exePath));
    fs.writeFileSync(vbsPath, vbs, 'utf8');
    fs.writeFileSync(launchLogPath, `Launcher: cscript //nologo ${vbsPath}\nJSX: ${jsx}\n`, 'utf8');

    try {
      const stdout = execSync(`cscript //nologo "${vbsPath}"`, {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fs.appendFileSync(launchLogPath, stdout);
    } catch (e) {
      const err = e;
      const detail = [err.message, err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n');
      fs.appendFileSync(launchLogPath, `\n${detail}\n`);
      throw new Error(formatLaunchFailure(jsx, launchLogPath, detail));
    }
    return { launchLogPath };
  }

  if (process.platform === 'darwin') {
    const jsxPosix = jsx.replace(/\\/g, '/');
    fs.writeFileSync(launchLogPath, `Launcher: osascript do script\nJSX: ${jsx}\n`, 'utf8');
    try {
      const cmd = `osascript -e 'tell application "Adobe InDesign" to do script POSIX file "${jsxPosix.replace(/'/g, "'\\''")}" language javascript'`;
      const stdout = execSync(cmd, {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fs.appendFileSync(launchLogPath, stdout);
    } catch (e) {
      const err = e;
      const detail = [err.message, err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n');
      fs.appendFileSync(launchLogPath, `\n${detail}\n`);
      throw new Error(formatLaunchFailure(jsx, launchLogPath, detail));
    }
    return { launchLogPath };
  }

  throw new Error(`ExtendScript launch is not implemented for platform: ${process.platform}`);
}

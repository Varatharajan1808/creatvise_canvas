import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Result of InDesign discovery.
 * `installed` is true when EITHER exe path is found OR COM is available.
 * `exePath` and `comAvailable` are reported independently.
 */

/**
 * True when `configuredPath` exists and looks like an InDesign install target.
 */
function isValidIndesignExecutable(configuredPath) {
  if (process.platform === 'win32') {
    try {
      return fs.statSync(configuredPath).isFile() && /^InDesign\.exe$/i.test(path.basename(configuredPath));
    } catch {
      return false;
    }
  }
  if (process.platform === 'darwin') {
    return /Adobe InDesign/i.test(configuredPath) && fs.existsSync(configuredPath);
  }
  try {
    return fs.statSync(configuredPath).isFile();
  } catch {
    return false;
  }
}

function findIndesignExeUnderDir(dir) {
  if (!fs.existsSync(dir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hits = [];
  for (const name of entries) {
    if (!/Adobe InDesign/i.test(name)) continue;
    const exe = path.join(dir, name, 'InDesign.exe');
    if (fs.existsSync(exe)) hits.push({ exePath: exe, versionFolder: name });
  }
  hits.sort((a, b) => b.versionFolder.localeCompare(a.versionFolder));
  return hits[0] ?? null;
}

/**
 * Scan standard install locations and PATH. Returns { exePath, versionFolder } or null.
 */
function findExePathAutomatic() {
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Adobe') : null,
    ].filter(Boolean);

    for (const root of roots) {
      const direct = findIndesignExeUnderDir(root);
      if (direct) return direct;
      const nested = findIndesignExeUnderDir(path.join(root, 'Adobe'));
      if (nested) return nested;
    }

    try {
      const where = execSync('where.exe InDesign.exe', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const first = where.split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) {
        return { exePath: first, versionFolder: path.basename(path.dirname(first)) };
      }
    } catch {
      /* not on PATH */
    }

    return null;
  } else if (process.platform === 'darwin') {
    const appDir = '/Applications';
    if (fs.existsSync(appDir)) {
      try {
        const apps = fs.readdirSync(appDir).filter((a) => /Adobe InDesign/i.test(a));
        if (apps.length > 0) {
          return { exePath: path.join(appDir, apps[0]), versionFolder: apps[0] };
        }
      } catch {}
    }
    return null;
  }

  return null;
}

/**
 * Attempt to find InDesign executable on disk.
 * Returns { exePath, versionFolder, configuredPathIssue? } or null.
 */
function findExePath() {
  let configuredPathIssue = null;
  const configured = process.env.INDESIGN_PATH?.trim();
  if (configured) {
    if (!fs.existsSync(configured)) {
      configuredPathIssue =
        `INDESIGN_PATH is set but the path does not exist: ${configured}. Verify the path and that InDesign is installed.`;
    } else if (!isValidIndesignExecutable(configured)) {
      configuredPathIssue =
        `INDESIGN_PATH is set but does not point to a valid InDesign executable: ${configured}. Set INDESIGN_PATH to the full path of InDesign.exe.`;
    } else {
      return {
        exePath: configured,
        versionFolder: path.basename(path.dirname(configured)),
      };
    }
  }

  const automatic = findExePathAutomatic();
  if (automatic) {
    return configuredPathIssue ? { ...automatic, configuredPathIssue } : automatic;
  }
  if (configuredPathIssue) {
    return { exePath: null, versionFolder: null, configuredPathIssue };
  }
  return null;
}

/**
 * Attempt COM probe on Windows. Returns { ok, version?, error? }.
 */
function probeComAvailability() {
  if (process.platform !== 'win32') {
    return { ok: false, version: null, error: 'COM is only available on Windows.' };
  }

  const psScript = [
    '$ids = @(',
    "  'InDesign.Application.2026',",
    "  'InDesign.Application.2025',",
    "  'InDesign.Application.2024',",
    "  'InDesign.Application'",
    ')',
    'foreach ($id in $ids) {',
    '  try {',
    '    $app = New-Object -ComObject $id',
    '    $v = $app.Version',
    '    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)',
    '    Write-Output "OK|$id|$v"',
    '    exit 0',
    '  } catch {',
    '    $err = $_.Exception.Message',
    '  }',
    '}',
    'Write-Output "FAIL|$err"',
    'exit 1',
  ].join('\n');

  const probeDir = path.join(process.cwd(), 'artifacts', 'poc');
  fs.mkdirSync(probeDir, { recursive: true });
  const psPath = path.join(probeDir, '_probe-indesign-com.ps1');
  fs.writeFileSync(psPath, psScript, 'utf8');

  try {
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
    if (out.startsWith('OK|')) {
      const parts = out.split('|');
      return { ok: true, version: parts[2] || null, error: null };
    }
    return { ok: false, version: null, error: out.replace(/^FAIL\|/, '') || 'COM class not registered' };
  } catch (e) {
    const err = e;
    const out = (err.stdout ?? '').trim();
    if (out.startsWith('FAIL|')) {
      return { ok: false, version: null, error: out.replace(/^FAIL\|/, '') || 'COM class not registered' };
    }
    return { ok: false, version: null, error: err.message ?? 'COM probe failed' };
  }
}

/**
 * Full InDesign discovery. Returns combined status with independent exe and COM checks.
 */
export function discoverIndesign() {
  const exeResult = findExePath();
  const comResult = probeComAvailability();

  const exePath = exeResult?.exePath ?? null;
  const versionFolder = exeResult?.versionFolder ?? null;
  const configuredPathIssue = exeResult?.configuredPathIssue ?? null;

  // Version: prefer COM-reported version (e.g. "21.6.0.57"), fallback to folder name
  const version = comResult.version || versionFolder || null;

  // installed is true if either exe path or COM is available
  const installed = Boolean(exePath) || comResult.ok;

  // Determine if conversion can run (requires exe path for the runner)
  const canConvert = Boolean(exePath);

  // Build diagnostic detail
  const diagnostics = [];
  if (configuredPathIssue) {
    diagnostics.push(configuredPathIssue);
  }
  if (exePath) {
    diagnostics.push(`Executable: ${exePath}`);
  } else {
    diagnostics.push('Executable path not detected automatically.');
  }
  if (comResult.ok) {
    diagnostics.push(`COM available (version ${comResult.version ?? 'unknown'})`);
  } else {
    diagnostics.push(`COM unavailable: ${comResult.error ?? 'unknown'}`);
  }
  if (installed && !canConvert) {
    diagnostics.push('InDesign is installed (COM works) but the executable path was not found.');
    diagnostics.push('Conversion requires the executable path. Set the INDESIGN_PATH environment variable or install to a standard location.');
  }

  return {
    installed,
    path: exePath,
    version,
    comAvailable: comResult.ok,
    comVersion: comResult.version,
    canConvert,
    diagnostics,
  };
}

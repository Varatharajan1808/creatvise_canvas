import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface IndesignInstall {
  exe: string;
  versionFolder: string;
}

/** Best-effort locate Adobe InDesign on Windows (PoC-B only). */
export function findIndesignWindows(): IndesignInstall | null {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Adobe'),
  ].filter(Boolean) as string[];

  const hits: IndesignInstall[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/Adobe InDesign/i.test(name)) continue;
      const exe = path.join(root, name, 'InDesign.exe');
      if (fs.existsSync(exe)) hits.push({ exe, versionFolder: name });
    }
  }

  if (hits.length === 0) {
    try {
      const where = execSync('where.exe InDesign.exe', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const first = where.split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) {
        hits.push({ exe: first, versionFolder: path.basename(path.dirname(first)) });
      }
    } catch {
      /* not on PATH */
    }
  }

  hits.sort((a, b) => b.versionFolder.localeCompare(a.versionFolder));
  return hits[0] ?? null;
}

export function tryIndesignCom(): { ok: boolean; version?: string; error?: string } {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'COM probe only implemented on win32' };
  }
  const scriptPath = path.join(process.cwd(), 'artifacts', 'poc', '_probe-indesign-com.ps1');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      '$ids = @(',
      "  'InDesign.Application',",
      "  'InDesign.Application.2025',",
      "  'InDesign.Application.2024'",
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
    ].join('\n'),
    'utf8',
  );
  try {
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (out.startsWith('OK|')) {
      const parts = out.split('|');
      return { ok: true, version: parts[2] };
    }
    return { ok: false, error: out.replace(/^FAIL\|/, '') || 'InDesign COM class not registered' };
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    const out = (err.stdout ?? '').trim();
    if (out.startsWith('FAIL|')) {
      return { ok: false, error: out.replace(/^FAIL\|/, '') || 'InDesign COM class not registered' };
    }
    return { ok: false, error: err.message ?? 'InDesign COM probe failed' };
  }
}

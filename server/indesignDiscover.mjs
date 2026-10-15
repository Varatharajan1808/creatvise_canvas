import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function discoverIndesign() {
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Adobe'),
    ].filter(Boolean);

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!/Adobe InDesign/i.test(name)) continue;
        const exe = path.join(root, name, 'InDesign.exe');
        if (fs.existsSync(exe)) {
          return { installed: true, path: exe, version: name };
        }
      }
    }

    try {
      const where = execSync('where.exe InDesign.exe', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const first = where.split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) {
        return { installed: true, path: first, version: path.basename(path.dirname(first)) };
      }
    } catch {
      /* not on PATH */
    }

    return { installed: false, path: null, version: null };
  } else if (process.platform === 'darwin') {
    const appDir = '/Applications';
    if (fs.existsSync(appDir)) {
      try {
        const apps = fs.readdirSync(appDir).filter((a) => /Adobe InDesign/i.test(a));
        if (apps.length > 0) {
          return { installed: true, path: path.join(appDir, apps[0]), version: apps[0] };
        }
      } catch {}
    }
    return { installed: false, path: null, version: null };
  }

  return { installed: false, path: null, version: null };
}

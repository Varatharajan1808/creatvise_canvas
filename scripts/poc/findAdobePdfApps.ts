import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface AdobeAppInstall {
  exe: string;
  label: string;
}

function collectFromProgramFiles(pattern: RegExp, exeName: string): AdobeAppInstall[] {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  const hits: AdobeAppInstall[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!pattern.test(name)) continue;
      const candidates = [
        path.join(root, name, exeName),
        path.join(root, name, 'Support Files', 'Contents', 'Windows', exeName),
      ];
      for (const exe of candidates) {
        if (fs.existsSync(exe)) hits.push({ exe, label: name });
      }
    }
  }
  return hits;
}

/** Best-effort locate Illustrator / Acrobat on Windows (PoC reporting only). */
export function findIllustratorWindows(): AdobeAppInstall | null {
  const hits = collectFromProgramFiles(/Adobe Illustrator/i, 'Illustrator.exe');
  return hits[0] ?? null;
}

export function findAcrobatWindows(): AdobeAppInstall | null {
  const hits = collectFromProgramFiles(/Adobe Acrobat/i, 'Acrobat.exe');
  if (hits.length > 0) return hits[0]!;
  try {
    const where = execSync('where.exe Acrobat.exe', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const first = where.split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return { exe: first, label: 'Acrobat (PATH)' };
  } catch {
    /* not on PATH */
  }
  return null;
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load INDESIGN_PATH from project `.env` when not already set in the process environment.
 * Does not override existing environment variables (shell / IDE wins).
 */
export function loadIndesignEnv(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const candidates = [
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local'),
  ];

  if (options.includeRepoRoot !== false) {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const repoRoot = path.resolve(here, '..');
      candidates.push(path.join(repoRoot, '.env'), path.join(repoRoot, '.env.local'));
    } catch {
      /* ignore */
    }
  }

  const seen = new Set();
  for (const envPath of candidates) {
    const key = path.resolve(envPath);
    if (seen.has(key) || !fs.existsSync(envPath)) continue;
    seen.add(key);
    parseEnvFile(envPath);
  }
}

function parseEnvFile(envPath) {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (process.env[name] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

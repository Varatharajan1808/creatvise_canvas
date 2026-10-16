import { formatFromFileName } from './formatCaps';

export type FolderImportFormat = 'psd' | 'ai';
export type FolderImportSource = 'directory-picker' | 'webkitdirectory';

export interface FolderDiscoveredFile {
  file: File;
  /** Path inside the selected folder (may include subfolders). */
  relativePath: string;
  format: FolderImportFormat;
}

export interface FolderSkippedFile {
  relativePath: string;
  name: string;
  reason: string;
}

export interface FolderCollectionMeta {
  directoriesScanned: number;
  readErrors: Array<{ path: string; message: string }>;
}

export interface FolderScanDiagnostics {
  source: FolderImportSource;
  directoriesScanned: number;
  readErrors: Array<{ path: string; message: string }>;
  hiddenDotfiles: number;
}

export interface FolderScanResult {
  folderName: string;
  importable: FolderDiscoveredFile[];
  skipped: FolderSkippedFile[];
  totalScanned: number;
  diagnostics: FolderScanDiagnostics;
}

/** Relative path keyed by `File` (picker `File`s often have a read-only empty `webkitRelativePath`). */
const fileRelativePath = new WeakMap<File, string>();

export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function basenameFromRelativePath(relativePath: string): string {
  const normalized = normalizeRelPath(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function attachRelativePathToFile(file: File, relativePath: string): void {
  const normalized = normalizeRelPath(relativePath);
  fileRelativePath.set(file, normalized);
  try {
    Object.defineProperty(file, 'webkitRelativePath', { value: normalized, configurable: true });
  } catch {
    /* keep WeakMap entry */
  }
}

export function relativePathFromFile(file: File, folderName: string): string {
  const mapped = fileRelativePath.get(file);
  if (mapped) return mapped;
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel) return normalizeRelPath(rel);
  return normalizeRelPath(`${folderName}/${file.name}`);
}

/** Path shown in UI: strip leading folder segment when present (matches webkitdirectory layout). */
export function displayRelativePath(relativePath: string, folderName: string): string {
  const norm = normalizeRelPath(relativePath);
  const prefix = `${normalizeRelPath(folderName)}/`;
  if (norm.startsWith(prefix)) return norm.slice(prefix.length);
  return norm;
}

export function classifyRelativePath(relativePath: string): FolderImportFormat | null {
  const base = basenameFromRelativePath(relativePath).trim();
  const format = formatFromFileName(base);
  if (format === 'psd' || format === 'ai') return format;
  return null;
}

export function rootFolderNameFromFileList(files: File[]): string {
  if (files.length === 0) return 'Selected Folder';
  const rel = relativePathFromFile(files[0], 'Selected Folder');
  const parts = normalizeRelPath(rel).split('/').filter(Boolean);
  return parts[0] ?? 'Selected Folder';
}

export interface DiscoverFromFileListOptions {
  source?: FolderImportSource;
  collectionMeta?: FolderCollectionMeta;
}

/** Classify flat file list from picker recursion or `<input webkitdirectory>`. */
export function discoverFromFileList(
  files: File[],
  folderName: string,
  opts: DiscoverFromFileListOptions = {},
): FolderScanResult {
  const importable: FolderDiscoveredFile[] = [];
  const skipped: FolderSkippedFile[] = [];
  let hiddenDotfiles = 0;

  for (const file of files) {
    const relativePath = relativePathFromFile(file, folderName);
    const format = classifyRelativePath(relativePath);
    if (format) {
      importable.push({ file, relativePath, format });
      continue;
    }
    const base = basenameFromRelativePath(relativePath);
    if (base.startsWith('.')) {
      hiddenDotfiles++;
      continue;
    }
    const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
    let reason = 'Unsupported file type';
    if (ext === 'indd') reason = 'InDesign (.indd) is not supported yet';
    else if (ext === 'zip' || ext === 'rar' || ext === '7z')
      reason = `Archive (.${ext}) — extract it first; PSD/AI must be loose files`;
    else if (ext) reason = `.${ext} is not supported (use .psd or .ai)`;
    skipped.push({ relativePath, name: base, reason });
  }

  importable.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' }));

  const meta = opts.collectionMeta;
  return {
    folderName,
    importable,
    skipped,
    totalScanned: files.length,
    diagnostics: {
      source: opts.source ?? 'webkitdirectory',
      directoriesScanned: meta?.directoriesScanned ?? 0,
      readErrors: meta?.readErrors ?? [],
      hiddenDotfiles,
    },
  };
}

/** Build a user-facing message when no importable files were found. */
export function formatEmptyFolderScanMessage(scan: FolderScanResult): string {
  const lines: string[] = [
    `Scanned folder "${scan.folderName}" (${scan.totalScanned} file${scan.totalScanned === 1 ? '' : 's'}), but found no .psd or .ai files.`,
  ];
  const d = scan.diagnostics;
  if (d.source === 'directory-picker') {
    lines.push(
      d.directoriesScanned > 0
        ? `Nested folders traversed: yes (${d.directoriesScanned} director${d.directoriesScanned === 1 ? 'y' : 'ies'} scanned).`
        : 'Nested folders traversed: no directories were entered (only immediate files were visible).',
    );
  } else {
    lines.push('Source: folder file input (includes nested paths when the browser provides them).');
  }
  if (scan.skipped.length) {
    lines.push('', 'Skipped files:');
    for (const s of scan.skipped.slice(0, 8)) {
      lines.push(`• ${displayRelativePath(s.relativePath, scan.folderName)} — ${s.reason}`);
    }
    if (scan.skipped.length > 8) lines.push(`• …and ${scan.skipped.length - 8} more`);
  }
  if (d.hiddenDotfiles) {
    lines.push('', `${d.hiddenDotfiles} hidden/dotfile(s) omitted from the list.`);
  }
  if (d.readErrors.length) {
    lines.push('', 'Could not read some entries:');
    for (const e of d.readErrors.slice(0, 5)) {
      lines.push(`• ${e.path}: ${e.message}`);
    }
  }
  if (scan.totalScanned <= 2 && scan.importable.length === 0) {
    lines.push(
      '',
      'Tip: If assets are inside a .zip, extract the archive first. Open the folder that directly contains .psd/.ai files (often a "PSD" subfolder).',
    );
  }
  return lines.join('\n');
}

/** Unique document name when the same basename appears in different subfolders. */
export function uniqueDocumentName(relativePath: string, used: Set<string>): string {
  const base = basenameFromRelativePath(relativePath);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const nested = normalizeRelPath(relativePath).replace(/\//g, ' / ');
  let candidate = nested;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${nested} (${n})`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

function isDirectoryHandle(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
  return handle.kind === 'directory';
}

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === 'file';
}

async function collectFilesFromDirectoryHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: File[],
  meta: FolderCollectionMeta,
): Promise<void> {
  meta.directoriesScanned++;
  for await (const [name, handle] of dir.entries()) {
    const relPath = prefix ? `${prefix}${name}` : name;
    try {
      if (isFileHandle(handle)) {
        const file = await handle.getFile();
        attachRelativePathToFile(file, relPath);
        out.push(file);
      } else if (isDirectoryHandle(handle)) {
        await collectFilesFromDirectoryHandle(handle, `${relPath}/`, out, meta);
      } else {
        meta.readErrors.push({
          path: relPath,
          message: `Unknown handle kind: ${String((handle as FileSystemHandle).kind)}`,
        });
      }
    } catch (err) {
      meta.readErrors.push({ path: relPath, message: (err as Error).message || String(err) });
    }
  }
}

export async function collectFilesFromDirectoryPicker(dirHandle: FileSystemDirectoryHandle): Promise<{
  files: File[];
  meta: FolderCollectionMeta;
}> {
  const meta: FolderCollectionMeta = { directoriesScanned: 0, readErrors: [] };
  const files: File[] = [];
  const requestPermission = (
    dirHandle as FileSystemDirectoryHandle & {
      requestPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
    }
  ).requestPermission;
  if (requestPermission) {
    try {
      const perm = await requestPermission.call(dirHandle, { mode: 'read' });
      if (perm !== 'granted') {
        meta.readErrors.push({ path: dirHandle.name, message: 'Read permission was not granted' });
        return { files, meta };
      }
    } catch {
      /* ignore permission API errors */
    }
  }
  await collectFilesFromDirectoryHandle(dirHandle, '', files, meta);
  return { files, meta };
}

export function isDirectoryFileList(files: File[]): boolean {
  return files.length > 0 && files.every((f) => !!(f as File & { webkitRelativePath?: string }).webkitRelativePath);
}

/** For tests: scan path strings as if they came from a folder picker. */
export function discoverFromPathList(folderName: string, paths: string[]): FolderScanResult {
  const pseudoFiles = paths.map((relativePath) => {
    const name = basenameFromRelativePath(relativePath);
    const format = classifyRelativePath(relativePath);
    const blob = new Blob([]);
    const file = new File([blob], name, { type: format === 'ai' ? 'application/pdf' : 'application/octet-stream' });
    attachRelativePathToFile(file, `${folderName}/${normalizeRelPath(relativePath)}`);
    return file;
  });
  return discoverFromFileList(pseudoFiles, folderName, { source: 'webkitdirectory' });
}

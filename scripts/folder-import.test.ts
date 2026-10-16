/**
 * Regression tests for folder discovery and naming (no browser picker).
 */
import {
  attachRelativePathToFile,
  basenameFromRelativePath,
  classifyRelativePath,
  collectFilesFromDirectoryPicker,
  discoverFromFileList,
  discoverFromPathList,
  formatEmptyFolderScanMessage,
  normalizeRelPath,
  uniqueDocumentName,
  isDirectoryFileList,
} from '../src/folderImport';

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name} — ${detail}`);
};

const assert = (name: string, cond: boolean, detail: string) => log(name, cond, detail);

// Nested PSD + AI
const scan = discoverFromPathList('Archive', [
  'root.psd',
  'nested/deep/photo.psd',
  'assets/logo.ai',
  'readme.txt',
  'thumb.jpg',
  'draft.indd',
  '.DS_Store',
]);

assert('nested psd count', scan.importable.length === 3, `expected 3, got ${scan.importable.length}`);
assert(
  'formats',
  scan.importable.every((f) => f.format === 'psd' || f.format === 'ai') &&
    scan.importable.some((f) => f.relativePath.includes('nested/deep')),
  scan.importable.map((f) => f.relativePath).join(', '),
);
assert('skipped unsupported', scan.skipped.some((s) => s.name === 'readme.txt'), scan.skipped.length.toString());
assert('indd reason', scan.skipped.some((s) => s.reason.includes('InDesign')), 'indd skip');
assert('hidden dotfile omitted', !scan.skipped.some((s) => s.name === '.DS_Store'), 'dotfile');

// overlay-photo-effect: failure mode when only the root readme is collected (no nested PSDs)
const shallow = discoverFromPathList('overlay-photo-effect', ['Instructions.txt']);
assert(
  'overlay shallow matches user error',
  shallow.importable.length === 0 && shallow.totalScanned === 1 && shallow.skipped.length === 1,
  `importable=${shallow.importable.length} scanned=${shallow.totalScanned}`,
);

const nestedOverlay = discoverFromPathList('overlay-photo-effect', [
  'Instructions.txt',
  'PSD/Overlay Template.psd',
  'PSD/Extras/Double Exposure.psd',
]);
assert('overlay nested psds', nestedOverlay.importable.length === 2, String(nestedOverlay.importable.length));

// Windows-style webkitRelativePath (backslashes)
const winFile = new File([], 'Overlay Template.psd');
attachRelativePathToFile(winFile, 'overlay-photo-effect\\PSD\\Overlay Template.psd');
const winScan = discoverFromFileList([winFile], 'overlay-photo-effect', { source: 'webkitdirectory' });
assert('windows path psd', winScan.importable.length === 1 && winScan.importable[0].format === 'psd', 'win path');

assert(
  'basename backslashes',
  basenameFromRelativePath('overlay-photo-effect\\PSD\\x.psd') === 'x.psd',
  basenameFromRelativePath('overlay-photo-effect\\PSD\\x.psd'),
);

// Duplicate basenames in different folders
const used = new Set<string>();
const n1 = uniqueDocumentName('a/photo.psd', used);
const n2 = uniqueDocumentName('b/photo.psd', used);
assert('unique basename collision', n1 === 'photo.psd' && n2.includes('/'), `${n1} | ${n2}`);

assert('classify ai', classifyRelativePath('x/y/file.ai') === 'ai', 'ai');
assert('classify psd', classifyRelativePath('file.PSD') === 'psd', 'psd case');
assert('classify null', classifyRelativePath('file.png') === null, 'png');

// isDirectoryFileList
const folderLike = discoverFromPathList('F', ['a.psd']).importable.map((d) => d.file);
assert('directory file list', isDirectoryFileList(folderLike), 'webkitRelativePath set');
const flat = [new File([], 'a.psd')];
assert('not directory list', !isDirectoryFileList(flat), 'flat file');

// Empty scan diagnostics mention skipped file + zip tip
const zipOnly = discoverFromPathList('overlay-photo-effect', ['overlay-photo-effect.zip']);
const msg = formatEmptyFolderScanMessage(zipOnly);
assert('zip skip reason', zipOnly.skipped[0]?.reason.includes('extract'), zipOnly.skipped[0]?.reason ?? '');
assert('empty message lists skip', msg.includes('overlay-photo-effect.zip') || msg.includes('.zip'), 'msg');

// Mock directory picker recursion (root readme + nested PSD folder)
function mockFile(name: string): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    async getFile() {
      return new File([], name);
    },
    async isSameEntry() {
      return false;
    },
  } as FileSystemFileHandle;
}

function mockDir(name: string, children: Record<string, FileSystemHandle>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, h] of Object.entries(children)) yield [n, h] as [string, FileSystemHandle];
    },
    async *keys() {
      for (const n of Object.keys(children)) yield n;
    },
    async *values() {
      for (const h of Object.values(children)) yield h;
    },
    async getDirectoryHandle(n: string) {
      const h = children[n];
      if (!h || h.kind !== 'directory') throw new DOMException('Not found', 'NotFoundError');
      return h as FileSystemDirectoryHandle;
    },
    async getFileHandle(n: string) {
      const h = children[n];
      if (!h || h.kind !== 'file') throw new DOMException('Not found', 'NotFoundError');
      return h as FileSystemFileHandle;
    },
    async removeEntry() {},
    async resolve() {
      return null;
    },
    async isSameEntry() {
      return false;
    },
    async requestPermission() {
      return 'granted' as PermissionState;
    },
  } as FileSystemDirectoryHandle;
}

const psdDir = mockDir('PSD', { 'template.psd': mockFile('template.psd') });
const root = mockDir('overlay-photo-effect', {
  'Instructions.txt': mockFile('Instructions.txt'),
  PSD: psdDir,
});

const collected = await collectFilesFromDirectoryPicker(root);
const pickerScan = discoverFromFileList(collected.files, root.name, {
  source: 'directory-picker',
  collectionMeta: collected.meta,
});
assert(
  'mock picker recursion',
  collected.files.length === 2 &&
    pickerScan.importable.length === 1 &&
    collected.meta.directoriesScanned >= 2,
  `files=${collected.files.length} psd=${pickerScan.importable.length} dirs=${collected.meta.directoriesScanned}`,
);
assert(
  'mock nested relative path',
  pickerScan.importable[0]?.relativePath === 'PSD/template.psd',
  pickerScan.importable[0]?.relativePath ?? '',
);

assert('normalizeRelPath', normalizeRelPath('\\a\\b.psd') === 'a/b.psd', 'norm');

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error('\nFailed:', failed);
  process.exit(1);
}
console.log(`\nAll ${results.length} folder-import checks passed.`);

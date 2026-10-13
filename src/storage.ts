import type { SavedWorkspace } from './workspace';

/**
 * IndexedDB storage. Two stores:
 *  - "files": the untouched bytes of every open file (written once per file)
 *  - "workspace": one small record with every layer's edits, file positions and the canvas view (rewritten on each save)
 * A connection is opened per operation and closed right after, so clearing the database is never blocked.
 */
const DB_NAME = 'creatvise-canvas';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('files');
      req.result.createObjectStore('workspace');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open browser storage.'));
    req.onblocked = () => reject(new Error('Browser storage is blocked by another tab.'));
  });
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Saving was cancelled by the browser.'));
  });

export interface FileToStore { id: string; name: string; bytes: ArrayBuffer }

export async function saveWorkspace(ws: SavedWorkspace, newFiles: FileToStore[], keepIds: string[]): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(['files', 'workspace'], 'readwrite');
    const files = tx.objectStore('files');
    const existing = (await request(files.getAllKeys())) as IDBValidKey[];
    for (const f of newFiles) files.put({ name: f.name, bytes: f.bytes }, f.id);
    for (const k of existing) if (!keepIds.includes(String(k))) files.delete(k); // files that were closed
    tx.objectStore('workspace').put(ws, 'current');
    await done(tx);
  } finally {
    db.close();
  }
}

export async function loadWorkspace(): Promise<{ ws: SavedWorkspace; files: Map<string, ArrayBuffer> } | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(['files', 'workspace'], 'readonly');
    const ws = (await request(tx.objectStore('workspace').get('current'))) as SavedWorkspace | undefined;
    if (!ws || ws.version !== 1) return null;
    const files = new Map<string, ArrayBuffer>();
    for (const d of ws.docs) {
      const f = (await request(tx.objectStore('files').get(d.id))) as { bytes: ArrayBuffer } | undefined;
      if (f) files.set(d.id, f.bytes);
    }
    return { ws, files };
  } finally {
    db.close();
  }
}

export function clearAll(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(); return; }
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

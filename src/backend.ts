export interface BackendHealthResponse {
  ok: boolean;
  status: 'online' | 'offline' | 'starting' | 'converting' | 'not-found' | string;
  installed?: boolean;
  version?: string | null;
  queueLength?: number;
  lastJob?: unknown;
  detail?: string;
}

export class BackendError extends Error {
  friendly: string;
  detail?: string;

  constructor(message: string, opts?: { friendly?: string; detail?: string }) {
    super(message);
    this.name = 'BackendError';
    this.friendly = opts?.friendly ?? message;
    this.detail = opts?.detail;
  }
}

async function postBytes(url: string, bytes: ArrayBuffer, _opts?: { slowHint?: boolean }): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new BackendError(`Backend request failed with status ${res.status}: ${errText}`, {
        friendly: 'InDesign conversion server error',
        detail: errText,
      });
    }
    return await res.arrayBuffer();
  } catch (e) {
    if (e instanceof BackendError) throw e;
    throw new BackendError((e as Error).message, {
      friendly: 'Failed to connect to InDesign conversion server',
      detail: (e as Error).message,
    });
  }
}

export function inddToIdml(inddBytes: ArrayBuffer, opts?: { slowHint?: boolean }): Promise<ArrayBuffer> {
  return postBytes('/api/indd-to-idml', inddBytes, opts);
}

export function idmlToIndd(idmlBytes: ArrayBuffer): Promise<ArrayBuffer> {
  return postBytes('/api/idml-to-indd', idmlBytes);
}

export async function fetchBackendHealth(): Promise<BackendHealthResponse | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok ? ((await res.json()) as BackendHealthResponse) : null;
  } catch {
    return null;
  }
}

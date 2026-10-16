import type { BackendHealthResponse } from './backend';

export type IndesignHealthState = 'online' | 'offline' | 'starting' | 'converting' | 'not-found' | 'degraded';

export function healthStateFromResponse(h: BackendHealthResponse | null): IndesignHealthState {
  if (!h) return 'offline';
  if (h.status === 'online' || (h.ok && h.canConvert !== false)) return 'online';
  if (h.status === 'degraded' || (h.installed && !h.canConvert)) return 'degraded';
  if (h.status === 'starting') return 'starting';
  if (h.status === 'converting') return 'converting';
  if (h.status === 'not-found') return 'not-found';
  return 'offline';
}

export function indesignChipLabel(h: BackendHealthResponse | null): string {
  const state = healthStateFromResponse(h);
  switch (state) {
    case 'online':
      return h?.version ? `InDesign: Online (${h.version})` : 'InDesign: Online';
    case 'degraded':
      return h?.version ? `InDesign: Detected (${h.version})` : 'InDesign: Detected (no exe)';
    case 'starting':
      return 'InDesign: Starting…';
    case 'converting':
      return 'InDesign: Converting…';
    case 'not-found':
      return 'InDesign: Not Found';
    case 'offline':
    default:
      return 'InDesign: Offline';
  }
}

export function indesignChipTitle(h: BackendHealthResponse | null): string {
  if (!h) return 'InDesign conversion server is offline or unreachable.';
  if (h.ok || h.status === 'online') {
    const q = h.queueLength ?? 0;
    return `InDesign server ready${h.version ? ' (' + h.version + ')' : ''}. Queue: ${q}`;
  }
  if (h.status === 'degraded') {
    return (
      h.detail ||
      'InDesign COM is available but the executable path was not found. Conversion is unavailable.'
    );
  }
  return (
    h.detail ||
    (h.installed === false ? 'Adobe InDesign is not installed on this machine.' : 'InDesign service offline.')
  );
}

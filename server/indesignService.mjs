import { discoverIndesign } from './indesignDiscover.mjs';
import { runConversion } from './indesignRunner.mjs';

class IndesignService {
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this._install = null;
  }

  startWarmUp() {
    this._install = discoverIndesign();
    if (this._install.installed) {
      const parts = [];
      if (this._install.path) parts.push(`exe: ${this._install.path}`);
      if (this._install.version) parts.push(`version: ${this._install.version}`);
      if (this._install.comAvailable) parts.push('COM: available');
      this.log(`[indesignService] InDesign discovered: ${parts.join(', ')}`);
      if (!this._install.canConvert) {
        this.log('[indesignService] WARNING: Executable path not found — conversion will not work.');
        this.log('[indesignService] Set INDESIGN_PATH env var or install InDesign to a standard location.');
      }
    } else {
      this.log('[indesignService] InDesign not detected on host system.');
    }
  }

  shutdown() {
    this.log('[indesignService] InDesign service shutdown.');
  }

  getHealth({ queueLength = 0, lastJob = null } = {}) {
    this._install = discoverIndesign();
    const i = this._install;

    // Status reflects conversion readiness
    let status = 'offline';
    if (i.canConvert) {
      status = 'online';
    } else if (i.installed && !i.canConvert) {
      status = 'degraded';
    }

    // Detail message
    let detail;
    if (i.canConvert) {
      detail = `Ready (${i.version || 'unknown version'})`;
    } else if (i.installed && !i.canConvert) {
      detail = 'InDesign COM is available but the executable path was not found. Conversion requires the executable path.';
    } else {
      detail = 'Adobe InDesign is not installed or available on this machine.';
    }

    return {
      ok: i.canConvert,
      status,
      installed: i.installed,
      version: i.version,
      path: i.path,
      comAvailable: i.comAvailable,
      comVersion: i.comVersion,
      canConvert: i.canConvert,
      queueLength,
      lastJob,
      detail,
      diagnostics: i.diagnostics,
    };
  }

  async convert(action, body) {
    this._install = discoverIndesign();
    if (!this._install.canConvert) {
      const reason =
        this._install.diagnostics?.join(' ') ||
        'Set INDESIGN_PATH to InDesign.exe and restart the conversion server (npm run dev or npm run server).';
      throw new Error(`Conversion unavailable: ${reason}`);
    }
    return await runConversion(action, body);
  }
}

export function createIndesignService(options) {
  return new IndesignService(options);
}

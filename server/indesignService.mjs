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
      this.log(`[indesignService] InDesign discovered: ${this._install.path} (${this._install.version})`);
    } else {
      this.log('[indesignService] InDesign not detected on host system.');
    }
  }

  shutdown() {
    this.log('[indesignService] InDesign service shutdown.');
  }

  getHealth({ queueLength = 0, lastJob = null } = {}) {
    if (!this._install) {
      this._install = discoverIndesign();
    }
    return {
      ok: this._install.installed,
      status: this._install.installed ? 'online' : 'offline',
      installed: this._install.installed,
      version: this._install.version,
      path: this._install.path,
      queueLength,
      lastJob,
      detail: this._install.installed
        ? `Ready (${this._install.version})`
        : 'Adobe InDesign is not installed or available on this machine.',
    };
  }

  async convert(action, body) {
    return await runConversion(action, body);
  }
}

export function createIndesignService(options) {
  return new IndesignService(options);
}

import { discoverIndesign } from '../../server/indesignDiscover.mjs';

export type PocBIndesignReadiness = {
  discovery: ReturnType<typeof discoverIndesign>;
  executableAvailable: boolean;
  comAvailable: boolean;
  canConvert: boolean;
  blocker: string | null;
};

/** PoC-B preflight using shared server discovery (INDESIGN_PATH + auto-scan). */
export function evaluatePocBIndesignReadiness(): PocBIndesignReadiness {
  const discovery = discoverIndesign();
  const executableAvailable = Boolean(discovery.path);
  const comAvailable = discovery.comAvailable;
  const canConvert = discovery.canConvert;

  let blocker: string | null = null;
  if (!canConvert) {
    const lines = [
      'PoC-B cannot run: InDesign executable path is required for ExtendScript conversion.',
      ...discovery.diagnostics,
    ];
    blocker = lines.join('\n');
  }

  return {
    discovery,
    executableAvailable,
    comAvailable,
    canConvert,
    blocker,
  };
}

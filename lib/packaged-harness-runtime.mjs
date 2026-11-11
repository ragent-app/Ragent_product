import { join } from 'node:path';

// Debian installs provider launchers under /opt. The macOS app passes its
// movable bundle's runtime directory explicitly through the launcher and Run.
export const PACKAGED_HARNESS_ROOT = process.env.AGENTOC_PACKAGED_HARNESS_ROOT
  || (process.platform === 'linux' ? '/opt/agentoc/runtime' : '');

export function packagedHarnessCommandPath(command) {
  if (!PACKAGED_HARNESS_ROOT) return '';
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  return join(PACKAGED_HARNESS_ROOT, executable);
}

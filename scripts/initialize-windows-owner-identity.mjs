// Fixed one-shot entry. No config module, server, networking, Provider or secrets.
import { initializeFreshInstanceIdentity } from '../lib/instance-identity.mjs';
import { ownerIdentityPathForService } from '../lib/windows-owner-identity-paths.mjs';
const identityPath = ownerIdentityPathForService();
if (process.platform !== 'win32' || process.argv.length !== 2 ||
    process.env.RAGENT_WINDOWS_SERVICE_ROLE !== 'control' ||
    !identityPath) {
  console.error('IID_FIXED_SERVICE_CONTEXT_REQUIRED'); process.exitCode = 1;
} else {
  try {
    await initializeFreshInstanceIdentity({filePath: identityPath});
  } catch { console.error('IID_INITIALIZATION_REFUSED'); process.exitCode = 1; }
}

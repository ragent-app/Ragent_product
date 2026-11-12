// Product Windows CLI bridge. Installed/native trust owns helper, purpose and
// peer pins. Never pass a Run/HTTP/environment path or policy into that boundary.
import { setTimeout as delay } from 'node:timers/promises';
import { requestInstalledOwnerBootstrap, requestInstalledOwnerActivation } from './windows-owner-bootstrap.mjs';

export const WINDOWS_OWNER_CLI_BASE_URL = 'http://127.0.0.1:7690';
const typed = code => Object.assign(new Error(code), { code });

export function isWindowsOwnerCliTarget(baseUrl) {
  return baseUrl === WINDOWS_OWNER_CLI_BASE_URL || baseUrl === WINDOWS_OWNER_CLI_BASE_URL + '/';
}

export async function requestWindowsCliOwnerCookie({ baseUrl, signal } = {}) {
  if (!isWindowsOwnerCliTarget(baseUrl)) throw typed('CLI_OWNER_TARGET_REFUSED');
  // Both errors arise before the native bootstrap client connects or sends
  // a request: the endpoint is rotating, or its short-lived policy expired.
  // Re-inspect and reactivate; never replay an HTTP operation or a receipt
  // failure, whose outcome may already be committed.
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await requestInstalledOwnerActivation({ signal });
    try {
      result = await requestInstalledOwnerBootstrap({ signal });
      break;
    } catch (error) {
      if (attempt === 2 || !['OBD_ENDPOINT_UNAVAILABLE', 'OBC_DEADLINE_INVALID'].includes(error?.code)) throw error;
      await delay(150 * (attempt + 1), undefined, { signal });
    }
  }
  if (result?.baseUrl !== WINDOWS_OWNER_CLI_BASE_URL
    || typeof result.sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.sessionToken)) {
    throw typed('CLI_OWNER_RESULT_INVALID');
  }
  return 'session_token=' + result.sessionToken;
}

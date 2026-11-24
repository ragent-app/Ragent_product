import {rename} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';

export const WINDOWS_FILE_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800]);

// Windows readers/scanners can temporarily deny file replacement or removal.
// Permanent errors still propagate after at most 1600 ms backoff; access-denied
// EACCES is not retried.
export async function retryWindowsFileAccess(operation, {
  signal,
  beforeAttempt,
  abortMessage = 'Windows file operation aborted',
  platform = process.platform,
  waitImpl = (ms, signal) => sleep(ms, undefined, { signal }),
  jitterImpl = () => Math.floor(Math.random() * 11),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw Object.assign(new Error(abortMessage), { code: 'ABORT_ERR' });
    beforeAttempt?.();
    try {
      return await operation();
    } catch (error) {
      if (
        platform !== 'win32'
        || !['EPERM', 'EBUSY'].includes(error?.code)
        || attempt === WINDOWS_FILE_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      const jitter = Math.max(0, Math.min(10, Number(jitterImpl()) || 0));
      await waitImpl(WINDOWS_FILE_RETRY_DELAYS_MS[attempt] + jitter, signal);
    }
  }
}

// Preserve atomic rename: never unlink the destination or copy over it.
export async function renameWithWindowsRetry(source, target, {
  signal,
  beforeAttempt,
  platform = process.platform,
  renameImpl = rename,
  waitImpl = (ms, signal) => sleep(ms, undefined, { signal }),
  jitterImpl = () => Math.floor(Math.random() * 11),
} = {}) {
  return retryWindowsFileAccess(() => renameImpl(source, target), {
    signal,
    beforeAttempt,
    abortMessage: 'Atomic replacement aborted',
    platform,
    waitImpl,
    jitterImpl,
  });
}

import { access } from 'node:fs/promises';

const DEFAULT_POLL_INTERVAL_MS = 250;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Watch the stop request created by Ragent.ServiceHost. Windows services do
 * not receive a portable console signal, so the service host asks the Node
 * child to run its normal shutdown path before the process-tree kill fallback.
 *
 * The hook is intentionally inert outside the explicit Windows service mode;
 * ordinary per-user runtimes do not acquire or poll a service control file.
 */
export function watchWindowsServiceStop({
  stopFilePath = process.env.RAGENT_WINDOWS_SERVICE_STOP_FILE,
  onStop,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (process.platform !== 'win32'
    || trimString(process.env.RAGENT_WINDOWS_SERVICE_MODE) !== '1'
    || !trimString(stopFilePath)
    || typeof onStop !== 'function') {
    return () => {};
  }

  let stopped = false;
  let checking = false;
  const interval = Math.max(50, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      await access(stopFilePath);
      if (!stopped) {
        stopped = true;
        await onStop();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[windows-service-stop] probe failed: ${error?.message || error}`);
      }
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => { void check(); }, interval);
  timer.unref?.();
  void check();

  return () => {
    clearInterval(timer);
    stopped = true;
  };
}

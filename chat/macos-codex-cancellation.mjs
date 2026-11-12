// Broker-only notification. The broker filters the same method from the
// upstream provider, so a provider cannot claim that cleanup was attempted.
export const MAC_CLEANUP_NOTIFICATION = 'agentoc/macosRunCleanup';
export const MAC_CLEANUP_SPOOL_TYPE = 'agentoc.macos_cancellation_cleanup';
export const MAC_CLEANUP_WARNING = 'Cancellation was requested, but macOS could not confirm task process cleanup. A task process may still be running.';

export function readMacCleanupNotification(message, { threadId, runId } = {}) {
  if (message?.method !== MAC_CLEANUP_NOTIFICATION || !threadId ||
      message?.params?.threadId !== threadId) return null;
  const status = message?.params?.status;
  if (status === 'attempted' && message?.params?.runId === runId && runId) return status;
  if (status === 'unconfirmed' && (!message?.params?.runId || message.params.runId === runId)) return status;
  return null;
}

// A clean scan is only an attempt, not a guarantee that an escaped or newly
// created process cannot survive. Missing evidence is always unconfirmed.
export function macCancellationCleanupStatus({ platform, brokered, cancelled, interruptSent, observed } = {}) {
  if (platform !== 'darwin' || !brokered || !cancelled || !interruptSent) return null;
  return observed === 'attempted' ? 'attempted' : 'unconfirmed';
}

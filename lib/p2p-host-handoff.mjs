// Coordinate a standby without closing the carrier that is currently serving
// requests. The registry owns authorization, expiry and revocation; this helper
// only promotes after the standby has observed an authenticated business probe.
export async function tryP2PHostHandoff({ old, createStandby, verified, isCurrent,
  promote, signal, deadlineMs = 20_000 }) {
  let standby = null;
  let promoted = false;
  let timer;
  let abortListener;
  const deadlineAt = Date.now() + Math.max(1, deadlineMs);
  const aborted = () => signal?.aborted || !isCurrent();
  const interrupted = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, deadlineMs));
    timer.unref?.();
    if (signal) {
      abortListener = () => resolve(false);
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  try {
    if (aborted()) return false;
    if (typeof old?.hasActiveChild === 'function' && !old.hasActiveChild()) return false;
    old.suspendSignaling();
    // The creation promise is not raced: an eventual process must be stopped
    // even when revocation arrives while its creation is still in progress.
    standby = await createStandby();
    if (aborted()) return false;
    const joined = await Promise.race([
      Promise.all([standby.ready, standby.joined]).then(() => true, () => false), interrupted,
    ]);
    const remainingMs = deadlineAt - Date.now();
    // Reserve time for the mobile peer to abandon an incomplete attempt
    // before the old host reclaims its signaling slot.
    if (!joined || aborted() || remainingMs <= 5_000 || !standby.requestCarrierHandoff(remainingMs)) return false;
    const ready = await Promise.race([verified.then(() => true, () => false), interrupted]);
    if (!ready || aborted()) return false;
    promoted = await promote(standby) === true;
    return promoted;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (!promoted) {
      try { standby?.stop(); } catch {}
      if (!aborted()) { try { old.resumeSignaling(); } catch {} }
    }
  }
}

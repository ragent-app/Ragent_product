(() => {
  const fragment = location.hash;
  history.replaceState(null, '', location.pathname + location.search);

  const status = document.getElementById('status');
  const expiry = document.getElementById('expiry');
  const open = document.getElementById('open');
  let pairingUri;
  let expiresAt;

  if (!fragment) {
    status.textContent = 'This page no longer has the pairing link. Reopen the original link on this phone, or create a new invitation on your host.';
    return;
  }

  try {
    if (!/^#v1\.[A-Za-z0-9_-]+$/.test(fragment)) throw new Error('Invalid fragment');
    const encoded = fragment.slice(4);
    if (encoded.length % 4 === 1) throw new Error('Invalid encoding');
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
    pairingUri = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const uri = new URL(pairingUri);
    if (uri.protocol !== 'ragent:' || uri.host !== 'pair' || uri.username || uri.password) throw new Error('Invalid pairing URI');
    const expiryValue = uri.searchParams.get('x');
    if (expiryValue) {
      const parsedExpiry = Date.parse(expiryValue);
      if (Number.isFinite(parsedExpiry)) expiresAt = parsedExpiry;
    }
  } catch {
    status.textContent = 'This pairing link is invalid. Create a new invitation on your host and open its link on this phone.';
    return;
  }

  function updateState() {
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      status.textContent = 'This invitation may have expired according to this device’s clock. You can still try opening Ragent, or create a new invitation on your host.';
    }
  }

  if (expiresAt !== undefined) {
    expiry.textContent = `Invitation expires: ${new Date(expiresAt).toLocaleString()}`;
    expiry.hidden = false;
  }
  status.textContent = 'Continue in Ragent to complete pairing. If the app does not open automatically, use the button below.';
  updateState();
  open.hidden = false;
  open.addEventListener('click', () => { updateState(); location.href = pairingUri; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateState(); });
  if (expiresAt !== undefined) setTimeout(updateState, Math.min(expiresAt - Date.now(), 2147483647));
  location.href = pairingUri;
})();

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(process.argv[2] || '.');
const { createOwnerAuthBroker, ACCOUNT_SESSION_CHALLENGE_TTL_MS } = await import(pathToFileURL(resolve(root, 'accounts/owner-auth-broker.mjs')));
const { handleOwnerAuthRoutes } = await import(pathToFileURL(resolve(root, 'accounts/owner-auth-routes.mjs')));
const { buildAccountSessionMessage, createDevicePublicKeyFingerprint } = await import(pathToFileURL(resolve(root, 'lib/device-auth-protocol.mjs')));
let now = Date.now(); let state = {}; let googleCalls = 0;
const broker = createOwnerAuthBroker({ clock: () => now, store: { mutate: async (fn) => fn(state) },
  verifyGoogleCredential: async ({ idToken, nonce }) => {
    assert.equal(idToken, 'fixture-google-token'); assert.ok(nonce.startsWith('nonce_')); googleCalls++;
    return { sub: 'browser-fixture-owner', email: 'browser@example.test' };
  }, verifyNativeGoogleCredential: async () => { throw new Error('Browser sign-in must not use native Google verification'); },
  resolveAccount: async () => ({ accountId: 'acct_browser_http_fixture' }), signAssertion: async () => 'unused' });
let dropNextSessionReply = false;
const server = createServer((req, res) => {
  if (req.url.split('?')[0].endsWith('/v1/owner-auth/native/session/complete')) {
    const originalEnd = res.end;
    res.end = function (...args) {
      if (dropNextSessionReply && this.statusCode === 200) {
        dropNextSessionReply = false;
        this.destroy();
        return this;
      }
      return originalEnd.apply(this, args);
    };
  }
  handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base,
    googleWebClientId: 'fixture.apps.googleusercontent.com', allowInsecurePublicBaseUrl: true })
    .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
    .catch((error) => { res.writeHead(500); res.end(); console.error(error); });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`; const base = `${origin}/accounts`;
const jar = new Map();
function saveCookies(response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]; const split = pair.indexOf('=');
    if (cookie.includes('Max-Age=0')) jar.delete(pair.slice(0, split));
    else jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
}
async function post(path, body, headers = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function page(id) {
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = device.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const requestId = `request_browser_fixture_${id}`; const deviceId = `adev_browser_fixture_${id}`;
  const response = await post('/v1/owner-auth/native/session/challenge', { requestId, device: { deviceId, publicKey, platform: 'android' } });
  assert.equal(response.status, 201); const challenge = await response.json();
  assert.equal(Date.parse(challenge.expiresAt) - now, 900_000); assert.ok(challenge.browserTicket);
  const opened = await fetch(`${base}/owner/google/native-phone?tx=${encodeURIComponent(challenge.transactionId)}&ticket=${encodeURIComponent(challenge.browserTicket)}`);
  assert.equal(opened.status, 200); saveCookies(opened); const html = await opened.text();
  const script = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].at(-1)?.[1]; assert.ok(script);
  let callback; const requests = []; const elements = new Map();
  const google = { accounts: { id: { initialize(config) { assert.equal(config.nonce, challenge.nonce); callback = config.callback; }, renderButton() {} } } };
  const window = { google }; const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', addEventListener() {} }); return elements.get(id);
  } };
  runInNewContext(script, { window, document, google, fetch: async (url, options) => {
    assert.equal(new URL(url).origin, origin); const payload = JSON.parse(options.body); requests.push(payload);
    const result = await fetch(url, { ...options, headers: { ...options.headers, Origin: origin,
      Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } }); saveCookies(result); return result;
  } });
  assert.equal(typeof callback, 'function');
  return { challenge, requests, elements, callback, async complete() {
    const body = { transactionId: challenge.transactionId, requestId };
    body.signature = sign('sha256', Buffer.from(buildAccountSessionMessage({ ...body, deviceId,
      publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey), nonce: challenge.nonce })), device.privateKey).toString('base64url');
    return post('/v1/owner-auth/native/session/complete', body);
  } };
}
try {
  assert.equal(ACCOUNT_SESSION_CHALLENGE_TTL_MS, 900_000);
  const first = await page('first'); const second = await page('second');
  assert.equal(jar.size, 4, 'two native browser flows need independent cookies');
  const firstState = [...jar].find(([key, value]) => key.startsWith('ragent_owner_broker_phone_state_') && value.startsWith(first.challenge.transactionId + '.'));
  const csrf = jar.get(firstState[0].replace('phone_state_', 'phone_csrf_'));
  const cookies = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const verifyPath = '/v1/owner-auth/native/session/browser-verified';
  const payload = { transactionId: first.challenge.transactionId, idToken: 'fixture-google-token' };
  assert.equal((await post(verifyPath, payload, { Origin: origin, 'X-Ragent-CSRF': csrf })).status, 403, 'missing cookies cannot verify a challenge');
  assert.equal((await post(verifyPath, payload, { Origin: 'https://attacker.example', Cookie: cookies, 'X-Ragent-CSRF': csrf })).status, 403, 'foreign origin is refused');
  assert.equal((await post(verifyPath, { ...payload, transactionId: second.challenge.transactionId }, { Origin: origin, Cookie: cookies, 'X-Ragent-CSRF': csrf })).status, 403, 'one flow cannot verify another flow');
  assert.equal(googleCalls, 0, 'CSRF failures must precede Google verification');
  now += 600_000;
  assert.equal((await first.complete()).status, 409, 'a phone signature alone cannot skip Google verification');
  await first.callback({ credential: 'fixture-google-token' });
  assert.equal(first.requests[0].transactionId, first.challenge.transactionId, 'the real rendered callback must send its transaction id');
  assert.match(first.elements.get('error').textContent, /登录完成/);
  assert.equal(jar.size, 2, 'completing one flow must leave the other flow cookies intact');
  dropNextSessionReply = true;
  await assert.rejects(first.complete(), 'the server commits issuance, then the first HTTP response is lost');
  assert.equal(dropNextSessionReply, false);
  assert.equal(state.accountCredentials.length, 1);
  const session = await first.complete(); assert.equal(session.status, 200); const account = await session.json();
  assert.equal(account.email, 'browser@example.test'); assert.match(account.credential.token, /^rac_/);
  assert.equal(JSON.stringify(account).includes('fixture-google-token'), false);
  const recovered = await first.complete(); assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), account, 'the same phone recovers the original response without new issuance');
  await second.callback({ credential: 'fixture-google-token' }); assert.match(second.elements.get('error').textContent, /登录完成/);
  assert.equal((await second.complete()).status, 200); assert.equal(googleCalls, 2);
  state.accountDevices.find((device) => device.deviceId === account.deviceId).revokedAt = new Date(now).toISOString();
  assert.equal((await first.complete()).status, 403, 'a revoked phone cannot recover a cached session');
  const expired = await page('expired'); now = Date.parse(expired.challenge.expiresAt);
  await expired.callback({ credential: 'fixture-google-token' }); assert.match(expired.elements.get('error').textContent, /已过期/);
  assert.equal(googleCalls, 2, 'expired browser authority must be refused before Google verification');
  console.log('PASS native browser callback -> phone-signed RAC; parallel cookies, ten-minute wait, one issuance, lost-response recovery, revocation and exact expiry');
} finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }

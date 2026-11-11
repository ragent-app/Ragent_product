#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createAdminServer, createAccessVerifier } from '../infrastructure/admin-console/server.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const issuer = 'https://ragent-test.cloudflareaccess.com';
const audience = 'admin-console-audience';
const ownerEmail = 'owner@example.com';
const now = () => 1_800_000_000_000;

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(overrides = {}) {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const claims = b64({
    iss: issuer,
    aud: [audience],
    email: ownerEmail,
    sub: 'owner-subject',
    exp: Math.floor(now() / 1000) + 600,
    nbf: Math.floor(now() / 1000) - 1,
    ...overrides,
  });
  const input = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

async function main() {
  const verifier = createAccessVerifier({
    accessDomain: 'ragent-test.cloudflareaccess.com',
    audience,
    ownerEmail,
    clock: now,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
  });

  assert.deepEqual(await verifier(token()), { email: ownerEmail, subject: 'owner-subject' });
  assert.equal(await verifier(token({ exp: Math.floor(now() / 1000) - 100 })), null, 'expired Access JWT is rejected');
  assert.equal(await verifier(token({ iss: 'https://attacker.cloudflareaccess.com' })), null, 'wrong JWT issuer is rejected');
  assert.equal(await verifier(token({ aud: ['another-app'] })), null, 'wrong Access app audience is rejected');
  assert.equal(await verifier(token({ email: 'other@example.com' })), null, 'non-owner email is rejected');

  const seen = [];
  const app = createAdminServer({
    host: '127.0.0.1',
    port: 0,
    expectedOrigin: 'https://ops.agentoncloud.com',
    accessVerifier: verifier,
    backupDirectory: 'G:/admin-console-test-backups',
    helperClient: async (request) => {
      seen.push(request);
      if (request.op === 'secrets') return { items: [{ id: 'openai-api-key', configured: true }] };
      if (request.op === 'set_secret') return { id: request.data.secretId, configured: true, applied: true };
      return { ok: true };
    },
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${base}/api/secrets`);
    assert.equal(denied.status, 401, 'requests without an Access JWT are denied');

    const page = await fetch(`${base}/`, { headers: { 'cf-access-jwt-assertion': token() } });
    assert.equal(page.status, 200, 'authorized owners can load the admin console page');
    assert.match(await page.text(), /Ragent/);

    const asset = await fetch(`${base}/assets/admin.css`, { headers: { 'cf-access-jwt-assertion': token() } });
    assert.equal(asset.status, 200, 'authorized owners can load the console assets');
    assert.match(asset.headers.get('content-type'), /text\/css/);

    const authorized = await fetch(`${base}/api/secrets`, { headers: { 'cf-access-jwt-assertion': token() } });
    assert.equal(authorized.status, 200);
    const authorizedBody = await authorized.text();
    assert.match(authorizedBody, /"configured":true/);
    assert.doesNotMatch(authorizedBody, /secret-value|sk-proj|private_key/);

    const rejectedOrigin = await fetch(`${base}/api/secrets/openai-api-key`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': token(), Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value-never-echoed' }),
    });
    assert.equal(rejectedOrigin.status, 403, 'cross-origin writes are rejected');
    assert.equal(seen.length, 1, 'cross-origin write never reaches the privileged helper');

    const written = await fetch(`${base}/api/secrets/openai-api-key`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': token(), Origin: 'https://ops.agentoncloud.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value-never-echoed' }),
    });
    assert.equal(written.status, 200);
    const writtenBody = await written.text();
    assert.doesNotMatch(writtenBody, /secret-value-never-echoed/);
    assert.equal(seen.at(-1).data.value, 'secret-value-never-echoed', 'the value reaches only the privileged helper');
    assert.equal(seen.at(-1).actor, ownerEmail);

    const direct = await fetch(`${base}/`);
    assert.equal(direct.status, 401, 'the page itself is denied without Cloudflare Access');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
  console.log('test-admin-console-security: ok');
}

await main();

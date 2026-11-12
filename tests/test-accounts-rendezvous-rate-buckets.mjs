import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAccountsServer } from '../accounts/server.mjs';

test('inbox polling cannot consume the account control request budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoc-rate-buckets-'));
  let app;
  try {
    app = await startAccountsServer({ dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing-key.json'),
      publicBaseUrl: 'http://127.0.0.1:0/accounts', googleWebClientId: 'test.apps.googleusercontent.com',
      allowInsecurePublicBaseUrl: true, port: 0, rateLimit: { max: 3, postMax: 3, authorityMax: 3 } });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async path => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    const inbox = ['/accounts/v1/owner-auth/rendezvous/inbox', '/v1/owner-auth/rendezvous/inbox'];
    for (let i = 0; i < 3; i++) assert.notEqual(await post(inbox[i % inbox.length]), 429);
    assert.equal(await post(inbox[0]), 429, 'the separate inbox budget remains bounded across route aliases');
    assert.notEqual(await post('/accounts/v1/owner-auth/rendezvous'), 429, 'inbox traffic must not exhaust rendezvous creation');
    assert.notEqual(await post('/accounts/v1/owner-auth/transactions'), 429);
    assert.notEqual(await post('/accounts/v1/owner-auth/transactions'), 429);
    assert.equal(await post('/accounts/v1/owner-auth/transactions'), 429, 'control operations retain their own limit');
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('account control requests cannot consume the inbox polling budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoc-rate-buckets-reverse-'));
  let app;
  try {
    app = await startAccountsServer({ dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing-key.json'),
      publicBaseUrl: 'http://127.0.0.1:0/accounts', googleWebClientId: 'test.apps.googleusercontent.com',
      allowInsecurePublicBaseUrl: true, port: 0, rateLimit: { max: 3, postMax: 3, authorityMax: 3 } });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async path => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    const control = '/accounts/v1/owner-auth/transactions';
    const inbox = '/accounts/v1/owner-auth/rendezvous/inbox';
    assert.notEqual(await post('/accounts/v1/owner-auth/rendezvous'), 429);
    for (let i = 0; i < 2; i++) assert.notEqual(await post(control), 429);
    assert.equal(await post(control), 429, 'control requests remain bounded');
    for (let i = 0; i < 3; i++) assert.notEqual(await post(inbox), 429, 'control traffic must not exhaust the inbox budget');
    assert.equal(await post(inbox), 429, 'inbox requests retain their own limit');
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('binding authority refresh has a bounded budget independent of account control and inbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoc-authority-rate-buckets-'));
  let app;
  try {
    app = await startAccountsServer({ dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing-key.json'),
      publicBaseUrl: 'http://127.0.0.1:0/accounts', googleWebClientId: 'test.apps.googleusercontent.com',
      allowInsecurePublicBaseUrl: true, port: 0, rateLimit: { max: 3, postMax: 3, authorityMax: 3 } });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async path => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    const control = '/accounts/v1/owner-auth/transactions';
    const inbox = '/accounts/v1/owner-auth/rendezvous/inbox';
    const authority = ['/accounts/v1/owner-auth/instances/authority', '/v1/owner-auth/instances/authority',
      '/accounts/v1/owner-auth/instances/workspace-authority', '/v1/owner-auth/instances/workspace-authority'];
    for (let i = 0; i < 3; i++) assert.notEqual(await post(control), 429);
    assert.equal(await post(control), 429);
    for (let i = 0; i < 3; i++) assert.notEqual(await post(inbox), 429);
    assert.equal(await post(inbox), 429);
    for (let i = 0; i < 3; i++) assert.notEqual(await post(authority[i]), 429);
    assert.equal(await post(authority[3]), 429, 'authority requests remain bounded across both routes and aliases');
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('authority refresh has its own configurable capacity while remaining bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoc-authority-capacity-'));
  let app;
  try {
    app = await startAccountsServer({ dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing-key.json'),
      publicBaseUrl: 'http://127.0.0.1:0/accounts', googleWebClientId: 'test.apps.googleusercontent.com',
      allowInsecurePublicBaseUrl: true, port: 0, rateLimit: { max: 3, postMax: 3, authorityMax: 7 } });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async path => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    const authority = '/accounts/v1/owner-auth/instances/authority';
    const control = '/accounts/v1/owner-auth/transactions';
    for (let i = 0; i < 3; i++) assert.notEqual(await post(control), 429);
    assert.equal(await post(control), 429);
    for (let i = 0; i < 7; i++) assert.notEqual(await post(authority), 429);
    assert.equal(await post(authority), 429);
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import { readFile } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const parameters = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const deny = () => Object.assign(new Error('Demo account sign-in was rejected.'), {
  code: 'owner_auth_demo_rejected', statusCode: 401,
});
const unavailable = () => Object.assign(new Error('Demo account is unavailable.'), {
  code: 'owner_auth_demo_unavailable', statusCode: 403,
});

/** Operator-created policy, kept outside the checkout and runtime payload. */
export async function createDemoAccountPolicy({ username, password, instanceId, accessMode = 'full', instanceAccess = 'account', unlimitedConnections = false }) {
  if (typeof unlimitedConnections !== 'boolean' || !['allowlist', 'account'].includes(instanceAccess) || !['restricted', 'full'].includes(accessMode) || !/^[a-z0-9._-]{3,80}$/.test(username || '') || typeof password !== 'string'
    || password.length < 16 || password.length > 256 || !/^inst_[A-Za-z0-9_-]{4,156}$/.test(instanceId || '')) {
    throw new Error('A username, 16–256 character password and exact default instance ID are required.');
  }
  const salt = randomBytes(32);
  const key = await derive(password, salt, 64, parameters);
  return { version: 1, username, accessMode, instanceAccess, unlimitedConnections, accountId: `acct_demo_${randomBytes(24).toString('hex')}`,
    passwordHash: { algorithm: 'scrypt-32768-8-1', salt: salt.toString('hex'), key: key.toString('hex') },
    allowedInstanceIds: [instanceId] };
}

export async function loadDemoAccountAuth(path, options = {}) {
  if (!path) return null; // No implicit demo account, default password or fallback.
  try {
    const input = await readFile(path);
    if (input.length > 4096) throw new Error('Demo policy is too large.');
    return createDemoAccountAuth(JSON.parse(input.toString('utf8')), options);
  } catch {
    // A broken optional test policy must not prevent normal owner sign-in or
    // silently enable an account. Expose the unavailable state without logging
    // the policy, path, or credentials; restart after an operator fixes it.
    console.error('[accounts] Test account policy unavailable; test sign-in is disabled.');
    return Object.freeze({
      accountId: '',
      instanceAccess: 'unavailable',
      unlimitedConnections: false,
      async verify() { throw unavailable(); },
      assertAccount() { throw unavailable(); },
    });
  }
}

export function createDemoAccountAuth(policy, { clock = Date.now } = {}) {
  if ((policy?.unlimitedConnections != null && typeof policy.unlimitedConnections !== 'boolean') || !['allowlist', 'account'].includes(policy?.instanceAccess ?? 'allowlist') || !['restricted', 'full'].includes(policy?.accessMode ?? 'restricted') || policy?.version !== 1 || !/^[a-z0-9._-]{3,80}$/.test(policy.username || '')
    || !/^acct_demo_[a-f0-9]{48}$/.test(policy.accountId || '')
    || policy.passwordHash?.algorithm !== 'scrypt-32768-8-1'
    || !/^[a-f0-9]{64}$/.test(policy.passwordHash?.salt || '')
    || !/^[a-f0-9]{128}$/.test(policy.passwordHash?.key || '')
    || !Array.isArray(policy.allowedInstanceIds) || policy.allowedInstanceIds.length !== 1
    || !/^inst_[A-Za-z0-9_-]{4,156}$/.test(policy.allowedInstanceIds[0])) {
    throw new Error('Invalid demo account policy.');
  }
  // Copy the policy: caller mutation cannot change authority after startup.
  const { accountId, username } = policy;
  // Old review-only flags are retained on disk for compatibility; login is now
  // an ordinary account and access is determined by actual instance authority.
  const accessMode = 'full';
  const targetId = policy.allowedInstanceIds[0];
  const instanceAccess = 'account';
  const salt = Buffer.from(policy.passwordHash.salt, 'hex');
  const expected = Buffer.from(policy.passwordHash.key, 'hex');
  let active = 0, windowStart = clock(), attempts = 0;
  return Object.freeze({
    accountId,
    accessMode,
    instanceAccess,
    defaultInstanceId: targetId,
    unlimitedConnections: policy.unlimitedConnections === true,
    async verify(input) {
      if (clock() - windowStart >= 60_000) { windowStart = clock(); attempts = 0; }
      if (++attempts > 20 || active >= 2) throw Object.assign(new Error('Too many demo sign-in attempts. Try again later.'), {
        code: 'owner_auth_demo_rate_limited', statusCode: 429,
      });
      const validInput = typeof input?.username === 'string' && input.username.length <= 80
        && typeof input?.password === 'string' && input.password.length >= 16 && input.password.length <= 256;
      active++;
      try {
        // Unknown usernames and invalid passwords perform the same bounded KDF.
        const key = await derive(validInput ? input.password : 'invalid-demo-credential', salt, 64, parameters);
        const matches = timingSafeEqual(key, expected);
        key.fill(0);
        if (!validInput || !matches || input.username !== username) throw deny();
        return { accountId, username };
      } finally { active--; }
    },
    assertAccount(draft, id, instanceId = '') {
      if (id !== accountId) throw unavailable();
      const account = (draft.accounts || []).find(entry => entry.accountId === id);
      if (!account || account.provider !== 'demo' || account.disabledAt || account.deletedAt) {
        throw unavailable();
      }
      return account;
    },
  });
}

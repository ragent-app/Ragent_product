#!/usr/bin/env node
import assert from 'assert/strict';

import { CATEGORY_INSTALL, CATEGORY_OTHER } from '../chat/privileged-classifier.mjs';
import { computeOpManifestHash } from '../chat/privileged-ops.mjs';
import {
  PRIVILEGED_AUTH_MODE_INVALID,
  PRIVILEGED_CGROUP_MISMATCH,
  PRIVILEGED_COMMAND_MISMATCH,
  PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
  PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY,
  PRIVILEGED_TOKEN_EXPIRED,
  PRIVILEGED_TOKEN_INVALID,
  PRIVILEGED_TOKEN_OK,
  PRIVILEGED_TOKEN_VERSION,
  buildPrivilegedCgroupFromRunId,
  canonicalPrivilegedToken,
  createPrivilegedKeyId,
  generatePrivilegedSigningKeyPair,
  isKnownPrivilegedAuthMode,
  isPrivilegedTokenExpired,
  signPrivilegedToken,
  verifyPrivilegedExecutableScope,
  verifyPrivilegedInstallScope,
  verifyPrivilegedPasskeyScope,
  verifyPrivilegedToken,
  verifyPrivilegedTokenCgroup,
  verifyPrivilegedTokenManifest,
  verifyPrivilegedTokenSignature,
} from '../chat/privileged-token.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

// P3a — proposal §8.2 (no-root unit tests): the minted token uses FIXED past
// timestamps, so every verifyPrivilegedToken call injects a `now` inside the
// validity window. Wall-clock `now` would otherwise read the token as expired.
const NOW = Date.parse('2026-07-31T12:00:10Z');
const ISSUED_AT = new Date('2026-07-31T12:00:00Z').toISOString();
const EXPIRES_AT = new Date('2026-07-31T12:00:30Z').toISOString(); // +30s, within the 60s TTL (D6)

const key = generatePrivilegedSigningKeyPair();
const otherKey = generatePrivilegedSigningKeyPair();

// Mint a fully valid baseline token. `manifestHash`/`cgroup` default to the
// values the real minter would compute, so the baseline passes every §3.3
// pure check; individual tests then mutate + re-sign to isolate one check.
function mintToken(overrides = {}) {
  const command = overrides.command ?? 'apt-get install nginx';
  const category = overrides.category ?? CATEGORY_INSTALL;
  const cwd = overrides.cwd ?? '/srv/ragent-promoted';
  const runId = overrides.runId ?? 'run_abc';
  const manifestHash = overrides.manifestHash ?? computeOpManifestHash({ command, category, cwd });
  const cgroup = overrides.cgroup ?? buildPrivilegedCgroupFromRunId(runId);
  const base = {
    v: PRIVILEGED_TOKEN_VERSION,
    kid: 'pkx_testkey',
    opId: 'pop_1',
    category,
    command,
    cwd,
    manifestHash,
    sessionId: 'sess_1',
    runId,
    turnId: 'turn_1',
    cgroup,
    authMode: overrides.authMode ?? PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY,
    issuedAt: overrides.issuedAt ?? ISSUED_AT,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
  };
  return signPrivilegedToken(base, key.privateKey, { kid: base.kid });
}

// --- key + id generation ---
check('keypair has public+private', Boolean(key.publicKey) && Boolean(key.privateKey));
check('keypair objects differ', key.publicKey !== key.privateKey && key !== otherKey);
check('kid prefix', createPrivilegedKeyId().startsWith('pkx_'));
check('kid length grows with bytes', createPrivilegedKeyId(12).length > createPrivilegedKeyId(4).length);

// --- canonicalPrivilegedToken ---
const canon = JSON.parse(canonicalPrivilegedToken({
  v: 1, kid: 'k', command: 'c', manifestHash: 'h', sig: 'xxx', bogus: 'y', random: 7,
}));
eq('canonical excludes sig', canon.sig, undefined);
eq('canonical excludes unknown field', canon.bogus, undefined);
eq('canonical excludes random field', canon.random, undefined);
eq('canonical keeps signable field', canon.command, 'c');
const rawCanon = canonicalPrivilegedToken({ command: 'c', v: 1, kid: 'k' });
check('canonical fixed field order (v before command)', rawCanon.indexOf('"v"') < rawCanon.indexOf('"command"'));
check('canonical deterministic', canonicalPrivilegedToken({ command: 'c' }) === canonicalPrivilegedToken({ command: 'c' }));

// --- signPrivilegedToken stamping ---
const stamped = signPrivilegedToken({ command: 'x', category: CATEGORY_OTHER }, key.privateKey);
eq('sign stamps version', stamped.v, PRIVILEGED_TOKEN_VERSION);
check('sign attaches base64url sig', typeof stamped.sig === 'string' && /^[A-Za-z0-9_-]+$/.test(stamped.sig));
const kidStamped = signPrivilegedToken({ command: 'x' }, key.privateKey, { kid: 'pkx_zzz' });
eq('sign stamps kid from options', kidStamped.kid, 'pkx_zzz');
const kidFromToken = signPrivilegedToken({ command: 'x', kid: 'pkx_tok' }, key.privateKey);
eq('sign keeps kid from token', kidFromToken.kid, 'pkx_tok');

// --- happy path: sign -> verify ---
const token = mintToken();
check('baseline sig base64url', typeof token.sig === 'string' && token.sig.length > 0);
check('baseline sig valid', verifyPrivilegedTokenSignature(token, key.publicKey) === true);
const okResult = verifyPrivilegedToken(token, { publicKey: key.publicKey, now: NOW });
check('baseline verify ok', okResult.ok === true && okResult.code === PRIVILEGED_TOKEN_OK);

// --- tamper every signable field -> signature fails (§8.2) ---
// Mirror of the (unexported) SIGNABLE_TOKEN_FIELDS in privileged-token.mjs.
const SIGNABLE = [
  'v', 'kid', 'opId', 'category', 'command', 'cwd', 'manifestHash',
  'sessionId', 'runId', 'turnId', 'cgroup', 'authMode', 'issuedAt', 'expiresAt',
];
function mutate(value) {
  if (typeof value === 'number') return value + 1;
  return `${value}_tampered`;
}
for (const field of SIGNABLE) {
  const tampered = { ...token, [field]: mutate(token[field]) };
  check(`tamper ${field} breaks sig`, verifyPrivilegedTokenSignature(tampered, key.publicKey) === false);
}
// tampering the sig itself also fails verification
const badSig = { ...token, sig: `${token.sig.slice(0, -4)}AAAA` };
check('tamper sig breaks verify', verifyPrivilegedTokenSignature(badSig, key.publicKey) === false);
// adding an UNSIGNED field does NOT break the signature (sig is over the canonical subset only)
const extraField = { ...token, note: 'unsigned annotation' };
check('unsigned field keeps sig valid', verifyPrivilegedTokenSignature(extraField, key.publicKey) === true);

// --- signature edge cases ---
check('sig false with no public key', verifyPrivilegedTokenSignature(token, null) === false);
check('sig false with non-object token', verifyPrivilegedTokenSignature(null, key.publicKey) === false);
check('sig false with empty token', verifyPrivilegedTokenSignature({}, key.publicKey) === false);
check('sig false with empty sig', verifyPrivilegedTokenSignature({ ...token, sig: '' }, key.publicKey) === false);
check('sig false with wrong key', verifyPrivilegedTokenSignature(token, otherKey.publicKey) === false);

// --- expiry (§3.3 step 3) ---
check('not expired inside window', isPrivilegedTokenExpired(token, Date.parse('2026-07-31T12:00:10Z')) === false);
check('expired at boundary', isPrivilegedTokenExpired(token, Date.parse('2026-07-31T12:00:30Z')) === true);
check('expired after window', isPrivilegedTokenExpired(token, Date.parse('2026-07-31T12:05:00Z')) === true);
check('expired with malformed expiresAt', isPrivilegedTokenExpired({ expiresAt: 'nope' }) === true);
check('expired with missing expiresAt', isPrivilegedTokenExpired({}) === true);

// --- manifest mismatch (§3.3 step 5), isolated by re-signing ---
const manifestStale = signPrivilegedToken(
  { ...token, command: 'apt-get install completely-different' },
  key.privateKey,
);
check('manifest-mismatch sig still valid', verifyPrivilegedTokenSignature(manifestStale, key.publicKey) === true);
check('manifest-mismatch detected', verifyPrivilegedTokenManifest(manifestStale) === false);
eq(
  'manifest-mismatch verify code',
  verifyPrivilegedToken(manifestStale, { publicKey: key.publicKey, now: NOW }).code,
  PRIVILEGED_COMMAND_MISMATCH,
);
check('manifest empty command fails', verifyPrivilegedTokenManifest({ command: '' }) === false);
check('manifest missing hash fails', verifyPrivilegedTokenManifest({ command: 'apt-get install nginx', manifestHash: '' }) === false);

// --- cgroup mismatch (§3.3 step 6), isolated by re-signing ---
const cgStale = signPrivilegedToken(
  { ...token, cgroup: 'ragent-runner-run_NOTABC' },
  key.privateKey,
);
check('cgroup-mismatch sig valid', verifyPrivilegedTokenSignature(cgStale, key.publicKey) === true);
check('cgroup-mismatch manifest still ok', verifyPrivilegedTokenManifest(cgStale) === true);
check('cgroup-mismatch detected', verifyPrivilegedTokenCgroup(cgStale) === false);
eq(
  'cgroup-mismatch verify code',
  verifyPrivilegedToken(cgStale, { publicKey: key.publicKey, now: NOW }).code,
  PRIVILEGED_CGROUP_MISMATCH,
);
// absent cgroup fails closed (non-systemd launch rejected by default, D4)
const noCgroup = signPrivilegedToken({ ...token, cgroup: '' }, key.privateKey);
check('no cgroup fails closed', verifyPrivilegedTokenCgroup(noCgroup) === false);

// --- buildPrivilegedCgroupFromRunId (must mirror run-launcher unit naming) ---
eq('cgroup derived', buildPrivilegedCgroupFromRunId('run_abc'), 'ragent-runner-run_abc');
eq('cgroup sanitizes specials', buildPrivilegedCgroupFromRunId('run a/b'), 'ragent-runner-run_a_b');
eq('cgroup empty fallback', buildPrivilegedCgroupFromRunId(''), 'ragent-runner-unknown');

// --- verifyPrivilegedToken returns the FIRST failing check (ordering) ---
const allBroken = { ...token, sig: 'x', command: 'different', cgroup: 'wrong' };
eq('invalid precedes everything', verifyPrivilegedToken(allBroken, { publicKey: key.publicKey, now: NOW }).code, PRIVILEGED_TOKEN_INVALID);
const expiredValidSig = signPrivilegedToken(
  { ...token, expiresAt: new Date('2026-07-31T11:00:00Z').toISOString() },
  key.privateKey,
);
eq(
  'expired precedes manifest/cgroup',
  verifyPrivilegedToken(expiredValidSig, { publicKey: key.publicKey, now: NOW }).code,
  PRIVILEGED_TOKEN_EXPIRED,
);

// --- install-auto hard structural whitelist (§3.3 step 7, §8.2) ---
// in-scope: named-package install verbs -> executor consents to root
check('install nginx in scope', verifyPrivilegedInstallScope({ command: 'apt-get install nginx' }) === true);
check('install -y nginx in scope', verifyPrivilegedInstallScope({ command: 'apt-get install -y nginx' }) === true);
check('sudo install nginx in scope', verifyPrivilegedInstallScope({ command: 'sudo apt-get install nginx' }) === true);
check('pacman -S install in scope', verifyPrivilegedInstallScope({ command: 'pacman -S --noconfirm nginx' }) === true);
check('sudo pacman -S install in scope', verifyPrivilegedInstallScope({ command: 'sudo pacman -S --needed nginx' }) === true);
check('wrapped sudo install denied', verifyPrivilegedInstallScope({ command: 'env sudo apt-get install nginx' }) === false);
// out-of-scope: every §8.2 rejection case
check('add-apt-repository denied', verifyPrivilegedInstallScope({ command: 'add-apt-repository ppa:nginx/stable' }) === false);
check('dpkg -i local deb denied', verifyPrivilegedInstallScope({ command: 'dpkg -i ./pkg.deb' }) === false);
check('reinstall denied', verifyPrivilegedInstallScope({ command: 'apt-get install --reinstall nginx' }) === false);
check('pip language package denied', verifyPrivilegedInstallScope({ command: 'pip install requests' }) === false);
check('npm language package denied', verifyPrivilegedInstallScope({ command: 'npm install lodash' }) === false);
// non-install categories -> not an install op -> false
check('remove not install', verifyPrivilegedInstallScope({ command: 'apt-get remove nginx' }) === false);
check('systemctl not install', verifyPrivilegedInstallScope({ command: 'systemctl restart nginx' }) === false);
check('rm not install', verifyPrivilegedInstallScope({ command: 'rm -rf /tmp/x' }) === false);
check('empty command scope false', verifyPrivilegedInstallScope({ command: '' }) === false);

// --- passkey-mode executable allowlist (design §5.6, plan phase 4) ---
// Concrete, bounded programs on the allowlist -> executor consents to root.
check('rm allowed', verifyPrivilegedPasskeyScope({ command: 'rm -rf /var/cache/ragent-stale' }) === true);
check('systemctl allowed', verifyPrivilegedPasskeyScope({ command: 'systemctl restart nginx' }) === true);
check('chown allowed', verifyPrivilegedPasskeyScope({ command: 'chown -R app:app /srv/ragent-promoted' }) === true);
check('sudo-stripped program checked', verifyPrivilegedPasskeyScope({ command: 'sudo rm -rf /tmp/x' }) === true);
// Arbitrary-code launchers and anything off the list fail closed, even with a
// valid passkey — `sudo bash ...` / `sudo su` must never reach the root executor.
check('bash denied', verifyPrivilegedPasskeyScope({ command: 'bash -c "rm -rf /" ' }) === false);
check('sh denied', verifyPrivilegedPasskeyScope({ command: 'sh -c "echo x > /etc/y" ' }) === false);
check('su denied', verifyPrivilegedPasskeyScope({ command: 'su - root' }) === false);
check('sudo bash denied', verifyPrivilegedPasskeyScope({ command: 'sudo bash -c "rm -rf /" ' }) === false);
check('python interpreter denied', verifyPrivilegedPasskeyScope({ command: 'python -c "import shutil; shutil.rmtree(\"/x\")"' }) === false);
check('unknown program denied', verifyPrivilegedPasskeyScope({ command: 'some-weird-tool --force' }) === false);
check('empty command scope false', verifyPrivilegedPasskeyScope({ command: '' }) === false);

// --- executable allowlist is mode-independent (owner-click regression) ---
// The owner-click policy drops only the passkey PROOF, never the executable
// gate: `sudo bash -c ...` must stay DENIED when the owner approves with a
// click alone. Regression for the 88604cb2 review finding.
check('owner-click rm allowed', verifyPrivilegedExecutableScope({ command: 'rm -rf /var/cache/ragent-stale', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === true);
check('owner-click sudo bash denied', verifyPrivilegedExecutableScope({ command: 'sudo bash -c "rm -rf /tmp/x"', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click sh -c denied', verifyPrivilegedExecutableScope({ command: 'sudo sh -c "echo x > /etc/y"', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click python denied', verifyPrivilegedExecutableScope({ command: 'sudo python3 -c "import shutil; shutil.rmtree(\'/x\')"', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click node denied', verifyPrivilegedExecutableScope({ command: 'sudo node -e "fs.rmSync(\'/x\',{recursive:true})"', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('passkey alias parity', verifyPrivilegedPasskeyScope({ command: 'sudo bash -c "id"', authMode: PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY }) === false);
check('owner-click composite shell denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/x; touch /tmp/pwn', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('passkey composite shell denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/x && touch /tmp/pwn', authMode: PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY }) === false);
check('owner-click command substitution denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/x$(touch /tmp/pwn)', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click variable expansion denied', verifyPrivilegedExecutableScope({ command: 'rm -rf "$HOME/.ssh"', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click redirect denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/x >foo_bar', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click dev-null redirect denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/x 2>/dev/null', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click input redirect denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/x <foo_bar', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('owner-click brace expansion denied', verifyPrivilegedExecutableScope({ command: 'rm -rf /tmp/{a,b}', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('install env wrapper denied', verifyPrivilegedInstallScope({ command: 'env APT_CONFIG=/tmp/evil.conf sudo apt-get install nginx' }) === false);
check('install bare env wrapper denied', verifyPrivilegedInstallScope({ command: 'env sudo apt-get install nginx' }) === false);
check('install sudo env assignment denied', verifyPrivilegedInstallScope({ command: 'sudo APT_CONFIG=/tmp/evil.conf apt-get install nginx' }) === false);
check('owner-click sudo preserve-env denied', verifyPrivilegedExecutableScope({ command: 'sudo -E rm -rf /tmp/x', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('install apt hook option denied', verifyPrivilegedInstallScope({ command: 'apt-get install --option=DPkg::Pre-Invoke::=/tmp/evil nginx' }) === false);
check('install apt source option denied', verifyPrivilegedInstallScope({ command: 'apt-get install --option=Dir::Etc::sourcelist=/tmp/evil.list nginx' }) === false);
check('install dnf setopt denied', verifyPrivilegedInstallScope({ command: 'dnf install --setopt=plugin=/tmp/evil nginx' }) === false);
check('install apk repository denied', verifyPrivilegedInstallScope({ command: 'apk add --repository=/tmp/evil nginx' }) === false);
check('owner-click tar exec hook denied', verifyPrivilegedExecutableScope({ command: 'tar --checkpoint=1 --checkpoint-action=exec=/tmp/evil -cf /tmp/a /tmp/input', authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK }) === false);
check('passkey tar exec hook denied', verifyPrivilegedPasskeyScope({ command: 'tar --checkpoint=1 --checkpoint-action=exec=/tmp/evil -cf /tmp/a /tmp/input', authMode: PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY }) === false);

// --- known authMode set: unknown/empty values fail closed in the pure chain ---
check('known mode passkey', isKnownPrivilegedAuthMode(PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY) === true);
check('known mode owner-click', isKnownPrivilegedAuthMode('owner-click') === true);
check('known mode install-auto', isKnownPrivilegedAuthMode('install-auto') === true);
check('unknown mode rejected', isKnownPrivilegedAuthMode('sudo') === false);
check('empty mode rejected', isKnownPrivilegedAuthMode('') === false);
check('missing mode rejected', isKnownPrivilegedAuthMode(undefined) === false);
check('case-sensitive mode rejected', isKnownPrivilegedAuthMode('Passkey') === false);

{
  // Unknown authMode on an otherwise perfectly signed token -> AUTH_MODE_INVALID
  // from the pure chain, before expiry/manifest/cgroup logic ever runs.
  const unknownModeToken = mintToken({ authMode: 'weird-mode' });
  const result = verifyPrivilegedToken(unknownModeToken, { publicKey: key.publicKey, now: NOW });
  check('unknown authMode fails closed', result.ok === false && result.code === PRIVILEGED_AUTH_MODE_INVALID);

  const missingModeToken = signPrivilegedToken({
    v: PRIVILEGED_TOKEN_VERSION, kid: 'pkx_testkey', opId: 'pop_1',
    category: CATEGORY_INSTALL, command: 'apt-get install nginx', cwd: '/srv/ragent-promoted',
    manifestHash: computeOpManifestHash({ command: 'apt-get install nginx', category: CATEGORY_INSTALL, cwd: '/srv/ragent-promoted' }),
    sessionId: 'sess_1', runId: 'run_abc', turnId: 'turn_1',
    cgroup: buildPrivilegedCgroupFromRunId('run_abc'),
    issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT,
  }, key.privateKey, { kid: 'pkx_testkey' });
  const missingResult = verifyPrivilegedToken(missingModeToken, { publicKey: key.publicKey, now: NOW });
  check('missing authMode fails closed', missingResult.ok === false && missingResult.code === PRIVILEGED_AUTH_MODE_INVALID);

  // owner-click mode with an allowlisted program is a fully valid token.
  const ownerClickToken = mintToken({
    authMode: PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
    command: 'rm -rf /var/cache/ragent-stale',
    category: CATEGORY_OTHER,
  });
  const ownerClickResult = verifyPrivilegedToken(ownerClickToken, { publicKey: key.publicKey, now: NOW });
  check('owner-click allowlisted token ok', ownerClickResult.ok === true && ownerClickResult.code === PRIVILEGED_TOKEN_OK);
}

console.log(`privileged-token: ${passed} checks passed`);

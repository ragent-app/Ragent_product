import { randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createDemoAccountAuth, createDemoAccountPolicy } from './demo-credentials.mjs';

const execFile = promisify(execFileCallback);

// The directory is dedicated to the Accounts service. Restrict it before any
// credential is written; Node's mode argument alone does not protect Windows.
async function secureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid Ragent account directory');
  if (process.platform === 'win32') {
    // Replace, rather than extend, any existing discretionary ACL: removing
    // inheritance alone would leave unrelated explicit grants in place.
    const script = `
      $ErrorActionPreference = 'Stop'
      $directory = [System.IO.DirectoryInfo]::new($env:RAGENT_ACCOUNT_PRIVATE_DIR)
      $acl = $directory.GetAccessControl()
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
      $sids = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
      foreach ($sid in $sids) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
          [System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
          'ContainerInherit,ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
      }
      $directory.SetAccessControl($acl)
    `;
    await execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, env: { ...process.env, RAGENT_ACCOUNT_PRIVATE_DIR: directory },
    });
  } else {
    await chmod(directory, 0o700);
  }
}

async function readPolicy(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid Ragent account policy');
    if (process.platform === 'win32') {
      await execFile('icacls.exe', [path, '/reset'], { windowsHide: true });
    } else {
      await chmod(path, 0o600);
    }
    const bytes = await readFile(path);
    if (bytes.length > 4096) throw new Error('Invalid Ragent account policy');
    const policy = JSON.parse(bytes.toString('utf8'));
    const auth = createDemoAccountAuth(policy); // Validate before using the identity.
    if (policy.password !== undefined) {
      if (typeof policy.password !== 'string') throw new Error('Invalid bootstrap credential');
      await auth.verify({ username: policy.username, password: policy.password });
    }
    return policy;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Ragent account policy is unavailable');
  }
}

async function publishOnce(path, policy) {
  const tmp = join(dirname(path), `.initial-${randomBytes(16).toString('hex')}`);
  let file;
  try {
    file = await open(tmp, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(policy, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    try { await link(tmp, path); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  } finally {
    await file?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Create one persistent first-party account on first Accounts startup.
 * The one-time random password is kept only in the service-private policy
 * file so its operator can retrieve it. Never regenerate a missing policy if
 * an account already exists, and never replace an existing policy or account.
 */
export async function ensureDefaultRagentAccount({ store, dataDirectory, clock = Date.now }) {
  if (!store || typeof store.mutate !== 'function' || typeof dataDirectory !== 'string' || !dataDirectory) {
    throw new TypeError('An Accounts store and data directory are required');
  }
  const directory = join(resolve(dataDirectory), 'ragent-account');
  const policyPath = join(directory, 'account.json');
  await secureDirectory(directory);
  const result = await store.mutate(async draft => {
    if (!Array.isArray(draft.accounts)) draft.accounts = [];
    let policy = await readPolicy(policyPath);
    const existing = draft.accounts.filter(account => account.provider === 'demo');
    if (!policy) {
      if (existing.length) return { status: 'unavailable' };
      const password = randomBytes(32).toString('base64url');
      const candidate = await createDemoAccountPolicy({ username: 'ragent', password });
      await publishOnce(policyPath, { ...candidate, password });
      policy = await readPolicy(policyPath);
      if (!policy) throw new Error('Ragent account policy was not published');
    }
    const account = existing.find(entry => entry.accountId === policy.accountId);
    if (existing.some(entry => entry.accountId !== policy.accountId)
      || (account && (account.providerSubject !== policy.username || account.disabledAt || account.deletedAt
        || account.deletionRequestedAt))) return { status: 'unavailable' };
    if (!account) draft.accounts.push({ accountId: policy.accountId, provider: 'demo',
      providerSubject: policy.username, createdAt: new Date(clock()).toISOString() });
    return { status: 'configured' };
  });
  return { ...result, policyPath };
}

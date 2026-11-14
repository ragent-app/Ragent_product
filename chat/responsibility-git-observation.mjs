// A narrow source-version observation, not a workspace or network fingerprint.
// Git and project identities are external to SQLite and cannot be read atomically.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { verifyCurrentResponsibilityProject } from './responsibility-project.mjs';
import { digest } from './responsibility-store.mjs';

const exec = promisify(execFile);
const unavailable = () => Object.assign(new Error('Committed Git observation is unavailable'), { code: 'RESPONSIBILITY_GIT_OBSERVATION_UNAVAILABLE' });
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

async function inspect(fact) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const options = { cwd: fact.rootRealPath, env, timeout: 10000, maxBuffer: 65536, windowsHide: true };
  const root = await realpath((await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim());
  if (!samePath(root, fact.rootRealPath)) throw unavailable();
  const head = (await exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], options)).stdout.trim().toLowerCase();
  const branch = (await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], options)).stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || !branch.startsWith('refs/heads/') || /[\r\n\0]/.test(branch)) throw unavailable();
  return { head, branch };
}

// No watermarks or decisions are changed here. Callers must recheck their
// lease, policy, project fact and trigger authority in their own transaction.
export async function observeResponsibilityCommittedGitHead(projectFactId) {
  if (typeof projectFactId !== 'string' || !projectFactId.trim()) throw unavailable();
  try {
    const before = await verifyCurrentResponsibilityProject(projectFactId);
    const first = await inspect(before);
    const after = await verifyCurrentResponsibilityProject(projectFactId);
    const second = await inspect(after);
    if (before.digest !== after.digest || first.head !== second.head || first.branch !== second.branch) throw unavailable();
    const fact = { schemaVersion: 1, kind: 'committed_git_head', projectFactId: after.id, projectFactDigest: after.digest, ...second };
    return { ...fact, digest: digest(fact) };
  } catch { throw unavailable(); }
}

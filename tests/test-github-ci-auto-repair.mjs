#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildSessionMessage, selectLatestFailureCandidates, truncateLogText } from '../scripts/github-ci-auto-repair.mjs';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsRoot, '..');
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-github-ci-auto-repair-'));
const configDir = join(tempHome, '.config', 'ragent');
const binDir = join(tempHome, 'bin');
const stateFile = join(tempHome, 'state.json');
const snapshotDir = join(tempHome, 'snapshots');

mkdirSync(configDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
  token: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
}, null, 2));

const nowMs = Date.now();
const tenMinutesAgo = new Date(nowMs - (10 * 60 * 1000)).toISOString();
const twoMinutesAgo = new Date(nowMs - (2 * 60 * 1000)).toISOString();

const pureSelection = selectLatestFailureCandidates([
  {
    id: 1,
    workflow_id: 7,
    name: 'CI',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    updated_at: tenMinutesAgo,
    html_url: 'https://github.com/owner/repo/actions/runs/1',
  },
], {
  bootstrapHours: 24,
  settleMinutes: 5,
  events: ['push'],
  workflows: [],
}, { handledRuns: {} }, nowMs);

assert.equal(pureSelection.candidates.length, 1, 'old completed failure should be actionable');
assert.equal(pureSelection.skipped.length, 0);

const pureInProgress = selectLatestFailureCandidates([
  {
    id: 1,
    workflow_id: 7,
    name: 'CI',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    updated_at: tenMinutesAgo,
    html_url: 'https://github.com/owner/repo/actions/runs/1',
  },
  {
    id: 2,
    workflow_id: 7,
    name: 'CI',
    head_branch: 'main',
    event: 'push',
    status: 'in_progress',
    conclusion: '',
    updated_at: twoMinutesAgo,
    html_url: 'https://github.com/owner/repo/actions/runs/2',
  },
], {
  bootstrapHours: 24,
  settleMinutes: 0,
  events: ['push'],
  workflows: [],
}, { handledRuns: {} }, nowMs);

assert.equal(pureInProgress.candidates.length, 0, 'newer in-progress rerun should suppress repair trigger');
assert.equal(pureInProgress.skipped[0].reason, 'latest_run_in_progress');
assert.equal(truncateLogText('a\n'.repeat(200), 5, 50).split('\n').length <= 5, true);

const builtMessage = buildSessionMessage({
  repo: 'owner/repo',
  sessionFolder: '/tmp/workspace',
  run: {
    id: 9,
    name: 'CI',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/owner/repo/actions/runs/9',
    updated_at: tenMinutesAgo,
    head_sha: 'abcdef1234567890',
  },
  commit: {
    sha: 'abcdef1234567890',
    html_url: 'https://github.com/owner/repo/commit/abcdef1234567890',
    commit: {
      message: 'Break CI intentionally',
      author: { name: 'alice' },
    },
    author: { login: 'alice' },
  },
  failedJobs: [{ name: 'test', conclusion: 'failure', url: '', steps: [{ name: 'Run smoke tests', conclusion: 'failure' }] }],
  failedLog: 'Error: boom',
  snapshotFile: '/tmp/snapshot.md',
});

assert.match(builtMessage, /Source: GitHub CI monitor/);
assert.match(builtMessage, /Run smoke tests/);
assert.match(builtMessage, /snapshot\.md/);

const ghPath = join(binDir, 'gh');
writeFileSync(ghPath, String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);

const mainRun = {
  id: 101,
  workflow_id: 999,
  name: 'CI',
  head_branch: 'main',
  head_sha: 'abcdef1234567890',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/owner/repo/actions/runs/101',
  created_at: '${tenMinutesAgo}',
  updated_at: '${tenMinutesAgo}',
};

const masterRun = {
  id: 202,
  workflow_id: 999,
  name: 'CI',
  head_branch: 'master',
  head_sha: 'beefbeefbeefbeef',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/owner/repo/actions/runs/202',
  created_at: '${tenMinutesAgo}',
  updated_at: '${tenMinutesAgo}',
};

function endpointFrom(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-X' || arg === '-f' || arg === '--input' || arg === '--jq') {
      index += 1;
      continue;
    }
    if (arg.startsWith('repos/')) return arg;
  }
  return '';
}

function fieldFrom(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '-f') continue;
    const raw = argv[index + 1] || '';
    const split = raw.indexOf('=');
    const key = split >= 0 ? raw.slice(0, split) : raw;
    const value = split >= 0 ? raw.slice(split + 1) : '';
    if (key === name) return value;
    index += 1;
  }
  return '';
}

if (args[0] === 'api') {
  const endpoint = endpointFrom(args);
  if (endpoint === 'repos/owner/repo/actions/runs') {
    const branch = fieldFrom(args, 'branch');
    const runs = branch === 'main' ? [mainRun] : branch === 'master' ? [masterRun] : [];
    process.stdout.write(JSON.stringify({ workflow_runs: runs }) + '\n');
    process.exit(0);
  }

  if (endpoint === 'repos/owner/repo/actions/runs/101/jobs') {
    process.stdout.write(JSON.stringify({
      jobs: [{
        id: 7001,
        name: 'test',
        conclusion: 'failure',
        html_url: 'https://github.com/owner/repo/actions/runs/101/job/7001',
        steps: [
          { number: 1, name: 'Install dependencies', conclusion: 'success' },
          { number: 2, name: 'Run smoke tests', conclusion: 'failure' },
        ],
      }],
    }) + '\n');
    process.exit(0);
  }

  if (endpoint === 'repos/owner/repo/commits/abcdef1234567890') {
    process.stdout.write(JSON.stringify({
      sha: 'abcdef1234567890',
      html_url: 'https://github.com/owner/repo/commit/abcdef1234567890',
      author: { login: 'alice' },
      commit: {
        message: 'Break CI intentionally\n\nextra context',
        author: { name: 'alice' },
      },
    }) + '\n');
    process.exit(0);
  }
}

if (args[0] === 'run' && args[1] === 'view' && args[2] === '101' && args.includes('--log-failed')) {
  process.stdout.write('test / Run smoke tests\nError: boom\n');
  process.exit(0);
}

console.error('unsupported gh command', args.join(' '));
process.exit(1);
`);
chmodSync(ghPath, 0o755);

function runNode(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', command, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const sessionCreates = [];
const messageCreates = [];

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }

  if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'session_token=test-cookie; HttpOnly; Path=/',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions') {
    sessionCreates.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'session_ci_1', name: 'CI repair session' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/session_ci_1/messages') {
    messageCreates.push(JSON.parse(body));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_ci_1' } }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const command = [
    join(repoRoot, 'scripts', 'github-ci-auto-repair.mjs'),
    '--repo', 'owner/repo',
    '--branch', 'main',
    '--branch', 'master',
    '--workflow', 'CI',
    '--chat-base-url', baseUrl,
    '--session-folder', repoRoot,
    '--state-file', stateFile,
    '--snapshot-dir', snapshotDir,
    '--settle-minutes', '0',
    '--bootstrap-hours', '1000',
    '--json',
  ];

  const childEnv = {
    ...process.env,
    RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
    RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
    HOME: tempHome,
    PATH: `${binDir}:${process.env.PATH}`,
  };

  const firstRun = await runNode(command, childEnv);

  assert.equal(firstRun.code, 0, `first repair run should exit cleanly: ${firstRun.stderr}`);
  const firstSummary = JSON.parse(firstRun.stdout);
  assert.equal(firstSummary.triggered.length, 1, 'failed main run should trigger one repair session');
  assert.equal(firstSummary.skipped.some((item) => item.reason === 'latest_run_success'), true, 'successful master run should be skipped as healthy');
  assert.equal(sessionCreates.length, 1, 'session should be created exactly once');
  assert.equal(messageCreates.length, 1, 'repair message should be submitted once');
  assert.equal(sessionCreates[0].sourceId, 'github-ci');
  assert.equal(sessionCreates[0].sourceName, 'GitHub CI');
  assert.equal(sessionCreates[0].externalTriggerId, 'github-ci:owner/repo:run/101');
  assert.match(messageCreates[0].requestId, /^github-ci:owner__repo:main:ci:101$/);
  assert.match(messageCreates[0].text, /https:\/\/github.com\/owner\/repo\/actions\/runs\/101/);
  assert.match(messageCreates[0].text, /Run smoke tests/);
  assert.equal(existsSync(join(snapshotDir, 'main-ci-run-101.md')), true, 'snapshot should be written');
  assert.match(readFileSync(join(snapshotDir, 'main-ci-run-101.md'), 'utf8'), /# GitHub CI failure snapshot/);

  const storedState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(storedState.handledRuns['101'].sessionId, 'session_ci_1');
  assert.equal(storedState.handledRuns['101'].ragentRunId, 'run_ci_1');

  const secondRun = await runNode(command, childEnv);

  assert.equal(secondRun.code, 0, `second repair run should exit cleanly: ${secondRun.stderr}`);
  const secondSummary = JSON.parse(secondRun.stdout);
  assert.equal(secondSummary.triggered.length, 0, 'already handled run should not retrigger');
  assert.equal(secondSummary.skipped.some((item) => item.reason === 'already_handled'), true);
  assert.equal(sessionCreates.length, 1, 'handled state should prevent duplicate sessions');
  assert.equal(messageCreates.length, 1, 'handled state should prevent duplicate submissions');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('github ci auto repair tests passed');

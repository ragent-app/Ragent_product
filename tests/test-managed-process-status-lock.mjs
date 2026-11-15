#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = join(new URL('.', import.meta.url).pathname, '..');
const home = mkdtempSync(join(tmpdir(), 'ragent-managed-process-lock-'));
const configDir = join(home, '.config', 'ragent');
mkdirSync(configDir, { recursive: true });
const processId = 'mp_000000000000000000000001';
const processDir = join(configDir, 'managed-processes', processId);
mkdirSync(processDir, { recursive: true });
writeFileSync(join(processDir, 'manifest.json'), JSON.stringify({
  version: 'managed-process/v1',
  id: processId,
  sessionId: 'session-lock-test',
  executable: process.execPath,
  args: [],
  cwd: repoRoot,
  env: {},
  wake: { sessionId: 'session-lock-test', on: ['output'], text: 'output' },
}), 'utf8');
writeFileSync(join(processDir, 'status.json'), JSON.stringify({
  version: 'managed-process-status/v1',
  id: processId,
  state: 'running',
  pid: null,
  sidecarPid: null,
  stdoutBytes: 0,
  stderrBytes: 0,
  outputSeq: 0,
  outputFeedbackSeq: 0,
}), 'utf8');

const moduleUrl = pathToFileURL(join(repoRoot, 'chat/managed-processes.mjs')).href;
const childEnv = {
  ...process.env,
  HOME: home,
  RAGENT_CONFIG_DIR: configDir,
  RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
};

function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

const chunkCount = 40;
const firstChunk = 'a'.repeat(257);
const secondChunk = 'b'.repeat(389);
await Promise.all([
  runChild(`const { appendManagedProcessOutput } = await import(${JSON.stringify(moduleUrl)}); for (let i = 0; i < ${chunkCount}; i += 1) await appendManagedProcessOutput(${JSON.stringify(processId)}, 'stdout', Buffer.from(${JSON.stringify(firstChunk)}));`),
  runChild(`const { appendManagedProcessOutput } = await import(${JSON.stringify(moduleUrl)}); for (let i = 0; i < ${chunkCount}; i += 1) await appendManagedProcessOutput(${JSON.stringify(processId)}, 'stdout', Buffer.from(${JSON.stringify(secondChunk)}));`),
  runChild(`const { writeManagedProcessStatus } = await import(${JSON.stringify(moduleUrl)}); await writeManagedProcessStatus(${JSON.stringify(processId)}, { state: 'completed', completedAt: new Date().toISOString(), exitCode: 0 });`),
]);

const status = JSON.parse(readFileSync(join(processDir, 'status.json'), 'utf8'));
const stdout = readFileSync(join(processDir, 'stdout.log'));
assert.equal(status.state, 'completed', 'terminal state must survive concurrent output writes');
assert.equal(status.stdoutBytes, chunkCount * (Buffer.byteLength(firstChunk) + Buffer.byteLength(secondChunk)));
assert.equal(status.outputSeq, chunkCount * 2, 'output sequence increments must not be lost');
assert.equal(stdout.length, status.stdoutBytes, 'durable byte counter must match the output file');
assert.equal(stdout.toString('utf8').length, status.stdoutBytes, 'UTF-8 test output should remain intact');

await runChild(`const { appendManagedProcessOutput } = await import(${JSON.stringify(moduleUrl)}); await appendManagedProcessOutput(${JSON.stringify(processId)}, 'stdout', Buffer.alloc(1024 * 1024 + 17, 0x63));`);
const boundedStatus = JSON.parse(readFileSync(join(processDir, 'status.json'), 'utf8'));
const boundedStdout = readFileSync(join(processDir, 'stdout.log'));
assert.equal(boundedStdout.length, 1024 * 1024, 'durable output file must retain a bounded tail');
assert.equal(boundedStatus.stdoutBytes, 1024 * 1024, 'stdoutBytes must describe the retained tail');
assert.equal(boundedStatus.stdoutTotalBytes, status.stdoutBytes + 1024 * 1024 + 17, 'total output bytes must remain observable');
assert.equal(boundedStdout.at(-1), 0x63, 'bounded tail must contain the newest output');

rmSync(home, { recursive: true, force: true });
console.log('test-managed-process-status-lock: ok');

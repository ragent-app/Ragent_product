#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-claude-resume-cwd-'));
const claudeHome = join(tempHome, 'claude-home');
const requestedCwd = join(tempHome, 'home', 'andy');
const transcriptCwd = join(tempHome, 'workspace');
const projectDir = join(claudeHome, 'projects', '-var-lib-ragent-workspace');
const sessionId = 'dbf325d8-d499-457d-be70-2a5fc980d78b';

try {
  mkdirSync(requestedCwd, { recursive: true });
  mkdirSync(transcriptCwd, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: 'queue-operation', sessionId }),
      JSON.stringify({ type: 'system', sessionId }),
      JSON.stringify({ type: 'user', sessionId, cwd: transcriptCwd }),
      JSON.stringify({ type: 'assistant', sessionId, cwd: join(transcriptCwd, 'nested') }),
    ].join('\n'),
    'utf8',
  );

  const cacheBust = `?t=${Date.now()}`;
  const module = await import(pathToFileURL(join(repoRoot, 'chat', 'claude-resume-cwd.mjs')).href + cacheBust);

  const located = await module.resolveClaudeResumeCwd({
    requestedCwd,
    claudeSessionId: sessionId,
    claudeHomeDir: claudeHome,
  });
  assert.equal(located.relocated, true, 'resume cwd should relocate when transcript belongs to another cwd');
  assert.equal(located.cwd, transcriptCwd, 'resume cwd should use the transcript cwd');
  assert.equal(located.requestedCwd, requestedCwd, 'requested cwd should be preserved for diagnostics');
  assert.equal(located.reason, 'claude-resume-transcript-cwd');

  const sameCwd = await module.resolveClaudeResumeCwd({
    requestedCwd: transcriptCwd,
    claudeSessionId: sessionId,
    claudeHomeDir: claudeHome,
  });
  assert.equal(sameCwd.relocated, false, 'matching transcript cwd should not relocate');
  assert.equal(sameCwd.cwd, transcriptCwd);

  const missing = await module.resolveClaudeResumeCwd({
    requestedCwd,
    claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    claudeHomeDir: claudeHome,
  });
  assert.equal(missing.relocated, false, 'missing transcript should not relocate');
  assert.equal(missing.cwd, requestedCwd);

  const traversal = await module.resolveClaudeResumeCwd({
    requestedCwd,
    claudeSessionId: '../escape',
    claudeHomeDir: claudeHome,
  });
  assert.equal(traversal.relocated, false, 'unsafe session ids should be ignored');
  assert.equal(traversal.cwd, requestedCwd);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-claude-resume-cwd: ok');

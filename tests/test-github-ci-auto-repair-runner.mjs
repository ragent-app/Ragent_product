#!/usr/bin/env node
import assert from 'assert/strict';
import { buildMonitorArgv } from '../scripts/github-ci-auto-repair-runner.mjs';

const argv = buildMonitorArgv({
  repo: 'Ninglo/ragent',
  branches: ['main', 'master'],
  events: ['push', 'workflow_dispatch'],
  workflows: ['CI'],
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: '/tmp/ragent',
  sessionTool: 'codex',
  model: 'gpt-5',
  effort: 'high',
  thinking: true,
  bootstrapHours: 48,
  limit: 30,
  settleMinutes: 0,
  maxLogLines: 200,
  maxLogChars: 15000,
  stateFile: '/tmp/state.json',
  snapshotDir: '/tmp/snapshots',
});

assert.deepEqual(argv, [
  '--repo', 'Ninglo/ragent',
  '--branch', 'main',
  '--branch', 'master',
  '--event', 'push',
  '--event', 'workflow_dispatch',
  '--workflow', 'CI',
  '--chat-base-url', 'http://127.0.0.1:7690',
  '--session-folder', '/tmp/ragent',
  '--session-tool', 'codex',
  '--model', 'gpt-5',
  '--effort', 'high',
  '--thinking',
  '--bootstrap-hours', '48',
  '--limit', '30',
  '--settle-minutes', '0',
  '--max-log-lines', '200',
  '--max-log-chars', '15000',
  '--state-file', '/tmp/state.json',
  '--snapshot-dir', '/tmp/snapshots',
  '--json',
]);

console.log('github ci auto repair runner tests passed');

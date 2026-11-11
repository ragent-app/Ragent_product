import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'linux') {
  console.log('session read-only dispatch requires Linux');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'agentoc-readonly-dispatch-'));
console.log(`fixture root: ${root}`);
const projectDir = join(root, 'project');
const configDir = join(root, 'config');
const memoryDir = join(root, 'memory');
const workDir = join(root, 'work');
for (const dir of [projectDir, configDir, memoryDir, workDir]) mkdirSync(dir, { recursive: true });
const fake = join(projectDir, 'fake-codex');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
let blocked = false;
try { fs.writeFileSync(require('path').join(process.cwd(), 'must-not-write.txt'), 'bad'); } catch { blocked = true; }
console.log(JSON.stringify({ type: 'content_start', contentType: 'text', text: blocked ? 'READ_ONLY_OK' : 'READ_ONLY_BROKEN' }));
console.log(JSON.stringify({ type: 'content_end', contentType: 'text' }));
console.log(JSON.stringify({ type: 'done' }));
`, 'utf8');
chmodSync(fake, 0o755);
writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{ id: 'fake-codex', name: 'Fixture', command: fake,
  runtimeFamily: 'cline-json', models: [{ id: 'fake-model', label: 'Fake' }] }]));
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_MEMORY_DIR = memoryDir;
process.env.AGENTOC_WORK_ROOT_DIR = workDir;
process.env.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.AGENTOC_REVIEWER_ENABLED = '1';
process.env.AGENTOC_REPLY_SELF_CHECK = 'off';
delete process.env.AGENTOC_RUN_SANDBOX;
const { createProject } = await import('../chat/projects.mjs');
const { createSession, getSession, sendMessage, killAll } = await import('../chat/session-manager.mjs');
const { getRun, getRunManifest } = await import('../chat/runs.mjs');
let runId = '';
try {
  const project = await createProject({ name: 'Read-only dispatch fixture', rootPath: projectDir });
  const session = await createSession(projectDir, 'fake-codex', 'Read-only fixture', { projectId: project.id });
  const sent = await sendMessage(session.id, 'Read the project.', [], {
    tool: 'fake-codex', model: 'fake-model', internalOperation: 'collaboration_task',
    accessMode: 'read', readOnlyRequired: true, runnerId: 'runtime_reviewer_readonly',
  });
  runId = sent.run.id;
  const manifest = await getRunManifest(runId);
  assert.equal(manifest.executionScope.accessMode, 'read');
  assert.equal(manifest.options.readOnlyRequired, true);
  assert.equal(manifest.options.runnerId, 'runtime_reviewer_readonly');
  let run;
  for (let i = 0; i < 120; i += 1) {
    await getSession(session.id);
    run = await getRun(runId);
    if (['completed', 'failed', 'cancelled'].includes(run?.state)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(run?.state, 'completed', `read-only fixture did not complete: ${JSON.stringify({ state: run?.state, error: run?.error, failureReason: run?.failureReason })}`);
  const spool = readFileSync(join(configDir, 'chat-runs', runId, 'spool.jsonl'), 'utf8');
  assert.match(spool, /READ_ONLY_OK/, 'the child must actually attempt and fail to write');
  assert.doesNotMatch(spool, /READ_ONLY_BROKEN/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(projectDir, 'must-not-write.txt')), false);
  console.log('session dispatch retained read-only scope and the actual child could not write the project');
} finally {
  await killAll();
  if (process.env.AGENTOC_KEEP_TEST_FIXTURE !== '1') rmSync(root, { recursive: true, force: true });
}

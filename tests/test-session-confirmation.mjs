#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-session-confirmation-'));

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(tempHome, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'workspace');
delete process.env.RAGENT_INSTANCE_ROOT;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getSessionEventsAfter,
  killAll,
  requestSessionConfirmation,
  submitSessionConfirmationDecision,
} = sessionManager;

try {
  const session = await createSession(tempHome, 'codex', 'Confirmation test');
  const created = await requestSessionConfirmation(session.id, {
    approvalId: 'confirm-test',
    title: 'Restart service?',
    reason: 'The service needs to reload backend routes.',
    questions: [{
      id: 'restart_window',
      header: 'Restart window',
      question: 'When should the restart happen?',
      options: [
        { label: 'Now', description: 'Restart immediately.' },
        { label: 'Later', description: 'Wait for a quiet window.' },
      ],
    }],
    confirmLabel: 'Restart',
    denyLabel: 'Skip',
  });

  assert.equal(created.duplicate, false, 'first confirmation request should be new');
  assert.equal(created.confirmation.type, 'approval_request');
  assert.equal(created.confirmation.source, 'ragent-confirmation');
  assert.equal(created.confirmation.kind, 'confirmation');
  assert.equal(created.confirmation.confirmLabel, 'Restart');
  assert.equal(created.confirmation.denyLabel, 'Skip');
  assert.deepEqual(created.confirmation.questions, [{
    id: 'restart_window',
    header: 'Restart window',
    question: 'When should the restart happen?',
    options: [
      { label: 'Now', value: 'Now', description: 'Restart immediately.' },
      { label: 'Later', value: 'Later', description: 'Wait for a quiet window.' },
    ],
  }]);

  const duplicateCreate = await requestSessionConfirmation(session.id, {
    approvalId: 'confirm-test',
    title: 'Restart service?',
  });
  assert.equal(duplicateCreate.duplicate, true, 'same confirmation id should be idempotent');

  const decided = await submitSessionConfirmationDecision(session.id, 'confirm-test', {
    decision: 'deny',
    requestId: 'req-confirm-test',
  });
  assert.equal(decided.duplicate, false, 'first confirmation decision should be new');
  assert.equal(decided.responseEvent.type, 'approval_response');
  assert.equal(decided.responseEvent.status, 'denied');
  assert.equal(decided.responseEvent.source, 'ragent-confirmation');

  const duplicateDecision = await submitSessionConfirmationDecision(session.id, 'confirm-test', {
    decision: 'deny',
    requestId: 'req-confirm-test',
  });
  assert.equal(duplicateDecision.duplicate, true, 'repeated confirmation decision should be idempotent');

  const events = await getSessionEventsAfter(session.id, 0, {
    includeBodies: false,
    includeMessageBodies: true,
  });
  assert.equal(
    events.filter((event) => event.type === 'approval_request' && event.source === 'ragent-confirmation').length,
    1,
    'confirmation request should be stored once',
  );
  assert.equal(
    events.filter((event) => event.type === 'approval_response' && event.source === 'ragent-confirmation').length,
    1,
    'confirmation response should be stored once',
  );

  console.log('test-session-confirmation: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

#!/usr/bin/env node
// Derived Runs must receive fresh publication identity and Run-bound inputs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-derived-run-publication-'));
process.env.HOME = home;

const {
  createSession,
  killAll,
  regenerateSessionReply,
  resendEditedMessage,
} = await import('../chat/session-manager.mjs');
const { createRun, createRunId, getRun, getRunManifest, updateRun } = await import('../chat/runs.mjs');

try {
  const session = await createSession(home, 'codex', 'Derived Run publication regression', {
    riskMode: 'recommended',
  });
  const parentRunId = createRunId();
  const parent = await createRun({
    status: {
      id: parentRunId,
      sessionId: session.id,
      requestId: 'request-parent',
      responseId: 'response-parent',
      state: 'completed',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
    },
    manifest: {
      sessionId: session.id,
      requestId: 'request-parent',
      responseId: 'response-parent',
      prompt: 'Original prompt for the parent Run.',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      attachmentStaging: { scope: { runId: parentRunId }, operations: [{ stale: true }] },
      options: { runtimeFamily: 'codex-app-server-json', riskMode: 'recommended' },
    },
  });
  const parentManifest = await getRunManifest(parent.id);

  const editOptions = {
    prompt: 'Edited prompt.',
    requestId: 'request-edited',
    skipDispatch: true,
  };
  const [firstEditAttempt, replayedEditAttempt] = await Promise.all([
    resendEditedMessage(session.id, 'request-parent', editOptions),
    resendEditedMessage(session.id, 'request-parent', editOptions),
  ]);
  const edited = firstEditAttempt.duplicate ? replayedEditAttempt : firstEditAttempt;
  const replayed = firstEditAttempt.duplicate ? firstEditAttempt : replayedEditAttempt;
  assert.equal(replayed.duplicate, true, 'a replayed edit request must return the accepted child Run');
  assert.equal(replayed.run.id, edited.run.id, 'concurrent retries must not publish duplicate Runs');
  const editedManifest = await getRunManifest(edited.run.id);
  assert.equal(editedManifest.id, edited.run.id);
  assert.equal(editedManifest.requestId, 'request-edited');
  assert.notEqual(editedManifest.runPublication.publicationId, parentManifest.runPublication.publicationId);
  assert.equal(editedManifest.attachmentStaging, undefined, 'stale parent staging must not cross the Run boundary');
  assert.equal((await getRun(parent.id)).supersededByRunId, edited.run.id);

  await updateRun(edited.run.id, (current) => ({ ...current, state: 'completed' }));
  const regenerated = await regenerateSessionReply(session.id, 'request-edited', {
    requestId: 'request-regenerated',
    skipDispatch: true,
  });
  const regeneratedManifest = await getRunManifest(regenerated.run.id);
  assert.equal(regeneratedManifest.id, regenerated.run.id);
  assert.equal(regeneratedManifest.requestId, 'request-regenerated');
  assert.notEqual(regeneratedManifest.runPublication.publicationId, editedManifest.runPublication.publicationId);
  assert.equal(regeneratedManifest.attachmentStaging, undefined);
  assert.equal((await getRun(edited.run.id)).supersededByRunId, regenerated.run.id);

  // Request identity and publication metadata remain owned by the parent.
  assert.equal(parentManifest.id, parent.id);
  assert.equal(parentManifest.runPublication.publicationId, (await getRunManifest(parent.id)).runPublication.publicationId);
  console.log('test-derived-run-publication: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}

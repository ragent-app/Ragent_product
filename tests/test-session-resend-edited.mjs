#!/usr/bin/env node
// A1 edit-resend (backend): resendEditedMessage replaces the LAST user
// message's run with one built from the edited prompt — fresh provider
// thread, old run superseded, run_regenerate marker carrying the edited
// prompt for the version-rail client patch. History stays append-only: no
// new user message is echoed, the original text remains in the event log.
import assert from 'assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-resend-edited-'));
process.env.HOME = home;

const {
  createSession,
  getHistory,
  getSession,
  killAll,
  regenerateSessionReply,
  resendEditedMessage,
  submitHttpMessage,
} = await import('../chat/session-manager.mjs');
const { getRun, getRunManifest, updateRun } = await import('../chat/runs.mjs');
const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { publishLocalFileAssetFromPath } = await import('../chat/file-assets.mjs');

function makeTerminal(runId) {
  return updateRun(runId, (current) => ({
    ...current,
    state: 'completed',
    completedAt: new Date().toISOString(),
  }));
}

try {
  const session = await createSession(home, 'codex', 'Edit resend source', {
    description: 'Source conversation to edit from',
  });
  const attachmentSourcePath = join(home, 'source.txt');
  writeFileSync(attachmentSourcePath, 'attachment survives replay\n', 'utf8');
  const sourceAsset = await publishLocalFileAssetFromPath({
    sessionId: session.id,
    localPath: attachmentSourcePath,
    originalName: 'source.txt',
    mimeType: 'text/plain',
  });

  const original = await submitHttpMessage(session.id, 'Original question', [], {
    preSavedAttachments: [{
    assetId: sourceAsset.id,
    originalName: 'source.txt',
    mimeType: 'text/plain',
    }],
    requestId: 'req_original',
    skipDispatch: true,
  });
  const originalRunId = original.run.id;
  const originalManifest = await getRunManifest(originalRunId);
  assert.equal(originalManifest.id, originalRunId, 'source manifest must be bound to its own Run');
  assert.ok(originalManifest.runPublication?.publicationId, 'source manifest must carry its publication identity');
  assert.equal(originalManifest.options.images[0].assetId, sourceAsset.id, 'normal submit should stage the exact asset id');
  assert.match(originalManifest.options.images[0].relativePath, /^inputs[\\/]fasset_[a-f0-9]{24}\.txt$/);
  assert.equal(originalManifest.options.images[0].inputPath, undefined, 'manifest must not expose an absolute input path');
  assert.equal(originalManifest.options.images[0].savedPath, undefined, 'manifest must not carry the source path');
  assert.equal(originalManifest.attachmentStaging.scope.runId, originalRunId, 'normal submit staging must bind to its Run');
  assert.ok(originalRunId, 'source run should be created');
  await makeTerminal(originalRunId);

  // Validation guards: edited prompt required, source run must exist and be
  // finished.
  await assert.rejects(
    () => resendEditedMessage(session.id, 'req_original', {}),
    /edited prompt is required/,
    'missing edited prompt should be rejected',
  );
  await assert.rejects(
    () => resendEditedMessage(session.id, 'req_unknown', { prompt: 'Edited' }),
    /source run not found/,
    'unknown source requestId should be rejected',
  );
  const running = await submitHttpMessage(session.id, 'Another question', [], {
    requestId: 'req_running',
    skipDispatch: true,
  });
  await assert.rejects(
    () => resendEditedMessage(session.id, 'req_running', { prompt: 'Edited' }),
    /finished run/,
    'non-terminal source run should be rejected',
  );

  const outcome = await resendEditedMessage(session.id, 'req_original', {
    prompt: 'Edited question',
    skipDispatch: true,
  });
  assert.ok(outcome.run, 'edit-resend should create a new run');
  assert.notEqual(outcome.run.requestId, 'req_original', 'new run should get its own requestId');

  // The status record stores a fixed field set (createRunRecord drops
  // non-standard fields), so edit-resend semantics live on the manifest —
  // which getRun never surfaces; it must be read from manifest.json.
  const run = await getRun(outcome.run.id);
  const manifest = await getRunManifest(outcome.run.id);
  assert.ok(manifest, 'edit-resend should persist a prompt manifest');
  assert.equal(manifest.id, outcome.run.id, 'edit-resend must bind the child manifest to the new Run');
  assert.notEqual(manifest.runPublication.publicationId, originalManifest.runPublication.publicationId,
    'edit-resend must receive a fresh publication identity');
  assert.equal(manifest.editResend, true, 'manifest should carry the edit-resend flag');
  assert.equal(manifest.regenerate, true, 'edit-resend should share the regenerate rail semantics');
  assert.equal(manifest.regenerateParentRequestId, 'req_original', 'manifest should fold under the original user request');
  assert.equal(manifest.editResendParentRequestId, 'req_original', 'manifest should record the edited source request');
  assert.equal(manifest.internalOperation, 'editResend', 'manifest should record the internal operation');
  assert.equal(manifest.options.freshThread, true, 'edit-resend must run on a fresh provider thread');
  assert.ok(typeof manifest.prompt === 'string' && manifest.prompt.length > 0, 'manifest should carry the rebuilt prompt envelope');
  assert.equal(manifest.options.codexResume, undefined, 'edit-resend must not carry provider resume state');
  assert.equal(manifest.options.images[0].assetId, sourceAsset.id, 'edit-resend should re-stage the parent asset');
  assert.equal(manifest.options.images[0].inputPath, undefined, 'edit-resend must not expose an absolute input path');
  assert.equal(manifest.attachmentStaging.scope.runId, outcome.run.id, 'edit-resend staging must bind to the new Run');
  assert.equal(manifest.attachmentStaging.operations[0].requestBinding.runId, outcome.run.id, 'edit-resend operation must bind to the new Run');
  assert.equal(run.state, 'accepted', 'new run should be accepted');

  const supersededParent = await getRun(originalRunId);
  assert.equal(supersededParent.supersededByRequestId, outcome.run.requestId, 'source run should be superseded');
  assert.equal(supersededParent.supersededByRunId, outcome.run.id, 'source run should point at the replacement');

  const history = await getHistory(session.id);
  const userEvents = history.filter((event) => event.type === 'message' && event.role === 'user');
  assert.equal(userEvents.length, 2, 'no new user message should be echoed (original + running fixture)');
  const marker = history.filter((event) => event.type === 'run_regenerate').at(-1);
  assert.ok(marker, 'edit-resend should append a run_regenerate marker');
  assert.equal(marker.editResend, true, 'marker should be flagged as an edit');
  assert.equal(marker.prompt, 'Edited question', 'marker should carry the exact edited prompt for the client patch');
  assert.equal(marker.parentRequestId, 'req_original', 'marker should fold under the original user request');
  assert.equal(marker.runId, outcome.run.id, 'marker should reference the replacement run');

  // Editing an edit again keeps folding under the ORIGINAL requestId.
  await makeTerminal(outcome.run.id);
  const second = await resendEditedMessage(session.id, outcome.run.requestId, {
    prompt: 'Edited question v2',
    skipDispatch: true,
  });
  const secondRun = await getRun(second.run.id);
  const secondManifest = await getRunManifest(second.run.id);
  assert.equal(secondManifest.id, second.run.id, 'repeated edit-resend must bind the next child manifest');
  assert.notEqual(secondManifest.runPublication.publicationId, manifest.runPublication.publicationId,
    'each edit-resend must get a distinct publication identity');
  assert.equal(secondManifest.regenerateParentRequestId, 'req_original', 'v2 edit should still fold under the original user request');
  assert.equal(secondManifest.editResendParentRequestId, outcome.run.requestId, 'v2 edit should record its immediate source');
  const marker2 = (await getHistory(session.id)).filter((event) => event.type === 'run_regenerate').at(-1);
  assert.equal(marker2.prompt, 'Edited question v2', 'v2 marker should carry the v2 prompt');
  assert.equal(marker2.parentRequestId, 'req_original', 'v2 marker should keep the original rail');

  // Regression: regenerateSessionReply used to read parentRun.manifest (the
  // status record never carries it — prompts live in manifest.json) and
  // rejected every call with "no prompt manifest". After an edit chain, the
  // rail root must also be read from the manifest, not the record.
  await makeTerminal(secondRun.id);
  const regen = await regenerateSessionReply(session.id, secondRun.requestId, {
    requestId: 'req_regenerated',
    skipDispatch: true,
  });
  const regenRun = await getRun(regen.run.id);
  const regenManifest = await getRunManifest(regen.run.id);
  assert.equal(regenManifest.id, regen.run.id, 'regenerate must bind the child manifest to the new Run');
  assert.notEqual(regenManifest.runPublication.publicationId, secondManifest.runPublication.publicationId,
    'regenerate must get a fresh publication identity');
  assert.equal(regenManifest.regenerateParentRequestId, 'req_original', 'regenerate after an edit keeps the ORIGINAL rail root');
  assert.equal(regenManifest.options.images[0].assetId, sourceAsset.id, 'regenerate should re-stage the parent asset');
  assert.equal(regenManifest.options.images[0].inputPath, undefined, 'regenerate must not expose an absolute input path');
  assert.equal(regenManifest.attachmentStaging.scope.runId, regen.run.id, 'regenerate staging must bind to the new Run');
  const regenMarker = (await getHistory(session.id)).filter((event) => event.type === 'run_regenerate').at(-1);
  assert.equal(regenMarker.parentRequestId, 'req_original', 'regenerate marker keeps the original rail');
  assert.equal(regenMarker.editResend, undefined, 'plain regenerate must not be flagged as an edit');
  assert.equal(regenMarker.runId, regen.run.id, 'regenerate marker should reference the regen run');

  // Cross-agent resend: explicit tool/model/effort overrides replace the
  // source run's runtime contract for this run only — the session itself
  // keeps its own defaults (resend-edited never rebinds session.tool).
  const cross = await resendEditedMessage(session.id, 'req_original', {
    prompt: 'Cross-agent resend',
    tool: 'claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    thinking: true,
    skipDispatch: true,
  });
  const crossRun = await getRun(cross.run.id);
  const crossManifest = await getRunManifest(cross.run.id);
  assert.equal(crossRun.tool, 'claude-bidi', 'risk-gated Claude override should use the bidi runtime');
  assert.equal(crossRun.model, 'claude-sonnet-5', 'override model should land on the run record');
  assert.equal(crossRun.effort, 'high', 'override effort should land on the run record');
  assert.equal(crossRun.thinking, true, 'override thinking should land on the run record');
  assert.equal(crossRun.runtimeFamily, 'claude-stream-json-bidi', 'runtime family should re-derive for the override tool');
  assert.equal(crossRun.permissionMode, 'default', 'risk-gated Claude override should use the default approval channel');
  assert.equal(crossManifest.options.model, 'claude-sonnet-5', 'manifest options should carry the override model');
  assert.equal(crossManifest.options.effort, 'high', 'manifest options should carry the override effort');
  assert.equal(crossManifest.options.thinking, true, 'manifest options should carry the override thinking');
  assert.equal(crossManifest.options.runtimeFamily, 'claude-stream-json-bidi', 'manifest options should carry the bidi runtime family');
  const crossSession = await getSession(session.id);
  assert.equal(crossSession.tool, 'codex', 'session default tool must NOT be rebound by a per-run override');
  const crossMarker = (await getHistory(session.id)).filter((event) => event.type === 'run_regenerate').at(-1);
  assert.equal(crossMarker.parentRequestId, 'req_original', 'cross-agent resend keeps the original rail');
  await makeTerminal(cross.run.id);

  // activeRunId lives on the session meta (the client-facing session shape
  // strips it), so read it from the meta store.
  const finalMeta = await findSessionMeta(session.id);
  assert.equal(finalMeta.activeRunId, cross.run.id, 'session meta should point at the latest run');
  console.log('test-session-resend-edited: ok');
} finally {
  await killAll();
}

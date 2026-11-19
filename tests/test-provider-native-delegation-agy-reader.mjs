#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-agy-reader-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_PROVIDER_HOMES_DIR = join(tempHome, 'provider-homes');
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const {
  createMemberReader,
  readProviderMemberEvents,
} = await import('../chat/adapters/provider-native-delegation.mjs');
const { normalizeDelegationEvent } = await import('../chat/delegation-canonical.mjs');
const { capturedMember, listMemberEvents } = await import('../chat/organization-member-aggregation.mjs');
const { handleOrganizationRoutes } = await import('../chat/router-organization-routes.mjs');
const { createSession, killAll } = await import('../chat/session-manager.mjs');
const {
  appendRunSpoolRecord,
  createRun,
  flushRunSpool,
  updateRun,
} = await import('../chat/runs.mjs');
const { canonicalDelegationSpoolRecord } = await import('../chat/provider-native-delegation-runtime.mjs');

function responseProbe() {
  const state = { status: 0, payload: null, headers: {} };
  return {
    state,
    setHeader(key, value) { state.headers[key] = value; },
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers || {}); },
    end(body) { state.payload = body ? JSON.parse(body) : null; },
  };
}

try {
  // 1. Direct createMemberReader disk + wire integration, transcript honesty & path-containment safety
  const appDataDir = join(tempHome, 'isolated-agy', '.gemini', 'antigravity-cli');
  const parentConvId = 'agy-parent-uuid-1';
  const echoerConvId = 'agy-echoer-uuid-1';
  const subagentConvId = 'agy-subagent-uuid-1';
  const noTranscriptConvId = 'agy-missing-log-uuid-1';
  const partialConvId = 'agy-partial-uuid-1';

  const parentSysDir = join(appDataDir, 'brain', parentConvId, '.system_generated');
  mkdirSync(join(parentSysDir, 'subagents'), { recursive: true });
  mkdirSync(join(parentSysDir, 'swarm'), { recursive: true });
  mkdirSync(join(appDataDir, 'brain', echoerConvId, '.system_generated', 'logs'), { recursive: true });
  mkdirSync(join(appDataDir, 'brain', partialConvId, '.system_generated', 'logs'), { recursive: true });

  writeFileSync(
    join(parentSysDir, 'subagents', `${subagentConvId}.json`),
    JSON.stringify({
      conversationId: subagentConvId,
      subagentDescriptor: { typeName: 'reviewer', role: 'Independent Verifier' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 4,
    }),
  );

  writeFileSync(
    join(parentSysDir, 'swarm', 'members.json'),
    JSON.stringify({
      title: 'Swarm Alpha',
      members: {
        coordinator: { conversation_id: parentConvId, role: 'coordinator', phase: 'RUNNING' },
        echoer: {
          conversation_id: echoerConvId,
          role: 'worker',
          phase: 'RUNNING',
          model: 'gemini-3.8-flash-low',
          killed: false,
        },
        silent: {
          conversation_id: noTranscriptConvId,
          role: 'reviewer',
          phase: 'WAITING',
          killed: false,
        },
        partialWorker: {
          conversation_id: partialConvId,
          role: 'worker',
          phase: 'COMPLETED',
          killed: false,
        },
      },
    }),
  );

  writeFileSync(
    join(parentSysDir, 'swarm', 'board.jsonl'),
    [
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        channel: 'main',
        text: '@echoer inspect module X with sk-ant-secretvalue9876543210',
        time: '2026-11-19T14:06:50Z',
        kind: 'brief',
      }),
      JSON.stringify({
        seq: 2,
        agent: 'echoer',
        channel: 'review',
        text: '@coordinator [done] checked #1',
        time: '2026-11-19T14:07:10Z',
        kind: 'done',
      }),
    ].join('\n') + '\n',
  );

  writeFileSync(
    join(appDataDir, 'brain', echoerConvId, '.system_generated', 'logs', 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-19T14:06:51Z',
        content: 'Inspect module X cleanly',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-19T14:07:00Z',
        thinking: 'PRIVATE_THOUGHT_MUST_NEVER_LEAK',
        content: 'Verified clean output without sk-ant-secretvalue9876543210',
        tool_calls: [{ name: 'read_file', arguments: { Path: 'chat/a.mjs' } }],
      }),
    ].join('\n') + '\n',
  );

  writeFileSync(
    join(appDataDir, 'brain', partialConvId, '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'truncated fragment',
      truncated_fields: ['content'],
    })}\n`,
  );

  // Escape symlink test inside brain/ (when platform permissions allow creating symlinks)
  const outsideSecretPath = join(tempHome, 'outside-secret.txt');
  writeFileSync(outsideSecretPath, '{"conversationId":"evil"}');
  let symlinkCreated = false;
  try {
    symlinkSync(outsideSecretPath, join(parentSysDir, 'subagents', 'escape.json'));
    symlinkCreated = true;
  } catch {
    // Windows without Developer Mode may disallow symlink creation for unprivileged user.
  }

  // Test path traversal member id / folder explicitly fails closed
  writeFileSync(
    join(parentSysDir, 'subagents', 'traversal.json'),
    JSON.stringify({
      conversationId: '../../outside',
      subagentDescriptor: { typeName: 'worker', role: 'Ignored' },
      state: 'SUBAGENT_STATE_ALIVE',
    }),
  );

  const wireRecords = [
    {
      stream: 'stdout',
      json: { event: 'init', conversation_id: parentConvId },
    },
    {
      stream: 'stdout',
      json: {
        event: 'step_update',
        step_update: {
          conversation_id: parentConvId,
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'swarm',
          tool_info: {
            name: 'swarm',
            parameters: { action: 'add', name: 'echoer' },
            output: JSON.stringify({ conversation_id: echoerConvId, status: 'added' }),
          },
        },
      },
    },
  ];

  const reader = createMemberReader({
    provider: 'antigravity',
    runId: 'run-agy-disk-1',
    parentSessionId: 'root-agy-disk-1',
    agyAppDataDir: appDataDir,
  });
  const consumed = await reader.consume(wireRecords, { sourceVerified: true });
  if (symlinkCreated) {
    assert.equal(consumed.gap, true, 'symlink escape inside subagents/ must set gap=true');
  }
  // Ensure wire + disk swarm:echoer deduped to ONE memberId (plus subagent, silent, partialWorker = 4 distinct members)
  const distinctMembers = new Map();
  for (const ev of consumed.snapshot) {
    distinctMembers.set(ev.memberId, ev);
  }
  assert.equal(distinctMembers.size, 4, `expected 4 deduplicated members, got ${distinctMembers.size}`);
  assert.equal([...distinctMembers.values()].some((m) => m.displayName === 'Ignored'), false, 'traversal conversationId rejected');

  const echoerEvent = [...distinctMembers.values()].find((m) => m.displayName === 'echoer');
  const silentEvent = [...distinctMembers.values()].find((m) => m.displayName === 'silent');
  const partialEvent = [...distinctMembers.values()].find((m) => m.displayName === 'partialWorker');
  assert.ok(echoerEvent && silentEvent && partialEvent);

  const echoerTranscript = reader.readCapturedMember(echoerEvent.memberId);
  assert.equal(echoerTranscript.scope, 'captured_only', 'external disk capture must never pretend full');
  assert.equal(echoerTranscript.coverage, 'partial');
  assert.equal(JSON.stringify(echoerTranscript.entries).includes('PRIVATE_THOUGHT_MUST_NEVER_LEAK'), false);
  assert.equal(JSON.stringify(echoerTranscript.entries).includes('secretvalue9876543210'), false);
  assert.ok(echoerTranscript.entries.some((e) => String(e.content || '').includes('Inspect module X cleanly')));

  const silentTranscript = reader.readCapturedMember(silentEvent.memberId);
  assert.equal(silentTranscript.entries.length, 0);
  assert.equal(silentTranscript.scope, 'activity_only');
  assert.equal(silentTranscript.coverage, 'activity_only');
  assert.equal(silentTranscript.availability, 'partial');

  const unknownTranscript = reader.readCapturedMember('nonexistent-member-id');
  assert.equal(unknownTranscript.scope, 'unavailable');
  assert.equal(unknownTranscript.availability, 'unavailable');

  const partialTranscript = reader.readCapturedMember(partialEvent.memberId);
  assert.equal(partialTranscript.scope, 'captured_only');
  assert.equal(partialTranscript.coverage, 'partial');
  assert.equal(partialTranscript.gap, true);
  assert.equal(partialTranscript.availability, 'partial');

  const board = reader.readBoard();
  assert.ok(board);
  assert.equal(board.schemaVersion, 1);
  assert.equal(board.readOnly, true);
  assert.equal(board.title, 'Swarm Alpha');
  assert.equal(board.channels.map((c) => c.name).includes('review'), true);
  assert.equal(board.messages.length, 2);
  assert.equal(board.messages[0].text.includes('secretvalue9876543210'), false);
  assert.equal(board.messages[1].replyToSeq, 1);

  const combinedDirect = await readProviderMemberEvents(wireRecords, {
    provider: 'agy',
    runId: 'run-agy-disk-2',
    parentSessionId: 'root-agy-disk-2',
    agyAppDataDir: appDataDir,
    sourceVerified: true,
  });
  assert.ok(combinedDirect.board);

  // 2. Full end-to-end aggregation & HTTP router (/members, /board, /conversation, /delegation-runs/:id/events)
  const agyManagedBrain = join(process.env.RAGENT_PROVIDER_HOMES_DIR, 'agy', '.gemini', 'antigravity-cli', 'brain');
  const liveParentConv = 'agy-live-parent-uuid';
  const liveChildConv = 'agy-live-child-uuid';
  mkdirSync(join(agyManagedBrain, liveParentConv, '.system_generated', 'swarm'), { recursive: true });
  mkdirSync(join(agyManagedBrain, liveChildConv, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(
    join(agyManagedBrain, liveParentConv, '.system_generated', 'swarm', 'members.json'),
    JSON.stringify({
      title: 'Live Board',
      members: {
        reviewer: { conversation_id: liveChildConv, role: 'reviewer', phase: 'RUNNING', model: 'gemini-4-neon-high' },
      },
    }),
  );
  writeFileSync(
    join(agyManagedBrain, liveParentConv, '.system_generated', 'swarm', 'board.jsonl'),
    `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@reviewer review PR', kind: 'brief' })}\n`,
  );
  writeFileSync(
    join(agyManagedBrain, liveChildConv, '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Review complete LGTM' })}\n`,
  );

  const rootSession = await createSession(join(tempHome, 'workspace'), 'agy', 'AgY Reader Integration', {
    suppressBroadcast: true,
  });
  const run = await createRun({
    status: {
      id: 'run_agy_http_int',
      sessionId: rootSession.id,
      requestId: 'req-agy-http-1',
      tool: 'agy',
      provider: 'antigravity',
      runtimeFamily: 'agy-acp',
      state: 'running',
      agyConversationId: liveParentConv,
    },
    manifest: {
      sessionId: rootSession.id,
      requestId: 'req-agy-http-1',
      tool: 'agy',
      prompt: 'test',
    },
  });

  const agySpawnEvent = normalizeDelegationEvent({
    provider: 'agy',
    providerDelegationId: 'call_live_sub_1',
    runId: run.id,
    parentSessionId: rootSession.id,
    childSessionId: liveChildConv,
    kind: 'spawned',
    state: 'spawned',
    seq: 1,
    timestamp: 1000,
    facts: { birthActor: 'root_session' },
  });
  await updateRun(run.id, (latest) => ({
    ...latest,
    agyConversationId: liveParentConv,
    providerNativeDelegation: {
      schemaVersion: 1,
      handled: true,
      delegations: [{
        delegationId: agySpawnEvent.delegationId,
        provider: 'agy',
        runId: run.id,
        parentRunId: run.id,
        parentSessionId: rootSession.id,
        childSessionId: liveChildConv,
        state: 'running',
      }],
    },
  }));
  await appendRunSpoolRecord(run.id, {
    stream: 'stdout',
    json: { event: 'init', conversation_id: liveParentConv },
  });
  await appendRunSpoolRecord(run.id, canonicalDelegationSpoolRecord(agySpawnEvent));
  await appendRunSpoolRecord(run.id, {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: liveParentConv,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_live_sub_1',
          name: 'invoke_subagent',
          status: 'completed',
          rawOutput: { conversation_id: liveChildConv },
        },
      },
    },
  });
  await flushRunSpool(run.id);

  const agg = await listMemberEvents(rootSession.id);
  assert.ok(agg.events.some((ev) => ev.sourceTag === 'agy' && ev.executionHarnessId === 'agy'));
  assert.ok(agg.board && agg.board.messages.length === 1);

  async function invokeRoute(method, pathname, authSession = { role: 'owner' }) {
    const res = responseProbe();
    await handleOrganizationRoutes({
      req: { method, headers: {}, url: pathname },
      res,
      pathname: pathname.split('?')[0],
      authSession,
      writeJson: (_r, status, body) => { res.state.status = status; res.state.payload = body; },
    });
    return res.state;
  }

  const membersRes = await invokeRoute('GET', `/api/sessions/${rootSession.id}/organization/members`);
  assert.equal(membersRes.status, 200);
  assert.ok(membersRes.payload.board);
  assert.equal(membersRes.payload.channels[0].name, 'main');
  const reviewerMember = membersRes.payload.members.find((m) => m.sourceTag === 'agy');
  assert.ok(reviewerMember);
  assert.equal(reviewerMember.executionHarnessId, 'agy');
  assert.equal(reviewerMember.controlCapabilities.readOnly, true);

  const boardDenied = await invokeRoute('GET', `/api/sessions/${rootSession.id}/organization/board`, { role: 'agent' });
  assert.equal(boardDenied.status, 403);
  const boardMethodDenied = await invokeRoute('POST', `/api/sessions/${rootSession.id}/organization/board`);
  assert.equal(boardMethodDenied.status, 405);
  const boardRes = await invokeRoute('GET', `/api/sessions/${rootSession.id}/organization/board`);
  assert.equal(boardRes.status, 200);
  assert.equal(boardRes.payload.board.title, 'Live Board');

  const convRes = await invokeRoute(
    'GET',
    `/api/sessions/${rootSession.id}/organization/members/${encodeURIComponent(reviewerMember.conversation.ref)}/conversation?limit=50`,
  );
  assert.equal(convRes.status, 200);
  assert.equal(convRes.payload.scope, 'captured_only');
  assert.equal(convRes.payload.coverage, 'partial');
  assert.ok(convRes.payload.entries.some((entry) => String(entry.content || '').includes('Review complete LGTM')));

  const delgEventsRes = await invokeRoute(
    'GET',
    `/api/sessions/${rootSession.id}/delegation-runs/${run.id}/events?afterLines=0`,
  );
  assert.equal(delgEventsRes.status, 200);
  const agySpawnView = delgEventsRes.payload.events.find((e) => e.kind === 'spawned');
  assert.equal(agySpawnView?.birthActor, 'root_session', 'delegation-runs events must expose root_session birthActor for agy');

  assert.equal(capturedMember(rootSession.id, run.id, reviewerMember.canonicalId).scope, 'captured_only');

  // 3. Monotonic wire/disk seq ordering & stale members.json non-regression
  const staleDiskAppData = join(tempHome, 'stale-disk-agy', '.gemini', 'antigravity-cli');
  const staleParentConv = 'agy-stale-parent-1';
  mkdirSync(join(staleDiskAppData, 'brain', staleParentConv, '.system_generated', 'swarm'), { recursive: true });
  writeFileSync(
    join(staleDiskAppData, 'brain', staleParentConv, '.system_generated', 'swarm', 'members.json'),
    JSON.stringify({
      members: {
        echoer: { conversation_id: 'agy-stale-child-1', role: 'worker', phase: 'RUNNING', killed: false },
      },
    }),
  );

  // 3a. Single batch: wire add -> wire kill while members.json is stale RUNNING
  const batchReader = createMemberReader({
    provider: 'agy',
    runId: 'run-stale-batch',
    parentSessionId: 'root-stale-batch',
    agyAppDataDir: staleDiskAppData,
  });
  const batchRes = await batchReader.consume([
    { stream: 'stdout', json: { event: 'init', conversation_id: staleParentConv } },
    {
      stream: 'stdout',
      json: {
        method: 'session/update',
        params: {
          sessionId: staleParentConv,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-add-1',
            name: 'swarm',
            status: 'completed',
            rawInput: { action: 'add', name: 'echoer', role: 'worker' },
            rawOutput: { status: 'added', conversation_id: 'agy-stale-child-1' },
          },
        },
      },
    },
    {
      stream: 'stdout',
      json: {
        method: 'session/update',
        params: {
          sessionId: staleParentConv,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-kill-1',
            name: 'swarm',
            status: 'completed',
            rawInput: { action: 'kill', name: 'echoer' },
            rawOutput: { status: 'killed' },
          },
        },
      },
    },
  ], { sourceVerified: true });
  const batchEchoerEvents = batchRes.snapshot.filter((e) => e.displayName === 'echoer');
  const batchLast = batchEchoerEvents.at(-1);
  assert.equal(batchLast?.phase, 'terminal');
  assert.equal(batchLast?.state, 'cancelled', 'stale RUNNING members.json must not revert wire kill');

  // 3a-ii. Single batch: wire add (no convId) -> wire model ('neon-high') while stale members.json still has old model ('flash-low')
  const staleModelAppData = join(tempHome, 'stale-model-agy', '.gemini', 'antigravity-cli');
  const staleModelParent = 'agy-stale-model-parent';
  mkdirSync(join(staleModelAppData, 'brain', staleModelParent, '.system_generated', 'swarm'), { recursive: true });
  writeFileSync(
    join(staleModelAppData, 'brain', staleModelParent, '.system_generated', 'swarm', 'members.json'),
    JSON.stringify({
      members: {
        echoer: { conversation_id: 'agy-stale-child-2', role: 'worker', phase: 'RUNNING', applied_model: 'gemini-3.8-flash-low' },
      },
    }),
  );
  const batchModelReader = createMemberReader({
    provider: 'agy',
    runId: 'run-stale-model',
    parentSessionId: 'root-stale-model',
    agyAppDataDir: staleModelAppData,
  });
  const batchModelRes = await batchModelReader.consume([
    { stream: 'stdout', json: { event: 'init', conversation_id: staleModelParent } },
    {
      stream: 'stdout',
      json: {
        method: 'session/update',
        params: {
          sessionId: staleModelParent,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-m-add',
            name: 'swarm',
            status: 'completed',
            rawInput: { action: 'add', name: 'echoer', role: 'worker', model: 'gemini-3.8-flash-low' },
            rawOutput: { status: 'added' },
          },
        },
      },
    },
    {
      stream: 'stdout',
      json: {
        method: 'session/update',
        params: {
          sessionId: staleModelParent,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-m-upd',
            name: 'swarm',
            status: 'completed',
            rawInput: { action: 'model', name: 'echoer', model: 'gemini-4-neon-high' },
            rawOutput: { status: 'updated', model: 'gemini-4-neon-high' },
          },
        },
      },
    },
  ], { sourceVerified: true });
  const batchModelLast = batchModelRes.snapshot.filter((e) => e.displayName === 'echoer').at(-1);
  assert.equal(batchModelLast?.model, 'gemini-4-neon-high', 'stale applied_model on disk must not revert wire model update');
  assert.equal(batchModelLast?.providerRef?.id, 'agy-stale-child-2', 'missing wire conversation_id still enriched from disk');

  // 3b. Incremental: disk sync FIRST -> wire model -> wire kill -> HTTP /members projection
  const incSession = await createSession(join(tempHome, 'workspace'), 'agy', 'Incremental Seq Test', {
    suppressBroadcast: true,
  });
  const incParentConv = 'agy-inc-parent-1';
  const incChildConv = 'agy-inc-child-1';
  const incSessionStorageDir = join(tempHome, 'stream1b-storage', 'by-session', 'hash-1', 'antigravity-cli');
  mkdirSync(join(incSessionStorageDir, 'brain', incParentConv, '.system_generated', 'swarm'), { recursive: true });
  mkdirSync(join(incSessionStorageDir, 'brain', incChildConv, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(
    join(incSessionStorageDir, 'brain', incParentConv, '.system_generated', 'swarm', 'members.json'),
    JSON.stringify({
      title: 'Incremental Board',
      members: {
        echoer: {
          conversation_id: incChildConv,
          role: 'worker',
          phase: 'RUNNING',
          applied_model: 'gemini-3.8-flash-low',
          killed: false,
        },
      },
    }),
  );
  writeFileSync(
    join(incSessionStorageDir, 'brain', incChildConv, '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Stream 1B storage trace' })}\n`,
  );

  const incRun = await createRun({
    status: {
      id: 'run_agy_inc_seq',
      sessionId: incSession.id,
      requestId: 'req-agy-inc-1',
      tool: 'agy',
      provider: 'agy',
      runtimeFamily: 'agy-acp',
      state: 'running',
      agyConversationId: incParentConv,
      agySessionStorageDir: incSessionStorageDir,
    },
    manifest: {
      sessionId: incSession.id,
      requestId: 'req-agy-inc-1',
      tool: 'agy',
      prompt: 'test',
    },
  });
  await updateRun(incRun.id, (latest) => ({
    ...latest,
    agyConversationId: incParentConv,
    agySessionStorageDir: incSessionStorageDir,
  }));
  await appendRunSpoolRecord(incRun.id, {
    stream: 'stdout',
    json: { event: 'init', conversation_id: incParentConv },
  });
  await flushRunSpool(incRun.id);

  // Tick 1: disk discovers echoer first (no hardcoded 2000+ seq) + Stream 1B agySessionStorageDir interop
  const tick1Members = await invokeRoute('GET', `/api/sessions/${incSession.id}/organization/members`);
  assert.equal(tick1Members.status, 200);
  const tick1Echoer = tick1Members.payload.members.find((m) => m.displayName === 'echoer');
  assert.ok(tick1Echoer, 'Stream 1B agySessionStorageDir must resolve echoer from disk');
  assert.equal(tick1Echoer.activity.state, 'working');
  assert.ok(tick1Echoer.activity.sourceSeq < 1000, 'disk sync seq must be monotonic small integer, not hardcoded 1000+/2000+');
  assert.equal(tick1Echoer.model, 'gemini-3.8-flash-low');
  const tick1Conv = await invokeRoute(
    'GET',
    `/api/sessions/${incSession.id}/organization/members/${encodeURIComponent(tick1Echoer.conversation.ref)}/conversation?limit=20`,
  );
  assert.equal(tick1Conv.status, 200);
  assert.ok(tick1Conv.payload.entries.some((entry) => String(entry.content || '').includes('Stream 1B storage trace')));

  // Tick 2: wire swarm(model) then wire swarm(kill) after earlier disk sync while members.json stays stale RUNNING
  await appendRunSpoolRecord(incRun.id, {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: incParentConv,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-inc-model',
          name: 'swarm',
          status: 'completed',
          rawInput: { action: 'model', name: 'echoer', model: 'gemini-4-neon-high' },
          rawOutput: { status: 'updated', model: 'gemini-4-neon-high' },
        },
      },
    },
  });
  await flushRunSpool(incRun.id);
  const tick2Members = await invokeRoute('GET', `/api/sessions/${incSession.id}/organization/members`);
  const tick2Echoer = tick2Members.payload.members.find((m) => m.displayName === 'echoer');
  assert.equal(tick2Echoer?.model, 'gemini-4-neon-high', 'wire model update after earlier disk sync must apply');
  assert.ok(tick2Echoer.activity.sourceSeq > tick1Echoer.activity.sourceSeq);

  await appendRunSpoolRecord(incRun.id, {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: incParentConv,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-inc-kill',
          name: 'swarm',
          status: 'completed',
          rawInput: { action: 'kill', name: 'echoer' },
          rawOutput: { status: 'killed' },
        },
      },
    },
  });
  await flushRunSpool(incRun.id);
  const tick3Members = await invokeRoute('GET', `/api/sessions/${incSession.id}/organization/members`);
  const tick3Echoer = tick3Members.payload.members.find((m) => m.displayName === 'echoer');
  assert.equal(tick3Echoer?.activity.state, 'idle', 'wire kill after earlier disk sync must transition worker to idle even with stale members.json');
  assert.ok(tick3Echoer.activity.sourceSeq > tick2Echoer.activity.sourceSeq);

  // 4. Stream 1A sessions/<key> relative appData path resolution & safety boundaries
  const relGeminiDir = join(tempHome, 'stream1a-gemini');
  const relBrainDir = join(relGeminiDir, 'sessions', 's-1', 'brain');
  const relParentConv = 'agy-rel-parent-1';
  const relChildConv = 'agy-rel-child-1';
  mkdirSync(join(relBrainDir, relParentConv, '.system_generated', 'swarm'), { recursive: true });
  mkdirSync(join(relBrainDir, relChildConv, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(
    join(relBrainDir, relParentConv, '.system_generated', 'swarm', 'members.json'),
    JSON.stringify({
      members: {
        relWorker: { conversation_id: relChildConv, role: 'worker', phase: 'RUNNING', model: 'gemini-3.8-flash-low' },
      },
    }),
  );
  writeFileSync(
    join(relBrainDir, relChildConv, '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Stream 1A relative sessions path trace' })}\n`,
  );

  for (const variant of [
    { agyGeminiDir: relGeminiDir, agyAppDataRelDir: 'sessions/s-1' },
    { agyGeminiDir: relGeminiDir, agyAppDataDir: 'sessions/s-1' },
    { agyGeminiDir: relGeminiDir, appDataDirName: 'sessions/s-1' },
  ]) {
    const res = await readProviderMemberEvents(
      [{ stream: 'stdout', json: { event: 'init', conversation_id: relParentConv } }],
      {
        provider: 'agy',
        runId: `run-rel-${Object.keys(variant)[1]}`,
        parentSessionId: 'root-rel-1',
        sourceVerified: true,
        ...variant,
      },
    );
    assert.ok(
      res.snapshot.some((m) => m.displayName === 'relWorker'),
      `expected relative variant ${JSON.stringify(variant)} to resolve sessions/s-1`,
    );
  }

  // Reject unsafe traversal appDataDir variants rather than resolving against cwd
  for (const unsafeVariant of [
    { agyGeminiDir: relGeminiDir, agyAppDataDir: '../outside' },
    { agyGeminiDir: relGeminiDir, agyAppDataRelDir: 'sessions/../../outside' },
    { agyAppDataDir: 'sessions/s-1' }, // relative without geminiDir
  ]) {
    const unsafeRes = await readProviderMemberEvents(
      [{ stream: 'stdout', json: { event: 'init', conversation_id: relParentConv } }],
      {
        provider: 'agy',
        runId: 'run-rel-unsafe',
        parentSessionId: 'root-rel-unsafe',
        sourceVerified: true,
        ...unsafeVariant,
      },
    );
    assert.equal(unsafeRes.snapshot.length, 0, `unsafe relative path must fail closed: ${JSON.stringify(unsafeVariant)}`);
  }

  // Verify readRun / HTTP routes with Stream 1A agyGeminiDir + agyAppDataRelDir ('sessions/s-1')
  const relSession = await createSession(join(tempHome, 'workspace'), 'agy', 'Stream 1A Relative Storage', {
    suppressBroadcast: true,
  });
  const relRun = await createRun({
    status: {
      id: 'run_agy_rel_route',
      sessionId: relSession.id,
      requestId: 'req-agy-rel-1',
      tool: 'agy',
      provider: 'agy',
      runtimeFamily: 'agy-acp',
      state: 'running',
      agyConversationId: relParentConv,
      agyGeminiDir: relGeminiDir,
      agyAppDataRelDir: 'sessions/s-1',
    },
    manifest: {
      sessionId: relSession.id,
      requestId: 'req-agy-rel-1',
      tool: 'agy',
      prompt: 'test',
    },
  });
  await updateRun(relRun.id, (latest) => ({
    ...latest,
    agyConversationId: relParentConv,
    agyGeminiDir: relGeminiDir,
    agyAppDataRelDir: 'sessions/s-1',
  }));
  await appendRunSpoolRecord(relRun.id, {
    stream: 'stdout',
    json: { event: 'init', conversation_id: relParentConv },
  });
  await flushRunSpool(relRun.id);

  const relMembersRes = await invokeRoute('GET', `/api/sessions/${relSession.id}/organization/members`);
  assert.equal(relMembersRes.status, 200);
  const relMember = relMembersRes.payload.members.find((m) => m.displayName === 'relWorker');
  assert.ok(relMember, 'readRun must honor agyGeminiDir + agyAppDataRelDir sessions/s-1');
  const relConvRes = await invokeRoute(
    'GET',
    `/api/sessions/${relSession.id}/organization/members/${encodeURIComponent(relMember.conversation.ref)}/conversation?limit=20`,
  );
  assert.equal(relConvRes.status, 200);
  assert.ok(relConvRes.payload.entries.some((e) => String(e.content || '').includes('Stream 1A relative sessions path trace')));

  // 5. Real agy.exe 1.5.12 ACP invoke_subagent wire/disk correlation, stale SUBAGENT_STATE_ALIVE, & /delegation-runs events
  const realShapeSession = await createSession(join(tempHome, 'workspace'), 'agy', 'Real AgY ACP Subagent Shape', {
    suppressBroadcast: true,
  });
  const realParentConv = 'agy-real-parent-conv';
  const realChildConv = 'agy-real-child-conv';
  const realStorageDir = join(tempHome, 'real-shape-gemini', 'sessions', realShapeSession.id);
  mkdirSync(join(realStorageDir, 'brain', realParentConv, '.system_generated', 'subagents'), { recursive: true });
  mkdirSync(join(realStorageDir, 'brain', realChildConv, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(
    join(realStorageDir, 'brain', realParentConv, '.system_generated', 'subagents', `${realChildConv}.json`),
    JSON.stringify({
      conversationId: realChildConv,
      subagentDescriptor: { typeName: 'research', role: 'Simple Ping Responder' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 2,
    }),
  );
  writeFileSync(
    join(realStorageDir, 'brain', realChildConv, '.system_generated', 'logs', 'transcript.jsonl'),
    `${JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'SUBAGENT_LIVE_OK' })}\n`,
  );

  const realShapeRunId = 'run_agy_real_acp_subagent';
  let realShapeRun = await createRun({
    status: {
      id: realShapeRunId,
      sessionId: realShapeSession.id,
      requestId: 'req-real-acp-1',
      tool: 'agy',
      provider: 'agy',
      runtimeFamily: 'agy-acp',
      state: 'running',
      agyConversationId: realParentConv,
      agySessionStorageDir: realStorageDir,
    },
    manifest: {
      sessionId: realShapeSession.id,
      requestId: 'req-real-acp-1',
      tool: 'agy',
      prompt: 'subagent probe',
    },
  });
  await updateRun(realShapeRunId, (latest) => ({
    ...latest,
    agyConversationId: realParentConv,
    agySessionStorageDir: realStorageDir,
  }));
  // Wire invoke_subagent WITHOUT rawOutput.conversation_id (matches real agy.exe 1.5.12 ACP)
  await appendRunSpoolRecord(realShapeRunId, {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: realParentConv,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_real_sub_1',
          name: 'invoke_subagent',
          kind: 'other',
          title: 'Run invoke_subagent',
        },
      },
    },
  });
  await appendRunSpoolRecord(realShapeRunId, {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: realParentConv,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_real_sub_1',
          name: 'invoke_subagent',
          status: 'completed',
        },
      },
    },
  });
  await flushRunSpool(realShapeRunId);

  const { reconcileProviderNativeDelegationRun } = await import('../chat/provider-native-delegation-runtime.mjs');
  await reconcileProviderNativeDelegationRun({
    runId: realShapeRunId,
    terminalCandidate: { outcome: 'completed' },
    providerExited: true,
    providerExitedAtMs: 5000,
    getRun: async () => (await import('../chat/runs.mjs')).getRun(realShapeRunId),
    readRunSpoolRecords: async (id) => (await import('../chat/runs.mjs')).readRunSpoolRecords(id),
    appendRunSpoolRecord,
    updateRun,
  });
  await flushRunSpool(realShapeRunId);

  const realMembersRes = await invokeRoute('GET', `/api/sessions/${realShapeSession.id}/organization/members`);
  assert.equal(realMembersRes.status, 200);
  assert.equal(realMembersRes.payload.members.length, 1, 'wire invoke_subagent + disk subagents/*.json must deduplicate into 1 member');
  const realSubMember = realMembersRes.payload.members[0];
  assert.equal(realSubMember.displayName, 'Simple Ping Responder');
  assert.equal(realSubMember.role, 'research');
  assert.equal(realSubMember.activity.state, 'idle', 'stale SUBAGENT_STATE_ALIVE must not force working after invoke_subagent completed');

  const realConvRes = await invokeRoute(
    'GET',
    `/api/sessions/${realShapeSession.id}/organization/members/${encodeURIComponent(realSubMember.conversation.ref)}/conversation?limit=20`,
  );
  assert.equal(realConvRes.status, 200);
  assert.equal(realConvRes.payload.scope, 'captured_only');
  assert.equal(realConvRes.payload.coverage, 'partial');
  assert.ok(realConvRes.payload.entries.some((e) => String(e.content || '').includes('SUBAGENT_LIVE_OK')));

  const realDelgRes = await invokeRoute(
    'GET',
    `/api/sessions/${realShapeSession.id}/delegation-runs/${realShapeRunId}/events?afterLines=0`,
  );
  assert.equal(realDelgRes.status, 200);
  assert.equal(realDelgRes.payload.events.length, 2, '/delegation-runs/:runId/events must map ragent.member_event barrier events');
  assert.equal(realDelgRes.payload.events.find((e) => e.kind === 'spawned')?.birthActor, 'root_session');

  // Verify unmatched disk-only SUBAGENT_STATE_ALIVE settles once parentRunState becomes completed
  const orphanDiskAppData = join(tempHome, 'orphan-disk-agy', '.gemini', 'antigravity-cli');
  const orphanParentConv = 'agy-orphan-parent-1';
  const orphanChildConv = 'agy-orphan-child-1';
  mkdirSync(join(orphanDiskAppData, 'brain', orphanParentConv, '.system_generated', 'subagents'), { recursive: true });
  writeFileSync(
    join(orphanDiskAppData, 'brain', orphanParentConv, '.system_generated', 'subagents', `${orphanChildConv}.json`),
    JSON.stringify({
      conversationId: orphanChildConv,
      subagentDescriptor: { typeName: 'worker', role: 'Disk Only Subagent' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 1,
    }),
  );
  const orphanReader = createMemberReader({
    provider: 'agy',
    runId: 'run-orphan-disk-1',
    parentSessionId: 'root-orphan-disk-1',
    agyAppDataDir: orphanDiskAppData,
  });
  const orphanWhileRunning = await orphanReader.consume(
    [{ stream: 'stdout', json: { event: 'init', conversation_id: orphanParentConv } }],
    { sourceVerified: true, parentRunState: 'running' },
  );
  assert.equal(orphanWhileRunning.snapshot.at(-1)?.state, 'running');
  const orphanAfterComplete = await orphanReader.consume([], { sourceVerified: true, parentRunState: 'completed' });
  assert.equal(orphanAfterComplete.snapshot.at(-1)?.state, 'completed');
  assert.equal(orphanAfterComplete.snapshot.at(-1)?.phase, 'terminal');
  void realShapeRun;
} finally {
  try { await killAll(); } catch {}
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-provider-native-delegation-agy-reader: ok');

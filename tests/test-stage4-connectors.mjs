#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = process.env.RAGENT_TEST_TMPDIR || tmpdir();
mkdirSync(tempRoot, { recursive: true });
const tempHome = mkdtempSync(join(tempRoot, 'ragent-stage4-connectors-'));
const configDir = join(tempHome, 'config');
const dataDir = join(tempHome, 'data');
const workRootDir = join(tempHome, 'work-root');
const memoryDir = join(tempHome, 'memory');
mkdirSync(configDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(workRootDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });

process.env.ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.LOCALAPPDATA = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_DATA_DIR = dataDir;
process.env.RAGENT_WORK_ROOT_DIR = workRootDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';

const OWNER_ID = 'stage4-owner-1';
const OWNER_ACTOR = { kind: 'user', role: 'owner', principalId: OWNER_ID };

const dispatcherMod = await import('../lib/connector-action-dispatcher.mjs');
const githubMod = await import('../lib/connector-github.mjs');
const gmailMod = await import('../lib/connector-gmail.mjs');
const calendarMod = await import('../lib/connector-calendar.mjs');
const driveMod = await import('../lib/connector-drive.mjs');
const respCapabilities = await import('../chat/responsibility-capabilities.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const projects = await import('../chat/projects.mjs');
const sessionManager = await import('../chat/session-manager.mjs');

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function equal(actual, expected, msg) {
  assert.equal(actual, expected, msg);
  passed += 1;
}

function makeJsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function createStatefulGitHubMock() {
  const pulls = new Map();
  const comments = new Map();
  let nextPrNumber = 42;
  let nextCommentId = 9001;
  let postPullCalls = 0;
  let patchPullCalls = 0;
  let postCommentCalls = 0;
  let putMergeCalls = 0;
  let dropNextCreateResponse = false;
  let dropNextMergeResponse = false;

  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;

    if (target.startsWith('https://api.github.com/repos/octo/repo-a/pulls?')) {
      const urlObj = new URL(target);
      const state = urlObj.searchParams.get('state') || 'open';
      const head = urlObj.searchParams.get('head') || '';
      const base = urlObj.searchParams.get('base') || '';
      const headBranch = head.includes(':') ? head.split(':')[1] : head;
      const items = [...pulls.values()].filter((pr) => {
        if (state !== 'all' && pr.state !== state) return false;
        if (headBranch && pr.head.ref !== headBranch) return false;
        if (base && pr.base.ref !== base) return false;
        return true;
      });
      return makeJsonResponse(items);
    }

    if (target === 'https://api.github.com/repos/octo/repo-a/pulls' && method === 'POST') {
      postPullCalls += 1;
      const pr = {
        number: nextPrNumber++,
        title: body.title,
        body: body.body || '',
        state: 'open',
        draft: body.draft === true,
        merged: false,
        merge_commit_sha: '',
        user: { login: 'octo' },
        head: { ref: body.head, sha: 'sha-head-111' },
        base: { ref: body.base },
        created_at: '2026-11-22T07:00:00Z',
        updated_at: '2026-11-22T07:00:00Z',
        html_url: `https://github.com/octo/repo-a/pull/${nextPrNumber - 1}`,
      };
      pulls.set(pr.number, pr);
      if (dropNextCreateResponse) {
        dropNextCreateResponse = false;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return makeJsonResponse(pr, 201);
    }

    const singlePrMatch = target.match(/^https:\/\/api\.github\.com\/repos\/octo\/repo-a\/pulls\/(\d+)$/);
    if (singlePrMatch) {
      const prNum = Number(singlePrMatch[1]);
      const pr = pulls.get(prNum);
      if (!pr) return makeJsonResponse({ message: 'Not Found' }, 404);
      if (method === 'GET') return makeJsonResponse(pr);
      if (method === 'PATCH') {
        patchPullCalls += 1;
        if (body.title !== undefined) pr.title = body.title;
        if (body.body !== undefined) pr.body = body.body;
        if (body.state !== undefined) pr.state = body.state;
        if (body.base !== undefined) pr.base.ref = body.base;
        pr.updated_at = '2026-11-22T07:05:00Z';
        return makeJsonResponse(pr);
      }
    }

    const mergeMatch = target.match(/^https:\/\/api\.github\.com\/repos\/octo\/repo-a\/pulls\/(\d+)\/merge$/);
    if (mergeMatch && method === 'PUT') {
      putMergeCalls += 1;
      const prNum = Number(mergeMatch[1]);
      const pr = pulls.get(prNum);
      if (!pr) return makeJsonResponse({ message: 'Not Found' }, 404);
      if (pr.head.sha !== body.sha) {
        return makeJsonResponse({ message: 'Head branch was modified' }, 409);
      }
      pr.merged = true;
      pr.state = 'closed';
      pr.merged_at = '2026-11-22T07:10:00Z';
      pr.merge_commit_sha = `merge-sha-${prNum}`;
      if (dropNextMergeResponse) {
        dropNextMergeResponse = false;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return makeJsonResponse({ merged: true, sha: pr.merge_commit_sha, message: 'Pull Request successfully merged' });
    }

    const commentMatch = target.match(/^https:\/\/api\.github\.com\/repos\/octo\/repo-a\/issues\/(\d+)\/comments/);
    if (commentMatch) {
      const prNum = Number(commentMatch[1]);
      const list = comments.get(prNum) || [];
      if (method === 'GET') return makeJsonResponse(list);
      if (method === 'POST') {
        postCommentCalls += 1;
        const created = {
          id: nextCommentId++,
          body: body.body,
          html_url: `https://github.com/octo/repo-a/pull/${prNum}#issuecomment-${nextCommentId - 1}`,
          created_at: '2026-11-22T07:03:00Z',
        };
        list.push(created);
        comments.set(prNum, list);
        return makeJsonResponse(created, 201);
      }
    }

    return makeJsonResponse({ message: `Unhandled mock GitHub route: ${method} ${target}` }, 404);
  };

  return {
    fetchImpl,
    pulls,
    stats: () => ({ postPullCalls, patchPullCalls, postCommentCalls, putMergeCalls }),
    setDropNextCreateResponse: (v) => { dropNextCreateResponse = v; },
    setDropNextMergeResponse: (v) => { dropNextMergeResponse = v; },
  };
}

function createStatefulGmailMock() {
  const drafts = new Map();
  const messages = new Map();
  let nextDraftId = 1;
  let nextMsgId = 100;
  let sendCalls = 0;
  let draftCalls = 0;
  let mode = 'normal'; // 'normal' | 'missing_id' | 'timeout_and_sent' | 'timeout_and_lost'

  function decodeRawHeaders(rawB64Url) {
    const raw = Buffer.from(rawB64Url, 'base64url').toString('utf8');
    const [headPart] = raw.split(/\r?\n\r?\n/);
    return headPart.split(/\r?\n/).map((line) => {
      const idx = line.indexOf(':');
      return {
        name: line.slice(0, idx).trim(),
        value: line.slice(idx + 1).trim(),
      };
    });
  }

  const gmailClient = {
    users: {
      drafts: {
        create: async ({ requestBody }) => {
          draftCalls += 1;
          const id = `draft_${nextDraftId++}`;
          const msgId = `draft_msg_${nextDraftId}`;
          const headers = decodeRawHeaders(requestBody.message.raw);
          const record = { id, message: { id: msgId, labelIds: ['DRAFT'], payload: { headers } } };
          drafts.set(id, record);
          return { data: record };
        },
        get: async ({ id }) => {
          const d = drafts.get(id);
          if (!d) throw Object.assign(new Error('Draft not found'), { code: 404 });
          return { data: d };
        },
        list: async () => ({
          data: { drafts: [...drafts.values()].map((d) => ({ id: d.id })) },
        }),
      },
      messages: {
        send: async ({ requestBody }) => {
          sendCalls += 1;
          const headers = decodeRawHeaders(requestBody.raw);
          if (mode === 'missing_id') {
            return { data: {} };
          }
          if (mode === 'timeout_and_lost') {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return { data: {} };
          }
          const id = `msg_${nextMsgId++}`;
          const msg = {
            id,
            threadId: `thread_${id}`,
            labelIds: ['SENT'],
            snippet: 'Sent message snippet',
            payload: { headers },
          };
          messages.set(id, msg);
          if (mode === 'timeout_and_sent') {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          return { data: { id, threadId: msg.threadId, labelIds: ['SENT'] } };
        },
        get: async ({ id }) => {
          const msg = messages.get(id);
          if (!msg) throw Object.assign(new Error('Message not found'), { code: 404 });
          return { data: msg };
        },
        list: async ({ q = '' } = {}) => {
          const rfcMatch = /rfc822msgid:([^\s]+)/i.exec(q);
          const all = [...messages.values()];
          const filtered = rfcMatch
            ? all.filter((msg) => msg.payload.headers.some(
                (h) => h.name.toLowerCase() === 'message-id' && h.value.replace(/^<|>$/g, '') === rfcMatch[1],
              ))
            : all;
          return { data: { messages: filtered.map((m) => ({ id: m.id, threadId: m.threadId })) } };
        },
      },
    },
  };

  return {
    gmailClient,
    messages,
    drafts,
    stats: () => ({ sendCalls, draftCalls }),
    setMode: (next) => { mode = next; },
  };
}

function createStatefulCalendarMock() {
  const events = new Map();
  let insertCalls = 0;
  let patchCalls = 0;
  let deleteCalls = 0;
  let dropNextInsertResponse = false;

  const calendarClient = {
    events: {
      list: async () => ({ data: { items: [...events.values()] } }),
      get: async ({ eventId }) => {
        const ev = events.get(eventId);
        if (!ev) throw Object.assign(new Error('Not Found'), { code: 404, status: 404 });
        return { data: structuredClone(ev) };
      },
      insert: async ({ requestBody }) => {
        insertCalls += 1;
        const id = requestBody.id || `evt_${insertCalls}`;
        const ev = {
          ...structuredClone(requestBody),
          id,
          status: 'confirmed',
          etag: `"etag-${id}-1"`,
          sequence: 0,
          updated: '2026-11-22T07:00:00Z',
        };
        events.set(id, ev);
        if (dropNextInsertResponse) {
          dropNextInsertResponse = false;
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return { data: structuredClone(ev) };
      },
      patch: async ({ eventId, requestBody }) => {
        patchCalls += 1;
        const ev = events.get(eventId);
        if (!ev) throw Object.assign(new Error('Not Found'), { code: 404, status: 404 });
        const nextSeq = Number.isInteger(requestBody.sequence) ? requestBody.sequence : (ev.sequence || 0) + 1;
        const updated = {
          ...ev,
          ...structuredClone(requestBody),
          sequence: nextSeq,
          etag: `"etag-${eventId}-${nextSeq + 1}"`,
          updated: `2026-11-22T07:0${nextSeq}:00Z`,
          extendedProperties: requestBody.extendedProperties || ev.extendedProperties,
        };
        events.set(eventId, updated);
        return { data: structuredClone(updated) };
      },
      delete: async ({ eventId }) => {
        deleteCalls += 1;
        events.delete(eventId);
        return { data: {} };
      },
    },
  };

  return {
    calendarClient,
    events,
    stats: () => ({ insertCalls, patchCalls, deleteCalls }),
    setDropNextInsertResponse: (v) => { dropNextInsertResponse = v; },
  };
}

function createStatefulDriveMock() {
  const files = new Map();
  const contents = new Map();
  const permissions = new Map();
  let nextId = 1;
  let createCalls = 0;
  let updateCalls = 0;
  let shareCalls = 0;
  let dropNextUpdateResponse = false;

  // Seed one out-of-scope file inside 'folder-secret'
  files.set('file-secret-1', {
    id: 'file-secret-1',
    name: 'secrets.txt',
    mimeType: 'text/plain',
    parents: ['folder-secret'],
    headRevisionId: 'rev-secret-1',
    etag: 'etag-secret-1',
    version: '1',
    trashed: false,
    appProperties: {},
  });
  contents.set('file-secret-1', 'top-secret');

  const driveClient = {
    files: {
      list: async ({ q = '' } = {}) => {
        const match = /'([^']+)'\s+in\s+parents/.exec(q);
        const parentFilter = match ? match[1] : null;
        const matched = [...files.values()].filter((f) => {
          if (f.trashed) return false;
          if (parentFilter && !(f.parents || []).includes(parentFilter)) return false;
          return true;
        });
        return { data: { files: matched.map((f) => structuredClone(f)) } };
      },
      get: async ({ fileId, alt }) => {
        const f = files.get(fileId);
        if (!f) throw Object.assign(new Error('File not found'), { code: 404, status: 404 });
        if (alt === 'media') {
          return { data: contents.get(fileId) ?? '' };
        }
        return { data: structuredClone(f) };
      },
      create: async ({ requestBody, media }) => {
        createCalls += 1;
        const id = `drive_item_${nextId++}`;
        const file = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || 'text/plain',
          parents: Array.isArray(requestBody.parents) ? [...requestBody.parents] : [],
          headRevisionId: `rev-${id}-1`,
          etag: `etag-${id}-1`,
          version: '1',
          trashed: false,
          modifiedTime: '2026-11-22T07:00:00Z',
          webViewLink: `https://drive.google.com/file/d/${id}/view`,
          appProperties: requestBody.appProperties ? { ...requestBody.appProperties } : {},
        };
        files.set(id, file);
        if (media?.body !== undefined) contents.set(id, String(media.body));
        return { data: structuredClone(file) };
      },
      update: async ({ fileId, requestBody, media }) => {
        updateCalls += 1;
        const existing = files.get(fileId);
        if (!existing) throw Object.assign(new Error('File not found'), { code: 404, status: 404 });
        const nextVer = Number(existing.version || '1') + 1;
        const updated = {
          ...existing,
          ...(requestBody.name !== undefined ? { name: requestBody.name } : {}),
          ...(requestBody.mimeType !== undefined ? { mimeType: requestBody.mimeType } : {}),
          ...(requestBody.appProperties ? { appProperties: { ...existing.appProperties, ...requestBody.appProperties } } : {}),
          version: String(nextVer),
          headRevisionId: `rev-${fileId}-${nextVer}`,
          etag: `etag-${fileId}-${nextVer}`,
          modifiedTime: '2026-11-22T07:05:00Z',
        };
        files.set(fileId, updated);
        if (media?.body !== undefined) contents.set(fileId, String(media.body));
        if (dropNextUpdateResponse) {
          dropNextUpdateResponse = false;
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return { data: structuredClone(updated) };
      },
    },
    permissions: {
      create: async ({ fileId, requestBody }) => {
        shareCalls += 1;
        const list = permissions.get(fileId) || [];
        const perm = {
          id: `perm_${shareCalls}`,
          type: requestBody.type,
          role: requestBody.role,
          emailAddress: requestBody.emailAddress || '',
          domain: requestBody.domain || '',
        };
        list.push(perm);
        permissions.set(fileId, list);
        return { data: perm };
      },
      list: async ({ fileId }) => ({
        data: { permissions: structuredClone(permissions.get(fileId) || []) },
      }),
    },
  };

  return {
    driveClient,
    files,
    contents,
    stats: () => ({ createCalls, updateCalls, shareCalls }),
    setDropNextUpdateResponse: (v) => { dropNextUpdateResponse = v; },
  };
}

try {
  // =========================================================================
  // 1. Unified Action Contract validation
  // =========================================================================
  const validContract = dispatcherMod.validateConnectorActionContract({
    capability: 'github.pr.create',
    scope: { connectorId: 'github', resource: 'octo/repo-a', repository: 'octo/repo-a' },
    riskLevel: 'external_broadcast',
    idempotencyKey: 'key-contract-1',
    confirmationPolicy: 'require_approval',
    timeoutMs: 5000,
    receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => null },
    compensation: { supported: true, mode: 'compensating_action', description: 'Close PR' },
  });
  equal(validContract.riskLevel, 'external_broadcast', 'Valid contract validates cleanly');

  assert.throws(
    () => dispatcherMod.validateConnectorActionContract({
      capability: 'gmail.message.send',
      scope: { connectorId: 'gmail', resource: 'send:user@example.com' },
      riskLevel: 'external_broadcast',
      idempotencyKey: 'bad-auto-1',
      confirmationPolicy: 'auto_within_policy',
      timeoutMs: 5000,
      receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => null },
      compensation: { supported: false, mode: 'irreversible', description: 'Irreversible' },
    }),
    /cannot use confirmationPolicy "auto_within_policy"/,
    'Rejects auto_within_policy on external_broadcast',
  );
  passed += 1;

  assert.throws(
    () => dispatcherMod.validateConnectorActionContract({
      capability: 'github.pr.merge',
      scope: { connectorId: 'github', resource: 'octo/repo-a' },
      riskLevel: 'irreversible_write',
      idempotencyKey: 'bad-auto-2',
      confirmationPolicy: 'auto_within_policy',
      timeoutMs: 5000,
      receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => null },
      compensation: { supported: false, mode: 'irreversible', description: 'Irreversible' },
    }),
    /cannot use confirmationPolicy "auto_within_policy"/,
    'Rejects auto_within_policy on irreversible_write',
  );
  passed += 1;

  assert.throws(
    () => dispatcherMod.validateConnectorActionContract({
      capability: 'drive.file.update',
      scope: { connectorId: 'drive', resource: '*' },
      riskLevel: 'reversible_write',
      idempotencyKey: 'bad-wildcard',
      confirmationPolicy: 'require_approval',
      timeoutMs: 5000,
      receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => null },
      compensation: { supported: true, mode: 'compensating_action', description: 'Restore' },
    }),
    /must not contain wildcards/,
    'Rejects wildcard scope on write action',
  );
  passed += 1;

  assert.throws(
    () => dispatcherMod.validateConnectorActionContract({
      capability: 'custom.write',
      scope: { connectorId: 'custom', resource: 'item:1' },
      riskLevel: 'reversible_write',
      idempotencyKey: 'bad-verifier',
      confirmationPolicy: 'require_approval',
      timeoutMs: 5000,
      receiptVerifier: { kind: 'none_readonly', supported: false },
      compensation: { supported: false, mode: 'manual_only', description: 'Manual' },
    }),
    /cannot declare a readonly receiptVerifier/,
    'Write action cannot declare readonly receiptVerifier',
  );
  passed += 1;

  // =========================================================================
  // 2. Dispatcher gates, approval replay/bypass defense, ledger & compensation
  // =========================================================================
  const ledgerPath = join(configDir, 'test-stage4-ledger.sqlite');
  let dispatcher = dispatcherMod.createConnectorActionDispatcher({ ledgerPath });

  // Bypass attempt via withinPolicy / automated approver / mismatched digest
  let sideEffects = 0;
  const dangerousAction = {
    contract: {
      capability: 'custom.broadcast',
      scope: { connectorId: 'gmail', resource: 'send:team@example.com' },
      riskLevel: 'external_broadcast',
      idempotencyKey: 'adv-broadcast-1',
      confirmationPolicy: 'require_approval',
      timeoutMs: 1000,
      receiptVerifier: { kind: 'custom_verifier', supported: true, verify: async () => ({ verified: true, externalId: 'ext-1' }) },
      compensation: { supported: false, mode: 'irreversible', description: 'Cannot unsend' },
    },
    payload: { body: 'Hello' },
    execute: async () => {
      sideEffects += 1;
      return { externalId: 'ext-1' };
    },
  };

  const withinPolicyTry = await dispatcher.dispatch(dangerousAction, {
    policy: { withinPolicy: true, allowAutoWithinPolicyReversible: true },
  });
  equal(withinPolicyTry.state, 'pending_approval', 'withinPolicy cannot bypass external_broadcast approval');
  equal(withinPolicyTry.wireCrossed, false, 'pending_approval never crosses wire');

  const autoApproverTry = await dispatcher.dispatch(dangerousAction, {
    approval: { confirmed: true, approvedBy: 'responsibility-policy-auto' },
  });
  equal(autoApproverTry.state, 'denied', 'Automated approver cannot satisfy human approval');

  const modelApproverTry = await dispatcher.dispatch(dangerousAction, {
    actor: { kind: 'agent', principalId: 'planner-agent' },
    approval: { confirmed: true, approvedBy: 'planner-agent', actorKind: 'user' },
  });
  equal(modelApproverTry.state, 'denied', 'Non-user actor cannot self-approve even with spoofed actorKind');

  const nonOwnerOverrideTry = await dispatcher.dispatch(dangerousAction, {
    actor: { kind: 'user', role: 'member', principalId: 'member-1' },
    approval: { confirmed: true, approvedBy: 'member-1', ownerOverride: true },
  });
  equal(nonOwnerOverrideTry.state, 'denied', 'Non-owner user cannot bypass owner gate with ownerOverride');
  equal(nonOwnerOverrideTry.code, 'CONNECTOR_FORBIDDEN');

  const digestMismatchTry = await dispatcher.dispatch(dangerousAction, {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID, actionDigest: 'wrong-digest' },
  });
  equal(digestMismatchTry.state, 'denied', 'Approval actionDigest mismatch is denied');
  equal(sideEffects, 0, 'No side effects occurred during rejected approval attempts');

  // Hard deny overrides even valid approval
  const hardDenyRes = await dispatcher.dispatch({
    ...dangerousAction,
    contract: { ...dangerousAction.contract, idempotencyKey: 'hard-deny-1', confirmationPolicy: 'hard_deny' },
  }, {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-hard-deny' },
  });
  equal(hardDenyRes.state, 'denied', 'hard_deny cannot be overridden by approval');

  // Valid approval succeeds once and consumes approvalId; second different action cannot replay approvalId
  const validBroadcast = await dispatcher.dispatch(dangerousAction, {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-single-use-1' },
  });
  equal(validBroadcast.ok, true, 'Approved external_broadcast executes');
  equal(validBroadcast.state, 'delivered');
  equal(sideEffects, 1);

  const replayedApproval = await dispatcher.dispatch({
    ...dangerousAction,
    contract: { ...dangerousAction.contract, idempotencyKey: 'adv-broadcast-2' },
  }, {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-single-use-1' },
  });
  equal(replayedApproval.state, 'denied', 'Consumed approvalId cannot be replayed on a different action');
  equal(replayedApproval.code, 'CONNECTOR_APPROVAL_REPLAYED');

  // Compensation check: unsupported irreversible action vs supported reversible action
  const irrevComp = await dispatcher.compensate('adv-broadcast-1', {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(irrevComp.code, 'CONNECTOR_COMPENSATION_UNSUPPORTED', 'Irreversible action rejects automatic compensation');

  let compCalled = 0;
  const revAction = {
    contract: {
      capability: 'custom.rev',
      scope: { connectorId: 'calendar', resource: 'calendar:primary/event:1' },
      riskLevel: 'reversible_write',
      idempotencyKey: 'rev-comp-1',
      confirmationPolicy: 'require_approval',
      timeoutMs: 1000,
      receiptVerifier: { kind: 'custom_verifier', supported: true, verify: async () => ({ verified: true, externalId: 'evt-99' }) },
      compensation: { supported: true, mode: 'compensating_action', compensatingCapability: 'calendar.event.cancel', description: 'Cancel event' },
    },
    payload: { title: 'Sync' },
    execute: async () => ({ externalId: 'evt-99' }),
  };
  const revRes = await dispatcher.dispatch(revAction, {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-rev-1' },
  });
  equal(revRes.state, 'delivered');
  const compRes = await dispatcher.compensate('rev-comp-1', {
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-comp-1' },
    executeCompensation: async () => {
      compCalled += 1;
      return { externalId: 'evt-99-cancelled' };
    },
  });
  equal(compRes.ok, true, 'Supported compensation runs under explicit approval');
  equal(compCalled, 1);
  equal(dispatcher.getEntry('rev-comp-1').state, 'compensated');

  // =========================================================================
  // 3. GitHub Connector: PR create / update / comment / merge + receipt + gate
  // =========================================================================
  const gh = createStatefulGitHubMock();
  const ghPolicy = {
    allowedCapabilities: ['github.pull.list', 'github.pull.get', 'github.pr.create', 'github.pr.update', 'github.pr.comment', 'github.pr.merge'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: {
      github: {
        allowedRepositories: ['octo/repo-a'],
        allowedBaseBranches: ['main'],
      },
    },
  };

  // Out-of-scope repo blocked
  const ghOutOfScope = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'evil', repo: 'other-repo', title: 'Hijack', head: 'feat', base: 'main', idempotencyKey: 'gh-scope-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok', actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID } },
  );
  equal(ghOutOfScope.state, 'denied');
  equal(ghOutOfScope.code, 'CONNECTOR_SCOPE_VIOLATION', 'GitHub repo outside policy scope is denied');

  // PR create requires explicit approval even with withinPolicy=true
  const ghPrPending = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'repo-a', title: 'Stage 4 PR', head: 'feat/s4', base: 'main', body: 'Adds S4', idempotencyKey: 'gh-pr-create-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok' },
  );
  equal(ghPrPending.state, 'pending_approval', 'PR create enforces approval gate');

  // Timeout during PR create -> unknown_outcome, no blind replay across restart, reconcile recovers PR #42
  gh.setDropNextCreateResponse(true);
  const ghPrTimeout = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'repo-a', title: 'Stage 4 PR', head: 'feat/s4', base: 'main', body: 'Adds S4', idempotencyKey: 'gh-pr-create-1' },
    {
      policy: ghPolicy,
      fetchImpl: gh.fetchImpl,
      token: 'gh-tok',
      timeoutMs: 40,
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-pr-1' },
    },
  );
  equal(ghPrTimeout.state, 'unknown_outcome', 'Timed out PR create enters unknown_outcome');
  equal(ghPrTimeout.wireCrossed, true);

  // Wait briefly for mock server to finish persisting PR #42, simulate restart with fresh dispatcher
  await new Promise((r) => setTimeout(r, 150));
  dispatcher.close();
  dispatcher = dispatcherMod.createConnectorActionDispatcher({ ledgerPath });

  const ghPrReplayAttempt = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'repo-a', title: 'Stage 4 PR', head: 'feat/s4', base: 'main', body: 'Adds S4', idempotencyKey: 'gh-pr-create-1' },
    {
      policy: ghPolicy,
      fetchImpl: gh.fetchImpl,
      token: 'gh-tok',
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-pr-2' },
    },
  );
  equal(ghPrReplayAttempt.state, 'unknown_outcome');
  equal(ghPrReplayAttempt.blockedReplay, true, 'Refuses blind replay of unknown_outcome PR create after restart');
  equal(gh.stats().postPullCalls, 1, 'PR create POST only executed once');

  const ghPrCreateAction = githubMod.createGitHubConnectorAction(
    'github.pr.create',
    { owner: 'octo', repo: 'repo-a', title: 'Stage 4 PR', head: 'feat/s4', base: 'main', body: 'Adds S4' },
    { idempotencyKey: 'gh-pr-create-1', fetchImpl: gh.fetchImpl, token: 'gh-tok' },
  );
  const ghPrReconciled = await dispatcher.reconcile(ghPrCreateAction);
  equal(ghPrReconciled.ok, true, 'GitHub PR create reconciles via idempotency tag lookup');
  equal(ghPrReconciled.state, 'delivered');
  equal(ghPrReconciled.externalId, '42');

  // Idempotent dedup after delivered + conflict on altered payload with same idempotencyKey
  const ghPrDedup = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'repo-a', title: 'Stage 4 PR', head: 'feat/s4', base: 'main', body: 'Adds S4', idempotencyKey: 'gh-pr-create-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok', actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-pr-dedup' } },
  );
  equal(ghPrDedup.ok, true);
  equal(ghPrDedup.deduplicated, true, 'Delivered PR create deduplicates cleanly');
  equal(ghPrDedup.externalId, '42');
  equal(gh.stats().postPullCalls, 1, 'Dedup never invokes POST /pulls again');

  const ghPrPayloadConflict = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'repo-a', title: 'Different Title', head: 'feat/s4', base: 'main', body: 'Adds S4', idempotencyKey: 'gh-pr-create-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok', actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-pr-conf' } },
  );
  equal(ghPrPayloadConflict.state, 'conflict');
  equal(ghPrPayloadConflict.code, 'CONNECTOR_IDEMPOTENCY_CONFLICT', 'Idempotency key with changed payload is rejected');

  // PR update requires approval by default; with approval, stale SHA fails pre-wire; fresh SHA succeeds
  const ghUpdatePending = await dispatcher.dispatch(
    'github.pr.update',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, title: 'Updated Title', expectedHeadSha: 'sha-head-111', idempotencyKey: 'gh-pr-upd-pending' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok' },
  );
  equal(ghUpdatePending.state, 'pending_approval', 'PR update requires approval by default');

  const ghUpdateConflict = await dispatcher.dispatch(
    'github.pr.update',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, title: 'Updated Title', expectedHeadSha: 'stale-sha', idempotencyKey: 'gh-pr-upd-conflict' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok', actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-upd-c' } },
  );
  equal(ghUpdateConflict.state, 'conflict', 'PR update rejects stale head SHA pre-wire');
  equal(ghUpdateConflict.wireCrossed, false);
  equal(gh.stats().patchPullCalls, 0);

  const ghUpdateOk = await dispatcher.dispatch(
    'github.pr.update',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, title: 'Updated Title', expectedHeadSha: 'sha-head-111', idempotencyKey: 'gh-pr-upd-ok' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok', actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-upd-ok' } },
  );
  equal(ghUpdateOk.ok, true, 'PR update succeeds with matching head SHA and approval');

  // PR comment requires explicit approval (external_broadcast)
  const ghCommentPending = await dispatcher.dispatch(
    'github.pr.comment',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, body: 'Looks ready', idempotencyKey: 'gh-pr-cmt-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok' },
  );
  equal(ghCommentPending.state, 'pending_approval', 'PR comment requires explicit human approval');
  const ghCommentOk = await dispatcher.dispatch(
    'github.pr.comment',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, body: 'Looks ready', idempotencyKey: 'gh-pr-cmt-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok', actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-cmt-1' } },
  );
  equal(ghCommentOk.ok, true, 'Approved PR comment posts cleanly');

  // PR merge requires explicit approval + pinned head SHA + timeout recovery via getGitHubPull
  const ghMergePending = await dispatcher.dispatch(
    'github.pr.merge',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, sha: 'sha-head-111', idempotencyKey: 'gh-pr-merge-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-tok' },
  );
  equal(ghMergePending.state, 'pending_approval', 'PR merge enforces mandatory approval gate');

  gh.setDropNextMergeResponse(true);
  const ghMergeTimeout = await dispatcher.dispatch(
    'github.pr.merge',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, sha: 'sha-head-111', idempotencyKey: 'gh-pr-merge-1' },
    {
      policy: ghPolicy,
      fetchImpl: gh.fetchImpl,
      token: 'gh-tok',
      timeoutMs: 40,
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-merge-1' },
    },
  );
  equal(ghMergeTimeout.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 150));

  const ghMergeReplay = await dispatcher.dispatch(
    'github.pr.merge',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, sha: 'sha-head-111', idempotencyKey: 'gh-pr-merge-1' },
    {
      policy: ghPolicy,
      fetchImpl: gh.fetchImpl,
      token: 'gh-tok',
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gh-merge-2' },
    },
  );
  equal(ghMergeReplay.blockedReplay, true, 'PR merge never blindly replays after unknown_outcome');
  equal(gh.stats().putMergeCalls, 1);

  const ghMergeAction = githubMod.createGitHubConnectorAction(
    'github.pr.merge',
    { owner: 'octo', repo: 'repo-a', pullNumber: 42, sha: 'sha-head-111' },
    { idempotencyKey: 'gh-pr-merge-1', fetchImpl: gh.fetchImpl, token: 'gh-tok' },
  );
  const ghMergeReconciled = await dispatcher.reconcile(ghMergeAction);
  equal(ghMergeReconciled.ok, true, 'GitHub PR merge reconciles via getGitHubPull');
  equal(ghMergeReconciled.externalId, 'merge-sha-42');

  // =========================================================================
  // 4. Gmail Connector: read/draft vs send isolation + message ID verification
  // =========================================================================
  const gm = createStatefulGmailMock();
  const gmailDraftOnlyPolicy = {
    allowedCapabilities: ['gmail.message.list', 'gmail.message.read', 'gmail.draft.create'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: { gmail: { allowDraftOnly: true, allowedRecipients: ['partner@example.com'] } },
  };

  const draftRes = await dispatcher.dispatch(
    'gmail.draft.create',
    { to: 'partner@example.com', subject: 'Weekly Status', body: 'Draft body', idempotencyKey: 'gm-draft-1' },
    { policy: gmailDraftOnlyPolicy, gmailClient: gm.gmailClient },
  );
  equal(draftRes.ok, true, 'Draft creation succeeds within draft-only policy');
  check(Boolean(draftRes.result?.draftId), 'Draft returns draftId');
  equal(gm.stats().sendCalls, 0, 'Draft creation never calls messages.send');

  // Send strictly blocked by draft-only policy even with approval
  const sendBlockedByDraftPolicy = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Weekly Status', body: 'Send body', idempotencyKey: 'gm-send-blocked' },
    { policy: gmailDraftOnlyPolicy, gmailClient: gm.gmailClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID } },
  );
  equal(sendBlockedByDraftPolicy.state, 'denied', 'Draft-only policy strictly blocks gmail.message.send');

  // CRLF header injection rejected
  assert.throws(
    () => gmailMod.createGmailConnectorAction(
      'gmail.message.send',
      { to: 'partner@example.com\r\nBcc: evil@attacker.com', subject: 'Hi', body: 'x' },
      { idempotencyKey: 'gm-crlf', gmailClient: gm.gmailClient },
    ),
    /control characters are forbidden/,
    'Gmail rejects CRLF header injection',
  );
  passed += 1;

  const gmailSendPolicy = {
    allowedCapabilities: ['gmail.message.list', 'gmail.message.read', 'gmail.draft.create', 'gmail.message.send'],
    withinPolicy: true,
    connectorScopes: { gmail: { allowedRecipients: ['partner@example.com'] } },
  };

  // Send without approval -> pending_approval
  const sendPending = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Report', body: 'Final', idempotencyKey: 'gm-send-1' },
    { policy: gmailSendPolicy, gmailClient: gm.gmailClient },
  );
  equal(sendPending.state, 'pending_approval', 'gmail.message.send requires explicit human approval');

  // Send returning without message ID -> unknown_outcome
  gm.setMode('missing_id');
  const sendMissingId = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Missing ID', body: 'Body', idempotencyKey: 'gm-send-missing-id' },
    { policy: gmailSendPolicy, gmailClient: gm.gmailClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gm-miss' } },
  );
  equal(sendMissingId.state, 'unknown_outcome', 'Send without authoritative message ID stays unknown_outcome');

  // Timeout during send where provider lost send -> stays unknown_outcome after reconcile!
  gm.setMode('timeout_and_lost');
  const sendLostTimeout = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Lost', body: 'Body', idempotencyKey: 'gm-send-lost' },
    {
      policy: gmailSendPolicy,
      gmailClient: gm.gmailClient,
      timeoutMs: 40,
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gm-lost' },
    },
  );
  equal(sendLostTimeout.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));
  const lostAction = gmailMod.createGmailConnectorAction(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Lost', body: 'Body' },
    { idempotencyKey: 'gm-send-lost', gmailClient: gm.gmailClient },
  );
  const lostReconciled = await dispatcher.reconcile(lostAction);
  equal(lostReconciled.ok, false, 'Unconfirmed send stays unknown_outcome on reconcile');
  equal(lostReconciled.state, 'unknown_outcome');

  // Manual outcome review enforces owner role and keeps unknown_outcome immutable until verified
  await assert.rejects(
    () => dispatcher.recordOutcomeReview(
      { idempotencyKey: 'gm-send-lost', observation: 'observed_absent', evidence: 'Checked Sent folder' },
      { kind: 'agent', role: 'specialist', principalId: 'agent-1' },
    ),
    /Owner access required/,
    'Non-owner cannot record manual outcome review',
  );
  passed += 1;
  const reviewRes = await dispatcher.recordOutcomeReview(
    { idempotencyKey: 'gm-send-lost', observation: 'observed_absent', evidence: 'Checked Sent folder manually' },
    OWNER_ACTOR,
  );
  equal(reviewRes.state, 'unknown_outcome', 'Manual review records evidence without auto-clearing unknown_outcome');

  // Timeout during send where provider DID send -> reconciles via rfc822msgid receipt lookup!
  gm.setMode('timeout_and_sent');
  const sendTimeoutSent = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Delivered Timeout', body: 'Body', idempotencyKey: 'gm-send-timeout-ok' },
    {
      policy: gmailSendPolicy,
      gmailClient: gm.gmailClient,
      timeoutMs: 40,
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gm-tok' },
    },
  );
  equal(sendTimeoutSent.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));
  const sentBeforeReconcile = gm.stats().sendCalls;
  const replayBlockedSend = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Delivered Timeout', body: 'Body', idempotencyKey: 'gm-send-timeout-ok' },
    {
      policy: gmailSendPolicy,
      gmailClient: gm.gmailClient,
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-gm-tok-2' },
    },
  );
  equal(replayBlockedSend.blockedReplay, true, 'Never blindly re-sends email on unknown_outcome');
  equal(gm.stats().sendCalls, sentBeforeReconcile);

  const timeoutOkAction = gmailMod.createGmailConnectorAction(
    'gmail.message.send',
    { to: 'partner@example.com', subject: 'Delivered Timeout', body: 'Body' },
    { idempotencyKey: 'gm-send-timeout-ok', gmailClient: gm.gmailClient },
  );
  const reconciledSend = await dispatcher.reconcile(timeoutOkAction);
  equal(reconciledSend.ok, true, 'Reconciles sent email via deterministic rfc822msgid lookup');
  equal(reconciledSend.state, 'delivered');
  check(Boolean(reconciledSend.externalId), 'Reconciled email has authoritative messageId');

  // =========================================================================
  // 5. Calendar Connector: deterministic eventId receipt & etag/sequence conflicts
  // =========================================================================
  const cal = createStatefulCalendarMock();
  const calPolicy = {
    allowedCapabilities: ['calendar.event.list', 'calendar.event.get', 'calendar.event.create', 'calendar.event.update', 'calendar.event.cancel', 'calendar.event.delete'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: { calendar: { allowedCalendarIds: ['primary'] } },
  };

  cal.setDropNextInsertResponse(true);
  const calCreateTimeout = await dispatcher.dispatch(
    'calendar.event.create',
    {
      calendarId: 'primary',
      title: 'Architecture Review',
      startTime: '2026-12-01T09:00:00Z',
      endTime: '2026-12-01T10:00:00Z',
      idempotencyKey: 'cal-create-1',
    },
    {
      policy: calPolicy,
      calendarClient: cal.calendarClient,
      timeoutMs: 40,
      actor: OWNER_ACTOR,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-create-1' },
    },
  );
  equal(calCreateTimeout.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));
  const calCreateAction = calendarMod.createCalendarConnectorAction(
    'calendar.event.create',
    {
      calendarId: 'primary',
      title: 'Architecture Review',
      startTime: '2026-12-01T09:00:00Z',
      endTime: '2026-12-01T10:00:00Z',
    },
    { idempotencyKey: 'cal-create-1', calendarClient: cal.calendarClient },
  );
  const calReconciled = await dispatcher.reconcile(calCreateAction);
  equal(calReconciled.ok, true, 'Calendar create reconciles via deterministic eventId + actionDigest');
  const eventId = calReconciled.externalId;
  equal(cal.stats().insertCalls, 1);

  const fetchedEvent = await calendarMod.getCalendarEvent({ calendarId: 'primary', eventId, calendarClient: cal.calendarClient });
  equal(fetchedEvent.event.sequence, 0);

  // Update without precondition -> failed pre-dispatch (no patch!)
  const calNoGuard = await dispatcher.dispatch(
    'calendar.event.update',
    { calendarId: 'primary', eventId, title: 'Blind Overwrite', idempotencyKey: 'cal-upd-noguard' },
    { policy: calPolicy, calendarClient: cal.calendarClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-ng' } },
  );
  equal(calNoGuard.state, 'failed_pre_dispatch');
  equal(calNoGuard.code, 'CONNECTOR_CONFLICT_CHECK_REQUIRED', 'Calendar update requires etag/sequence check');
  equal(cal.stats().patchCalls, 0);

  // Update with stale etag -> conflict (no patch!)
  const calStaleEtag = await dispatcher.dispatch(
    'calendar.event.update',
    { calendarId: 'primary', eventId, title: 'Stale', expectedEtag: '"wrong-etag"', expectedSequence: 0, idempotencyKey: 'cal-upd-stale' },
    { policy: calPolicy, calendarClient: cal.calendarClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-stale' } },
  );
  equal(calStaleEtag.state, 'conflict', 'Calendar update detects stale ETag pre-wire');
  equal(calStaleEtag.wireCrossed, false);
  equal(cal.stats().patchCalls, 0);

  // Valid update with matching etag + sequence succeeds and increments sequence
  const calUpdateOk = await dispatcher.dispatch(
    'calendar.event.update',
    {
      calendarId: 'primary',
      eventId,
      title: 'Architecture Review v2',
      expectedEtag: fetchedEvent.event.etag,
      expectedSequence: fetchedEvent.event.sequence,
      idempotencyKey: 'cal-upd-ok',
    },
    { policy: calPolicy, calendarClient: cal.calendarClient, verifyReceiptAfterExecute: true, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-upd-ok' } },
  );
  equal(calUpdateOk.ok, true, 'Calendar update succeeds with valid ETag & sequence and verifies mutation receipt');

  // Cancel with stale sequence 0 (now sequence is 1) -> conflict!
  const calCancelStale = await dispatcher.dispatch(
    'calendar.event.cancel',
    { calendarId: 'primary', eventId, expectedSequence: 0, idempotencyKey: 'cal-cancel-stale' },
    { policy: calPolicy, calendarClient: cal.calendarClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-cstale' } },
  );
  equal(calCancelStale.state, 'conflict', 'Calendar cancel detects stale sequence');

  const afterUpdate = await calendarMod.getCalendarEvent({ calendarId: 'primary', eventId, calendarClient: cal.calendarClient });
  const calCancelOk = await dispatcher.dispatch(
    'calendar.event.cancel',
    { calendarId: 'primary', eventId, expectedEtag: afterUpdate.event.etag, expectedSequence: afterUpdate.event.sequence, idempotencyKey: 'cal-cancel-ok' },
    { policy: calPolicy, calendarClient: cal.calendarClient, verifyReceiptAfterExecute: true, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-cok' } },
  );
  equal(calCancelOk.ok, true, 'Calendar cancel succeeds with current ETag & sequence');

  // Hard delete requires mandatory approval (irreversible_write) + precondition check
  const afterCancel = await calendarMod.getCalendarEvent({ calendarId: 'primary', eventId, calendarClient: cal.calendarClient });
  const calDeletePending = await dispatcher.dispatch(
    'calendar.event.delete',
    { calendarId: 'primary', eventId, expectedEtag: afterCancel.event.etag, expectedSequence: afterCancel.event.sequence, idempotencyKey: 'cal-del-1' },
    { policy: calPolicy, calendarClient: cal.calendarClient },
  );
  equal(calDeletePending.state, 'pending_approval', 'Calendar delete enforces irreversible_write approval gate');
  const calDeleteOk = await dispatcher.dispatch(
    'calendar.event.delete',
    { calendarId: 'primary', eventId, expectedEtag: afterCancel.event.etag, expectedSequence: afterCancel.event.sequence, idempotencyKey: 'cal-del-1' },
    { policy: calPolicy, calendarClient: cal.calendarClient, verifyReceiptAfterExecute: true, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-cal-del-1' } },
  );
  equal(calDeleteOk.ok, true, 'Approved calendar delete succeeds and verifies absence');

  // =========================================================================
  // 6. Drive Connector: scoped read/list/create/update + etag + sharing gate
  // =========================================================================
  const drv = createStatefulDriveMock();
  const drivePolicy = {
    allowedCapabilities: ['drive.file.list', 'drive.file.get', 'drive.file.read', 'drive.folder.create', 'drive.file.create', 'drive.file.update', 'drive.file.share'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: {
      drive: {
        allowedFolderIds: ['folder-allowed'],
        allowedShareEmails: ['alice@example.com'],
        allowedShareDomains: ['example.com'],
        allowPublicExposure: false,
      },
    },
  };

  // Out-of-scope folder list & file read denied
  const drvListForbidden = await dispatcher.dispatch(
    'drive.file.list',
    { folderId: 'folder-secret', idempotencyKey: 'drv-list-forbidden' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvListForbidden.state, 'denied', 'Listing out-of-scope Drive folder is denied');

  const drvReadSecret = await dispatcher.dispatch(
    'drive.file.read',
    { fileId: 'file-secret-1', idempotencyKey: 'drv-read-secret' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvReadSecret.state, 'denied', 'Reading file outside allowedFolderIds is denied');
  equal(drvReadSecret.code, 'CONNECTOR_SCOPE_VIOLATION');
  equal(drvReadSecret.ok, false);

  // Path traversal name rejected
  assert.throws(
    () => driveMod.createDriveConnectorAction('drive.file.create', { name: '../escape.txt', parentId: 'folder-allowed' }, { idempotencyKey: 'drv-bad-name', driveClient: drv.driveClient }),
    /Invalid Drive file name/,
    'Drive rejects traversal characters in file name',
  );
  passed += 1;

  // Create folder & file inside scoped folder, list, read content, update with etag/revision conflict check
  const drvFolderForbidden = await dispatcher.dispatch(
    'drive.folder.create',
    { name: 'bad-sub', parentId: 'folder-secret', idempotencyKey: 'drv-folder-forbidden' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-fld-forb' } },
  );
  equal(drvFolderForbidden.state, 'denied', 'Creating subfolder outside allowedFolderIds is denied');

  const drvFolderOk = await dispatcher.dispatch(
    'drive.folder.create',
    { name: 'reports', parentId: 'folder-allowed', idempotencyKey: 'drv-folder-ok' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-fld-ok' } },
  );
  equal(drvFolderOk.ok, true, 'Creating subfolder inside allowedFolderIds succeeds');

  const drvCreateRes = await dispatcher.dispatch(
    'drive.file.create',
    { name: 'status.md', parentId: 'folder-allowed', mimeType: 'text/markdown', content: 'v1', idempotencyKey: 'drv-create-1' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-create-1' } },
  );
  equal(drvCreateRes.ok, true, 'Scoped Drive file creation succeeds');
  const createdFileId = drvCreateRes.externalId;

  const drvListOk = await dispatcher.dispatch(
    'drive.file.list',
    { folderId: 'folder-allowed', idempotencyKey: 'drv-list-ok' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvListOk.ok, true);
  equal(drvListOk.result.files.length, 2);
  check(drvListOk.result.files.some((f) => f.id === createdFileId), 'Listed scoped folder contains created file');

  const drvReadOk = await dispatcher.dispatch(
    'drive.file.read',
    { fileId: createdFileId, idempotencyKey: 'drv-read-ok' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvReadOk.ok, true);
  equal(drvReadOk.result.content, 'v1');
  const initialEtag = drvReadOk.result.etag;
  const initialRev = drvReadOk.result.revisionId;

  // Stale etag update fails pre-wire with conflict
  const drvUpdateStale = await dispatcher.dispatch(
    'drive.file.update',
    { fileId: createdFileId, content: 'v2-stale', expectedEtag: 'stale-etag', idempotencyKey: 'drv-upd-stale' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-upd-stale' } },
  );
  equal(drvUpdateStale.state, 'conflict', 'Drive update detects stale ETag pre-wire');
  equal(drvUpdateStale.wireCrossed, false);
  equal(drv.stats().updateCalls, 0);

  // Valid update with timeout -> unknown_outcome -> reconcile via ragentMutationDigest
  drv.setDropNextUpdateResponse(true);
  const drvUpdateTimeout = await dispatcher.dispatch(
    'drive.file.update',
    { fileId: createdFileId, content: 'v2', expectedEtag: initialEtag, expectedRevisionId: initialRev, idempotencyKey: 'drv-upd-ok' },
    { policy: drivePolicy, driveClient: drv.driveClient, timeoutMs: 40, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-upd-ok' } },
  );
  equal(drvUpdateTimeout.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));
  const drvUpdateAction = driveMod.createDriveConnectorAction(
    'drive.file.update',
    { fileId: createdFileId, content: 'v2', expectedEtag: initialEtag, expectedRevisionId: initialRev, allowedFolderIds: ['folder-allowed'] },
    { idempotencyKey: 'drv-upd-ok', driveClient: drv.driveClient },
  );
  const drvUpdateReconciled = await dispatcher.reconcile(drvUpdateAction);
  equal(drvUpdateReconciled.ok, true, 'Drive update reconciles via ragentMutationDigest');
  equal(drv.contents.get(createdFileId), 'v2');

  // Sharing / public exposure strictly gated as external_broadcast
  const drvShareNoApproval = await dispatcher.dispatch(
    'drive.file.share',
    { fileId: createdFileId, type: 'user', role: 'reader', emailAddress: 'alice@example.com', idempotencyKey: 'drv-share-noappr' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvShareNoApproval.state, 'pending_approval', 'Drive sharing requires explicit approval despite withinPolicy');

  const drvPublicDenied = await dispatcher.dispatch(
    'drive.file.share',
    { fileId: createdFileId, type: 'anyone', role: 'reader', allowPublicExposure: true, idempotencyKey: 'drv-share-public' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-pub' } },
  );
  equal(drvPublicDenied.state, 'denied', 'Public Drive exposure denied by policy');

  const drvShareOutOfAllowlist = await dispatcher.dispatch(
    'drive.file.share',
    { fileId: createdFileId, type: 'user', role: 'reader', emailAddress: 'stranger@evil.test', idempotencyKey: 'drv-share-stranger' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-stranger' } },
  );
  equal(drvShareOutOfAllowlist.state, 'denied', 'Drive sharing outside allowedShareEmails is denied');

  const drvShareOk = await dispatcher.dispatch(
    'drive.file.share',
    { fileId: createdFileId, type: 'user', role: 'reader', emailAddress: 'alice@example.com', idempotencyKey: 'drv-share-alice' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: OWNER_ACTOR, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-drv-alice' }, verifyReceiptAfterExecute: true },
  );
  equal(drvShareOk.ok, true, 'Approved in-scope Drive share succeeds and verifies permission receipt');

  // =========================================================================
  // 7. Responsibility Capabilities Planner Catalog & Conservative Boundaries
  // =========================================================================
  const workspaceDir = join(tempHome, 'repo');
  mkdirSync(workspaceDir, { recursive: true });
  const project = await projects.createProject({ name: 'Stage 4 Test Project', rootPath: workspaceDir });
  const rootSession = await sessionManager.createSession(workspaceDir, 'codex', 'Stage 4 Root', {
    projectId: project.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const org = await orgStore.createOrganization({
    projectId: project.id,
    rootSessionId: rootSession.id,
    state: 'active',
    currentRevision: 1,
    policy: { projectRoot: workspaceDir, budgetLimits: { maxCost: 5.0, maxRuns: 10 } },
    budget: { maxCost: 5.0, maxRuns: 10 },
    idempotencyKey: 'stage4-connectors-org-init',
  });
  const caps = await respCapabilities.getResponsibilityCapabilities({ organizationId: org.id, projectId: project.id }, OWNER_ACTOR);
  equal(caps.planCatalogDescriptors[0].capability, 'project-report', 'Preserves Stage 1 descriptor order [0]');
  equal(caps.planCatalogDescriptors[1].capability, 'project-code', 'Preserves Stage 1 descriptor order [1]');
  ok_check: {
    const fanout = caps.planCatalogDescriptors.find((d) => d.capability === 'fanout');
    const swarm = caps.planCatalogDescriptors.find((d) => d.capability === 'swarm-collaboration');
    check(Boolean(fanout && swarm), 'Preserves Stage 2 fanout & swarm descriptors');
    break ok_check;
  }
  equal(caps.features.unifiedConnectorContracts, true);
  equal(caps.features.defaultCapabilityGates.allowConnectorRead, false, 'Connector read defaults false');
  equal(caps.features.defaultCapabilityGates.allowConnectorWrite, false, 'Connector write defaults false');
  equal(caps.features.defaultCapabilityGates.allowConnectorBroadcast, false, 'Connector broadcast defaults false');
  check(Array.isArray(caps.connectorCatalogDescriptors) && caps.connectorCatalogDescriptors.length >= 20, 'Exposes verified connector catalog descriptors');
  check(caps.connectorCatalogDescriptors.every((d) => d.defaultOptIn === false && d.autoEligible === false), 'Every connector descriptor is default-off and non-auto-eligible');

  // Default policy blocks everything
  const defaultBlocked = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'gmail.message.read',
    scope: { resource: 'mailbox:messages' },
    policy: {},
  });
  equal(defaultBlocked.allowed, false);
  equal(defaultBlocked.code, 'CONNECTOR_GATE_DISABLED');

  // Read-only opt-in grants ONLY opted-in read, never draft/write/broadcast
  const readOnlyPolicy = {
    capabilityGates: { allowConnectorRead: true },
    allowedConnectorCapabilities: ['gmail.message.read'],
  };
  equal(
    respCapabilities.resolveConnectorCapabilityBoundary({ capability: 'gmail.message.read', scope: { resource: 'message:1' }, policy: readOnlyPolicy }).allowed,
    true,
    'Opted-in connector read allowed',
  );
  equal(
    respCapabilities.resolveConnectorCapabilityBoundary({ capability: 'gmail.draft.create', scope: { resource: 'draft:a@b.com', recipients: ['a@b.com'] }, policy: readOnlyPolicy }).allowed,
    false,
    'Connector read opt-in never permits write/draft',
  );
  equal(
    respCapabilities.resolveConnectorCapabilityBoundary({ capability: 'gmail.message.send', scope: { resource: 'send:a@b.com', recipients: ['a@b.com'] }, policy: readOnlyPolicy }).allowed,
    false,
    'Connector read opt-in never permits send',
  );

  // Even when broadcast gate + within_policy are enabled, send/merge/share STILL require human approval!
  const broadcastPolicy = {
    capabilityGates: { allowConnectorRead: true, allowConnectorWrite: true, allowConnectorBroadcast: true },
    allowedConnectorCapabilities: ['gmail.message.send', 'github.pr.merge', 'drive.file.share'],
    planApproval: 'within_policy',
    planAutoAdmissionConfirmed: true,
    connectorScopes: {
      github: { allowedRepositories: ['octo/repo-a'] },
      gmail: { allowedRecipients: ['partner@example.com'] },
      drive: { allowedFolderIds: ['folder-a'], allowedShareEmails: ['alice@example.com'] },
    },
  };
  const orgRestrictivePolicy = {
    connectorScopes: {
      github: { allowedRepositories: ['octo/other-only'] },
    },
  };

  const sendWithoutApproval = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'gmail.message.send',
    scope: { resource: 'send:partner@example.com', recipients: ['partner@example.com'] },
    policy: broadcastPolicy,
  });
  equal(sendWithoutApproval.allowed, false);
  equal(sendWithoutApproval.state, 'pending_approval', 'Planner boundary enforces human approval on broadcast even with within_policy');

  const repoIntersectionDenied = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'github.pr.merge',
    scope: { resource: 'octo/repo-a', repository: 'octo/repo-a' },
    policy: broadcastPolicy,
    orgPolicy: orgRestrictivePolicy,
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(repoIntersectionDenied.allowed, false);
  equal(repoIntersectionDenied.code, 'CONNECTOR_SCOPE_VIOLATION', 'Policy ∩ OrgPolicy intersection blocks repo excluded by orgPolicy');

  const sendWithHumanApproval = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'gmail.message.send',
    scope: { resource: 'send:partner@example.com', recipients: ['partner@example.com'] },
    policy: broadcastPolicy,
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(sendWithHumanApproval.allowed, true, 'In-scope broadcast with explicit human approval succeeds boundary check');

  // --- Regression #59-1: pre-wire binding_required preserves wireCrossed=false and allows retry with same idempotencyKey ---
  let rebindReady = false;
  let rebindWireCalls = 0;
  const rebindPolicy = {
    capabilityGates: { allowConnectorRead: true, allowConnectorWrite: true, allowConnectorBroadcast: true },
    allowedConnectorCapabilities: [
      'calendar.event.create',
      'calendar.event.list',
      'github.pr.create',
      'gmail.message.send',
      'drive.file.share',
    ],
    connectorScopes: {
      calendar: { allowedCalendarIds: ['primary'] },
    },
  };
  const makeRebindAction = (idempotencyKey, crossBeforeFail = false) => ({
    contract: {
      capability: 'calendar.event.create',
      scope: { resource: 'calendar:primary', calendarId: 'primary' },
      riskLevel: 'reversible_write',
      idempotencyKey,
      confirmationPolicy: 'require_approval',
      timeoutMs: 5000,
      receiptVerifier: {
        kind: 'provider_lookup',
        supported: true,
        verify: async () => ({ verified: true, externalId: 'evt-rebound' }),
      },
      compensation: {
        supported: true,
        mode: 'compensating_action',
        description: 'Cancel calendar event',
      },
    },
    payload: { calendarId: 'primary', title: 'Rebind test' },
    execute: async ({ onBeforeWire }) => {
      if (!rebindReady) {
        if (crossBeforeFail) await onBeforeWire();
        return {
          connectorId: 'calendar',
          capabilityState: 'binding_required',
          deliveryState: 'drafted',
          message: 'Not connected',
        };
      }
      await onBeforeWire();
      rebindWireCalls += 1;
      return {
        connectorId: 'calendar',
        capabilityState: 'ready',
        deliveryState: 'delivered',
        externalId: 'evt-rebound',
      };
    },
  });

  const preWireBlocked = await dispatcher.dispatch(makeRebindAction('rebind-retry-1', false), {
    actor: OWNER_ACTOR,
    policy: rebindPolicy,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(preWireBlocked.ok, false);
  equal(preWireBlocked.state, 'failed_pre_dispatch', 'Pre-wire binding_required must not lock idempotencyKey as unknown_outcome');
  equal(preWireBlocked.code, 'BINDING_REQUIRED');
  equal(preWireBlocked.wireCrossed, false);
  equal(preWireBlocked.safeToRetry, true);
  equal(rebindWireCalls, 0);
  const preWireRow = dispatcher.getEntry('rebind-retry-1');
  equal(preWireRow?.state, 'failed_pre_dispatch');
  equal(preWireRow?.wireCrossed, false);

  rebindReady = true;
  const rebindRetried = await dispatcher.dispatch(makeRebindAction('rebind-retry-1', false), {
    actor: OWNER_ACTOR,
    policy: rebindPolicy,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(rebindRetried.ok, true, 'Retrying same idempotencyKey after binding becomes ready must succeed');
  equal(rebindRetried.state, 'delivered');
  equal(rebindRetried.externalId, 'evt-rebound');
  equal(rebindRetried.wireCrossed, true);
  equal(rebindWireCalls, 1);

  rebindReady = false;
  const postWireBlocked = await dispatcher.dispatch(makeRebindAction('rebind-postwire-unknown-1', true), {
    actor: OWNER_ACTOR,
    policy: rebindPolicy,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(postWireBlocked.ok, false);
  equal(postWireBlocked.state, 'unknown_outcome', 'Post-wire non-ready result still stays unknown_outcome');
  equal(postWireBlocked.wireCrossed, true);
  equal(postWireBlocked.safeToRetry, false);

  // --- Regression #59-2: fail-closed when scope omits required fields guarded by policy ---
  const ghRepoMissing = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'github.pr.create',
    scope: { resource: 'pr:new' },
    policy: {
      capabilityGates: { allowConnectorBroadcast: true },
      allowedConnectorCapabilities: ['github.pr.create'],
      connectorScopes: { github: { allowedRepositories: ['octo/repo-a'] } },
    },
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(ghRepoMissing.allowed, false);
  equal(ghRepoMissing.code, 'CONNECTOR_SCOPE_VIOLATION', 'Missing scope.repository fails closed under allowedRepositories');

  const ghBaseMissing = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'github.pr.create',
    scope: { resource: 'octo/repo-a', repository: 'octo/repo-a' },
    policy: {
      capabilityGates: { allowConnectorBroadcast: true },
      allowedConnectorCapabilities: ['github.pr.create'],
      connectorScopes: { github: { allowedRepositories: ['octo/repo-a'], allowedBaseBranches: ['main'] } },
    },
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(ghBaseMissing.allowed, false);
  equal(ghBaseMissing.code, 'CONNECTOR_SCOPE_VIOLATION', 'Missing scope.base fails closed under allowedBaseBranches');

  const gmailRecipientsMissing = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'gmail.message.send',
    scope: { resource: 'send:any' },
    policy: broadcastPolicy,
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(gmailRecipientsMissing.allowed, false);
  equal(gmailRecipientsMissing.code, 'CONNECTOR_SCOPE_VIOLATION', 'Missing scope.recipients fails closed under allowedRecipients');

  const calIdMissing = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'calendar.event.create',
    scope: { resource: 'calendar:evt' },
    policy: rebindPolicy,
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(calIdMissing.allowed, false);
  equal(calIdMissing.code, 'CONNECTOR_SCOPE_VIOLATION', 'Missing scope.calendarId fails closed under allowedCalendarIds');

  const driveShareTypeMissing = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'drive.file.share',
    scope: { resource: 'drive:file-1' },
    policy: broadcastPolicy,
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(driveShareTypeMissing.allowed, false);
  equal(driveShareTypeMissing.code, 'CONNECTOR_SCOPE_VIOLATION', 'Missing scope.shareType fails closed under allowedShareEmails');

  const driveDomainBlockedWhenOnlyEmailsAllowed = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'drive.file.share',
    scope: { resource: 'drive:file-1', shareType: 'domain', domain: 'example.com' },
    policy: broadcastPolicy,
    actor: OWNER_ACTOR,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(driveDomainBlockedWhenOnlyEmailsAllowed.allowed, false);
  equal(driveDomainBlockedWhenOnlyEmailsAllowed.code, 'CONNECTOR_SCOPE_VIOLATION', 'Non-user shareType denied when only allowedShareEmails is set');

  const dispatchFailClosedCases = [
    {
      name: 'github missing repository',
      contract: {
        capability: 'github.pr.create',
        scope: { resource: 'pr:new' },
        riskLevel: 'external_broadcast',
        idempotencyKey: 'fail-closed-gh-repo-1',
        confirmationPolicy: 'require_approval',
        timeoutMs: 5000,
        receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => ({ verified: false }) },
        compensation: { supported: false, mode: 'none', description: 'Close PR manually' },
      },
      policy: {
        capabilityGates: { allowConnectorBroadcast: true },
        allowedConnectorCapabilities: ['github.pr.create'],
        connectorScopes: { github: { allowedRepositories: ['octo/repo-a'] } },
      },
    },
    {
      name: 'gmail missing recipients',
      contract: {
        capability: 'gmail.message.send',
        scope: { resource: 'send:any' },
        riskLevel: 'external_broadcast',
        idempotencyKey: 'fail-closed-gmail-recip-1',
        confirmationPolicy: 'require_approval',
        timeoutMs: 5000,
        receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => ({ verified: false }) },
        compensation: { supported: false, mode: 'none', description: 'Cannot unsend' },
      },
      policy: broadcastPolicy,
    },
    {
      name: 'calendar missing calendarId',
      contract: {
        capability: 'calendar.event.create',
        scope: { resource: 'calendar:evt' },
        riskLevel: 'reversible_write',
        idempotencyKey: 'fail-closed-cal-id-1',
        confirmationPolicy: 'require_approval',
        timeoutMs: 5000,
        receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => ({ verified: false }) },
        compensation: { supported: true, mode: 'compensating_action', description: 'Cancel event' },
      },
      policy: rebindPolicy,
    },
    {
      name: 'drive missing shareType',
      contract: {
        capability: 'drive.file.share',
        scope: { resource: 'drive:file-1' },
        riskLevel: 'external_broadcast',
        idempotencyKey: 'fail-closed-drive-sharetype-1',
        confirmationPolicy: 'require_approval',
        timeoutMs: 5000,
        receiptVerifier: { kind: 'provider_lookup', supported: true, verify: async () => ({ verified: false }) },
        compensation: { supported: true, mode: 'compensating_action', description: 'Revoke permission' },
      },
      policy: broadcastPolicy,
    },
  ];
  for (const fc of dispatchFailClosedCases) {
    let executed = false;
    const deniedRes = await dispatcher.dispatch({
      contract: fc.contract,
      payload: {},
      execute: async () => {
        executed = true;
        return { externalId: 'should-not-execute' };
      },
    }, {
      actor: OWNER_ACTOR,
      policy: fc.policy,
      approval: { confirmed: true, approvedBy: OWNER_ID },
    });
    equal(deniedRes.ok, false, `dispatcher.dispatch fails closed on ${fc.name}`);
    equal(deniedRes.state, 'denied', `dispatcher.dispatch returns denied on ${fc.name}`);
    equal(deniedRes.code, 'CONNECTOR_SCOPE_VIOLATION', `dispatcher.dispatch returns CONNECTOR_SCOPE_VIOLATION on ${fc.name}`);
    equal(executed, false, `execute must not run when ${fc.name}`);
  }

  // --- Regression #59-3: multi-connector scope isolation & Drive query/parentless hardening ---
  const multiConnectorPolicy = {
    capabilityGates: { allowConnectorRead: true },
    allowedConnectorCapabilities: ['gmail.message.list', 'calendar.event.list'],
    connectorScopes: {
      github: { allowedRepositories: ['octo/repo-a'] },
      allowedCalendarIds: ['other-only'],
    },
  };
  equal(
    respCapabilities.resolveConnectorCapabilityBoundary({
      capability: 'gmail.message.list',
      scope: { resource: 'mailbox:messages' },
      policy: multiConnectorPolicy,
    }).allowed,
    true,
    'Multi-connector scope map with github key does not leak to gmail',
  );
  equal(
    respCapabilities.resolveConnectorCapabilityBoundary({
      capability: 'calendar.event.list',
      scope: { resource: 'calendar:primary', calendarId: 'primary' },
      policy: multiConnectorPolicy,
    }).allowed,
    true,
    'Multi-connector scope map without calendar key must not fall back to outer flat keys',
  );
  equal(
    respCapabilities.resolveConnectorCapabilityBoundary({
      capability: 'calendar.event.list',
      scope: { resource: 'calendar:primary', calendarId: 'primary' },
      policy: {
        capabilityGates: { allowConnectorRead: true },
        allowedConnectorCapabilities: ['calendar.event.list'],
        connectorScopes: { allowedCalendarIds: ['other-only'] },
      },
    }).code,
    'CONNECTOR_SCOPE_VIOLATION',
    'Direct flat single-connector scope map still enforces allowedCalendarIds',
  );
  const isolatedDispatchRead = await dispatcher.dispatch({
    contract: {
      capability: 'calendar.event.list',
      scope: { resource: 'calendar:primary', calendarId: 'primary' },
      riskLevel: 'read',
      idempotencyKey: 'multi-scope-cal-isolation-1',
      confirmationPolicy: 'auto_within_policy',
      timeoutMs: 5000,
      receiptVerifier: { kind: 'none', supported: false },
      compensation: { supported: false, mode: 'none', description: 'Read-only' },
    },
    payload: {},
    execute: async () => ({ items: [] }),
  }, {
    actor: OWNER_ACTOR,
    policy: multiConnectorPolicy,
  });
  equal(isolatedDispatchRead.ok, true, 'dispatcher multi-connector scope map isolates missing connector key from outer map');

  await assert.rejects(
    async () => driveMod.listDriveFiles({
      folderId: 'folder-allowed',
      allowedFolderIds: ['folder-allowed'],
      query: "name='x') or ('a'='a",
      driveClient: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    /Invalid Drive query/i,
    'Drive listDriveFiles rejects unbalanced query injection under allowedFolderIds',
  );
  passed += 1;

  const mockScopedDriveClient = {
    files: {
      list: async () => ({
        data: {
          files: [
            { id: 'parentless-1', name: 'leak.txt', parents: [] },
            { id: 'other-1', name: 'other.txt', parents: ['folder-other'] },
            { id: 'in-1', name: 'ok.txt', parents: ['folder-allowed'] },
          ],
        },
      }),
    },
  };
  const scopedListResult = await driveMod.listDriveFiles({
    folderId: 'folder-allowed',
    allowedFolderIds: ['folder-allowed'],
    query: "name contains 'txt'",
    driveClient: mockScopedDriveClient,
  });
  equal(scopedListResult.files.length, 1, 'Drive listDriveFiles strictly filters out parentless and out-of-scope files');
  equal(scopedListResult.files[0]?.id, 'in-1');

  dispatcher.close();
  console.log(`test-stage4-connectors: ok (${passed} checks passed)`);
} finally {
  try { sessionManager.killAll?.(); } catch {}
  try { dispatcher?.close?.(); } catch {}
  try { await orgStore.closeOrganizationDatabase?.(); } catch {}
  try { rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}

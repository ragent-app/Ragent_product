#!/usr/bin/env node
// test-agy-cross-account-conversation.mjs
// 验收：跨账号切换不 resume 旧 conversation；切回旧账号也不 resume
//
// 覆盖：
// 1. 同账号 Run 保留 agyConversationId（可以 resume）
// 2. 显式切换到另一账号时，session 的 agyConversationId 被清除
// 3. 切换后新 Run 不携带旧账号的 conversationId（buildRuntimeInvocation 验证）
// 4. 切回原账号也是新 conversation（而非 resume 原来的对话）
// 5. agyProviderProfileId 随每次选择更新，始终对应当前账号

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

// ── persistResumeIds 模拟：直接验证 session state 转换逻辑
//
// session-manager 的 persistResumeIds 是私有函数，
// 这里用白盒方式实现相同的状态机，验证跨账号 conversation 清除语义。

function createSessionState() {
  return {
    agyProviderProfileId: null,
    agyConversationId: null,
  };
}

function applyResumeIds(session, { agyProviderProfileId, agyConversationId }) {
  let changed = false;
  if (agyProviderProfileId) {
    if (session.agyProviderProfileId !== agyProviderProfileId) {
      session.agyProviderProfileId = agyProviderProfileId;
      changed = true;
    }
    // 跨账号切换：清除旧 conversationId
    if (!agyConversationId && session.agyConversationId) {
      delete session.agyConversationId;
      changed = true;
    }
  }
  if (agyConversationId && session.agyConversationId !== agyConversationId) {
    session.agyConversationId = agyConversationId;
    changed = true;
  }
  return changed;
}

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-cross-account-conv-'));

try {
  // ── Case 1: 同账号第一次 Run 绑定 conversation
  const session = createSessionState();
  applyResumeIds(session, {
    agyProviderProfileId: 'agy-work',
    agyConversationId: 'conv-work-001',
  });
  assert.equal(session.agyProviderProfileId, 'agy-work');
  assert.equal(session.agyConversationId, 'conv-work-001');

  // ── Case 2: 同账号 resume — conversation 保持
  applyResumeIds(session, {
    agyProviderProfileId: 'agy-work',
    agyConversationId: 'conv-work-001',
  });
  assert.equal(session.agyConversationId, 'conv-work-001', 'same-account re-run must keep the conversation id');

  // ── Case 3: 显式切换到另一账号 — 旧 conversationId 被清除
  // 切换时新 Run 尚未返回 conversationId（账号刚切过去，第一个 Run 不带 conversationId）
  const changed3 = applyResumeIds(session, {
    agyProviderProfileId: 'agy-personal',
    agyConversationId: null,  // 新账号第一个 Run 还没有 conversation
  });
  assert.equal(changed3, true, 'account switch must produce a change');
  assert.equal(session.agyProviderProfileId, 'agy-personal');
  assert.equal(
    session.agyConversationId,
    undefined,
    'cross-account switch must clear the previous conversation id',
  );

  // ── Case 4: 新账号 Run 返回了自己的 conversationId
  applyResumeIds(session, {
    agyProviderProfileId: 'agy-personal',
    agyConversationId: 'conv-personal-001',
  });
  assert.equal(session.agyProviderProfileId, 'agy-personal');
  assert.equal(session.agyConversationId, 'conv-personal-001');

  // ── Case 5: 切回原账号 — personal conversation 被清除，不 resume work conversation
  applyResumeIds(session, {
    agyProviderProfileId: 'agy-work',
    agyConversationId: null,  // 切回时没有 resumeId
  });
  assert.equal(session.agyProviderProfileId, 'agy-work');
  assert.equal(
    session.agyConversationId,
    undefined,
    'switching back to original account must also clear the conversation id (no resume of old thread)',
  );

  // ── Case 6: 切回账号的新 Run 正常开始新 conversation
  applyResumeIds(session, {
    agyProviderProfileId: 'agy-work',
    agyConversationId: 'conv-work-002',  // 新开的 conversation
  });
  assert.equal(session.agyConversationId, 'conv-work-002');
  assert.notEqual(
    session.agyConversationId,
    'conv-work-001',
    'switch-back must yield a fresh conversation, not resume the original one',
  );

  // ── Case 7: buildRuntimeInvocation 验证 conversationId 透传/不透传
  // 同账号 resume：应该携带 --conversation
  const resumeArgs = buildRuntimeInvocation('agy-stream-json', 'hello', {
    model: 'gemini-3.7-flash@agy-work',
    agyConversationId: 'conv-work-002',
    useResume: true,
  }, 'agy');
  const convIdx = resumeArgs.args.indexOf('--conversation');
  assert.ok(convIdx !== -1, 'same-account resume must include --conversation flag');
  assert.equal(resumeArgs.args[convIdx + 1], 'conv-work-002');

  // 跨账号切换后首个 Run：没有 conversationId，不应携带 --conversation
  const freshArgs = buildRuntimeInvocation('agy-stream-json', 'hello', {
    model: 'gemini-3.7-flash@agy-personal',
    // agyConversationId 未传（session 已被清除）
    useResume: false,
  }, 'agy');
  assert.equal(
    freshArgs.args.indexOf('--conversation'),
    -1,
    'cross-account first run must not carry --conversation',
  );
  assert.equal(
    freshArgs.args.indexOf('--continue'),
    -1,
    'cross-account first run must not carry --continue',
  );

  // model 中的 @providerId 不应出现在 CLI 参数里
  assert.equal(
    freshArgs.args.includes('gemini-3.7-flash@agy-personal'),
    false,
    'provider suffix must be stripped from --model arg',
  );

  console.log('test-agy-cross-account-conversation: cross-account conversation clear, switch-back new conversation, and buildRuntimeInvocation args OK');
} finally {
  await rm(root, { recursive: true, force: true });
}

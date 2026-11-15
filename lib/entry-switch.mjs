// 设备入口切换（介绍人机制）数据层：
//  - A 生成一次性 join-token（绑定目标设备+ownerId，短 TTL，只存 HMAC 摘要）
//  - B 凭阶段三握手凭证调 introspect 消费 token；A 回介绍信（本机私钥签名 introNonce）
//  - 防御：一次性（used 后 410）、过期 410、attempts>=5 锁定 429、target 绑定
import { createHash, randomBytes } from 'crypto';
import { join } from 'path';
import { CONFIG_DIR } from './config.mjs';
import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { signWithInstanceKey, getInstancePublicKey } from './instance-keys.mjs';

export const ENTRY_JOIN_TTL_MS = 2 * 60 * 1000;  // join-token 有效期（方案默认 2 分钟，上限 5）
export const MAX_JOIN_ATTEMPTS = 5;              // 防暴力：校验失败锁定
export const ENTRY_SWITCH_JOINS_FILE = join(CONFIG_DIR, 'entry-switch-joins.json');

export function createEntrySwitchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 摘要落盘（与 trusted-devices hashSecret 同模式：明文 token 不出现在文件）
export function hashJoinToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

async function readJoinsStore() {
  return (await readJson(ENTRY_SWITCH_JOINS_FILE, null)) || { version: 1, tokens: {}, audit: [] };
}

async function writeJoinsStore(store) {
  await writeJsonAtomic(ENTRY_SWITCH_JOINS_FILE, store, { mode: 0o600 });
}

async function pushAudit(store, event, record) {
  store.audit.push({
    at: new Date().toISOString(),
    event,
    targetDeviceId: record.targetDeviceId,
    ownerId: record.ownerId,
  });
}

// A 发起：为「切换到设备 B」签发一次性 join-token。
// 同一目标设备同时只允许一个未消费 token（409 ENTRY_SWITCH_ALREADY_PENDING）。
export async function issueEntryJoinToken({ targetDeviceId, ownerId }) {
  if (!targetDeviceId || !ownerId) {
    throw createEntrySwitchError('ENTRY_SWITCH_INVALID', 'targetDeviceId and ownerId are required.');
  }
  const store = await readJoinsStore();
  const now = Date.now();
  // 顺带清理过期记录
  for (const [hash, record] of Object.entries(store.tokens)) {
    if (!record.expiresAt || Date.parse(record.expiresAt) < now) delete store.tokens[hash];
  }
  const pending = Object.values(store.tokens).find(
    (record) => record.targetDeviceId === targetDeviceId && !record.used,
  );
  if (pending) {
    throw createEntrySwitchError('ENTRY_SWITCH_ALREADY_PENDING', 'An entry-switch invitation for this device is already pending.');
  }
  const joinToken = randomBytes(24).toString('hex');
  const record = {
    targetDeviceId,
    ownerId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ENTRY_JOIN_TTL_MS).toISOString(),
    used: false,
    attempts: 0,
  };
  store.tokens[hashJoinToken(joinToken)] = record;
  await pushAudit(store, 'invited', record);
  await writeJoinsStore(store);
  return { joinToken, expiresAt: record.expiresAt };
}

// B 消费：校验并标记 used。requestDeviceId 来自握手凭证记录（Bearer 消费产物）。
// 返回 { ownerId, targetDeviceId }；任一步失败抛带 code 的错（路由映射 401/410/429）。
export async function introspectEntryJoinToken({ joinToken, requestDeviceId }) {
  if (!/^[0-9a-f]{48}$/.test(String(joinToken || ''))) {
    throw createEntrySwitchError('JOIN_TOKEN_MISMATCH', 'Invalid join token.');
  }
  if (!requestDeviceId) {
    throw createEntrySwitchError('JOIN_TOKEN_MISMATCH', 'Requester device id is required.');
  }
  const store = await readJoinsStore();
  const record = store.tokens[hashJoinToken(joinToken)];
  if (!record) {
    throw createEntrySwitchError('JOIN_TOKEN_MISMATCH', 'Join token not found.');
  }
  if (record.attempts >= MAX_JOIN_ATTEMPTS) {
    throw createEntrySwitchError('TOO_MANY_ATTEMPTS', 'Too many failed attempts; join token locked.');
  }
  if (Date.parse(record.expiresAt) < Date.now()) {
    throw createEntrySwitchError('JOIN_TOKEN_EXPIRED', 'Join token expired.');
  }
  if (record.used) {
    throw createEntrySwitchError('JOIN_TOKEN_USED', 'Join token already used.');
  }
  if (record.targetDeviceId !== requestDeviceId) {
    record.attempts += 1;
    await writeJoinsStore(store);
    throw createEntrySwitchError('JOIN_TOKEN_MISMATCH', 'Join token is bound to another device.');
  }
  record.used = true;
  await pushAudit(store, 'introspected', record);
  await writeJoinsStore(store);
  return { ownerId: record.ownerId || record.sub || '', targetDeviceId: record.targetDeviceId };
}

// A 的介绍信：本机私钥对 introNonce 签名（B 用清单里 A 的公钥验）。
// message 格式固定，防跨场景复用（与 device-handshake 消息风格一致）。
export function buildIntroMessage({ sourceInstance, introNonce }) {
  return `ragent-entry-intro-v1\n${sourceInstance}\n${introNonce}`;
}

export async function buildIntroSigned({ sourceInstance, introNonce }) {
  const [introSig, sourcePublicKey] = await Promise.all([
    signWithInstanceKey(buildIntroMessage({ sourceInstance, introNonce })),
    getInstancePublicKey(),
  ]);
  return { introSig, sourcePublicKey };
}

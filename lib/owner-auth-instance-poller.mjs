// instance_poll 交付模式的实例侧可恢复轮询器。
// 生命周期（契约 §10）：startOwnerAccountAuth 落盘事务 → poller 按
// retryAfterMs/退避调用 instance-redeem → pending 继续 / completed 验证断言
// 并写入本地绑定 → 失败或过期投影到安全状态接口。进程重启后用同一
// requestId 恢复，不生成新请求。
//
// 依赖注入：本模块不 import owner-account-auth.mjs（避免环依赖）。事务
// 读取/更新、断言验证与本地写入由装配方（owner-account-auth.mjs）注入。
import { loadOrCreateInstanceIdentity, publicInstanceIdentity, signOwnerAuthPollProof } from './instance-identity.mjs';
import { fetchBrokerJsonWithRetry } from './broker-fetch.mjs';

const DEFAULT_RETRY_MS = 2000;
const MAX_RETRY_MS = 5000;
const BACKOFF_FACTOR = 1.5;
const MAX_BACKOFF_MS = 10 * 1000;
const FAILURE_THRESHOLD = 5;

// 致命错误：重试没有意义，事务直接进入 failed。
const FATAL_POLL_ERRORS = new Set([
  'owner_auth_transaction_invalid',
  'owner_auth_delivery_mode_mismatch',
  'owner_auth_instance_mismatch',
  'owner_auth_request_id_conflict',
  'owner_auth_assertion_expired',
  'owner_auth_broker_response_invalid',
  'owner_auth_proof_invalid',
  'owner_auth_proof_expired',
  'owner_auth_request_invalid',
  'owner_auth_assertion_invalid',
  'owner_auth_owner_required',
  'owner_auth_binding_mismatch',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

// 活跃 poller 注册表：内存定时器与在飞请求的唯一来源。
const activePollers = new Map();

function scheduleTimer(transactionId, delayMs) {
  const entry = activePollers.get(transactionId);
  if (!entry || entry.stopped) return;
  const timer = setTimeout(() => { void entry.tick(); }, Math.max(0, Math.min(delayMs, MAX_BACKOFF_MS)));
  timer.unref?.();
  entry.timer = timer;
}

export function startOwnerAuthPoller(transactionId, deps, { initialDelayMs = DEFAULT_RETRY_MS } = {}) {
  if (activePollers.has(transactionId)) return;
  const entry = {
    timer: null,
    inFlight: false,
    stopped: false,
    failures: 0,
    currentDelay: DEFAULT_RETRY_MS,
    deps,
  };
  entry.tick = async () => { await runOwnerAuthPollTick(transactionId); };
  activePollers.set(transactionId, entry);
  scheduleTimer(transactionId, initialDelayMs);
}

export function stopOwnerAuthPoller(transactionId) {
  const entry = activePollers.get(transactionId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  activePollers.delete(transactionId);
}

export function stopOwnerAuthPollers() {
  for (const transactionId of Array.from(activePollers.keys())) stopOwnerAuthPoller(transactionId);
}

export function getActiveOwnerAuthPollerCount() {
  return activePollers.size;
}

async function runOwnerAuthPollTick(transactionId) {
  const entry = activePollers.get(transactionId);
  if (!entry || entry.stopped || entry.inFlight) return;
  const {
    fetchImpl,
    clock = Date.now,
    accountsBaseUrl,
    readTransaction,
    updateTransaction,
    verifyAssertion,
    writeBinding,
    startPolling,
  } = entry.deps;
  entry.inFlight = true;
  try {
    const record = await readTransaction(transactionId);
    if (!record || record.deliveryMode !== 'instance_poll') {
      stopOwnerAuthPoller(transactionId);
      return;
    }
    if (['completed', 'failed', 'expired'].includes(trimString(record.pollState))) {
      stopOwnerAuthPoller(transactionId);
      return;
    }
    // expiresAt was added with instance_poll. Derive it for older local
    // records so a restart or upgrade cannot turn an old transaction into an
    // unbounded poll.
    const persistedExpiresMs = Date.parse(record.expiresAt || '');
    const createdMs = Date.parse(record.createdAt || '');
    const expiresMs = Number.isFinite(persistedExpiresMs)
      ? persistedExpiresMs
      : (Number.isFinite(createdMs) ? createdMs + 5 * 60 * 1000 : NaN);
    if (Number.isFinite(expiresMs) && expiresMs <= clock()) {
      await updateTransaction(transactionId, (tx) => {
        tx.pollState = 'expired';
        tx.pollError = 'owner_auth_transaction_invalid';
      });
      stopOwnerAuthPoller(transactionId);
      return;
    }

    const identity = await loadOrCreateInstanceIdentity();
    const requestPath = `/v1/owner-auth/transactions/${transactionId}/instance-redeem`;
    const issuedAt = nowIso(clock);
    const proof = signOwnerAuthPollProof(identity, {
      transactionId,
      requestId: record.requestId,
      purpose: record.purpose,
      deliveryMode: 'instance_poll',
      issuedAt,
      requestPath,
    });
    const response = await fetchJson(fetchImpl, `${accountsBaseUrl}${requestPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        requestId: record.requestId,
        purpose: record.purpose,
        deliveryMode: 'instance_poll',
        instance: publicInstanceIdentity(identity),
        issuedAt,
        audience: 'agentoc-owner-auth-poll',
        signature: proof.signature,
      }),
    });

    if (response.status === 'pending') {
      entry.failures = 0;
      entry.currentDelay = DEFAULT_RETRY_MS;
      const retry = Number(response.retryAfterMs);
      scheduleTimer(transactionId, Number.isFinite(retry) && retry > 0 ? Math.min(retry, MAX_RETRY_MS) : DEFAULT_RETRY_MS);
      return;
    }
    if (response.status === 'completed' && trimString(response.assertion)) {
      const account = await verifyAssertion(response.assertion, { purpose: record.purpose, transactionId });
      await writeBinding({
        purpose: record.purpose,
        accountId: account.accountId,
        provider: account.provider,
        alias: record.alias,
        plan: account.plan,
        limits: account.limits,
        planExpiresAt: account.planExpiresAt,
        bindingAuthorityRevision: account.bindingAuthorityRevision,
        clock,
      });
      await updateTransaction(transactionId, (tx) => {
        tx.pollState = 'completed';
        tx.pollError = '';
        tx.completedAt = tx.completedAt || nowIso(clock);
        tx.authorizedAccountId = account.accountId;
        if (account.bindingAuthorityRevision) tx.bindingAuthorityRevision = account.bindingAuthorityRevision;
      });
      stopOwnerAuthPoller(transactionId);
      return;
    }
    throw createError('owner_auth_broker_response_invalid', 'Accounts service returned an invalid poll response.', 502);
  } catch (error) {
    if (FATAL_POLL_ERRORS.has(trimString(error?.code))) {
      await updateTransaction(transactionId, (tx) => {
        tx.pollState = 'failed';
        tx.pollError = trimString(error?.code) || 'owner_auth_failed';
      });
      stopOwnerAuthPoller(transactionId);
      return;
    }
    // 网络/服务暂不可用：退避重试，超时由事务过期检查兜底。
    entry.failures += 1;
    const ceiling = entry.failures >= FAILURE_THRESHOLD ? MAX_BACKOFF_MS : MAX_RETRY_MS;
    entry.currentDelay = Math.min(Math.max(DEFAULT_RETRY_MS, Math.round(entry.currentDelay * BACKOFF_FACTOR)), ceiling);
    scheduleTimer(transactionId, entry.currentDelay);
  } finally {
    entry.inFlight = false;
  }
}

function brokerRetryAfterMs(response) {
  // Retry-After 只解析秒数格式；HTTP 日期格式对毫秒级退避没有额外价值。
  const seconds = Number(trimString(response?.headers?.get?.('retry-after')));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.round(seconds * 1000), 120_000) : 0;
}

async function fetchJson(fetchImpl, url, options) {
  let response;
  try {
    // instance-redeem 是幂等 poll；传输层瞬断/挂死由共享加固重试消化，
    // 单次抖动不再放大成整轮 poll 失败。
    response = await fetchBrokerJsonWithRetry(fetchImpl, url, options);
  } catch {
    throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    // 限流 429 响应没有结构化 code，必须单独识别，交给退避逻辑处理；
    // 否则会被误报成 owner_auth_broker_rejected。
    if (response.status === 429) {
      const error = createError('owner_auth_broker_rate_limited', 'Accounts service rate limited the owner authentication request.', 429);
      error.retryAfterMs = brokerRetryAfterMs(response);
      throw error;
    }
    const code = trimString(body?.code) || 'owner_auth_broker_rejected';
    throw createError(code, 'Accounts service rejected the owner authentication request.', response.status || 502);
  }
  return body || {};
}

// 进程重启恢复：重新启动所有未终结的 instance_poll 事务，沿用原 requestId。
export async function resumeOwnerAuthPollers(deps) {
  const ids = await deps.listResumableTransactions();
  for (const transactionId of ids) {
    startOwnerAuthPoller(transactionId, deps);
  }
  return ids.length;
}

export { runOwnerAuthPollTick };

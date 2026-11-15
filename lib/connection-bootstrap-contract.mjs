// ADR-0001 连接规则 v3（2026-08-17 修订）的 signed bootstrap contract 纯逻辑层：
//  - 连接模式只能由服务端在鉴权后判定，客户端不得在握手成功前自行选路。
//  - TURN 凭据和 P2P 升级候选只能由服务端放进已签名契约，客户端不得推断。
//  - 契约由实例 Ed25519 签名密钥整体签名（域分隔 + 规范化 JSON 摘要），
//    客户端用实例公钥指纹校验；本文件不做任何 IO，保持 Go 可移植。
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';

export const CONNECTION_BOOTSTRAP_CONTRACT_VERSION = 2;
export const CONNECTION_BOOTSTRAP_SIGNATURE_DOMAIN = 'ragent-connection-bootstrap-v2';
export const CONNECTION_BOOTSTRAP_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const CONNECTION_BOOTSTRAP_MODES = ['turn-first'];
// v2 enrollment is account-scoped. QR is only the one-time account claim step;
// it is not a bootstrap enrollment kind.
export const CONNECTION_BOOTSTRAP_ENROLLMENT_KINDS = ['account-claim', 'account-join'];
export const CONNECTION_BOOTSTRAP_REPORT_PHASES = [
  'selected',
  'connected',
  'migrated',
  'failed',
  'rejected-consent',
  'recovered',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 规范化 JSON：对象键递归排序、无空白。签名摘要与 Android 端验签都基于该
// 序列化，任何一端的键序差异都会导致签名失败，这是有意的防篡改属性。
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * 连接模式判定（唯一权威，客户端不得复算）：
 *  - 有服务端授权的 TURN 候选 → turn-first。
 *  - 没有 TURN → 无法签发契约；客户端不得自行选择其他承载。
 */
export function determineConnectionMode({
  hasTurn,
} = {}) {
  if (!hasTurn) throw new Error('TURN credentials are required for a v2 bootstrap contract');
  return 'turn-first';
}

function createCandidateId(value) {
  return `cand_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function candidate({ kind, provider, endpoint, priority, expiresAt, requiresUserConsent = false, metadata = {} }) {
  const normalizedEndpoint = trimString(endpoint);
  if (!normalizedEndpoint) return null;
  return {
    id: createCandidateId(`${kind}\n${provider}\n${normalizedEndpoint}`),
    kind,
    provider,
    endpoint: normalizedEndpoint,
    priority,
    expiresAt: trimString(expiresAt),
    requiresUserConsent: !!requiresUserConsent,
    metadata,
  };
}

const UPGRADE_TARGETS = ['webrtc'];

/**
 * 组装未签名的 bootstrap contract。输入全部来自服务端持久状态/配置；
 * candidates 的 priority 即探测顺序；TURN-first 时 TURN 必须排在 P2P 之前。
 */
export function buildConnectionBootstrapContract({
  instanceId,
  deviceId,
  enrollmentKind = '',
  p2p = {},
  turn = null,
  turnAuthorization = null,
  issuedAtMs = Date.now(),
  ttlMs = CONNECTION_BOOTSTRAP_DEFAULT_TTL_MS,
} = {}) {
  const normalizedInstanceId = trimString(instanceId);
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedInstanceId || !normalizedDeviceId) {
    throw new Error('instanceId and deviceId are required');
  }
  const requestedEnrollment = trimString(enrollmentKind);
  if (!CONNECTION_BOOTSTRAP_ENROLLMENT_KINDS.includes(requestedEnrollment)) {
    throw new Error('A v2 bootstrap contract requires account-claim or account-join enrollment');
  }
  const normalizedEnrollment = requestedEnrollment;
  const normalizedTurn = turn && typeof turn === 'object' ? turn : null;
  const normalizedTurnAuthorization = turnAuthorization && typeof turnAuthorization === 'object'
    ? turnAuthorization
    : null;
  const connectionMode = determineConnectionMode({
    hasTurn: !!normalizedTurn,
  });
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(issuedAtMs + (Number.isFinite(ttlMs) ? ttlMs : CONNECTION_BOOTSTRAP_DEFAULT_TTL_MS)).toISOString();

  const candidates = [];
  const signalingEndpoint = trimString(p2p?.signalingEndpoint);
  const roomId = trimString(p2p?.roomId);
  if (signalingEndpoint && roomId) {
    candidates.push(candidate({
      kind: 'webrtc',
      provider: 'core_p2p',
      endpoint: signalingEndpoint,
      priority: 60,
      expiresAt,
      metadata: { roomId, turnAllowed: !!normalizedTurn },
    }));
  }
  if (normalizedTurn) {
    candidates.push(candidate({
      kind: 'turn',
      provider: trimString(normalizedTurn.provider) || 'cloudflare-realtime',
      endpoint: trimString(normalizedTurn.iceServers?.[0]?.urls) || normalizedTurn.endpoint || '',
      priority: 120,
      expiresAt: trimString(normalizedTurn.expiresAt) || expiresAt,
      requiresUserConsent: false,
      metadata: {
        appTrafficOnly: true,
        carrier: 'cloudflare-realtime-turn',
        ...(trimString(normalizedTurn.connectionId) ? { connectionId: trimString(normalizedTurn.connectionId) } : {}),
        iceServers: normalizedTurn.iceServers || [],
      },
    }));
  }
  // priority 即探测顺序：始终按 priority 降序输出，不依赖组装顺序。
  const filtered = candidates.filter(Boolean).sort((a, b) => b.priority - a.priority);
  if (!filtered.length) throw new Error('A bootstrap contract requires a TURN candidate');
  const turnCandidate = filtered.find((entry) => entry.kind === 'turn');
  if (!turnCandidate) throw new Error('A v2 bootstrap contract requires a TURN candidate');
  const contract = {
    contractVersion: CONNECTION_BOOTSTRAP_CONTRACT_VERSION,
    instanceId: normalizedInstanceId,
    deviceId: normalizedDeviceId,
    enrollmentKind: normalizedEnrollment,
    connectionMode,
    issuedAt,
    expiresAt,
    candidates: filtered,
    turn: normalizedTurn,
    turnAuthorization: normalizedTurnAuthorization,
    initialCarrier: turnCandidate ? {
      candidateId: turnCandidate.id,
      kind: turnCandidate.kind,
      provider: turnCandidate.provider,
      endpoint: turnCandidate.endpoint,
    } : null,
    upgrade: {
      strategy: 'probe-after-bootstrap',
      targets: UPGRADE_TARGETS,
      retainCurrentWhenNoP2PPath: true,
    },
    // Reserved extension point. A future fallback provider must be added with
    // an explicit versioned contract and consent policy.
    fallback: null,
  };
  return contract;
}

/** 契约签名负载：域分隔行 + 全文规范化 JSON 的 sha256，键序无关且防篡改。 */
export function buildContractSigningPayload(contract) {
  if (!contract || typeof contract !== 'object') return '';
  const { signature, ...payload } = contract;
  return [
    CONNECTION_BOOTSTRAP_SIGNATURE_DOMAIN,
    trimString(contract.instanceId),
    trimString(contract.deviceId),
    trimString(contract.connectionMode),
    trimString(contract.issuedAt),
    trimString(contract.expiresAt),
    createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  ].join('\n');
}

/** 附上签名块（value 由调用方用实例签名密钥生成）。 */
export function attachContractSignature(contract, { keyId, signedAt, value } = {}) {
  return {
    ...contract,
    signature: {
      algorithm: 'ed25519',
      keyId: trimString(keyId),
      signedAt: trimString(signedAt),
      value: trimString(value),
    },
  };
}

/**
 * 校验契约：结构、枚举、有效期、Ed25519 签名。给服务端测试与任何回读
 * 契约的路径使用；Android 端按同一规则实现验签（见 runtime contract）。
 */
export function verifyConnectionBootstrapContract(contract, publicKeyPem, { nowMs = Date.now() } = {}) {
  if (!contract || typeof contract !== 'object') return { valid: false, reason: 'contract is not an object' };
  if (contract.contractVersion !== CONNECTION_BOOTSTRAP_CONTRACT_VERSION) {
    return { valid: false, reason: 'unsupported contractVersion' };
  }
  for (const field of ['instanceId', 'deviceId', 'issuedAt', 'expiresAt']) {
    if (!trimString(contract[field])) return { valid: false, reason: `missing ${field}` };
  }
  if (!CONNECTION_BOOTSTRAP_MODES.includes(contract.connectionMode)) {
    return { valid: false, reason: 'invalid connectionMode' };
  }
  if (!CONNECTION_BOOTSTRAP_ENROLLMENT_KINDS.includes(contract.enrollmentKind)) {
    return { valid: false, reason: 'invalid enrollmentKind' };
  }
  if (!Array.isArray(contract.candidates) || !contract.candidates.length) {
    return { valid: false, reason: 'candidates must be a non-empty array' };
  }
  if (contract.candidates.some((entry) => !['turn', 'webrtc'].includes(entry?.kind))) {
    return { valid: false, reason: 'unsupported candidate kind' };
  }
  const expiresAtMs = Date.parse(contract.expiresAt || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { valid: false, reason: 'contract expired' };
  }
  const signature = contract.signature;
  if (!signature || trimString(signature.algorithm) !== 'ed25519'
    || !trimString(signature.keyId) || !trimString(signature.signedAt) || !trimString(signature.value)) {
    return { valid: false, reason: 'incomplete signature block' };
  }
  if (contract.connectionMode === 'turn-first') {
    const turnCandidates = contract.candidates.filter((entry) => entry?.kind === 'turn');
    const hasTurnCandidate = turnCandidates.length > 0;
    if (!hasTurnCandidate) return { valid: false, reason: 'turn-first mode requires a turn candidate' };
    if (turnCandidates.length !== 1 || contract.initialCarrier?.kind !== 'turn'
      || contract.initialCarrier.candidateId !== turnCandidates[0].id) {
      return { valid: false, reason: 'turn-first mode requires a turn initialCarrier' };
    }
  }
  if (contract.fallback !== null) {
    return { valid: false, reason: 'fallback extension is not enabled in contract v2' };
  }
  if (!publicKeyPem) return { valid: false, reason: 'instance public key is required' };
  try {
    const valid = cryptoVerify(
      null,
      Buffer.from(buildContractSigningPayload(contract), 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.value, 'base64url'),
    );
    return valid ? { valid: true } : { valid: false, reason: 'signature mismatch' };
  } catch {
    return { valid: false, reason: 'signature verification failed' };
  }
}

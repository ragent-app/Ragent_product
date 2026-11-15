import { createHmac, timingSafeEqual } from 'crypto';

// canonical 的字符串值序列化有"Android org.json 转义正斜杠"的怪癖：
// Android 的 JSONObject.toString() 把 `/` 输出为 `\/`（libcore JSONStringer
// 与 RFC 4627 的实现差异），而 Node 的 JSON.stringify 不转义。App（移动端）
// 的 MAC 用转义形态（slashEscape:true），Web/JS 客户端用不转义形态。
// verify 双形态都试（向后兼容），sign 默认转义形态（对齐 App——唯一真实移动端）。
function canonical(envelope, { slashEscape = false } = {}) {
  const base = JSON.stringify({
    v: 1,
    roomId: String(envelope.roomId || ''),
    seq: Number(envelope.seq || 0),
    timestamp: Number(envelope.timestamp || 0),
    payload: envelope.payload || null,
  });
  return slashEscape ? base.replace(/\//g, '\\/') : base;
}

export function createP2PRoomId(secret) {
  return createHmac('sha256', String(secret || '')).update('ragent-p2p-room-v1').digest('hex').slice(0, 40);
}

export function signP2PSignal({ roomId, secret, seq, payload, timestamp = Date.now() }) {
  const envelope = { v: 1, roomId, seq, timestamp, payload };
  envelope.mac = createHmac('sha256', String(secret || '')).update(canonical(envelope, { slashEscape: true })).digest('base64url');
  return envelope;
}

export function verifyP2PSignal(envelope, { roomId, secret, maxSkewMs = 10 * 60_000 } = {}) {
  if (!envelope || envelope.v !== 1 || envelope.roomId !== roomId) return false;
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) return false;
  if (!Number.isFinite(envelope.timestamp) || Math.abs(Date.now() - envelope.timestamp) > maxSkewMs) return false;
  const secretBytes = String(secret || '');
  const expected = [
    createHmac('sha256', secretBytes).update(canonical(envelope)).digest(),
    createHmac('sha256', secretBytes).update(canonical(envelope, { slashEscape: true })).digest(),
  ];
  let actual;
  try { actual = Buffer.from(String(envelope.mac || ''), 'base64url'); } catch { return false; }
  return actual.length === expected[0].length && expected.some((exp) => timingSafeEqual(actual, exp));
}

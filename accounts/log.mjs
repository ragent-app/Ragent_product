// @ts-check
// Accounts 结构化日志：pino 实例，敏感字段统一 redact。
import { pino } from 'pino';

const SENSITIVE_FIELDS = [
  'idToken',
  'grant',
  'accountJoinGrant',
  'grantHash',
  'token',
  'tokenHash',
  'writeToken',
  'readToken',
  'bootstrap',
  'bootstrapHash',
  'csrf',
  'browserState',
  'phoneState',
  'deliveryGrant',
  'email',
  'signature',
  'receiptSecret',
  'confirmationSecret',
  'receiptSecretHash',
  'confirmationSecretHash',
  'proof',
  'nonce',
  'password',
  'passwordHash',
];

// pino 的 `*.field` 只匹配嵌套字段，顶层字段需要裸路径，因此两者都列出。
export const ACCOUNTS_LOGGER_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body.password',
  'request.body.password',
  ...SENSITIVE_FIELDS.flatMap((field) => [field, `*.${field}`]),
  ...SENSITIVE_FIELDS.flatMap((field) => [`req.body.${field}`, `request.body.${field}`]),
];

// Rejected URLs can still reach Fastify's automatic incoming-request log.
// Preserve ordinary request logging; never retain deletion query capabilities.
export function sanitizeAccountDeletionUrl(value) {
  if (typeof value !== 'string') return value;
  const path = value.split(/[?#]/, 1)[0];
  const at = path.indexOf('/v1/account-deletion');
  if (at < 0) return value;
  const tail = path.slice(at);
  return path.slice(0, at) + (/^\/v1\/account-deletion\/(?:challenges|confirmations|requests|receipts\/lookup)$/.test(tail)
    ? tail : '/v1/account-deletion/[redacted]');
}

/**
 * 供 Fastify 的 logger 配置（Fastify v5 只接受配置对象，不接受实例）。
 * @param {{ level?: string }} [options]
 */
export function createAccountsLoggerOptions({ level } = {}) {
  return {
    level: level || process.env.AGENTOC_ACCOUNTS_LOG_LEVEL || 'info',
    redact: { paths: ACCOUNTS_LOGGER_REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      path: sanitizeAccountDeletionUrl,
      url: sanitizeAccountDeletionUrl,
      req: (req) => ({ method: req.method, url: sanitizeAccountDeletionUrl(req.url),
        version: req.headers?.['accept-version'], host: req.host, remoteAddress: req.ip,
        remotePort: req.socket?.remotePort }),
    },
  };
}

/**
 * 创建独立 pino 日志器（非 Fastify 场景）。
 * @param {{ level?: string, stream?: import('node:stream').Writable }} [options]
 */
export function createAccountsLogger({ level, stream } = {}) {
  return pino(createAccountsLoggerOptions({ level }), stream);
}

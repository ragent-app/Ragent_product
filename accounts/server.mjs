// 可直接启动的 Accounts owner-auth 服务组合入口。
// 生产部署可替换 verifyGoogleCredential/resolveAccount，但默认实现不把
// Google secret 或 token 写入实例，只在 Accounts 侧验证短时 GIS ID token。
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createJwksHandler, loadOrCreateSigningKeyRing, signAssertionFactory } from './keys.mjs';
import { createAccountsLogger, createAccountsLoggerOptions, sanitizeAccountDeletionUrl } from './log.mjs';
import { createAccountDeletionService } from './account-deletion-service.mjs';
import { ACCOUNT_DELETION_BODY_LIMIT, handleAccountDeletionRoutes } from './account-deletion-routes.mjs';
import { createContentReportStore, handleContentReportRoutes } from './content-reports.mjs';
import { createOwnerAuthBroker } from './owner-auth-broker.mjs';
import { createAccountEntitlementResolver } from './turn-lease-policy.mjs';
import { loadDemoAccountAuth } from './demo-credentials.mjs';
import { handleOwnerAuthRoutes } from './owner-auth-routes.mjs';
import { createRefreshLeaseBroker } from './refresh-lease-broker.mjs';
import { handleRefreshLeaseRoutes } from './refresh-lease-routes.mjs';
import { createTemporaryPairingBroker } from './temporary-pairing-broker.mjs';
import { createTemporaryClaimCipher, readTemporaryClaimKeyRing } from './temporary-pairing-cipher.mjs';
import { handleTemporaryPairingRoutes } from './temporary-pairing-routes.mjs';
import { createTemporaryControlBroker } from './temporary-control-broker.mjs';
import { handleTemporaryControlRoutes } from './temporary-control-routes.mjs';
import { createAccountPairingBroker } from './account-pairing-broker.mjs';
import { handleAccountPairingRoutes } from './account-pairing-routes.mjs';
import { createPostgresStoreFromUrl } from './store/postgres.mjs';
import { ACCOUNT_ASR_MAX_AUDIO_BYTES } from './asr-audio.mjs';
import { ACCOUNT_ASR_MODEL } from './asr-policy.mjs';
import { createAccountAsrPostgresStore } from './asr-postgres-store.mjs';
import { createAccountAsrService } from './asr-service.mjs';
import { createElevenLabsScribeTranscriber } from './asr-elevenlabs.mjs';
import { buildHarnessPolicyDocument } from '../lib/harness-policy.mjs';
import {
  createGoogleIdTokenVerifier as createNativeGoogleIdTokenVerifier,
  resolveGoogleNativeServerClientIds,
} from '../lib/google-id-token.mjs';
import { readFile as readPolicyFile } from 'node:fs/promises';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function unb64(value) {
  return Buffer.from(
    text(value)
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(text(value).length / 4) * 4, '='),
    'base64',
  );
}
function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function writeAtomic(filePath, value, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, json(value), { mode });
  await rename(tmp, filePath);
}

export function createFileStore(filePath) {
  let queue = Promise.resolve();
  return {
    async ping() {
      await mkdir(dirname(filePath), { recursive: true });
      return true;
    },
    async mutate(mutator) {
      const run = queue.then(async () => {
        let state;
        try {
          state = JSON.parse(await readFile(filePath, 'utf8'));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          state = {};
        }
        const result = await mutator(state);
        await writeAtomic(filePath, state);
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

export function createGoogleIdTokenVerifier({
  clientId,
  fetchImpl = globalThis.fetch,
  jwksUrl = GOOGLE_JWKS_URL,
  clock = Date.now,
} = {}) {
  const expectedClientId = text(clientId);
  let cached = null;
  return async ({ idToken, nonce }) => {
    if (!expectedClientId || typeof fetchImpl !== 'function') throw new Error('Google verifier is not configured');
    const parts = text(idToken).split('.');
    if (parts.length !== 3) throw new Error('Invalid Google ID token');
    let header;
    let claims;
    try {
      header = JSON.parse(unb64(parts[0]).toString());
      claims = JSON.parse(unb64(parts[1]).toString());
    } catch {
      throw new Error('Invalid Google ID token');
    }
    if (header.alg !== 'RS256' || !text(header.kid)) throw new Error('Unsupported Google ID token');
    if (!cached || cached.expiresAt <= Date.now()) {
      const response = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Google keys unavailable');
      cached = { keys: await response.json(), expiresAt: Date.now() + 5 * 60 * 1000 };
    }
    const jwk = Array.isArray(cached.keys?.keys) ? cached.keys.keys.find((item) => item.kid === header.kid) : null;
    const valid =
      jwk &&
      verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        unb64(parts[2]),
      );
    const now = Math.floor(clock() / 1000);
    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !valid ||
      !GOOGLE_ISSUERS.has(text(claims.iss)) ||
      !audiences.includes(expectedClientId) ||
      text(claims.nonce) !== text(nonce) ||
      !text(claims.sub) ||
      !Number.isFinite(iat) ||
      iat > now + 5 * 60 ||
      !Number.isFinite(exp) ||
      exp <= now ||
      exp - iat > 24 * 60 * 60
    ) {
      throw new Error('Google ID token rejected');
    }
    return { providerSubject: text(claims.sub), email: text(claims.email), name: text(claims.name) };
  };
}

function createAccountResolver() {
  return async ({ draft, googleIdentity }) => {
    if (!Array.isArray(draft.accounts)) draft.accounts = [];
    const subject = text(googleIdentity?.providerSubject);
    if (!subject) return null;
    let account = draft.accounts.find((item) => item.provider === 'google' && item.providerSubject === subject);
    if (!account) {
      account = {
        accountId: `acct_google_${sha256(subject).slice(0, 32)}`,
        provider: 'google',
        providerSubject: subject,
        createdAt: new Date().toISOString(),
      };
      draft.accounts.push(account);
    }
    return account;
  };
}

export async function createAccountsServer({
  dataFile,
  publicBaseUrl,
  googleWebClientId,
  signingKeyFile,
  turnBrokerSigningKeyFile,
  store,
  verifyGoogleCredential,
  verifyNativeGoogleCredential,
  resolveAccount = createAccountResolver(),
  fetchImpl = globalThis.fetch,
  allowInsecurePublicBaseUrl = false,
  audit = () => {},
  clock = Date.now,
  harnessPolicyFile = '',
  temporaryPairingKeyFile = '',
  temporaryPairingKeyRing,
  demoAccountPolicyFile = '',
  contentReportFile = '',
  contentReportStore,
  asrService: injectedAsrService,
  asrRepository,
  asrTranscribe,
  asrEnabled: asrEnabledOverride,
  elevenLabsApiKey,
  asrZeroRetention,
  asrTimeoutMs,
  accountDeletionEnabled = false,
  googleNativeClientIds = resolveGoogleNativeServerClientIds(),
  accountDeletionWorkerIntervalMs = 1000,
} = {}) {
  const keyRing = await loadOrCreateSigningKeyRing(signingKeyFile, { clock });
  const turnKeyFile = turnBrokerSigningKeyFile
    || join(dirname(signingKeyFile || dataFile || '.'), 'turn-broker-signing-key.json');
  const turnBrokerKeyRing = await loadOrCreateSigningKeyRing(turnKeyFile, { clock });
  const stateStore = store || createFileStore(dataFile);
  let accountDeletion = null;
  let accountDeletionStatus = 'disabled';
  if (accountDeletionEnabled) {
    const base = new URL(publicBaseUrl);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(allowInsecurePublicBaseUrl && loopback && base.protocol === 'http:'))
      || base.username || base.password || base.search || base.hash) {
      throw new Error('Account deletion requires a fixed HTTPS Accounts base URL');
    }
    try {
      const context = stateStore.accountDeletionContext?.();
      if (!context) throw new Error('PostgreSQL deletion context required');
      const candidate = createAccountDeletionService({ ...context, googleWebClientId,
        nativeGoogleClientIds: googleNativeClientIds, fetchImpl, clock,
        workerIntervalMs: accountDeletionWorkerIntervalMs, audit });
      await candidate.checkReady();
      accountDeletion = candidate;
      accountDeletionStatus = 'ready';
    } catch {
      accountDeletionStatus = 'unavailable';
      audit({ event: 'account_deletion.store_unavailable', code: 'account_deletion_unavailable' });
    }
  }
  let contentReports = null;
  let contentReportStatus = 'disabled';
  if (contentReportStore || contentReportFile) {
    try {
      contentReports = contentReportStore || await createContentReportStore({ filePath: contentReportFile, clock });
      contentReportStatus = 'ready';
    } catch (error) {
      contentReportStatus = 'unavailable';
      audit({ event: 'content_report.store_unavailable', code: typeof error?.code === 'string'
        && error.code.startsWith('content_report_') ? error.code : 'content_report_store_failed' });
    }
  }
  const verifier =
    verifyGoogleCredential || createGoogleIdTokenVerifier({ clientId: googleWebClientId, fetchImpl, clock });
  // The web verifier and native verifier have different audience contracts.
  // Never reuse an injected web verifier for native credentials; deployments
  // that need custom native validation must inject it explicitly.
  const nativeVerifier = verifyNativeGoogleCredential
    || optionsNativeVerifier(fetchImpl, clock);
  const demoAccountAuth = await loadDemoAccountAuth(demoAccountPolicyFile, { clock });
  const resolveEntitlement = createAccountEntitlementResolver(demoAccountAuth);
  const broker = createOwnerAuthBroker({
    demoAccountAuth, resolveEntitlement,
    store: stateStore,
    issuer: new URL(publicBaseUrl).origin,
    verifyGoogleCredential: verifier,
    verifyNativeGoogleCredential: nativeVerifier,
    resolveAccount,
    signAssertion: signAssertionFactory(keyRing),
    signTurnBrokerCapability: signAssertionFactory(turnBrokerKeyRing),
    allowInsecureReturnUrl: allowInsecurePublicBaseUrl,
    audit,
    clock,
  });
  const asrKey = text(elevenLabsApiKey ?? process.env.ELEVENLABS_API_KEY);
  const asrEnabled = (asrEnabledOverride ?? process.env.AGENTOC_ACCOUNTS_ASR_ENABLED === '1') && Boolean(asrKey);
  let asrService = injectedAsrService || null;
  let asrStatus = asrService ? (asrService.enabled ? 'ready' : 'disabled') : 'unconfigured';
  if (!asrService && typeof stateStore.accountAsrContext === 'function') {
    const repository = asrRepository || createAccountAsrPostgresStore({ ...stateStore.accountAsrContext(), clock });
    const transcribe = asrTranscribe || (asrKey ? createElevenLabsScribeTranscriber({
      apiKey: asrKey,
      fetchImpl,
      modelId: ACCOUNT_ASR_MODEL,
      zeroRetention: (asrZeroRetention ?? process.env.AGENTOC_ACCOUNTS_ASR_ZERO_RETENTION) === '1',
      timeoutMs: Number(asrTimeoutMs ?? process.env.AGENTOC_ACCOUNTS_ASR_TIMEOUT_MS) || 30_000,
    }) : undefined);
    asrService = createAccountAsrService({ authenticateAccount: broker.authenticateAccountAsr,
      repository, transcribe, enabled: asrEnabled, env: process.env, clock, audit });
  }
  if (asrService) {
    try {
      await asrService.checkReady?.();
      asrService.startMaintenance?.();
      asrStatus = asrService.enabled ? 'ready' : asrKey ? 'disabled' : 'unconfigured';
    } catch (error) {
      asrStatus = 'unavailable';
      audit({ event: 'account_asr.store_unavailable', code: typeof error?.code === 'string'
        ? error.code : 'asr_schema_unavailable' });
    }
  }
  const jwks = createJwksHandler(keyRing, { clock });
  const turnBrokerJwks = createJwksHandler(turnBrokerKeyRing, { clock });
  const refreshLeaseBroker = createRefreshLeaseBroker({ store: stateStore, clock, audit });
  const temporaryKeys = temporaryPairingKeyRing || (temporaryPairingKeyFile
    ? await readTemporaryClaimKeyRing(temporaryPairingKeyFile) : null);
  if (temporaryKeys) {
    const base = new URL(publicBaseUrl);
    if ((base.protocol !== 'https:' && !(allowInsecurePublicBaseUrl && base.protocol === 'http:'))
      || base.username || base.password || base.search || base.hash) {
      throw new Error('Temporary pairing requires a fixed HTTPS Accounts base URL');
    }
  }
  const temporaryBroker = temporaryKeys ? createTemporaryPairingBroker({
    resolveEntitlement,
    store: stateStore, cipher: createTemporaryClaimCipher(temporaryKeys), clock,
    issuer: new URL(publicBaseUrl).origin, signTurnBrokerCapability: signAssertionFactory(turnBrokerKeyRing),
  }) : null;
  const temporaryControlBroker = temporaryKeys ? createTemporaryControlBroker({
    resolveEntitlement,
    store: stateStore, cipher: createTemporaryClaimCipher(temporaryKeys), clock,
    issuer: new URL(publicBaseUrl).origin, signTurnBrokerCapability: signAssertionFactory(turnBrokerKeyRing),
  }) : null;
  const accountPairingBroker = temporaryKeys ? createAccountPairingBroker({
    store: stateStore, cipher: createTemporaryClaimCipher(temporaryKeys), clock,
    issueSession: broker.completeDelegatedAccountSessionInTransaction,
  }) : null;
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', publicBaseUrl);
    const basePath = new URL(publicBaseUrl).pathname.replace(/\/+$/, '');
    const isPath = (path) => url.pathname === path || (basePath && url.pathname === `${basePath}${path}`);
    if (isPath('/.well-known/jwks.json') && req.method === 'GET') return jwks(req, res);
    if (isPath('/.well-known/turn-broker-jwks.json') && req.method === 'GET') return turnBrokerJwks(req, res);
    if (isPath('/v1/harness-policy') && req.method === 'GET') {
      let overrides = {};
      if (harnessPolicyFile) {
        try { overrides = JSON.parse(await readPolicyFile(harnessPolicyFile, 'utf8')); } catch (error) {
          if (error?.code !== 'ENOENT') audit({ event: 'harness_policy.read_failed', message: String(error?.message || error).slice(0, 240) });
        }
      }
      const stats = harnessPolicyFile ? await import('node:fs/promises').then((fs) => fs.stat(harnessPolicyFile).catch(() => null)) : null;
      const updatedAt = stats?.mtime?.toISOString?.() || '';
      const policy = buildHarnessPolicyDocument(overrides?.policies || overrides, { updatedAt });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
        'ETag': `"${policy.revision}:${updatedAt || 'builtin'}"`,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(policy));
      return true;
    }
    // handleOwnerAuthRoutes 在内部剥掉 publicBaseUrl 路径前缀，
    // handleRefreshLeaseRoutes 没有 publicBaseUrl 上下文，所以这里先剥前缀。
    const rawPathname = `${url.pathname}${url.search}`;
    const strippedPathname =
      basePath && basePath !== '/' && url.pathname.startsWith(`${basePath}/`)
        ? `${url.pathname.slice(basePath.length)}${url.search}`
        : rawPathname;
    if (await handleContentReportRoutes({ req, res, pathname: strippedPathname, store: contentReports })) return true;
    if (await handleAccountDeletionRoutes({ req, res, pathname: strippedPathname, service: accountDeletion, publicBaseUrl })) return true;
    if (await handleTemporaryPairingRoutes({ req, res, pathname: strippedPathname, broker: temporaryBroker })) return true;
    if (await handleTemporaryControlRoutes({ req, res, pathname: strippedPathname, broker: temporaryControlBroker })) return true;
    if (await handleAccountPairingRoutes({ req, res, pathname: strippedPathname, broker: accountPairingBroker })) return true;
    const handledByLeases = await handleRefreshLeaseRoutes({
      req,
      res,
      pathname: strippedPathname,
      broker: refreshLeaseBroker,
      audit,
    });
    if (handledByLeases) return true;
    return handleOwnerAuthRoutes({
      req,
      res,
      pathname: rawPathname,
      broker,
      publicBaseUrl,
      googleWebClientId,
      allowInsecurePublicBaseUrl,
      audit,
    });
  };
  return {
    handler,
    broker,
    store: stateStore,
    temporaryBroker,
    temporaryControlBroker,
    accountPairingBroker,
    contentReports,
    contentReportStatus,
    accountDeletion,
    accountDeletionStatus,
    asrService,
    asrStatus,
    keyRecord: keyRing,
    turnBrokerKeyRecord: turnBrokerKeyRing,
  };
}

function optionsNativeVerifier(fetchImpl, clock) {
  const clientIds = resolveGoogleNativeServerClientIds();
  return createNativeGoogleIdTokenVerifier({ clientIds, fetchImpl, clock });
}

// 限流上限解析：options.rateLimit 显式配置优先，其次是环境变量，最后是默认值。
// 独立导出便于契约测试，也方便部署侧只通过 /etc/agentoc/accounts.env 调整。
export function resolveAccountsRateLimits({ options = {}, env = process.env } = {}) {
  const positiveInt = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  };
  return {
    getMax: options.max ?? positiveInt(env.AGENTOC_ACCOUNTS_RATE_LIMIT_GET_MAX) ?? 60,
    postMax: options.postMax ?? positiveInt(env.AGENTOC_ACCOUNTS_RATE_LIMIT_POST_MAX) ?? 60,
    // One instance refreshes its signed proof every 10 seconds. Allow a
    // shared NAT substantially more than ten instances without letting
    // unauthenticated requests run unbounded.
    authorityMax: options.authorityMax ?? positiveInt(env.AGENTOC_ACCOUNTS_RATE_LIMIT_AUTHORITY_MAX) ?? 600,
  };
}

export async function startAccountsServer(options = {}) {
  const databaseUrl = options.databaseUrl || process.env.AGENTOC_ACCOUNTS_DATABASE_URL || '';
  const auditLogger = createAccountsLogger({ level: process.env.AGENTOC_ACCOUNTS_LOG_LEVEL || 'info' });
  const serverOptions = {
    dataFile:
      options.dataFile ||
      process.env.AGENTOC_ACCOUNTS_DATA_FILE ||
      join(process.env.AGENTOC_ACCOUNTS_DATA_DIR || '.', 'accounts.json'),
    publicBaseUrl:
      options.publicBaseUrl || process.env.AGENTOC_ACCOUNTS_PUBLIC_BASE_URL || 'https://accounts.agentoc.example',
    googleWebClientId: options.googleWebClientId || process.env.AGENTOC_GOOGLE_WEB_CLIENT_ID || '',
    signingKeyFile:
      options.signingKeyFile ||
      process.env.AGENTOC_ACCOUNTS_SIGNING_KEY_FILE ||
      join(process.env.AGENTOC_ACCOUNTS_DATA_DIR || '.', 'signing-key.json'),
    turnBrokerSigningKeyFile:
      options.turnBrokerSigningKeyFile ||
      process.env.AGENTOC_ACCOUNTS_TURN_BROKER_SIGNING_KEY_FILE ||
      join(process.env.AGENTOC_ACCOUNTS_DATA_DIR || '.', 'turn-broker-signing-key.json'),
    harnessPolicyFile:
      options.harnessPolicyFile ||
      process.env.AGENTOC_HARNESS_POLICY_FILE ||
      join(process.env.AGENTOC_ACCOUNTS_DATA_DIR || '.', 'harness-policy.json'),
    temporaryPairingKeyFile: options.temporaryPairingKeyFile || process.env.AGENTOC_TEMPORARY_PAIRING_KEY_FILE || '',
    demoAccountPolicyFile: options.demoAccountPolicyFile || process.env.AGENTOC_DEMO_ACCOUNT_POLICY_FILE || '',
    contentReportFile: options.contentReportFile || process.env.AGENTOC_ACCOUNTS_CONTENT_REPORT_FILE || '',
    accountDeletionEnabled: process.env.AGENTOC_ACCOUNTS_ACCOUNT_DELETION_ENABLED === '1',
    audit: (fields) => auditLogger.info(fields),
    ...options,
    store: options.store || (databaseUrl ? createPostgresStoreFromUrl(databaseUrl, {
      enableScopedRendezvousResult: options.enableScopedRendezvousResult ??
        (process.env.AGENTOC_ACCOUNTS_SCOPED_RENDEZVOUS_RESULT === '1'),
      enableScopedRendezvousCreation: options.enableScopedRendezvousCreation ??
        (process.env.AGENTOC_ACCOUNTS_SCOPED_RENDEZVOUS_CREATION === '1'),
    }) : undefined),
  };
  const app = await createAccountsServer(serverOptions);
  const fastify = Fastify({
    logger: options.logger || createAccountsLoggerOptions(),
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  await fastify.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  fastify.addHook('preClose', async () => { app.broker.closeRendezvousInboxWaiters(); });
  fastify.addHook('onClose', async () => {
    await app.accountDeletion?.close();
    await app.asrService?.close?.();
  });
  fastify.setErrorHandler((error, request, reply) => {
    const path = String(request.url).split(/[?#]/, 1)[0];
    if (path.includes('/v1/owner-auth/account/asr/')) {
      const status = error.statusCode === 413 ? 413 : error.statusCode === 415 ? 415
        : error.statusCode === 429 ? 429 : error.statusCode === 400 ? 400 : error.statusCode >= 500 ? 503 : 400;
      return reply.code(status).headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer' }).send({ code: status === 413 ? 'asr_audio_too_large'
        : status === 415 ? 'asr_audio_content_type_unsupported' : status === 429 ? 'asr_rate_limited'
          : status === 400 ? 'asr_audio_invalid' : 'asr_unavailable' });
    }
    if (path.includes('/v1/account-deletion/')) {
      const status = error.statusCode === 413 ? 413 : error.statusCode === 415 ? 415
        : error.statusCode === 429 ? 429 : error.statusCode >= 500 ? 503 : 400;
      return reply.code(status).headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer' }).send({ code: status === 413 ? 'account_deletion_too_large'
        : status === 415 ? 'account_deletion_json_required' : status === 429 ? 'account_deletion_rate_limited'
          : status === 503 ? 'account_deletion_unavailable' : 'account_deletion_invalid' });
    }
    reply.send(error);
  });

  fastify.get('/healthz', async () => ({ status: 'ok' }));
  fastify.get('/readyz', async (request, reply) => {
    try {
      if (app.store && typeof app.store.ping === 'function') await app.store.ping();
      return {
        status: 'ready',
        signingKey: Boolean(app.keyRecord),
        turnBrokerSigningKey: Boolean(app.turnBrokerKeyRecord),
        contentReporting: app.contentReportStatus,
        accountDeletion: app.accountDeletionStatus,
        speechRecognition: app.asrStatus,
        ...(app.accountDeletion ? { accountDeletionWorker: app.accountDeletion.workerStatus() } : {}),
      };
    } catch (error) {
      request.log.error({ err: error }, 'readyz failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const rateLimitOptions = options.rateLimit || {};
  // Keep signed authority refresh, inbox polling and account control in
  // separate per-IP buckets. High-volume pairing and connection recovery must
  // not starve the short-lived authority proofs used by active devices.
  const rateLimits = resolveAccountsRateLimits({ options: rateLimitOptions, env: process.env });
  fastify.log.info({ getMax: rateLimits.getMax, postMax: rateLimits.postMax, authorityMax: rateLimits.authorityMax }, 'accounts rate limits');
  const basePath = new URL(serverOptions.publicBaseUrl).pathname.replace(/\/+$/, '');
  const asrTranscriptionPath = '/v1/owner-auth/account/asr/transcriptions';
  const asrUsagePath = '/v1/owner-auth/account/asr/usage';
  const asrPath = (path) => [...new Set([path, ...(basePath && basePath !== '/' ? [`${basePath}${path}`] : [])])];
  fastify.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: ACCOUNT_ASR_MAX_AUDIO_BYTES },
    (_request, body, done) => done(null, body));
  for (const path of asrPath(asrTranscriptionPath)) {
    fastify.post(path, { bodyLimit: ACCOUNT_ASR_MAX_AUDIO_BYTES,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      reply.headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      if (!/^audio\/wav(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
        return reply.code(415).send({ code: 'asr_audio_content_type_unsupported' });
      }
      if (!app.asrService || app.asrStatus === 'unavailable' || app.asrStatus === 'unconfigured') {
        return reply.code(503).send({ code: 'asr_unavailable' });
      }
      const authorization = request.headers.authorization || '';
      const credential = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
      const controller = new AbortController();
      const abortIfDisconnected = () => {
        if (!reply.raw.writableEnded && !controller.signal.aborted) controller.abort();
      };
      request.raw.once('aborted', abortIfDisconnected);
      reply.raw.once('close', abortIfDisconnected);
      try {
        const result = await app.asrService.transcribeAudio({ credential,
          requestId: String(request.headers['idempotency-key'] || ''), audio: request.body, signal: controller.signal });
        return reply.code(200).send(result);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
        const safeStatus = status >= 400 && status <= 599 ? status : 503;
        return reply.code(safeStatus).send({ code: typeof error?.code === 'string' ? error.code : 'asr_unavailable' });
      } finally {
        request.raw.off('aborted', abortIfDisconnected);
        reply.raw.off('close', abortIfDisconnected);
      }
    });
  }
  for (const path of asrPath(asrUsagePath)) {
    fastify.get(path, async (request, reply) => {
      reply.headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      // Keep account-scoped usage visible while the provider is disabled or
      // its key has not been provisioned. `available` communicates readiness;
      // the usage endpoint itself remains useful for the Android settings UI.
      if (!app.asrService || app.asrStatus === 'unavailable') {
        return reply.code(503).send({ code: 'asr_unavailable' });
      }
      const authorization = request.headers.authorization || '';
      const credential = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
      try {
        const result = await app.asrService.getUsage({ credential, period: request.query?.period });
        return reply.code(200).send(result);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
        const safeStatus = status >= 400 && status <= 599 ? status : 503;
        return reply.code(safeStatus).send({ code: typeof error?.code === 'string' ? error.code : 'asr_unavailable' });
      }
    });
  }
  const inboxPath = '/v1/owner-auth/rendezvous/inbox';
  const inboxPaths = new Set([inboxPath, ...(basePath && basePath !== '/' ? [`${basePath}${inboxPath}`] : [])]);
  const authorityPath = '/v1/owner-auth/instances/authority';
  const authorityPaths = new Set([authorityPath, ...(basePath && basePath !== '/' ? [`${basePath}${authorityPath}`] : [])]);
  const mount = (method, max, path = '/*') =>
    fastify[method](path, { config: { rateLimit: { max: method === 'post' && path === '/*'
      ? request => authorityPaths.has(String(request.url).split(/[?#]/, 1)[0]) ? rateLimits.authorityMax : max
      : max, timeWindow: '1 minute',
      ...(method === 'post' && path === '/*' ? { keyGenerator: request => JSON.stringify([
        request.ip, inboxPaths.has(String(request.url).split(/[?#]/, 1)[0]) ? 'rendezvous-inbox'
          : authorityPaths.has(String(request.url).split(/[?#]/, 1)[0]) ? 'binding-authority' : 'account-control',
      ]) } : {}),
    } },
      ...(path.includes('/v1/account-deletion/') ? { bodyLimit: ACCOUNT_DELETION_BODY_LIMIT } : {}) }, async (request, reply) => {
      reply.hijack();
      const res = reply.raw;
      const startedAt = process.hrtime.bigint();
      try {
        // Fastify 已消费 raw 请求体，这里用解析后的 body 重建可读流，
        // 并保留原始 headers/method/url 供 owner-auth handler 使用。
        const req = Readable.from([Buffer.from(JSON.stringify(request.body ?? {}))]);
        req.headers = request.raw.headers;
        req.method = request.raw.method;
        req.url = request.raw.url;
        const handled = await app.handler(req, res);
        if (!handled && !res.writableEnded) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (error) {
        request.log.error({ err: error, path: sanitizeAccountDeletionUrl(request.url) }, 'owner-auth handler failed');
        if (!res.headersSent) {
          res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Accounts service failure' }));
        }
      } finally {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        request.log.info({ path: request.url, statusCode: res.statusCode || 0, durationMs }, 'owner-auth handled');
      }
    });
  mount('get', rateLimits.getMax);
  mount('post', rateLimits.postMax);
  const deletionPaths = new Set(['/v1/account-deletion/*',
    `${new URL(serverOptions.publicBaseUrl).pathname.replace(/\/+$/, '')}/v1/account-deletion/*`]);
  for (const method of ['post', 'put', 'patch', 'delete', 'options']) {
    for (const path of deletionPaths) mount(method, rateLimits.postMax, path);
  }
  fastify.addHook('preClose', async () => { app.broker.closeRendezvousResultWaiters(); });

  const port = Number(options.port ?? process.env.PORT ?? 7700);
  const host = options.host || process.env.AGENTOC_ACCOUNTS_HOST || '127.0.0.1';
  await fastify.listen({ port, host });
  app.accountDeletion?.startWorker();
  return {
    ...app,
    server: fastify.server,
    fastify,
    async close() {
      await fastify.close();
      app.contentReports?.close();
      if (app.store && typeof app.store.close === 'function') await app.store.close();
    },
  };
}

const isMainModule = process.argv[1]
  ? await realpath(process.argv[1]).then((entryPath) => import.meta.url === pathToFileURL(entryPath).href).catch(() => false)
  : false;

if (isMainModule) {
  const instance = await startAccountsServer();
  console.log(
    `Accounts owner-auth server listening on ${process.env.AGENTOC_ACCOUNTS_HOST || '127.0.0.1'}:${process.env.PORT || 7700}`,
  );
  const shutdown = async (signal) => {
    console.log(`accounts: received ${signal}, shutting down`);
    await instance.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

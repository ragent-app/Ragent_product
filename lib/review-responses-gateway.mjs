import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REVIEW_MODEL = 'gpt-5.6-luna';
const hash = value => createHash('sha256').update(value).digest();

/** Inference-only boundary. Credential ownership/refresh stays with the caller. */
export function createReviewResponsesGateway({
  clientKey, upstreamUrl, getAccessCredential, fetchImpl = fetch,
  maxBodyBytes = 512 * 1024, maxConcurrent = 2, timeoutMs = 120_000,
}) {
  if (typeof clientKey !== 'string' || clientKey.length < 32 || typeof getAccessCredential !== 'function') {
    throw new Error('A scoped gateway key and an external credential owner are required');
  }
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash
      || !['api.openai.com', 'chatgpt.com'].includes(upstream.hostname)
      || !['/v1/responses', '/backend-api/codex/responses'].includes(upstream.pathname)
      || upstream.port) throw new Error('Unsupported fixed inference upstream');
  if (![maxBodyBytes, maxConcurrent, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Invalid gateway resource bounds');
  }
  const expectedKey = hash(clientKey);
  let active = 0;
  function fail(response, status, code) {
    if (response.destroyed || response.headersSent) return response.destroy();
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { code, message: code } }));
  }
  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
        || authorization.length > 4096 || !timingSafeEqual(hash(authorization.slice(7)), expectedKey)) {
      request.resume(); return fail(response, 401, 'review_gateway_unauthorized');
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      const model = { id: REVIEW_MODEL, slug: REVIEW_MODEL, object: 'model', display_name: 'GPT-5.6 Luna', visibility: 'list' };
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return response.end(JSON.stringify({ object: 'list', data: [model], models: [model] }));
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      request.resume(); return fail(response, 404, 'review_gateway_route_denied');
    }
    if (active >= maxConcurrent) {
      request.resume(); return fail(response, 429, 'review_gateway_busy');
    }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnected);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) { request.resume(); return fail(response, 413, 'review_gateway_request_too_large'); }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return fail(response, 400, 'review_gateway_invalid_json'); }
      if (!body || Array.isArray(body) || body.model !== REVIEW_MODEL) {
        return fail(response, 403, 'review_gateway_model_denied');
      }
      if (body.stream !== true || body.store !== false || !Array.isArray(body.input)) {
        return fail(response, 400, 'review_gateway_stream_required');
      }
      // No client header, URL, cookie, proxy or auth field selects the upstream.
      let rejectCredential;
      const credentialAbort = () => rejectCredential(new Error('Aborted'));
      const interrupted = new Promise((_, reject) => { rejectCredential = reject; });
      controller.signal.addEventListener('abort', credentialAbort, { once: true });
      let credential;
      try {
        if (controller.signal.aborted) credentialAbort();
        credential = await Promise.race([getAccessCredential({ signal: controller.signal }), interrupted]);
      } finally { controller.signal.removeEventListener('abort', credentialAbort); }
      if (controller.signal.aborted) throw new Error('Aborted');
      if (!credential || typeof credential.accessToken !== 'string' || !credential.accessToken
          || /[\r\n]/.test(credential.accessToken)) throw new Error('Credential unavailable');
      const headers = {
        authorization: `Bearer ${credential.accessToken}`, 'content-type': 'application/json',
        accept: 'text/event-stream', 'user-agent': 'Ragent-Review-Gateway/1',
      };
      if (credential.accountId) {
        if (typeof credential.accountId !== 'string' || /[\r\n]/.test(credential.accountId)) throw new Error('Invalid account');
        headers['chatgpt-account-id'] = credential.accountId;
      }
      const result = await fetchImpl(upstream.href, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      if (!result.ok) {
        await result.body?.cancel();
        return fail(response, result.status === 401 || result.status === 403 ? 503 : 502, 'review_gateway_upstream_unavailable');
      }
      const contentType = result.headers.get('content-type');
      if ((contentType && !contentType.toLowerCase().startsWith('text/event-stream')) || !result.body) {
        await result.body?.cancel(); return fail(response, 502, 'review_gateway_invalid_stream');
      }
      // Some existing native-provider routes omit Content-Type. Require an SSE
      // prefix before releasing any bytes; never reinterpret an HTML/JSON error.
      const reader = result.body.getReader();
      const prefix = [];
      let prefixBytes = 0, validPrefix = false;
      while (prefixBytes < 4096) {
        const next = await reader.read();
        if (next.done) break;
        prefix.push(next.value); prefixBytes += next.value.byteLength;
        const head = Buffer.concat(prefix).subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
        if (/^(event:|data:|:)/.test(head)) { validPrefix = true; break; }
        if (head.includes('\n') || head.length > 6) break;
      }
      if (!validPrefix) {
        await reader.cancel(); return fail(response, 502, 'review_gateway_invalid_stream');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      async function* streamChunks() {
        try {
          yield* prefix;
          while (true) { const next = await reader.read(); if (next.done) return; yield next.value; }
        } finally { await reader.cancel().catch(() => {}); }
      }
      await pipeline(Readable.from(streamChunks(), { objectMode: false }), response, { signal: controller.signal });
    } catch {
      fail(response, 503, 'review_gateway_unavailable');
    } finally {
      clearTimeout(timer); response.off('close', disconnected); active--;
    }
  });
  server.requestTimeout = Math.min(timeoutMs, 30_000);
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);
  return server;
}

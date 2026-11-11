function providerError(code, statusCode, { definitelyNotProcessed = false } = {}) {
  return Object.assign(new Error(code), { code, statusCode, definitelyNotProcessed });
}

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

async function readProviderJson(response) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw Error('Provider response exceeded the size limit');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  }
  // Small injected fetch stubs used in tests may expose only json().
  if (typeof response.text === 'function') {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_PROVIDER_RESPONSE_BYTES) throw Error('Provider response exceeded the size limit');
    return JSON.parse(body);
  }
  if (typeof response.json === 'function') return response.json();
  throw Error('Provider response body is unavailable');
}

export function createOpenAiTranscriber({
  apiKey,
  fetchImpl = globalThis.fetch,
  modelId = 'gpt-transcribe',
  baseUrl = 'https://api.openai.com',
  timeoutMs = 30_000,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key || typeof fetchImpl !== 'function') throw new TypeError('OpenAI credentials and fetch are required');

  return async function transcribe(audio, { signal: requestSignal, requestId = '' } = {}) {
    const form = new FormData();
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav');
    form.set('model', modelId);
    // Deliberately omit a language hint so the model detects the spoken language.
    const url = new URL('/v1/audio/transcriptions', baseUrl);

    const headers = { Authorization: `Bearer ${key}` };
    if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
      // This opaque Ragent request ID contains no account/device information and
      // lets OpenAI support locate a request if the response is lost.
      headers['X-Client-Request-Id'] = requestId;
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: form,
        redirect: 'error',
        signal: requestSignal
          ? AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw providerError('asr_provider_outcome_unknown', 503);
    }

    if (!response.ok) {
      const statusCode = response.status;
      await response.body?.cancel?.().catch(() => {});
      const definitelyNotProcessed = statusCode === 400 || statusCode === 401 || statusCode === 403
        || statusCode === 413 || statusCode === 415 || statusCode === 422 || statusCode === 429;
      const code = statusCode === 401 || statusCode === 403 ? 'asr_provider_auth_failed'
        : statusCode === 429 ? 'asr_provider_rate_limited'
          : statusCode === 400 || statusCode === 413 || statusCode === 415 || statusCode === 422
            ? 'asr_provider_rejected_audio' : statusCode >= 500
              ? 'asr_provider_outcome_unknown' : 'asr_provider_unavailable';
      throw providerError(code, statusCode === 429 ? 503 : statusCode >= 500 ? 503 : 502,
        { definitelyNotProcessed });
    }

    let body;
    try { body = await readProviderJson(response); } catch {
      throw providerError('asr_provider_invalid_response', 502);
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 20_000) throw providerError('asr_provider_invalid_response', 502);
    const rawLanguage = body?.language ?? body?.language_code;
    const languageCode = typeof rawLanguage === 'string' && /^[A-Za-z0-9-]{2,16}$/.test(rawLanguage)
      ? rawLanguage : null;
    return { text, languageCode };
  };
}

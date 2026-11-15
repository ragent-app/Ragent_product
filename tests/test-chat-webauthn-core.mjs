#!/usr/bin/env node
// tests/test-chat-webauthn-core.mjs
//
// Stage 2: webauthn core (static/chat/transport/webauthn.js) is a DOM-free
// port of realtime.js's base64url ↔ ArrayBuffer and WebAuthn public-key
// hydration / credential serialization helpers. Every scenario runs against
// BOTH implementations and compares primitive-level outputs, so the port
// cannot drift from the legacy wire format.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function loadLegacy({ webAuthnAvailable }) {
  const context = {
    console,
    Map,
    Set,
    Date,
    Promise,
    Error,
    Uint8Array,
    ArrayBuffer,
    atob,
    btoa,
    window: {
      addEventListener() {},
      PublicKeyCredential: webAuthnAvailable ? { isUserVerifyingPlatformAuthenticatorAvailable() {} } : undefined,
    },
    navigator: webAuthnAvailable ? { credentials: {} } : undefined,
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8'),
    context,
    { filename: 'realtime.js' },
  );
  return {
    api: {
      base64UrlToArrayBuffer: (v) => context.base64UrlToArrayBuffer(v),
      arrayBufferToBase64Url: (v) => context.arrayBufferToBase64Url(v),
      hydrateWebAuthnPublicKey: (p) => context.hydrateWebAuthnPublicKey(p),
      serializeWebAuthnCredential: (c) => context.serializeWebAuthnCredential(c),
      assertWebAuthnAvailable: () => context.assertWebAuthnAvailable(),
    },
    label: 'legacy',
  };
}

// The urlBase64ToUint8Array counterpart lives in session-http-helpers.js
// (not realtime.js), so it needs its own legacy vm realm: loading helpers
// into the realtime realm would collide on shared top-level declarations.
function loadLegacyHelpers() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
    atob,
    btoa,
    Uint8Array,
    ArrayBuffer,
    navigator: {},
    window: {},
    localStorage: { getItem: () => null },
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  return {
    api: {
      urlBase64ToUint8Array: (v) => context.urlBase64ToUint8Array(v),
    },
    label: 'legacy-helpers',
  };
}

function loadCore({ webAuthnAvailable }) {
  const context = {
    console,
    Map,
    Set,
    Date,
    Promise,
    Error,
    Uint8Array,
    ArrayBuffer,
    RagentWebAuthnEnvironment: {
      atob,
      btoa,
      isWebAuthnAvailable: () => webAuthnAvailable,
    },
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/webauthn.js'), 'utf8'),
    context,
    { filename: 'transport/webauthn.js' },
  );
  const core = context.RagentWebAuthnCore;
  return {
    api: {
      base64UrlToArrayBuffer: (v) => core.base64UrlToArrayBuffer(v),
      arrayBufferToBase64Url: (v) => core.arrayBufferToBase64Url(v),
      hydrateWebAuthnPublicKey: (p) => core.hydrateWebAuthnPublicKey(p),
      serializeWebAuthnCredential: (c) => core.serializeWebAuthnCredential(c),
      assertWebAuthnAvailable: () => core.assertWebAuthnAvailable(),
      urlBase64ToUint8Array: (v) => core.urlBase64ToUint8Array(v),
    },
    label: 'transport',
  };
}

// ArrayBuffers cross the vm realm boundary; normalize to plain arrays so the
// two runs compare at the primitive level.
function bufferReplacer(key, value) {
  if (value instanceof ArrayBuffer) {
    return [...new Uint8Array(value)];
  }
  return value;
}

async function runScenario(api) {
  const out = {};

  // 1. base64url round-trip with known vectors.
  const sample = 'Hello, WebAuthn 世界';
  const bytes = new TextEncoder().encode(sample);
  const encoded = api.arrayBufferToBase64Url(bytes.buffer);
  out.roundTrip = {
    encoded,
    decoded: api.arrayBufferToBase64Url(api.base64UrlToArrayBuffer(encoded)),
  };
  out.vectors = [
    api.arrayBufferToBase64Url(new Uint8Array([0, 1, 2, 253, 254, 255]).buffer),
    api.arrayBufferToBase64Url(new Uint8Array([0]).buffer),
    api.arrayBufferToBase64Url(new ArrayBuffer(0)),
    api.arrayBufferToBase64Url(null),
    api.base64UrlToArrayBuffer('AAEC_f7_'),
  ];

  // 2. Public-key hydration: challenge, user id and credential ids become
  //    ArrayBuffers.
  const hydrated = api.hydrateWebAuthnPublicKey({
    challenge: 'AQID',
    rp: { id: 'example.test', name: 'Example' },
    user: { id: 'dXNlcg', name: 'user' },
    allowCredentials: [{ id: 'AQIDBA', type: 'public-key' }],
    excludeCredentials: [{ id: 'AQID', type: 'public-key' }],
  });
  out.hydrate = {
    challenge: hydrated.challenge,
    rp: hydrated.rp,
    user: hydrated.user,
    allowCredentials: hydrated.allowCredentials,
    excludeCredentials: hydrated.excludeCredentials,
  };
  out.hydrateEmpty = api.hydrateWebAuthnPublicKey({});
  out.hydrateMissingCredentialIds = api.hydrateWebAuthnPublicKey({
    challenge: 'AQID',
    allowCredentials: [{ type: 'public-key' }],
  });

  // 3. Credential serialization: buffers → base64url strings.
  const serialized = api.serializeWebAuthnCredential({
    id: 'cred-id',
    type: 'public-key',
    rawId: new Uint8Array([10, 20, 30]).buffer,
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
      attestationObject: new Uint8Array([4, 5, 6]).buffer,
      signature: new Uint8Array([7, 8]).buffer,
      userHandle: new Uint8Array([9]).buffer,
      getTransports() {
        return ['internal', 'hybrid'];
      },
    },
  });
  out.serialize = serialized;
  out.serializeSparse = api.serializeWebAuthnCredential({
    id: 'x',
    type: 'public-key',
    rawId: new Uint8Array([1]).buffer,
    response: { clientDataJSON: new Uint8Array([1]).buffer },
  });

  // 4. Availability probe.
  out.availableThrows = (() => {
    try {
      api.assertWebAuthnAvailable();
      return false;
    } catch {
      return true;
    }
  })();

  return JSON.parse(JSON.stringify(out, bufferReplacer));
}

// urlBase64ToUint8Array lives in session-http-helpers.js on the legacy side,
// so it is compared against the helpers realm separately (the core side
// exports it from RagentWebAuthnCore).
async function runUrlBase64Scenario(api) {
  // Undersized inputs (e.g. "a" → "a===") make atob throw on both sides;
  // capture that consistently instead of failing the vector collection.
  const vector = (value) => {
    try {
      return [...api.urlBase64ToUint8Array(value)];
    } catch {
      return `threw:${value}`;
    }
  };
  const out = {
    vectors: [
      vector('AAEC_f7_'),
      vector('SGVsbG8='),
      vector('SGVsbG8'),
      vector(''),
      vector('a'),
    ],
    emptyThrows: (() => {
      try {
        api.urlBase64ToUint8Array('====');
        return false;
      } catch {
        return true;
      }
    })(),
  };
  return JSON.parse(JSON.stringify(out, bufferReplacer));
}

async function main() {
  for (const available of [true, false]) {
    const [legacy, core] = [loadLegacy({ webAuthnAvailable: available }), loadCore({ webAuthnAvailable: available })];
    const [a, b] = await Promise.all([runScenario(legacy.api), runScenario(core.api)]);
    assert.deepEqual(
      b,
      a,
      `webauthn drift webAuthnAvailable=${available}: ${legacy.label} vs ${core.label}`,
    );
  }
  const [helpersLegacy, core] = [loadLegacyHelpers(), loadCore({ webAuthnAvailable: false })];
  const [a, b] = await Promise.all([
    runUrlBase64Scenario(helpersLegacy.api),
    runUrlBase64Scenario(core.api),
  ]);
  assert.deepEqual(
    b,
    a,
    `urlBase64 drift: ${helpersLegacy.label} vs ${core.label}`,
  );
  console.log('test-chat-webauthn-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

"use strict";

// Pure WebAuthn/passkey wire-format helpers (Stage 2 extraction of
// realtime.js): base64url ↔ ArrayBuffer conversion, public-key hydration
// (challenge / user id / credential ids as base64url strings → buffers) and
// credential serialization (buffers → base64url strings). The availability
// probe is injected via the environment contract
// (root.RagentWebAuthnEnvironment), so this module stays free of browser
// globals and runs identically in Node. Locked against the legacy
// implementation by tests/test-chat-webauthn-core.mjs.

(function attachRagentWebAuthnCore(root) {
  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    atob: null,
    btoa: null,
    isWebAuthnAvailable: () => false,
  });
  const environment = new Proxy(
    root.RagentWebAuthnEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function decodeBase64(input) {
    if (typeof atob === "function") return atob(input);
    if (typeof environment.atob === "function") return environment.atob(input);
    return Buffer.from(input, "base64").toString("binary");
  }

  function encodeBase64(input) {
    if (typeof btoa === "function") return btoa(input);
    if (typeof environment.btoa === "function") return environment.btoa(input);
    return Buffer.from(input, "binary").toString("base64");
  }

  function base64UrlToArrayBuffer(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
    const binary = decodeBase64(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  function arrayBufferToBase64Url(value) {
    const bytes = new Uint8Array(value || new ArrayBuffer(0));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return encodeBase64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function hydrateWebAuthnPublicKey(publicKey = {}) {
    const hydrated = { ...publicKey };
    if (publicKey.challenge) hydrated.challenge = base64UrlToArrayBuffer(publicKey.challenge);
    if (publicKey.user?.id) hydrated.user = { ...publicKey.user, id: base64UrlToArrayBuffer(publicKey.user.id) };
    for (const key of ["allowCredentials", "excludeCredentials"]) {
      if (Array.isArray(publicKey[key])) {
        hydrated[key] = publicKey[key].map((credential) => ({
          ...credential,
          id: base64UrlToArrayBuffer(credential.id),
        }));
      }
    }
    return hydrated;
  }

  function serializeWebAuthnCredential(credential) {
    const response = credential?.response || {};
    const serializedResponse = {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
    };
    for (const key of ["attestationObject", "authenticatorData", "signature", "userHandle"]) {
      if (response[key]) serializedResponse[key] = arrayBufferToBase64Url(response[key]);
    }
    if (typeof response.getTransports === "function") {
      serializedResponse.transports = response.getTransports();
    }
    return {
      id: credential.id,
      type: credential.type,
      rawId: arrayBufferToBase64Url(credential.rawId),
      authenticatorAttachment: credential.authenticatorAttachment || "",
      response: serializedResponse,
    };
  }

  function assertWebAuthnAvailable() {
    if (!environment.isWebAuthnAvailable()) {
      throw new Error("This browser cannot verify owner presence with WebAuthn/passkeys.");
    }
  }

  // helpers' urlBase64ToUint8Array: the Uint8Array view of the same wire
  // decoding (used for push-subscription applicationServerKey).
  function urlBase64ToUint8Array(value) {
    return new Uint8Array(base64UrlToArrayBuffer(value));
  }

  root.RagentWebAuthnCore = {
    base64UrlToArrayBuffer,
    arrayBufferToBase64Url,
    hydrateWebAuthnPublicKey,
    serializeWebAuthnCredential,
    assertWebAuthnAvailable,
    urlBase64ToUint8Array,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});

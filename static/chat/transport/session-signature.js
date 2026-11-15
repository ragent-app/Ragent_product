"use strict";

// Pure comparable-session signature (Stage 2 extraction of session-http.js).
// Session state received from the server is compared against the previously
// rendered record before every upsert / attached-session render: the state is
// recursively normalized (sorted keys, undefined dropped) and JSON-serialized
// into a signature, so two responses that carry the same facts but different
// key order / absent-vs-undefined differ never trigger a re-render.
// getComparableAttachedSessionStateSignature projects the fields the attached
// session header actually renders before signing.
//
// Fully pure: no environment contract, no platform hooks. Locked against the
// legacy implementation by tests/test-chat-session-signature-core.mjs.

(function attachRagentSessionSignatureCore(root) {
  function buildComparableSessionState(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => buildComparableSessionState(entry));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      const nextValue = buildComparableSessionState(value[key]);
      if (typeof nextValue !== "undefined") {
        normalized[key] = nextValue;
      }
    }
    return normalized;
  }

  function getComparableSessionStateSignature(value) {
    return JSON.stringify(buildComparableSessionState(value));
  }

  function getComparableAttachedSessionStateSignature(session) {
    if (!session || typeof session !== "object") {
      return getComparableSessionStateSignature(session);
    }
    return getComparableSessionStateSignature({
      id: session.id || null,
      name: session.name || "",
      tool: session.tool || "",
      providerProfile: typeof session.providerProfile === "string" ? session.providerProfile : null,
      status: session.status || "",
      archived: session.archived === true,
      activity: session.activity || null,
      queuedMessages: Array.isArray(session.queuedMessages) ? session.queuedMessages : null,
      model: typeof session.model === "string" ? session.model : null,
      effort: typeof session.effort === "string" ? session.effort : null,
      thinking: session.thinking === true ? true : null,
      permissionMode: typeof session.permissionMode === "string" ? session.permissionMode : null,
      interactionMode: typeof session.interactionMode === "string" ? session.interactionMode : null,
    });
  }

  root.RagentSessionSignatureCore = {
    buildComparableSessionState,
    getComparableSessionStateSignature,
    getComparableAttachedSessionStateSignature,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});

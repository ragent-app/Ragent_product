"use strict";

// Pure session-list organizer projection (Stage 2 extraction of
// session-http.js). Builds the metadata snapshot and task prompt the
// "organize session list" AI run consumes:
//
//   - clipSessionListOrganizerText() — whitespace-collapsing, length-clipping
//     text normalizer shared by every snapshot field.
//   - buildSessionListOrganizerSessionMetadata() — per-session projection
//     (title/brief/existing group & ordering/pinned/tool/source/folder/
//     workflow/messageCount/timestamps) with per-field clip limits.
//   - buildSessionListOrganizerPayload() — the tool-context snapshot
//     (selected tool/model/effort/permission mode/thinking + the active
//     session metadata array).
//   - buildSessionListOrganizerTask() — the formatted multi-line task prompt
//     embedding the payload as XML-ish input.
//
// Session display-name resolution and the active-session list are injected
// via the environment contract (root.RagentSessionListOrganizerEnvironment)
// together with the live editor-context scalars, so this module stays free
// of browser globals and runs identically in Node. Locked against the legacy
// implementation by tests/test-chat-session-list-organizer-core.mjs.

(function attachRagentSessionListOrganizerCore(root) {
  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    getSessionDisplayName: (session) => (session && typeof session.name === "string" ? session.name : ""),
    getActiveSessions: () => [],
    selectedTool: "",
    preferredTool: "",
    selectedModel: null,
    selectedEffort: null,
    selectedPermissionMode: null,
    thinkingEnabled: false,
  });
  const environment = new Proxy(
    root.RagentSessionListOrganizerEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function clipSessionListOrganizerText(value, maxChars = 240) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    return normalized.length > maxChars
      ? `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
      : normalized;
  }

  function buildSessionListOrganizerSessionMetadata(session) {
    const brief = typeof session?.description === "string"
      ? session.description.trim()
      : "";
    return {
      id: session?.id || "",
      title: clipSessionListOrganizerText(environment.getSessionDisplayName(session), 160),
      brief: clipSessionListOrganizerText(brief, 280),
      existingGroup: typeof session?.group === "string" && session.group.trim()
        ? clipSessionListOrganizerText(session.group, 80)
        : null,
      existingSidebarOrder: Number.isInteger(session?.sidebarOrder) && session.sidebarOrder > 0
        ? session.sidebarOrder
        : null,
      pinned: session?.pinned === true,
      tool: clipSessionListOrganizerText(session?.tool || "", 40),
      sourceName: clipSessionListOrganizerText(session?.sourceName || "", 80),
      folder: clipSessionListOrganizerText(session?.folder || "", 180),
      workflowState: clipSessionListOrganizerText(session?.workflowState || "", 40),
      workflowPriority: clipSessionListOrganizerText(session?.workflowPriority || "", 40),
      messageCount: Number.isInteger(session?.messageCount) ? session.messageCount : 0,
      created: clipSessionListOrganizerText(session?.created || "", 40),
      updatedAt: clipSessionListOrganizerText(session?.updatedAt || "", 40),
      lastEventAt: clipSessionListOrganizerText(session?.lastEventAt || "", 40),
    };
  }

  function buildSessionListOrganizerPayload() {
    const activeSessions = environment.getActiveSessions();
    return {
      tool: environment.selectedTool || environment.preferredTool || "claude",
      ...(environment.selectedModel ? { model: environment.selectedModel } : {}),
      ...(environment.selectedEffort ? { effort: environment.selectedEffort } : {}),
      ...(environment.selectedPermissionMode ? { permissionMode: environment.selectedPermissionMode } : {}),
      thinking: environment.thinkingEnabled === true,
      sessions: activeSessions.map(buildSessionListOrganizerSessionMetadata).filter((session) => session.id),
    };
  }

  function buildSessionListOrganizerTask(sessions) {
    const payload = {
      generatedAt: new Date().toISOString(),
      totalSessions: Array.isArray(sessions) ? sessions.length : 0,
      sessions: Array.isArray(sessions) ? sessions : [],
    };
    return [
      "Organize the current non-archived Ragent session list using the provided metadata snapshot.",
      "Choose clearer groups and a better sidebar ordering based on the current session density.",
      "Apply changes by calling the Ragent API from this machine; do not merely suggest them.",
      "Snapshot fields like `title`, `brief`, `existingGroup`, and `existingSidebarOrder` are read-only context.",
      "When patching a session, send only `group` and `sidebarOrder` in the API body.",
      "",
      "<session_list_organizer_input>",
      JSON.stringify(payload, null, 2),
      "</session_list_organizer_input>",
    ].join("\n");
  }

  root.RagentSessionListOrganizerCore = {
    clipSessionListOrganizerText,
    buildSessionListOrganizerSessionMetadata,
    buildSessionListOrganizerPayload,
    buildSessionListOrganizerTask,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});

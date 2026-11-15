"use strict";

(function attachWorkbenchInspector(root) {
  const INSPECTOR_OPEN_STORAGE_KEY = "ragent.workbenchInspectorOpen";
  const INSPECTOR_TAB_STORAGE_KEY = "ragent.workbenchInspectorTab";
  const DESKTOP_QUERY = "(min-width: 1181px)";
  const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const INSPECTOR_TABS = new Set(["outcome", "changes", "activity"]);
  const LEGACY_INSPECTOR_TAB_ALIASES = new Map([
    ["summary", "outcome"],
    ["artifacts", "outcome"],
    ["files", "changes"],
    ["review", "changes"],
    ["context", "activity"],
    ["logs", "activity"],
  ]);
  const MAX_ACTIVITY_ITEMS = 10;
  const MAX_DIFF_PREVIEW_LINES = 80;
  const MAX_DIFF_CELLS = 1_000_000;
  const INSPECTOR_EVENT_PAGE_LIMIT = 150;
  const MAX_INSPECTOR_EVENT_PAGES = 3;

  const state = {
    sessionId: "",
    session: null,
    events: [],
    projection: null,
    activeTab: readStoredTab(),
    loading: false,
    error: "",
    fetchTimer: null,
    requestSeq: 0,
    lastRenderAnimationKey: "",
  };

  const dom = {
    button: null,
    backButton: null,
    closeButton: null,
    panel: null,
    body: null,
    tabs: [],
  };

  // External consumers (e.g. the mobile Run Sheet) subscribe to render ticks so
  // they can re-render their own mirror of the inspector model on the same data.
  const renderSubscribers = new Set();

  function notifyRenderSubscribers() {
    for (const fn of renderSubscribers) {
      try {
        fn();
      } catch (error) {
        console.warn("[workbench] render subscriber failed:", error?.message || error);
      }
    }
  }

  // Android back button entry while the markdown reader is open.
  let markdownReaderBackEntryId = null;

  const markdownReader = {
    node: null,
    title: null,
    status: null,
    content: null,
    rawLink: null,
    downloadLink: null,
    requestSeq: 0,
    focusScopeDeactivate: null,
    trigger: null,
  };

  function tr(key, vars) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function renderIcon(name, className = "") {
    return root.RagentIcons?.render(name, { className }) || "";
  }

  function readStoredTab() {
    try {
      const value = localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY);
      const normalized = normalizeInspectorTab(value);
      return INSPECTOR_TABS.has(normalized) ? normalized : "outcome";
    } catch {
      return "outcome";
    }
  }

  function writeStoredTab(tab) {
    try {
      localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, tab);
    } catch {}
  }

  function normalizeInspectorTab(tab) {
    const value = String(tab || "").trim();
    if (LEGACY_INSPECTOR_TAB_ALIASES.has(value)) return LEGACY_INSPECTOR_TAB_ALIASES.get(value);
    return INSPECTOR_TABS.has(value) ? value : "outcome";
  }

  function readStoredOpen() {
    try {
      const value = localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
      if (value === "true") return true;
      if (value === "false") return false;
    } catch {}
    return root.matchMedia?.(DESKTOP_QUERY)?.matches === true;
  }

  function hasStoredOpenPreference() {
    try {
      return localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  function writeStoredOpen(open) {
    try {
      localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, open ? "true" : "false");
    } catch {}
  }

  function getCurrentSessionSafe() {
    if (typeof getCurrentSession === "function") {
      return getCurrentSession();
    }
    const sessionId = typeof currentSessionId !== "undefined" ? currentSessionId : "";
    if (typeof getChatStoreSession === "function") {
      return getChatStoreSession(sessionId);
    }
    if (typeof sessions !== "undefined" && Array.isArray(sessions)) {
      return sessions.find((session) => session?.id === sessionId) || null;
    }
    return null;
  }

  function getShortPath(path) {
    const value = String(path || "");
    return value.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  }

  function getFileNameFromPath(path) {
    const shortPath = getShortPath(path);
    const parts = shortPath.split("/").filter(Boolean);
    return parts.pop() || shortPath || "file";
  }

  function getSessionTitle(session) {
    if (typeof root.getSessionDisplayName === "function") {
      return root.getSessionDisplayName(session);
    }
    return session?.name || getShortPath(session?.folder || "") || tr("session.defaultName");
  }

  function normalizeSessionReferenceId(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeSessionReferenceTitle(value, fallback = "") {
    const title = typeof value === "string" ? value.trim() : "";
    return title || fallback || tr("session.defaultName");
  }

  function readDelegatedSessionReference(event) {
    if (event?.type !== "context_operation" || event.operation !== "delegate_session") return null;
    const sessionId = normalizeSessionReferenceId(event.targetSessionId);
    if (!sessionId) return null;
    const title = normalizeSessionReferenceTitle(event.targetSessionName, sessionId);
    const reason = typeof event.reason === "string" ? event.reason.trim() : "";
    const summary = typeof event.summary === "string" ? event.summary.trim() : "";
    return {
      type: "session",
      kind: "child",
      sessionId,
      title,
      label: tr("workbench.session.childCall"),
      subtitle: reason || summary,
      folder: typeof event.targetSessionFolder === "string" ? event.targetSessionFolder.trim() : "",
      seq: event.seq || 0,
    };
  }

  function getParentSessionReference(session) {
    const sessionId = normalizeSessionReferenceId(session?.parentSessionId);
    if (!sessionId) return null;
    return {
      type: "session",
      kind: "parent",
      sessionId,
      title: normalizeSessionReferenceTitle(session?.parentSessionName, sessionId),
      label: tr("workbench.session.parent"),
      subtitle: "",
      folder: "",
    };
  }

  function normalizeEvents(events) {
    return (Array.isArray(events) ? events : [])
      .filter((event) => event && typeof event === "object")
      .map((event, index) => {
        const normalized = {
          ...event,
          seq: Number.isInteger(event.seq) && event.seq > 0 ? event.seq : index + 1,
        };
        if (normalized.type === "file_change") {
          normalized.changeType = normalizeFileChangeType(normalized.changeType);
        }
        return normalized;
      });
  }

  function eventKey(event) {
    if (typeof event?.id === "string" && event.id) return `id:${event.id}`;
    if (Number.isInteger(event?.seq) && event.seq > 0) return `seq:${event.seq}`;
    return `${event?.type || "event"}:${event?.timestamp || ""}:${JSON.stringify(event).slice(0, 120)}`;
  }

  function mergeEvents(existing, incoming) {
    const next = [];
    const seen = new Set();
    for (const event of normalizeEvents(existing)) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(event);
    }
    for (const event of normalizeEvents(incoming)) {
      if (event.type === "text_delta") continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(event);
    }
    next.sort((a, b) => {
      const aSeq = Number.isInteger(a.seq) ? a.seq : 0;
      const bSeq = Number.isInteger(b.seq) ? b.seq : 0;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
    return next;
  }

  function getWorkbenchEventNoiseText(event) {
    return [
      event?.type,
      event?.role,
      event?.content,
      event?.toolName,
      event?.name,
      event?.title,
      event?.message,
    ]
      .map((part) => String(part || "").trim().toLowerCase())
      .filter(Boolean)
      .join(" ");
  }

  function isProviderUsageLimitStatusPart(value) {
    const part = String(value || "").trim();
    if (!part) return false;
    if (/^(?:primary|secondary)\s+\d+(?:\.\d+)?%(?:\s*\/\s*\d+m)?$/i.test(part)) {
      return true;
    }
    return /^(?:no credits|credits ok)$/i.test(part);
  }

  function isProviderUsageLimitStatusText(value) {
    const text = String(value || "").trim();
    if (!/^Usage\s+\S/i.test(text)) return false;
    const parts = text.split(/\s+·\s+/);
    if (parts.length < 2) return false;
    const usageParts = parts.slice(1);
    return usageParts.some(isProviderUsageLimitStatusPart)
      && usageParts.every(isProviderUsageLimitStatusPart);
  }

  function isProviderUsageLimitStatusEvent(event) {
    if (event?.type !== "status") return false;
    if (event.codexRateLimits && typeof event.codexRateLimits === "object") {
      return true;
    }
    return isProviderUsageLimitStatusText(event.content || event.message);
  }

  function isCodexAppServerLifecycleStatusText(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    return /^(?:idle|active|inProgress|in_progress|thinking|completed)$/i.test(text)
      || /^Thread (?:ready|started) \([^)]+\)$/i.test(text)
      || /^MCP(?:\s+[^\s:]+)?\s+(?:starting|ready|started|connected|connecting|initializing|initialized|stopped|disabled|failed|error)$/i.test(text)
      || /^mode:\s*\S+/i.test(text)
      || /^Goal(?: cleared|:)/i.test(text);
  }

  function isCodexAppServerLifecycleStatusEvent(event) {
    if (event?.type !== "status") return false;
    const text = typeof event.content === "string"
      ? event.content
      : (typeof event.message === "string" ? event.message : "");
    if (!isCodexAppServerLifecycleStatusText(text)) return false;
    return !!(event.runtimeFamily === "codex-app-server-json"
      || event.provider === "codex"
      || event.codexGoalEvent
      || event.codexMcpStatus
      || event.providerThreadId
      || isCodexAppServerLifecycleStatusText(text));
  }

  function isLowValueWorkbenchEvent(event) {
    const text = getWorkbenchEventNoiseText(event);
    if (!text) return false;
    if (isCodexAppServerLifecycleStatusEvent(event)) {
      return true;
    }
    if (isProviderUsageLimitStatusEvent(event)) {
      return true;
    }
    if (event?.type === "status" && String(event.content || "").startsWith("Assistant self-check:")) {
      return true;
    }
    if (event?.type === "context_operation" && event.operation === "write_memory") {
      return true;
    }
    if (
      event?.type === "context_operation"
      && event.operation === "continue_turn"
      && event.trigger === "automatic"
    ) {
      return true;
    }
    if (/\bthinking_tokens\b/.test(text)) return true;
    if (/\bcached_tokens\b/.test(text)) return true;
    if (event?.type === "status" && ["thinking", "completed", "idle"].includes(String(event.content || "").toLowerCase())) {
      return true;
    }
    if (event?.type === "tool_use" && String(event.toolName || "").toLowerCase() === "system") {
      return /\b(thinking|token|tokens|usage)\b/.test(text);
    }
    return false;
  }

  function summarizeHiddenWorkbenchEvent(event) {
    const label = [
      event?.toolName,
      event?.content,
      event?.title,
      event?.message,
      event?.type,
    ]
      .map((part) => String(part || "").trim())
      .find(Boolean);
    return label || "system";
  }

  function compactWorkbenchActivityItems(items) {
    const grouped = [];
    const byKey = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const key = `${item?.type || ""}:${item?.sessionId || ""}:${item?.title || ""}:${item?.subtitle || ""}`;
      const previous = byKey.get(key);
      if (previous) {
        previous.count = (previous.count || 1) + 1;
        previous.seq = Math.max(previous.seq || 0, item?.seq || 0);
        if (item?.type === "edit") {
          previous.added = (previous.added || 0) + (item.added || 0);
          previous.removed = (previous.removed || 0) + (item.removed || 0);
          previous.hasLineStats = previous.hasLineStats !== false || item.hasLineStats !== false;
        }
        continue;
      }
      const next = { ...item, count: 1 };
      byKey.set(key, next);
      grouped.push(next);
    }
    return grouped.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  }

  function parseToolInput(toolInput) {
    if (!toolInput) return {};
    if (typeof toolInput === "object") return toolInput;
    if (typeof toolInput !== "string") return {};
    try {
      const parsed = JSON.parse(toolInput);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function parseFileEdit(event) {
    const toolName = event?.toolName || "";
    if (!FILE_EDIT_TOOLS.has(toolName)) return null;
    const input = parseToolInput(event.toolInput);
    const filePath = input.file_path || input.path || input.notebook_path || "";
    if (!filePath) return null;
    if (toolName === "Write") {
      return {
        filePath,
        changeType: "add",
        source: toolName,
        edits: [{ oldText: "", newText: input.content || "" }],
      };
    }
    if (toolName === "Edit") {
      return {
        filePath,
        changeType: "edit",
        source: toolName,
        edits: [{
          oldText: input.old_string || "",
          newText: input.new_string || "",
        }],
      };
    }
    const edits = toolName === "NotebookEdit"
      ? (
          String(input.edit_mode || "").toLowerCase() === "insert"
          || typeof input.old_source === "string"
            ? [{ oldText: input.old_source || "", newText: input.new_source || input.source || "" }]
            : []
        )
      : (Array.isArray(input.edits)
          ? input.edits.map((edit) => ({
              oldText: edit?.old_string || "",
              newText: edit?.new_string || "",
            }))
          : []);
    return {
      filePath,
      changeType: toolName === "NotebookEdit" && String(input.edit_mode || "").toLowerCase() === "delete"
        ? "delete"
        : "edit",
      source: toolName,
      edits,
    };
  }

  function computeLineDiff(oldText, newText) {
    const oldLines = String(oldText || "").split("\n");
    const newLines = String(newText || "").split("\n");
    const m = oldLines.length;
    const n = newLines.length;
    if (m * n > MAX_DIFF_CELLS) return null;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i += 1) {
      for (let j = 1; j <= n; j += 1) {
        dp[i][j] = oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const diff = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        diff.unshift({
          type: "equal",
          text: oldLines[i - 1],
          oldLine: i,
          newLine: j,
        });
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        diff.unshift({
          type: "add",
          text: newLines[j - 1],
          newLine: j,
        });
        j -= 1;
      } else {
        diff.unshift({
          type: "remove",
          text: oldLines[i - 1],
          oldLine: i,
        });
        i -= 1;
      }
    }
    return diff;
  }

  function summarizeEditDiff(edits) {
    let added = 0;
    let removed = 0;
    const preview = [];
    for (const edit of Array.isArray(edits) ? edits : []) {
      const diff = computeLineDiff(edit.oldText, edit.newText);
      if (!diff) {
        const oldLineCount = String(edit.oldText || "").split("\n").length;
        const newLineCount = String(edit.newText || "").split("\n").length;
        removed += oldLineCount;
        added += newLineCount;
        if (preview.length < MAX_DIFF_PREVIEW_LINES) {
          preview.push({
            type: "equal",
            text: `[diff omitted: ${oldLineCount} old lines → ${newLineCount} new lines]`,
            truncated: true,
          });
        }
        continue;
      }
      for (const line of diff) {
        if (line.type === "add") added += 1;
        if (line.type === "remove") removed += 1;
        if (line.type !== "equal" && preview.length < MAX_DIFF_PREVIEW_LINES) {
          preview.push(line);
        }
      }
    }
    return { added, removed, preview };
  }

  function getChangeLabel(kind) {
    const normalized = normalizeFileChangeType(kind);
    if (normalized === "add" || normalized === "added" || normalized === "create") {
      return tr("workbench.change.add");
    }
    if (normalized === "delete" || normalized === "deleted" || normalized === "remove") {
      return tr("workbench.change.delete");
    }
    if (normalized === "edit" || normalized === "modified") {
      return tr("workbench.change.edit");
    }
    return tr("workbench.change.update");
  }

  function readFileChangeType(kind) {
    if (typeof kind === "string") return kind.trim();
    if (kind && typeof kind === "object") {
      return String(kind.type || kind.kind || kind.changeType || kind.status || "").trim();
    }
    return "";
  }

  function normalizeFileChangeType(kind) {
    const normalized = readFileChangeType(kind).toLowerCase();
    if (["add", "added", "create", "created"].includes(normalized)) return "add";
    if (["delete", "deleted", "remove", "removed"].includes(normalized)) return "delete";
    if (["edit", "edited", "modify", "modified"].includes(normalized)) return "edit";
    if (normalized === "update" || normalized === "updated") return "update";
    return normalized || "update";
  }

  function readFileChangeNumber(event, keys) {
    for (const key of keys) {
      const value = Number(event?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  function getFileChangeStats(event) {
    return {
      added: readFileChangeNumber(event, ["added", "additions", "linesAdded", "addedLines"]),
      removed: readFileChangeNumber(event, ["removed", "deletions", "linesRemoved", "removedLines"]),
    };
  }

  function hasReviewableDiffStats(value) {
    if (!value) return false;
    const added = Number(value.added || 0);
    const removed = Number(value.removed || 0);
    const previewCount = Array.isArray(value.preview) ? value.preview.length : 0;
    return added > 0 || removed > 0 || previewCount > 0;
  }

  function normalizeDiffPreviewType(value) {
    if (value === " ") return "equal";
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "add" || normalized === "added" || normalized === "insert" || normalized === "+") return "add";
    if (normalized === "remove" || normalized === "removed" || normalized === "delete" || normalized === "deleted" || normalized === "-") return "remove";
    if (normalized === "equal" || normalized === "context") return "equal";
    return "";
  }

  function readDiffPreviewLine(value) {
    if (typeof value === "string") {
      const marker = value.slice(0, 1);
      const type = normalizeDiffPreviewType(marker) || "equal";
      return {
        type,
        text: type === "equal" ? value : value.slice(1),
      };
    }
    if (!(value && typeof value === "object")) return null;
    const type = normalizeDiffPreviewType(value.type || value.kind || value.op || value.marker);
    if (!type) return null;
    const oldLine = Number(value.oldLine || value.old_line || value.beforeLine || value.before_line);
    const newLine = Number(value.newLine || value.new_line || value.afterLine || value.after_line);
    const text = typeof value.text === "string"
      ? value.text
      : (typeof value.content === "string"
        ? value.content
        : (typeof value.value === "string" ? value.value : ""));
    return {
      type,
      text,
      ...(Number.isInteger(oldLine) && oldLine > 0 ? { oldLine } : {}),
      ...(Number.isInteger(newLine) && newLine > 0 ? { newLine } : {}),
    };
  }

  function readFileChangePreview(event) {
    const source = Array.isArray(event?.preview)
      ? event.preview
      : (Array.isArray(event?.diffPreview) ? event.diffPreview : []);
    return source
      .slice(0, MAX_DIFF_PREVIEW_LINES)
      .map((line) => readDiffPreviewLine(line))
      .filter(Boolean);
  }

  function countDiffPreviewLines(preview) {
    let added = 0;
    let removed = 0;
    for (const line of Array.isArray(preview) ? preview : []) {
      if (line?.type === "add") added += 1;
      if (line?.type === "remove") removed += 1;
    }
    return { added, removed };
  }

  function getDiffPreviewGap(file) {
    if (!file || file.hasLineStats === false) return { added: 0, removed: 0 };
    const previewStats = countDiffPreviewLines(file.preview);
    return {
      added: Math.max(0, Number(file.added || 0) - previewStats.added),
      removed: Math.max(0, Number(file.removed || 0) - previewStats.removed),
    };
  }

  function shouldIncludeFileChangeInReview(event, previousFile) {
    if (event?.filePath) return true;
    const stats = getFileChangeStats(event);
    return stats.added > 0 || stats.removed > 0 || hasReviewableDiffStats(previousFile);
  }

  function normalizePlanItemStatus(value) {
    const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
    if (["in_progress", "active", "current", "running", "started"].includes(status)) return "in_progress";
    return "pending";
  }

  function normalizePlanArtifactItems(event) {
    const sourceItems = Array.isArray(event?.items)
      ? event.items
      : (Array.isArray(event?.plan) ? event.plan : []);
    return sourceItems
      .map((item) => (item && typeof item === "object" ? item : { text: item }))
      .map((item) => ({
        text: String(item.text || item.step || item.title || "").trim(),
        status: normalizePlanItemStatus(item.status || item.state || (item.completed === true ? "completed" : "pending")),
      }))
      .filter((item) => item.text);
  }

  function getPlanArtifactState(event, items) {
    const state = String(event?.status || event?.state || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["drafting", "running", "in_progress", "started"].includes(state)) return "drafting";
    if (["awaiting_decision", "ready"].includes(state)) return "awaiting_decision";
    if (["completed", "complete", "done"].includes(state)) return "completed";
    if (["revising", "approved", "executing", "superseded", "failed"].includes(state)) return state;
    if (items.length > 0 && items.every((item) => item.status === "completed")) return "awaiting_decision";
    return "drafting";
  }

  function getPlanArtifactTitle(event) {
    return String(event?.title || "").trim() || tr("plan.card.codexTitle");
  }

  function isPlanProgressArtifact(artifact) {
    const planIntent = String(artifact?.planIntent || "").trim().toLowerCase();
    if (planIntent) return planIntent === "progress";
    return String(artifact?.interactionMode || "").trim().toLowerCase() === "agent";
  }

  function formatPlanArtifactText(plan) {
    const bodyMarkdown = String(plan?.bodyMarkdown || "").trim();
    if (bodyMarkdown) return bodyMarkdown;
    const lines = (Array.isArray(plan?.items) ? plan.items : []).map((item) => {
      const marker = item.status === "completed" ? "[x]" : "[ ]";
      return `${marker} ${item.text}`;
    });
    return [plan?.name || tr("plan.card.codexTitle"), "", ...lines].join("\n").trim();
  }

  function collectPlanArtifacts(events) {
    const plans = new Map();
    for (const event of events) {
      if (event?.type !== "plan") continue;
      const seq = Number.isInteger(event.seq) ? event.seq : 0;
      const planId = String(event.planId || event.artifactId || event.id || `plan-${seq}`).trim();
      if (!planId) continue;
      const items = normalizePlanArtifactItems(event);
      const plan = {
        kind: "plan",
        name: getPlanArtifactTitle(event),
        planId,
        sourceRunId: String(event.runId || "").trim(),
        state: getPlanArtifactState(event, items),
        items,
        bodyMarkdown: String(event.bodyMarkdown || "").trim(),
        source: String(event.source || "").trim(),
        interactionMode: String(event.interactionMode || "").trim(),
        planIntent: String(event.planIntent || "").trim(),
        revision: Number.isInteger(event.revision) ? event.revision : 1,
        seq,
      };
      plan.text = formatPlanArtifactText(plan);
      const previous = plans.get(planId);
      if (!previous || seq >= previous.seq) {
        plans.set(planId, plan);
      }
    }
    return Array.from(plans.values()).sort((a, b) => (b.seq || 0) - (a.seq || 0));
  }

  function isProductLocalArtifactUrl(url) {
    return /^(?:\/)?(?:api|share-asset)(?:[/?#]|$)/i.test(String(url || "").trim());
  }

  function resolveProductPath(path) {
    if (typeof root.ragentResolveProductPath === "function") {
      return root.ragentResolveProductPath(path);
    }
    if (root.RagentProductPaths?.resolveProductPath) {
      return root.RagentProductPaths.resolveProductPath(path);
    }
    return path;
  }

  function resolveArtifactUrl(url) {
    const value = String(url || "").trim();
    if (!value) return "";
    if (isProductLocalArtifactUrl(value)) {
      return resolveProductPath(value);
    }
    return value;
  }

  function resolveArtifactAttachmentUrl(attachment) {
    const explicitUrl = attachment.downloadUrl || attachment.objectUrl || attachment.url || "";
    if (explicitUrl) return resolveArtifactUrl(explicitUrl);
    const assetId = typeof attachment.assetId === "string" ? attachment.assetId.trim() : "";
    if (assetId) {
      const path = `/api/assets/${encodeURIComponent(assetId)}/download`;
      return resolveProductPath(path);
    }
    return resolveLegacyAttachmentUrl(attachment);
  }

  function resolveLegacyAttachmentUrl(attachment) {
    const filename = typeof attachment?.filename === "string" ? attachment.filename.trim() : "";
    const savedPath = typeof attachment?.savedPath === "string" ? attachment.savedPath.trim() : "";
    const fallbackName = savedPath.split(/[\\/]/).filter(Boolean).pop() || "";
    const candidate = filename || fallbackName;
    if (!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(candidate)) return "";
    return resolveProductPath(`/api/images/${encodeURIComponent(candidate)}`);
  }

  function isMarkdownMimeType(mimeType) {
    return /^text\/(?:x-)?markdown(?:[;\s]|$)/i.test(String(mimeType || "").trim());
  }

  function isMarkdownArtifactName(name) {
    return /\.(?:md|markdown|mdown|mkdn)$/i.test(String(name || "").trim());
  }

  function isMarkdownArtifact(artifact) {
    return artifact?.isMarkdown === true
      || isMarkdownMimeType(artifact?.mimeType)
      || isMarkdownArtifactName(artifact?.name);
  }

  function isPdfArtifact(artifact) {
    const mimeType = String(artifact?.mimeType || "").trim().toLowerCase();
    return artifact?.isPdf === true
      || mimeType === "application/pdf"
      || /\.pdf$/i.test(String(artifact?.name || "").trim());
  }

  function isReadableArtifact(artifact) {
    return isMarkdownArtifact(artifact) || isPdfArtifact(artifact);
  }

  function appendUrlParam(url, key, value) {
    const source = String(url || "").trim();
    if (!source) return "";
    try {
      const parsed = new URL(source, document.baseURI || window.location.href);
      parsed.searchParams.set(key, value);
      if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return parsed.toString();
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      const separator = source.includes("?") ? "&" : "?";
      return `${source}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  }

  function buildArtifactDownloadUrl(artifact) {
    const source = String(artifact?.url || "").trim();
    if (!source) return "";
    if (/\/download(?:[?#]|$)|^share-asset\//i.test(source) || /\/share-asset\//i.test(source) || /\/api\/images\//i.test(source)) {
      return appendUrlParam(source, "download", "1");
    }
    return source;
  }

  function collectArtifacts(events) {
    return collectPlanArtifacts(events);
  }

  function collectArtifactFiles(events, { sessionId = "" } = {}) {
    const files = [];
    const seen = new Set();
    const artifactSessionId = String(sessionId || "").trim();
    for (const event of events) {
      const attachments = Array.isArray(event.attachments)
        ? event.attachments
        : (Array.isArray(event.images) ? event.images : []);
      for (const attachment of attachments) {
        if (!(attachment && typeof attachment === "object")) continue;
        const name = attachment.originalName || attachment.filename || attachment.name || "artifact";
        const url = resolveArtifactAttachmentUrl(attachment);
        const sourceRunId = String(event.runId || "").trim();
        const key = [
          artifactSessionId,
          attachment.assetId || url || `${name}:${attachment.sizeBytes || ""}`,
        ].join(":");
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({
          kind: "file",
          sessionId: artifactSessionId,
          sourceRunId,
          name,
          url,
          sourceRole: String(event.role || "").trim(),
          sourceType: String(event.type || "").trim(),
          mimeType: attachment.mimeType || "",
          sizeBytes: Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : null,
          isMarkdown: isMarkdownMimeType(attachment.mimeType) || isMarkdownArtifactName(name),
          isPdf: String(attachment.mimeType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(name),
        });
      }
    }
    return files;
  }

  function buildInspectorModel({ events: inputEvents = null, session: inputSession = null } = {}) {
    const events = normalizeEvents(Array.isArray(inputEvents) ? inputEvents : state.events);
    const session = inputSession || state.session || getCurrentSessionSafe();
    const tools = new Map();
    const files = new Map();
    const activity = [];
    const hiddenActivity = [];
    let userTurns = 0;
    let assistantMessages = 0;

    for (const event of events) {
      if (event.type === "message" && event.role === "user") userTurns += 1;
      if (event.type === "message" && event.role === "assistant") assistantMessages += 1;
      if (isLowValueWorkbenchEvent(event)) {
        hiddenActivity.push({
          title: summarizeHiddenWorkbenchEvent(event),
          seq: event.seq || 0,
        });
        continue;
      }

      const delegatedSessionRef = readDelegatedSessionReference(event);
      if (delegatedSessionRef) {
        activity.push(delegatedSessionRef);
        continue;
      }

      if (event.type === "tool_use") {
        const toolName = event.toolName || "tool";
        const count = (tools.get(toolName)?.count || 0) + 1;
        tools.set(toolName, { name: toolName, count, latestSeq: event.seq || 0 });
        const edit = parseFileEdit(event);
        if (edit) {
          const diff = summarizeEditDiff(edit.edits);
          const hasLineStats = hasReviewableDiffStats(diff);
          activity.push({
            type: "edit",
            title: getFileNameFromPath(edit.filePath),
            subtitle: getShortPath(edit.filePath),
            added: diff.added,
            removed: diff.removed,
            hasLineStats,
            seq: event.seq || 0,
          });
          const previous = files.get(edit.filePath) || {
            filePath: edit.filePath,
            changeType: edit.changeType,
            added: 0,
            removed: 0,
            preview: [],
            source: edit.source,
            latestSeq: 0,
            hasLineStats: false,
          };
          previous.changeType = edit.changeType || previous.changeType;
          previous.added += diff.added;
          previous.removed += diff.removed;
          previous.preview.push(...diff.preview);
          previous.preview = previous.preview.slice(0, MAX_DIFF_PREVIEW_LINES);
          previous.source = edit.source || previous.source;
          previous.latestSeq = Math.max(previous.latestSeq || 0, event.seq || 0);
          previous.hasLineStats = previous.hasLineStats === true || hasLineStats;
          files.set(edit.filePath, previous);
        } else {
          activity.push({
            type: "tool",
            title: toolName,
            subtitle: summarizeToolInput(event.toolInput),
            seq: event.seq || 0,
          });
        }
      }

      if (event.type === "file_change") {
        const filePath = event.filePath || "";
        if (!filePath) continue;
        const existingFile = files.get(filePath) || null;
        activity.push({
          type: "file",
          title: filePath,
          subtitle: getChangeLabel(event.changeType),
          seq: event.seq || 0,
        });
        if (!shouldIncludeFileChangeInReview(event, existingFile)) {
          continue;
        }
        const eventPreview = readFileChangePreview(event);
        const previewStats = countDiffPreviewLines(eventPreview);
        const rawStats = getFileChangeStats(event);
        const stats = {
          added: rawStats.added > 0 ? rawStats.added : previewStats.added,
          removed: rawStats.removed > 0 ? rawStats.removed : previewStats.removed,
        };
        const hasLineStats = stats.added > 0 || stats.removed > 0 || eventPreview.length > 0;
        const previous = existingFile || {
          filePath,
          changeType: event.changeType || "update",
          added: 0,
          removed: 0,
          preview: [],
          source: "",
          latestSeq: 0,
          hasLineStats: false,
        };
        if (event.changeType && (!existingFile || event.changeType !== "update")) {
          previous.changeType = event.changeType;
        }
        previous.added += stats.added;
        previous.removed += stats.removed;
        if (eventPreview.length > 0) {
          if (previous.preview.length === 0 || !previous.source) {
            previous.preview = eventPreview.slice(0, MAX_DIFF_PREVIEW_LINES);
          }
        }
        previous.latestSeq = Math.max(previous.latestSeq || 0, event.seq || 0);
        previous.hasLineStats = previous.hasLineStats === true || hasLineStats;
        files.set(filePath, previous);
      }

      if (event.type === "status" && event.content && !["thinking", "completed"].includes(String(event.content).toLowerCase())) {
        activity.push({
          type: "status",
          title: String(event.content),
          subtitle: "",
          seq: event.seq || 0,
        });
      }
    }

    const artifacts = collectArtifacts(events);
    const artifactFiles = collectArtifactFiles(events, { sessionId: session?.id || "" });
    const compactActivity = compactWorkbenchActivityItems(activity);
    hiddenActivity.sort((a, b) => (b.seq || 0) - (a.seq || 0));

    return {
      session,
      events,
      userTurns,
      assistantMessages,
      tools: Array.from(tools.values()).sort((a, b) => b.latestSeq - a.latestSeq),
      files: Array.from(files.values())
        .sort((a, b) => b.latestSeq - a.latestSeq),
      activity: compactActivity.slice(0, MAX_ACTIVITY_ITEMS),
      hiddenActivity: hiddenActivity.slice(0, MAX_ACTIVITY_ITEMS),
      artifacts,
      artifactFiles,
    };
  }

  function cloneProjectionValue(value) {
    if (value === null || value === undefined) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function buildInspectorModelFromProjection(inputProjection = null, inputSession = null) {
    const payload = inputProjection && typeof inputProjection === "object" ? inputProjection : null;
    const projection = payload?.projection || payload;
    const suppliedModel = payload?.model && typeof payload.model === "object" ? payload.model : null;
    const session = inputSession || payload?.session || state.session || getCurrentSessionSafe();
    if (suppliedModel) {
      return {
        ...cloneProjectionValue(suppliedModel),
        session: suppliedModel.session || session,
      };
    }
    return {
      session,
      events: [],
      userTurns: projection?.counts?.userTurns || 0,
      assistantMessages: projection?.counts?.assistantMessages || 0,
      tools: cloneProjectionValue(projection?.toolSummary || projection?.tools || []),
      files: cloneProjectionValue(projection?.changedFiles || projection?.files || []),
      activity: cloneProjectionValue(projection?.activitySummary || projection?.activity || []),
      hiddenActivity: [],
      artifacts: cloneProjectionValue(projection?.artifacts || projection?.planArtifacts || []),
      planArtifacts: cloneProjectionValue(projection?.planArtifacts || []),
      progressPlans: cloneProjectionValue(projection?.progressPlans || []),
      artifactFiles: cloneProjectionValue(projection?.artifactFiles || []),
      sourceLatestSeq: projection?.sourceLatestSeq || 0,
      projectionStale: projection?.projectionStale === true,
    };
  }

  function currentInspectorModel() {
    if (state.projection) {
      return buildInspectorModelFromProjection(state.projection, state.session);
    }
    return buildInspectorModel();
  }

  function summarizeToolInput(toolInput) {
    if (!toolInput) return "";
    if (typeof toolInput === "string") {
      return toolInput.replace(/\s+/g, " ").trim().slice(0, 140);
    }
    try {
      return JSON.stringify(toolInput).replace(/\s+/g, " ").slice(0, 140);
    } catch {
      return "";
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function getPlanArtifactSummary(artifact) {
    const items = Array.isArray(artifact?.items) ? artifact.items : [];
    const completed = items.filter((item) => item.status === "completed").length;
    if (items.length === 0) return tr(`plan.status.${artifact?.state || "running"}`);
    return tr("plan.card.summary", {
      completed,
      total: items.length,
      status: tr(`plan.status.${artifact?.state || "running"}`),
    });
  }

  function getPlanProgressArtifactSummary(artifact) {
    const items = Array.isArray(artifact?.items) ? artifact.items : [];
    if (items.length === 0) return tr("plan.progress.empty");
    const completed = items.filter((item) => item.status === "completed").length;
    const current = items.find((item) => item.status === "in_progress")
      || items.find((item) => item.status === "pending")
      || items[items.length - 1];
    if (completed === items.length) {
      return tr("plan.progress.complete", { completed, total: items.length });
    }
    return tr("plan.progress.summary", {
      completed,
      total: items.length,
      current: current?.text || tr("plan.progress.empty"),
    });
  }

  function renderStatusCard(model) {
    const session = model.session || {};
    const activity = typeof getSessionActivity === "function"
      ? getSessionActivity(session)
      : (session.activity || {});
    const runState = activity?.run?.state || "idle";
    const providerMeta = getProviderMeta(model);
    const statusClass = session.archived ? "archived" : (runState === "running" ? "running" : "");
    const statusText = session.archived ? tr("status.archived") : tr(`status.${runState}`) || runState;
    const rows = [
      [tr("workbench.meta.agent"), session.tool || ""],
      [tr("workbench.meta.provider"), providerMeta.provider],
      [tr("workbench.meta.runtime"), providerMeta.runtimeFamily],
      [tr("workbench.meta.model"), session.model || session.effort || ""],
      [tr("workbench.meta.capabilities"), providerMeta.capabilities.join(" · ")],
      [tr("workbench.meta.permissions"), providerMeta.permissions],
      [tr("workbench.meta.folder"), getShortPath(session.folder || "")],
      [tr("workbench.meta.messages"), String(model.userTurns + model.assistantMessages)],
    ].filter((row) => row[1]);

    return `
      <div class="workbench-status-card">
        <div class="workbench-status-line">
          <div class="workbench-status-title" title="${escapeHtml(getSessionTitle(session))}">${escapeHtml(getSessionTitle(session))}</div>
          <span class="workbench-pill ${escapeHtml(statusClass)}">${escapeHtml(statusText)}</span>
        </div>
        <div class="workbench-meta">
          ${rows.map(([label, value]) => `
            <div class="workbench-meta-row">
              <span class="workbench-meta-label">${escapeHtml(label)}</span>
              <span class="workbench-meta-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  function getProviderMeta(model) {
    const session = model?.session || {};
    const activity = typeof getSessionActivity === "function"
      ? getSessionActivity(session)
      : (session.activity || {});
    let provider = activity?.run?.provider || session.provider || "";
    let runtimeFamily = activity?.run?.runtimeFamily || session.runtimeFamily || "";
    let capabilities = activity?.run?.providerCapabilities || session.providerCapabilities || null;
    let permissionMode = activity?.run?.permissionMode || session.permissionMode || "";
    for (let index = model.events.length - 1; index >= 0; index -= 1) {
      const event = model.events[index];
      if (!provider && event?.provider) provider = event.provider;
      if (!runtimeFamily && event?.runtimeFamily) runtimeFamily = event.runtimeFamily;
      if (!permissionMode && event?.permissionMode) permissionMode = event.permissionMode;
      if (!capabilities && event?.providerCapabilities && typeof event.providerCapabilities === "object") {
        capabilities = event.providerCapabilities;
      }
      if (provider && runtimeFamily && capabilities && permissionMode) break;
    }
    const capabilityLabels = [];
    if (capabilities?.supportsSteer === true) capabilityLabels.push("steer");
    if (capabilities?.supportsInterrupt === true) capabilityLabels.push("interrupt");
    if (capabilities?.supportsRevise === true) capabilityLabels.push("revise");
    if (capabilities?.supportsTextDelta === true) capabilityLabels.push("delta");
    if (capabilities?.supportsExternalUsageProjection === true) capabilityLabels.push("usage");
    const permissionLabels = Array.isArray(capabilities?.permissionModes)
      ? capabilities.permissionModes
        .map((mode) => String(mode?.label || mode?.id || "").trim())
        .filter(Boolean)
      : [];
    const resolvedPermissionMode = permissionMode || capabilities?.defaultPermissionMode || "";
    const permissions = permissionLabels.length > 0
      ? (resolvedPermissionMode
        ? `${resolvedPermissionMode} (${permissionLabels.join(" · ")})`
        : permissionLabels.join(" · "))
      : "";
    return {
      provider,
      runtimeFamily,
      capabilities: capabilityLabels,
      permissions,
    };
  }

  function renderStats(model) {
    return `
      <div class="workbench-stats-grid">
        <div class="workbench-stat">
          <div class="workbench-stat-value">${model.userTurns}</div>
          <div class="workbench-stat-label">${escapeHtml(tr("workbench.stat.turns"))}</div>
        </div>
        <div class="workbench-stat">
          <div class="workbench-stat-value">${model.tools.length}</div>
          <div class="workbench-stat-label">${escapeHtml(tr("workbench.stat.tools"))}</div>
        </div>
        <div class="workbench-stat">
          <div class="workbench-stat-value">${model.files.length}</div>
          <div class="workbench-stat-label">${escapeHtml(tr("workbench.stat.files"))}</div>
        </div>
      </div>`;
  }

  function renderHiddenActivityDetails(model) {
    return model.hiddenActivity?.length
      ? `<details class="workbench-activity-raw workbench-activity--raw-collapsed">
          <summary>${escapeHtml(tr("workbench.showRawActivity", { count: model.hiddenActivity.length }))}</summary>
          <div class="workbench-raw-list">
            ${model.hiddenActivity.map((item) => `
              <div class="workbench-raw-item" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            `).join("")}
          </div>
        </details>`
      : "";
  }

  function renderActivity(model) {
    const rawDetails = renderHiddenActivityDetails(model);
    if (model.activity.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noActivity"))}</div>${rawDetails}`;
    }
    return `<div class="workbench-activity-list">
      ${model.activity.map((item) => renderActivityItem(item)).join("")}
      ${rawDetails}
    </div>`;
  }

  function renderSessionReferenceButton(ref, {
    className = "workbench-session-link",
    inspectorTab = "outcome",
  } = {}) {
    const sessionId = normalizeSessionReferenceId(ref?.sessionId);
    if (!sessionId) return "";
    const title = normalizeSessionReferenceTitle(ref?.title, sessionId);
    const label = typeof ref?.label === "string" && ref.label.trim()
      ? ref.label.trim()
      : tr("workbench.session.open");
    const folder = typeof ref?.folder === "string" && ref.folder.trim()
      ? `${tr("workbench.session.folder")}: ${getShortPath(ref.folder.trim())}`
      : "";
    const subtitle = [ref?.subtitle, folder]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" · ");
    return `
      <button type="button"
        class="${escapeHtml(className)}"
        data-session-ref="${escapeHtml(sessionId)}"
        data-inspector-tab="${escapeHtml(inspectorTab)}"
        title="${escapeHtml(title)}">
        <span class="workbench-activity-dot session" aria-hidden="true"></span>
        <span class="workbench-session-link-main">
          <span class="workbench-session-link-label">${escapeHtml(label)}</span>
          <span class="workbench-session-link-title">${escapeHtml(title)}</span>
          ${subtitle ? `<span class="workbench-session-link-subtitle" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span>` : ""}
        </span>
        <span class="workbench-session-link-action">${escapeHtml(tr("workbench.session.open"))}</span>
      </button>`;
  }

  function renderActivityItem(item) {
    if (item?.type === "session") {
      return renderSessionReferenceButton(item, {
        className: "workbench-session-link workbench-activity-item",
        inspectorTab: "outcome",
      });
    }
    if (item?.type === "edit") {
      const hasLineStats = item.hasLineStats !== false;
      const statsLabel = hasLineStats
        ? tr("workbench.editingStats", { added: item.added || 0, removed: item.removed || 0 })
        : tr("workbench.editingStatsUnknown");
      return `
        <div class="workbench-activity-item workbench-activity-editing">
          <span class="workbench-activity-edit-icon" aria-hidden="true"></span>
          <div class="workbench-activity-edit-main">
            <span class="workbench-activity-edit-label">${escapeHtml(tr("workbench.editing"))}</span>
            <span class="workbench-activity-edit-file" title="${escapeHtml(item.subtitle || item.title)}">${escapeHtml(item.title)}</span>
          </div>
          <div class="workbench-activity-edit-stats" aria-label="${escapeHtml(statsLabel)}">
            <span class="workbench-activity-edit-add ${hasLineStats ? "" : "workbench-activity-edit-unknown"}">${hasLineStats ? `+${escapeHtml(item.added || 0)}` : "+…"}</span>
            <span class="workbench-activity-edit-del ${hasLineStats ? "" : "workbench-activity-edit-unknown"}">${hasLineStats ? `-${escapeHtml(item.removed || 0)}` : "-…"}</span>
          </div>
        </div>`;
    }
    return `
      <div class="workbench-activity-item">
        <span class="workbench-activity-dot ${escapeHtml(item.type)}"></span>
        <div>
          <div class="workbench-activity-title" title="${escapeHtml(item.title)}">
            ${escapeHtml(item.title)}
            ${item.count > 1 ? `<span class="workbench-activity-count">×${item.count}</span>` : ""}
          </div>
          ${item.subtitle ? `<div class="workbench-activity-subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ""}
        </div>
      </div>`;
  }

  function renderArtifacts(model) {
    if (model.artifacts.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noArtifacts"))}</div>`;
    }
    const orderedArtifacts = orderArtifactsForDisplay(model.artifacts);
    return `<div class="workbench-artifact-list">
      ${orderedArtifacts.map((artifact) => artifact.kind === "plan"
        ? renderPlanArtifact(artifact)
        : renderFileArtifact(artifact)).join("")}
    </div>`;
  }

  function orderArtifactsForDisplay(artifacts) {
    const sourceArtifacts = Array.isArray(artifacts) ? artifacts : [];
    return [
      ...sourceArtifacts.filter((artifact) => !isPlanProgressArtifact(artifact)),
      ...sourceArtifacts.filter((artifact) => isPlanProgressArtifact(artifact)),
    ];
  }

  function getOutcomeSummaryText(model) {
    const artifactCount = model.artifacts.length;
    const fileCount = model.files.length + model.artifactFiles.length;
    if (artifactCount > 0 && fileCount > 0) {
      return tr("workbench.outcome.summaryArtifactsAndFiles", {
        artifacts: artifactCount,
        files: fileCount,
      });
    }
    if (artifactCount > 0) {
      return tr("workbench.outcome.summaryArtifacts", { artifacts: artifactCount });
    }
    if (fileCount > 0) {
      return tr("workbench.outcome.summaryFiles", { files: fileCount });
    }
    if (model.activity.length > 0) {
      return tr("workbench.outcome.summaryActivity");
    }
    return tr("workbench.outcome.summaryEmpty");
  }

  function renderOutcomeDeliveryCard(model) {
    const fileCount = model.files.length + model.artifactFiles.length;
    const artifactCount = model.artifacts.length;
    const statusInfo = getSessionMetaStatusInfo(model.session || {});
    const statusText = statusInfo.label || tr("status.idle");
    const hasReview = fileCount > 0;
    return `
      <section class="workbench-outcome-card">
        <div class="workbench-outcome-card-header">
          <div>
            <div class="workbench-outcome-eyebrow">${escapeHtml(tr("workbench.outcome.eyebrow"))}</div>
            <div class="workbench-outcome-title">${escapeHtml(getSessionTitle(model.session || {}))}</div>
          </div>
          <span class="workbench-pill ${escapeHtml(statusInfo.className || "")}">${escapeHtml(statusText)}</span>
        </div>
        <p class="workbench-outcome-summary">${escapeHtml(getOutcomeSummaryText(model))}</p>
        <div class="workbench-outcome-metrics">
          <div class="workbench-outcome-metric">
            <span class="workbench-outcome-metric-value">${artifactCount}</span>
            <span class="workbench-outcome-metric-label">${escapeHtml(tr("workbench.outcome.metric.outputs"))}</span>
          </div>
          <div class="workbench-outcome-metric">
            <span class="workbench-outcome-metric-value">${fileCount}</span>
            <span class="workbench-outcome-metric-label">${escapeHtml(tr("workbench.outcome.metric.files"))}</span>
          </div>
          <div class="workbench-outcome-metric">
            <span class="workbench-outcome-metric-value">${model.tools.length}</span>
            <span class="workbench-outcome-metric-label">${escapeHtml(tr("workbench.outcome.metric.tools"))}</span>
          </div>
        </div>
        ${hasReview ? `<div class="workbench-outcome-next">${escapeHtml(tr("workbench.outcome.reviewReady"))}</div>` : ""}
      </section>`;
  }

  function renderChangedFiles(model) {
    if (model.files.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noFiles"))}</div>`;
    }
    return `<section class="workbench-section">
      <div class="workbench-section-title">${escapeHtml(tr("workbench.files"))}</div>
      <div class="workbench-file-list">
        ${model.files.map((file) => {
          const hasLineStats = file.hasLineStats !== false;
          return `
            <article class="workbench-file-row">
              <div class="workbench-file-main">
                <div class="workbench-file-name" title="${escapeHtml(file.filePath)}">${escapeHtml(getFileNameFromPath(file.filePath))}</div>
                <div class="workbench-file-path" title="${escapeHtml(file.filePath)}">${escapeHtml(getShortPath(file.filePath))}</div>
              </div>
              <div class="workbench-file-meta">
                <span>${escapeHtml(getChangeLabel(file.changeType))}</span>
                <span class="workbench-review-add ${hasLineStats ? "" : "workbench-review-unknown"}">${hasLineStats ? `+${file.added || 0}` : "+…"}</span>
                <span class="workbench-review-del ${hasLineStats ? "" : "workbench-review-unknown"}">${hasLineStats ? `-${file.removed || 0}` : "-…"}</span>
              </div>
            </article>`;
        }).join("")}
      </div>
    </section>`;
  }

  function renderWorkbenchFiles(model) {
    const artifactFiles = Array.isArray(model.artifactFiles) ? model.artifactFiles : [];
    const hasArtifactFiles = artifactFiles.length > 0;
    const hasChangedFiles = model.files.length > 0;
    if (!hasArtifactFiles && !hasChangedFiles) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noFiles"))}</div>`;
    }
    return `
      ${hasArtifactFiles ? `<section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.files"))}</div>
        <div class="workbench-artifact-list">
          ${artifactFiles.map((artifact) => renderFileArtifact(artifact)).join("")}
        </div>
      </section>` : ""}
      ${hasChangedFiles ? renderChangedFiles(model) : ""}`;
  }

  function renderPlanArtifact(artifact) {
    const allItems = Array.isArray(artifact.items) ? artifact.items : [];
    if (isPlanProgressArtifact(artifact)) {
      const summary = getPlanProgressArtifactSummary(artifact);
      return `
        <details class="workbench-artifact-item workbench-plan-artifact workbench-plan-progress" data-plan-id="${escapeHtml(artifact.planId)}">
          <summary class="workbench-plan-artifact-header workbench-plan-progress-summary">
            <span class="workbench-plan-artifact-title">${escapeHtml(tr("plan.progress.label"))}</span>
            <span class="workbench-plan-artifact-state" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
          </summary>
          ${allItems.length > 0 ? `
            <ol class="workbench-plan-artifact-list">
              ${allItems.map((item) => `
                <li class="workbench-plan-artifact-step workbench-plan-artifact-step--${escapeHtml(item.status)}">
                  ${escapeHtml(item.text)}
                </li>
              `).join("")}
            </ol>
          ` : ""}
        </details>`;
    }
    const previewItems = allItems.slice(0, 4);
    const canAct = !(typeof isShareSnapshotReadOnlyMode === "function" && isShareSnapshotReadOnlyMode());
    return `
      <article class="workbench-artifact-item workbench-plan-artifact" data-plan-id="${escapeHtml(artifact.planId)}">
        <div class="workbench-plan-artifact-header">
          <div class="workbench-plan-artifact-title" title="${escapeHtml(artifact.name)}">${escapeHtml(artifact.name)}</div>
          <span class="workbench-plan-artifact-state">${escapeHtml(getPlanArtifactSummary(artifact))}</span>
        </div>
        ${previewItems.length > 0 ? `
          <ol class="workbench-plan-artifact-list">
            ${previewItems.map((item) => `
              <li class="workbench-plan-artifact-step workbench-plan-artifact-step--${escapeHtml(item.status)}">
                ${escapeHtml(item.text)}
              </li>
            `).join("")}
          </ol>
        ` : ""}
        ${canAct ? `<div class="workbench-plan-artifact-actions">
          <button type="button" class="workbench-plan-artifact-action" data-plan-artifact-action="revise" data-plan-id="${escapeHtml(artifact.planId)}">
            ${escapeHtml(tr("plan.action.revise"))}
          </button>
          <button type="button" class="workbench-plan-artifact-action primary" data-plan-artifact-action="execute" data-plan-id="${escapeHtml(artifact.planId)}">
            ${escapeHtml(tr("plan.action.execute"))}
          </button>
        </div>` : ""}
      </article>`;
  }

  function renderFileArtifact(artifact) {
    const meta = [artifact.mimeType, formatBytes(artifact.sizeBytes)].filter(Boolean).join(" / ");
    const isMarkdown = isMarkdownArtifact(artifact);
    const isPdf = isPdfArtifact(artifact);
    const isReadable = isMarkdown || isPdf;
    const artifactFileId = String(artifact?.id || artifact?.artifactFileId || "").trim();
    const artifactIdAttr = artifactFileId ? ` data-artifact-file-id="${escapeHtml(artifactFileId)}"` : "";
    const content = `
      <div class="workbench-artifact-title-row">
        <span>${escapeHtml(artifact.name)}</span>
        ${isReadable ? `<span class="workbench-artifact-badge">${escapeHtml(isPdf ? "PDF" : tr("workbench.markdown.badge"))}</span>` : ""}
      </div>
      ${meta ? `<div class="workbench-artifact-meta">${escapeHtml(meta)}</div>` : ""}
      ${isReadable ? `<div class="workbench-artifact-hint">${escapeHtml(tr("workbench.markdown.openHint"))}</div>` : ""}
    `;
    if (artifact.url) {
      if (isReadable) {
        const markdownAttrs = isMarkdown
          ? ` data-markdown-artifact-url="${escapeHtml(artifact.url)}" data-markdown-artifact-name="${escapeHtml(artifact.name)}" data-markdown-artifact-download-url="${escapeHtml(buildArtifactDownloadUrl(artifact))}"`
          : "";
        return `<a class="workbench-artifact-item workbench-artifact-item--markdown" href="${escapeHtml(artifact.url)}" target="_blank" rel="noreferrer noopener"${artifactIdAttr}${markdownAttrs}>${content}</a>`;
      }
      return `<a class="workbench-artifact-item" href="${escapeHtml(artifact.url)}" target="_blank" rel="noreferrer noopener"${artifactIdAttr}>${content}</a>`;
    }
    return `<div class="workbench-artifact-item"${artifactIdAttr}>${content}</div>`;
  }

  function ensureMarkdownReader() {
    if (markdownReader.node) return markdownReader;
    const node = document.createElement("section");
    node.className = "markdown-reader";
    node.id = "markdownArtifactReader";
    node.hidden = true;
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-labelledby", "markdownArtifactReaderTitle");
    node.innerHTML = `
      <div class="markdown-reader-scrim" data-markdown-reader-close></div>
      <div class="markdown-reader-panel" role="document">
        <header class="markdown-reader-header">
          <button type="button" class="markdown-reader-back" data-markdown-reader-close aria-label="${escapeHtml(tr("action.close"))}">
            ${renderIcon("chevron-left", "markdown-reader-back-icon")}
          </button>
          <div class="markdown-reader-title-block">
            <div class="markdown-reader-eyebrow">${escapeHtml(tr("workbench.markdown.readerEyebrow"))}</div>
            <h2 class="markdown-reader-title" id="markdownArtifactReaderTitle">${escapeHtml(tr("workbench.markdown.readerTitle"))}</h2>
          </div>
          <div class="markdown-reader-actions">
            <a class="markdown-reader-action markdown-reader-raw" href="#" target="_blank" rel="noreferrer noopener">${escapeHtml(tr("workbench.markdown.openRaw"))}</a>
            <a class="markdown-reader-action markdown-reader-download markdown-reader-download--icon" href="#" target="_blank" rel="noreferrer noopener" aria-label="${escapeHtml(tr("action.download"))}" title="${escapeHtml(tr("action.download"))}">${(window.RagentIcons && window.RagentIcons.render && window.RagentIcons.render("download")) || escapeHtml(tr("action.download"))}</a>
          </div>
        </header>
        <div class="markdown-reader-body">
          <div class="markdown-reader-status" role="status"></div>
          <div class="markdown-reader-content md-content"></div>
        </div>
      </div>
    `;
    document.body.appendChild(node);
    markdownReader.node = node;
    markdownReader.title = node.querySelector(".markdown-reader-title");
    markdownReader.status = node.querySelector(".markdown-reader-status");
    markdownReader.content = node.querySelector(".markdown-reader-content");
    markdownReader.rawLink = node.querySelector(".markdown-reader-raw");
    markdownReader.downloadLink = node.querySelector(".markdown-reader-download");
    node.addEventListener("click", (event) => {
      if (event.target?.closest?.("[data-markdown-reader-close]")) {
        event.preventDefault();
        closeMarkdownReader();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !markdownReader.node?.hidden) {
        closeMarkdownReader();
      }
    });
    return markdownReader;
  }

  function setMarkdownReaderStatus(message, kind = "") {
    const reader = ensureMarkdownReader();
    if (!reader.status) return;
    reader.status.textContent = message || "";
    reader.status.hidden = !message;
    reader.status.dataset.kind = kind;
  }

  function renderMarkdownReaderContent(markdown) {
    const reader = ensureMarkdownReader();
    if (!reader.content) return;
    reader.content.innerHTML = "";
    const source = String(markdown || "");
    if (typeof root.renderMarkdownIntoNode === "function") {
      root.renderMarkdownIntoNode(reader.content, source);
      return;
    }
    if (root.marked?.parse) {
      reader.content.innerHTML = root.marked.parse(source);
      if (typeof root.enhanceRenderedContentLinks === "function") {
        root.enhanceRenderedContentLinks(reader.content);
      }
      return;
    }
    reader.content.textContent = source;
  }

  function closeMarkdownReader() {
    if (!markdownReader.node) return;
    if (markdownReaderBackEntryId) {
      window.RagentBackHandler?.pop?.(markdownReaderBackEntryId);
      markdownReaderBackEntryId = null;
    }
    if (markdownReader.focusScopeDeactivate) {
      markdownReader.focusScopeDeactivate();
      markdownReader.focusScopeDeactivate = null;
    }
    markdownReader.requestSeq += 1;
    markdownReader.node.hidden = true;
    document.body.classList.remove("markdown-reader-open");
  }

  async function openMarkdownReader({ url, name, downloadUrl }) {
    const sourceUrl = String(url || "").trim();
    if (!sourceUrl) return;
    const reader = ensureMarkdownReader();
    markdownReader.trigger = document.activeElement;
    const requestSeq = markdownReader.requestSeq + 1;
    markdownReader.requestSeq = requestSeq;
    if (reader.title) {
      reader.title.textContent = String(name || "").trim() || tr("workbench.markdown.readerTitle");
    }
    if (reader.rawLink) reader.rawLink.href = sourceUrl;
    if (reader.downloadLink) {
      const resolvedDownloadUrl = String(downloadUrl || "").trim() || appendUrlParam(sourceUrl, "download", "1");
      reader.downloadLink.href = resolvedDownloadUrl;
      reader.downloadLink.hidden = !resolvedDownloadUrl;
    }
    if (reader.content) reader.content.innerHTML = "";
    setMarkdownReaderStatus(tr("workbench.markdown.loading"));
    reader.node.hidden = false;
    document.body.classList.add("markdown-reader-open");
    markdownReader.focusScopeDeactivate = root.RagentFocusScope?.activate?.(reader.node, {
      containmentRoot: document.body,
      initialFocus: () => reader.node?.querySelector?.("[data-markdown-reader-close]"),
      restoreFocus: () => (markdownReader.trigger && markdownReader.trigger.isConnected !== false)
        ? markdownReader.trigger
        : dom.button,
      modal: true,
      onEscape: () => closeMarkdownReader(),
    }) || null;
    markdownReaderBackEntryId = window.RagentBackHandler?.push?.({
      id: "markdown-reader",
      onBack: () => {
        closeMarkdownReader();
        return true;
      },
    }) || null;
    try {
      const response = await (root.ragentFetch || fetch)(sourceUrl, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (requestSeq !== markdownReader.requestSeq) return;
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText || ""}`.trim());
      }
      const markdown = await response.text();
      if (requestSeq !== markdownReader.requestSeq) return;
      setMarkdownReaderStatus("");
      renderMarkdownReaderContent(markdown);
    } catch (error) {
      if (requestSeq !== markdownReader.requestSeq) return;
      setMarkdownReaderStatus(tr("workbench.markdown.failed"), "error");
      if (reader.content) {
        reader.content.textContent = error?.message || "";
      }
    }
  }

  function handleMarkdownArtifactClick(event) {
    const link = event?.target?.closest?.("[data-markdown-artifact-url]");
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) return;
    event.preventDefault();
    openMarkdownReader({
      url: link.dataset.markdownArtifactUrl || link.getAttribute("href") || "",
      name: link.dataset.markdownArtifactName || link.textContent || "",
      downloadUrl: link.dataset.markdownArtifactDownloadUrl || "",
    });
  }

  function findPlanArtifact(planId) {
    const normalizedPlanId = String(planId || "").trim();
    if (!normalizedPlanId) return null;
    const model = currentInspectorModel();
    const artifacts = Array.isArray(model?.planArtifacts)
      ? model.planArtifacts
      : (Array.isArray(model?.artifacts) ? model.artifacts : []);
    return artifacts
      .find((artifact) => artifact.planId === normalizedPlanId) || null;
  }

  async function handlePlanArtifactActionClick(event) {
    const button = event?.target?.closest?.("[data-plan-artifact-action]");
    if (!button) return;
    const action = String(button.dataset.planArtifactAction || "").trim().toLowerCase();
    if (!["revise", "execute"].includes(action)) return;
    event.preventDefault();
    const artifact = findPlanArtifact(button.dataset.planId);
    if (!artifact || typeof insertPlanPromptIntoComposer !== "function") return;
    if (action === "execute" && typeof submitPlanArtifactAction === "function") {
      const submitted = await submitPlanArtifactAction("execute", artifact.planId, { button });
      if (submitted) return;
    }
    const promptKey = action === "execute" ? "plan.action.executePrompt" : "plan.action.revisePrompt";
    insertPlanPromptIntoComposer(action === "revise" ? tr(promptKey) : `${tr(promptKey)}\n\n${artifact.text}`, {
      send: action === "execute",
      interactionMode: action === "execute" ? "agent" : "plan",
      planAction: action,
      planId: artifact.planId,
    });
  }

  async function handleSessionReferenceClick(event, scope) {
    const button = event?.target?.closest?.("[data-session-ref]");
    const container = scope || dom.body;
    if (!button || (container && !container.contains(button))) return;
    event.preventDefault();
    const sessionId = normalizeSessionReferenceId(button.dataset.sessionRef);
    if (!sessionId) return;
    const inspectorTab = normalizeInspectorTab(button.dataset.inspectorTab || state.activeTab || "outcome");
    button.disabled = true;
    try {
      setOpen(true);
      if (typeof root.ragentOpenSessionReference === "function") {
        await root.ragentOpenSessionReference(sessionId, {
          tab: "sessions",
          inspectorTab,
          forceFresh: true,
        });
      } else {
        window.location.assign(`/?session=${encodeURIComponent(sessionId)}&tab=sessions`);
        return;
      }
      state.activeTab = inspectorTab;
      writeStoredTab(inspectorTab);
      scheduleRefresh(sessionId, { forceFresh: true, delay: 0 });
    } catch (error) {
      console.warn("[workbench] Failed to open session reference:", error?.message || error);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function renderParentSessionReference(model) {
    const ref = getParentSessionReference(model.session || {});
    if (!ref) return "";
    return `<section class="workbench-section">
      <div class="workbench-section-title">${escapeHtml(tr("workbench.session.parent"))}</div>
      ${renderSessionReferenceButton(ref, {
        className: "workbench-session-link workbench-session-ref-card",
        inspectorTab: "outcome",
      })}
    </section>`;
  }

  function renderOutcome(model) {
    return `
      <section class="workbench-section">
        ${renderOutcomeDeliveryCard(model)}
      </section>
      ${renderParentSessionReference(model)}
      ${model.artifacts.length > 0 ? `<section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.outputs"))}</div>
        ${renderArtifacts(model)}
      </section>` : ""}`;
  }

  function renderContext(model) {
    const session = model.session || {};
    const taskCard = session.taskCard && typeof session.taskCard === "object" ? session.taskCard : null;
    const providerMeta = getProviderMeta(model);
    const rows = [
      [tr("workbench.meta.session"), getSessionTitle(session)],
      [tr("workbench.meta.source"), session.sourceName || session.sourceId || ""],
      [tr("workbench.meta.group"), session.group || ""],
      [tr("workbench.meta.provider"), providerMeta.provider],
      [tr("workbench.meta.runtime"), providerMeta.runtimeFamily],
      [tr("workbench.meta.permissions"), providerMeta.permissions],
      [tr("workbench.meta.folder"), getShortPath(session.folder || "")],
      [tr("workbench.meta.contextMode"), session.contextMode || ""],
      [tr("workbench.meta.latestSeq"), Number.isInteger(session.latestSeq) ? String(session.latestSeq) : ""],
    ].filter((row) => row[1]);
    const taskItems = [
      taskCard?.goal,
      ...(Array.isArray(taskCard?.nextSteps) ? taskCard.nextSteps.slice(0, 6) : []),
    ].filter(Boolean);
    return `
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.context"))}</div>
        <div class="workbench-status-card">
          <div class="workbench-meta">
            ${rows.map(([label, value]) => `
              <div class="workbench-meta-row">
                <span class="workbench-meta-label">${escapeHtml(label)}</span>
                <span class="workbench-meta-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </section>
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.taskCard"))}</div>
        ${taskItems.length > 0 ? `<ol class="workbench-context-list">
          ${taskItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ol>` : `<div class="workbench-empty">${escapeHtml(tr("workbench.noContext"))}</div>`}
      </section>`;
  }

  function renderLogs(model) {
    if (model.activity.length === 0 && model.hiddenActivity.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noActivity"))}</div>`;
    }
    return `
      <section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.logs"))}</div>
        ${renderActivity(model)}
      </section>`;
  }

  function renderChanges(model) {
    const artifactFiles = Array.isArray(model.artifactFiles) ? model.artifactFiles : [];
    const sections = [];
    if (model.files.length > 0) sections.push(renderReview(model));
    if (artifactFiles.length > 0) {
      sections.push(`<section class="workbench-section">
        <div class="workbench-section-title">${escapeHtml(tr("workbench.files"))}</div>
        <div class="workbench-artifact-list">
          ${artifactFiles.map((artifact) => renderFileArtifact(artifact)).join("")}
        </div>
      </section>`);
    }
    return sections.length > 0
      ? sections.join("")
      : `<div class="workbench-empty">${escapeHtml(tr("workbench.noFiles"))}</div>`;
  }

  function renderActivityTab(model) {
    return `${renderLogs(model)}${renderContext(model)}`;
  }

  function renderDiffPreview(file) {
    const preview = Array.isArray(file.preview) ? file.preview : [];
    const gap = getDiffPreviewGap(file);
    const omittedRows = [
      gap.added > 0 ? { type: "add", count: gap.added, text: tr("workbench.diff.omittedAdded", { count: gap.added }) } : null,
      gap.removed > 0 ? { type: "remove", count: gap.removed, text: tr("workbench.diff.omittedRemoved", { count: gap.removed }) } : null,
    ].filter(Boolean);
    if (preview.length === 0 && omittedRows.length === 0) {
      return `<div class="workbench-diff-empty">${escapeHtml(tr("workbench.diff.noPreview"))}</div>`;
    }
    return `<div class="workbench-diff-preview">
      ${preview.slice(0, MAX_DIFF_PREVIEW_LINES).map((line) => `
        <div class="workbench-diff-line ${escapeHtml(line.type)}">
          <span class="workbench-diff-marker">${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
          <span class="workbench-diff-num">${escapeHtml(formatDiffLineNumber(line.oldLine))}</span>
          <span class="workbench-diff-num">${escapeHtml(formatDiffLineNumber(line.newLine))}</span>
          <span class="workbench-diff-text">${escapeHtml(line.text)}</span>
        </div>
      `).join("")}
      ${omittedRows.map((line) => `
        <div class="workbench-diff-line ${escapeHtml(line.type)} workbench-diff-omitted" aria-label="${escapeHtml(line.text)}">
          <span class="workbench-diff-marker">…</span>
          <span class="workbench-diff-num"></span>
          <span class="workbench-diff-num"></span>
          <span class="workbench-diff-text">${escapeHtml(line.text)}</span>
        </div>
      `).join("")}
    </div>`;
  }

  function formatDiffLineNumber(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? String(number) : "";
  }

  function renderReview(model) {
    if (model.files.length === 0) {
      return `<div class="workbench-empty">${escapeHtml(tr("workbench.noFiles"))}</div>`;
    }
    return `<section class="workbench-section">
      <div class="workbench-section-title">${escapeHtml(tr("workbench.filesChanged"))}</div>
      <div class="workbench-review-list">
        ${model.files.map((file) => {
          const hasLineStats = file.hasLineStats !== false;
          const statsLabel = hasLineStats
            ? tr("workbench.editingStats", { added: file.added || 0, removed: file.removed || 0 })
            : tr("workbench.editingStatsUnknown");
          return `
          <details class="workbench-review-file ${Array.isArray(file.preview) && file.preview.length > 0 ? "has-diff-preview" : "is-missing-diff-preview"}">
            <summary class="workbench-review-summary">
              <div class="workbench-review-file-header">
                <div class="workbench-review-path" title="${escapeHtml(file.filePath)}">${escapeHtml(getShortPath(file.filePath))}</div>
                <div class="workbench-review-kind">${escapeHtml(getChangeLabel(file.changeType))}</div>
              </div>
              <div class="workbench-review-stats" aria-label="${escapeHtml(statsLabel)}">
                ${file.source ? `<span>${escapeHtml(file.source)}</span>` : ""}
                <span class="workbench-review-add ${hasLineStats ? "" : "workbench-review-unknown"}">${hasLineStats ? `+${file.added || 0}` : "+…"}</span>
                <span class="workbench-review-del ${hasLineStats ? "" : "workbench-review-unknown"}">${hasLineStats ? `-${file.removed || 0}` : "-…"}</span>
              </div>
            </summary>
            ${renderDiffPreview(file)}
          </details>
        `; }).join("")}
      </div>
    </section>`;
  }

  function animateInspectorBody(animationKey) {
    if (!dom.body?.classList) return;
    if (animationKey && state.lastRenderAnimationKey === animationKey) return;
    state.lastRenderAnimationKey = animationKey || "";
    dom.body.classList.remove("is-refreshing");
    void dom.body.offsetWidth;
    dom.body.classList.add("is-refreshing");
  }

  function render() {
    if (!dom.body) return;
    syncButtonVisibility();
    syncTabs();
    const activeTab = normalizeInspectorTab(state.activeTab);
    if (activeTab !== state.activeTab) state.activeTab = activeTab;
    if (!state.sessionId) {
      dom.body.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.empty"))}</div>`;
      animateInspectorBody(`empty:${activeTab}`);
      return;
    }
    const hasCachedModel = !!state.projection || state.events.length > 0;
    if (state.loading && !hasCachedModel) {
      dom.body.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.loading"))}</div>`;
      animateInspectorBody(`loading:${state.sessionId}:${activeTab}`);
      return;
    }
    if (state.error && !hasCachedModel) {
      dom.body.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.error"))}</div>`;
      animateInspectorBody(`error:${state.sessionId}:${activeTab}`);
      return;
    }
    const model = currentInspectorModel();
    const renderers = {
      outcome: renderOutcome,
      changes: renderChanges,
      activity: renderActivityTab,
    };
    dom.body.innerHTML = (renderers[activeTab] || renderOutcome)(model);
    root.RagentIcons?.hydrate?.(dom.body);
    animateInspectorBody(`content:${state.sessionId}:${activeTab}`);
    notifyRenderSubscribers();
  }

  function syncTabs() {
    for (const tab of dom.tabs) {
      const active = tab.dataset.inspectorTab === state.activeTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function syncButtonVisibility() {
    const hasSession = !!state.sessionId || (typeof currentSessionId !== "undefined" && !!currentSessionId);
    if (dom.button) {
      dom.button.hidden = !hasSession;
    }
    if (!hasSession) {
      setOpen(false, { persist: false });
    }
  }

  function isInspectorOpen() {
    return document.body.classList.contains("workbench-inspector-open")
      && !document.body.classList.contains("workbench-inspector-collapsed");
  }

  function clearScheduledRefresh() {
    if (!state.fetchTimer) return;
    clearTimeout(state.fetchTimer);
    state.fetchTimer = null;
  }

  function setOpen(open, { persist = true } = {}) {
    if (open && typeof root.closeRightSidebar === "function") {
      root.closeRightSidebar();
    }
    document.body.classList.toggle("workbench-inspector-open", open);
    document.body.classList.toggle("workbench-inspector-collapsed", !open);
    if (dom.button) {
      dom.button.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (persist) writeStoredOpen(open);
    if (typeof syncMobileDisclosureState === "function") {
      syncMobileDisclosureState();
    }
    if (open) {
      const sessionId = state.sessionId || (typeof currentSessionId !== "undefined" ? currentSessionId : "");
      if (sessionId) scheduleRefresh(sessionId, { forceFresh: !state.projection && state.events.length === 0, delay: 0 });
    } else {
      clearScheduledRefresh();
      state.loading = false;
      render();
    }
  }

  function toggleOpen() {
    setOpen(!isInspectorOpen());
  }

  function setActiveTab(tab, { persist = true } = {}) {
    const nextTab = normalizeInspectorTab(tab);
    state.activeTab = nextTab;
    if (persist) writeStoredTab(nextTab);
    render();
  }

  function openTab(tab, { toggle = false } = {}) {
    const nextTab = normalizeInspectorTab(tab);
    if (toggle && isInspectorOpen() && state.activeTab === nextTab) {
      setOpen(false);
      return;
    }
    state.activeTab = nextTab;
    writeStoredTab(nextTab);
    setOpen(true);
    render();
  }

  async function fetchAllSessionEvents(sessionId, { forceFresh = false } = {}) {
    if (!sessionId) return [];
    if (typeof isShareSnapshotReadOnlyMode === "function" && isShareSnapshotReadOnlyMode()) {
      return typeof getShareSnapshotDisplayEvents === "function"
        ? getShareSnapshotDisplayEvents()
        : [];
    }
    const events = [];
    let beforeSeq = 0;
    for (let pageIndex = 0; pageIndex < MAX_INSPECTOR_EVENT_PAGES; pageIndex += 1) {
      const query = new URLSearchParams({
        filter: "all",
        direction: beforeSeq > 0 ? "before" : "latest",
        limit: String(INSPECTOR_EVENT_PAGE_LIMIT),
      });
      if (beforeSeq > 0) query.set("beforeSeq", String(beforeSeq));
      const data = await fetchJsonOrRedirect(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
        forceFresh ? { revalidate: false, cache: "no-store" } : {},
      );
      const pageEvents = normalizeEvents(data?.events || []);
      events.unshift(...pageEvents);
      const pagination = data?.pagination || {};
      beforeSeq = Number.isInteger(pagination.oldestSeq) ? pagination.oldestSeq : 0;
      if (!pagination.hasMoreBefore || beforeSeq <= 1 || pageEvents.length === 0) break;
    }
    return events;
  }

  async function fetchSessionProjection(sessionId, { view = "audit", forceFresh = false } = {}) {
    if (!sessionId) return null;
    if (typeof isShareSnapshotReadOnlyMode === "function" && isShareSnapshotReadOnlyMode()) {
      const events = typeof getShareSnapshotDisplayEvents === "function"
        ? getShareSnapshotDisplayEvents()
        : [];
      const session = getCurrentSessionSafe() || { id: sessionId };
      return {
        session,
        projection: null,
        model: buildInspectorModel({ events, session }),
      };
    }
    const query = new URLSearchParams({ view });
    return fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}/projection?${query.toString()}`,
      forceFresh ? { revalidate: false, cache: "no-store" } : {},
    );
  }

  async function fetchSessionDetailForModel(sessionId, { forceFresh = false } = {}) {
    if (!sessionId) return null;
    if (typeof isShareSnapshotReadOnlyMode === "function" && isShareSnapshotReadOnlyMode()) {
      return null;
    }
    const data = await fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}?view=sidebar`,
      forceFresh ? { revalidate: false, cache: "no-store" } : {},
    );
    return data?.session || null;
  }

  function scheduleRefresh(sessionId, { forceFresh = false, delay = 160 } = {}) {
    const liveSessionId = typeof currentSessionId !== "undefined" ? currentSessionId : "";
    if (!sessionId) sessionId = liveSessionId;
    const targetSessionId = sessionId || state.sessionId || "";
    if (!targetSessionId) {
      state.sessionId = "";
      state.session = null;
      state.events = [];
      state.projection = null;
      render();
      return;
    }
    state.sessionId = targetSessionId;
    if (!state.session || state.session.id !== targetSessionId) {
      state.session = getCurrentSessionSafe();
    }
    if (!isInspectorOpen()) {
      clearScheduledRefresh();
      state.loading = false;
      render();
      return;
    }
    state.loading = true;
    state.error = "";
    render();
    if (state.fetchTimer) clearTimeout(state.fetchTimer);
    state.fetchTimer = setTimeout(() => {
      state.fetchTimer = null;
      const requestSeq = state.requestSeq + 1;
      state.requestSeq = requestSeq;
      fetchSessionProjection(targetSessionId, { view: "audit", forceFresh })
        .then((payload) => {
          if (state.requestSeq !== requestSeq || state.sessionId !== targetSessionId) return;
          state.projection = payload || null;
          state.session = payload?.session || state.session || { id: targetSessionId };
          state.events = [];
          state.loading = false;
          state.error = "";
          render();
        })
        .catch((error) => {
          if (state.requestSeq !== requestSeq || state.sessionId !== targetSessionId) return;
          state.loading = false;
          state.error = error?.message || "failed";
          render();
        });
    }, delay);
  }

  function applyEventDelta(sessionId, events) {
    if (!sessionId || sessionId !== state.sessionId) return;
    state.events = mergeEvents(state.events, events);
    if (isInspectorOpen()) {
      scheduleRefresh(sessionId, { forceFresh: true, delay: 0 });
      return;
    }
    state.loading = false;
    render();
  }

  function syncSession(session) {
    const nextSession = session || getCurrentSessionSafe();
    state.session = nextSession || null;
    const liveSessionId = typeof currentSessionId !== "undefined" ? currentSessionId : "";
    const previousSessionId = state.sessionId;
    state.sessionId = nextSession?.id || liveSessionId || "";
    if (!state.sessionId) {
      state.events = [];
      state.projection = null;
      render();
      return;
    }
    if (previousSessionId && previousSessionId !== state.sessionId) {
      state.events = [];
      state.projection = null;
    }
    if (!hasStoredOpenPreference() && root.matchMedia?.(DESKTOP_QUERY)?.matches === true) {
      setOpen(true, { persist: false });
    }
    render();
    if (isInspectorOpen()) {
      scheduleRefresh(state.sessionId);
    }
  }

  function init() {
    dom.button = document.getElementById("workbenchInspectorBtn");
    dom.backButton = document.getElementById("workbenchInspectorBackBtn");
    dom.closeButton = document.getElementById("workbenchInspectorCloseBtn");
    dom.panel = document.getElementById("workbenchInspector");
    dom.body = document.getElementById("workbenchInspectorBody");
    dom.tabs = Array.from(document.querySelectorAll("[data-inspector-tab]"));
    if (!dom.panel || !dom.body) return;

    setOpen(readStoredOpen(), { persist: false });
    dom.button?.addEventListener("click", () => openTab("outcome", { toggle: true }));
    dom.backButton?.addEventListener("click", () => setOpen(false));
    dom.closeButton?.addEventListener("click", () => setOpen(false));
    dom.body.addEventListener("click", handleMarkdownArtifactClick);
    dom.body.addEventListener("click", handlePlanArtifactActionClick);
    dom.body.addEventListener("click", handleSessionReferenceClick);
    for (const tab of dom.tabs) {
      tab.addEventListener("click", () => {
        const nextTab = normalizeInspectorTab(tab.dataset.inspectorTab);
        setActiveTab(nextTab);
      });
    }
    root.matchMedia?.(DESKTOP_QUERY)?.addEventListener?.("change", () => {
      if (!localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY)) {
        setOpen(readStoredOpen(), { persist: false });
      }
    });
    syncSession(getCurrentSessionSafe());
    render();
  }

  root.syncWorkbenchInspectorSession = syncSession;
  root.scheduleWorkbenchInspectorRefresh = scheduleRefresh;
  root.applyWorkbenchInspectorEventDelta = applyEventDelta;
  root.ragentOpenWorkbenchInspectorTab = openTab;

  // Public surface for the mobile Run Sheet: it mirrors the same session model
  // and renderers so the sheet stays byte-for-byte consistent with the audit
  // panel, without duplicating the event-normalization pipeline.
  const TAB_RENDERERS = {
    outcome: renderOutcome,
    changes: renderChanges,
    activity: renderActivityTab,
  };

  root.RagentWorkbench = {
    normalizeTab: normalizeInspectorTab,
    // True once a session is attached (mirrors the inspector's own gating).
    hasSession() {
      return !!state.sessionId || (typeof currentSessionId !== "undefined" && !!currentSessionId);
    },
    // Return the raw projected model so external mobile surfaces (the Run Sheet)
    // can render their OWN layout from the same data, instead of reusing the
    // desktop audit tabs. `state` mirrors the inspector's own gating so consumers
    // can show matching loading/empty/error affordances.
    getModel() {
      if (!state.sessionId) return { state: "empty", model: null };
      const hasCachedModel = !!state.projection || state.events.length > 0;
      if (state.loading && !hasCachedModel) return { state: "loading", model: null };
      if (state.error && !hasCachedModel) return { state: "error", model: null };
      return { state: "content", model: currentInspectorModel() };
    },
    async getModelForSession(session, { forceFresh = false } = {}) {
      const targetSessionId = typeof session === "string"
        ? session.trim()
        : String(session?.id || "").trim();
      if (!targetSessionId) return { state: "empty", model: null };
      if (!forceFresh && targetSessionId === state.sessionId && state.projection) {
        return { state: "content", model: buildInspectorModelFromProjection(state.projection, state.session) };
      }
      if (!forceFresh && targetSessionId === state.sessionId && state.events.length > 0) {
        return { state: "content", model: buildInspectorModel() };
      }
      const fallbackSession = typeof session === "object" && session
        ? session
        : (typeof getChatStoreSession === "function"
          ? getChatStoreSession(targetSessionId)
          : null);
      const payload = await fetchSessionProjection(targetSessionId, { view: "run-sheet", forceFresh });
      const targetSession = payload?.session || fallbackSession || { id: targetSessionId };
      return {
        state: "content",
        model: buildInspectorModelFromProjection(payload, targetSession),
      };
    },
    // Render one tab's HTML for the current session into `container`, matching
    // the inspector's own loading/empty/error handling. Returns the state key.
    renderTabInto(container, tab) {
      if (!container) return "empty";
      const activeTab = normalizeInspectorTab(tab);
      if (!state.sessionId) {
        container.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.empty"))}</div>`;
        return "empty";
      }
      const hasCachedModel = !!state.projection || state.events.length > 0;
      if (state.loading && !hasCachedModel) {
        container.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.loading"))}</div>`;
        return "loading";
      }
      if (state.error && !hasCachedModel) {
        container.innerHTML = `<div class="workbench-empty">${escapeHtml(tr("workbench.error"))}</div>`;
        return "error";
      }
      const model = currentInspectorModel();
      container.innerHTML = (TAB_RENDERERS[activeTab] || renderOutcome)(model);
      root.RagentIcons?.hydrate?.(container);
      return "content";
    },
    // Wire the same content interactions (markdown reader, plan actions, session
    // refs) onto an external container.
    bindContentHandlers(container) {
      if (!container || container.dataset.workbenchHandlersBound === "true") return;
      container.dataset.workbenchHandlersBound = "true";
      container.addEventListener("click", handleMarkdownArtifactClick);
      container.addEventListener("click", handlePlanArtifactActionClick);
      container.addEventListener("click", (event) => handleSessionReferenceClick(event, container));
    },
    openMarkdownReader,
    // Notify on every inspector render tick so the sheet can re-render live.
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      renderSubscribers.add(fn);
      return () => renderSubscribers.delete(fn);
    },
    // Ask the inspector to (re)fetch events for the live session.
    refresh() {
      const sessionId = state.sessionId
        || (typeof currentSessionId !== "undefined" ? currentSessionId : "");
      if (sessionId) scheduleRefresh(sessionId, { delay: 0 });
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window);

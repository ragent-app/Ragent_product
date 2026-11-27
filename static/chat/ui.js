function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

function resolveUiProductPath(path) {
  if (typeof window.ragentResolveProductPath === "function") {
    return window.ragentResolveProductPath(path);
  }
  return typeof path === "string" ? path : String(path || "");
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

function formatFileChangeTypeLabel(kind) {
  switch (normalizeFileChangeType(kind)) {
    case "add":
      return t("ui.fileChange.add");
    case "edit":
      return t("ui.fileChange.edit");
    case "update":
      return t("ui.fileChange.update");
    case "updated":
      return t("ui.fileChange.updated");
    case "delete":
      return t("ui.fileChange.delete");
    default:
      return kind;
  }
}

function renderUiIcon(name, className = "") {
  return window.RagentIcons?.render(name, { className }) || "";
}

const RAGENT_UI_MAX_DIFF_CELLS = 1_000_000;

const replySelfCheckDrawerByContainer = new WeakMap();

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
  return isProviderUsageLimitStatusText(event.content);
}

function isCodexAppServerLifecycleStatusText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^(?:idle|active|inProgress|in_progress|thinking|completed)$/i.test(text)
    || /^Thread (?:ready|started) \([^)]+\)$/i.test(text)
    || /^MCP(?:\s+[^\s:]+)?\s+(?:starting|ready|started|connected|connecting|initializing|initialized|stopped|disabled|failed|error)$/i.test(text)
    || /^MCP inventory \d+ servers?\s+·\s+\d+ tools?$/i.test(text)
    || /^mode:\s*\S+/i.test(text)
    || /^Goal(?: cleared|:)/i.test(text);
}

function isCodexAppServerLifecycleStatusEvent(event) {
  if (event?.type !== "status") return false;
  if (String(event?.codexMcpStatus || "").trim().toLowerCase() === "inventory") return true;
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

function isCodexAppServerTerminalLifecycleStatusEvent(event) {
  if (!isCodexAppServerLifecycleStatusEvent(event)) return false;
  const text = typeof event.content === "string"
    ? event.content
    : (typeof event.message === "string" ? event.message : "");
  return /^(?:completed|idle)$/i.test(String(text || "").trim());
}

function renderMarkdownFragmentIntoNode(node, visibleSource, { deferEnhance = false, preserveLineBreaks = true } = {}) {
  const plainText = typeof hasMarkdownSignificantSyntax === "function"
    && !hasMarkdownSignificantSyntax(visibleSource);
  if (plainText) {
    try {
      return renderPlainTextFastPath(node, visibleSource, { preserveLineBreaks });
    } catch { /* fall through to the standard renderer */ }
  }
  const math = typeof prepareMarkdownMath === "function"
    ? prepareMarkdownMath(visibleSource)
    : { markdown: visibleSource, tokens: [] };
  const rendered = marked.parse(math.markdown, { gfm: true, breaks: true });
  if (rendered.trim()) {
    node.innerHTML = rendered;
    if (!deferEnhance) {
      enhanceCodeBlocks(node);
      window.RagentMarkdownEnhancements?.enhanceCodeBlocks?.(node);
      enhanceTables(node);
      enhanceRenderedContentLinks(node);
    }
    if (typeof renderMarkdownMathInNode === "function") {
      renderMarkdownMathInNode(node, math.tokens);
    }
    return true;
  }
  node.textContent = visibleSource;
  return !!visibleSource.trim();
}

// Streaming fast path: plain prose (the common streaming case) renders as
// text nodes instead of a full marked.parse + innerHTML rebuild every frame.
// Paragraphs are kept as <p> so spacing matches the markdown renderer.
function renderPlainTextFastPath(node, visibleSource, { preserveLineBreaks = true } = {}) {
  const text = String(visibleSource || "");
  if (!text.trim()) {
    node.textContent = text;
    return !!text.trim();
  }
  if (!text.includes("\n\n")) {
    if (preserveLineBreaks && text.includes("\n")) {
      const p = document.createElement("p");
      p.className = "composer-md-plain-text";
      p.textContent = text;
      node.replaceChildren(p);
      return true;
    }
    node.textContent = text;
    return true;
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    node.textContent = "";
    for (const paragraph of text.split(/\n{2,}/)) {
      const p = document.createElement("p");
      if (preserveLineBreaks) p.className = "composer-md-plain-text";
      p.textContent = paragraph;
      node.appendChild(p);
    }
    return true;
  }
  node.textContent = text;
  return true;
}

function getPlanProposalTitle(markdown) {
  const match = String(markdown || "").match(/^\s{0,3}#\s+(.+)$/m);
  return match ? match[1].replace(/[#*_`]+/g, "").trim() : "";
}

function stripPlanProposalTitleHeading(markdown) {
  const source = String(markdown || "");
  const lines = source.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^\s{0,3}#\s+/.test(line));
  if (headingIndex < 0) return source.trim();
  return [
    ...lines.slice(0, headingIndex),
    ...lines.slice(headingIndex + 1),
  ].join("\n").trim();
}

async function copyPlanProposalText(planText, button) {
  try {
    if (typeof copyText === "function") {
      await copyText(planText);
    } else if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(planText);
    } else {
      throw new Error("Clipboard unavailable");
    }
    if (button) {
      const previous = button.textContent;
      button.textContent = t("action.copied");
      window.setTimeout(() => {
        button.textContent = previous || t("plan.action.copy");
      }, 1400);
    }
  } catch {
    if (button) button.textContent = t("action.copyFailed");
  }
}

function setPendingComposerPlanAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  globalThis.__ragentPendingComposerPlanAction = ["revise", "execute"].includes(normalized) ? normalized : "";
}

function consumePendingComposerPlanAction() {
  const action = globalThis.__ragentPendingComposerPlanAction || "";
  globalThis.__ragentPendingComposerPlanAction = "";
  return action;
}

function insertPlanPromptIntoComposer(prompt, { send = false, interactionMode = "", planAction = "", planId = "" } = {}) {
  if (typeof msgInput === "undefined" || !msgInput) return false;
  setPendingComposerPlanAction(planAction);
  setPendingComposerPlanId(planId);
  if (interactionMode && typeof setComposerInteractionMode === "function") {
    setComposerInteractionMode(interactionMode);
  }
  msgInput.value = prompt;
  msgInput.dispatchEvent(new Event("input", { bubbles: true }));
  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: true });
  } else if (typeof msgInput.focus === "function") {
    msgInput.focus();
  }
  if (send && typeof sendMessage === "function") {
    sendMessage();
  }
  return true;
}

function createPlanProposalAction(labelKey, handler, planAction = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plan-card__action";
  button.textContent = t(labelKey);
  const normalizedPlanAction = String(planAction || "").trim().toLowerCase();
  if (normalizedPlanAction) button.dataset.planAction = normalizedPlanAction;
  button.addEventListener("click", handler);
  return button;
}

function createPlanCopyButton(planText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plan-card__copy";
  button.setAttribute("aria-label", t("plan.action.copy"));
  button.innerHTML = typeof renderUiIcon === "function" ? renderUiIcon("copy") : "⧉";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void copyPlanProposalText(planText, button);
  });
  return button;
}

function setPendingComposerPlanId(planId) {
  const normalized = String(planId || "").trim();
  globalThis.__ragentPendingComposerPlanId = normalized;
}

function consumePendingComposerPlanId() {
  const planId = globalThis.__ragentPendingComposerPlanId || "";
  globalThis.__ragentPendingComposerPlanId = "";
  return planId;
}

async function submitPlanArtifactAction(action, planId, { text = "", button = null } = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedPlanId = String(planId || "").trim();
  const sessionId = typeof currentSessionId === "string" ? currentSessionId : "";
  if (!["revise", "execute"].includes(normalizedAction)) return false;
  if (!normalizedPlanId || !sessionId || typeof dispatchAction !== "function") return false;

  const previousText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = normalizedAction === "execute" ? t("plan.action.executing") : t("plan.action.revising");
  }
  try {
    const ok = await dispatchAction({
      action: "plan_action",
      sessionId,
      planId: normalizedPlanId,
      planAction: normalizedAction,
      text,
    });
    if (ok) {
      if (normalizedAction === "execute" && typeof setComposerInteractionMode === "function") {
        setComposerInteractionMode("agent");
      }
      return true;
    }
  } catch (error) {
    console.error("Plan action failed:", error?.message || error);
  }
  if (button) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = previousText || t(`plan.action.${normalizedAction}`);
  }
  return false;
}

function renderPlanProposalCard(planText) {
  const normalizedPlanText = String(planText || "").trim();
  const title = getPlanProposalTitle(normalizedPlanText) || t("plan.card.untitled");
  const bodySource = stripPlanProposalTitleHeading(normalizedPlanText);

  const card = document.createElement("section");
  card.className = "plan-card";

  const header = document.createElement("div");
  header.className = "plan-card__header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "plan-card__title-block";

  const label = document.createElement("div");
  label.className = "plan-card__label";
  label.textContent = t("plan.card.label");
  titleBlock.appendChild(label);

  const heading = document.createElement("div");
  heading.className = "plan-card__title";
  heading.textContent = title;
  titleBlock.appendChild(heading);
  header.appendChild(titleBlock);
  card.appendChild(header);
  card.appendChild(createPlanCopyButton(normalizedPlanText));

  const body = document.createElement("div");
  body.className = "plan-card__body md-content";
  renderMarkdownFragmentIntoNode(body, bodySource || normalizedPlanText);
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "plan-card__actions";
  actions.appendChild(createPlanProposalAction("plan.action.copy", (event) => {
    void copyPlanProposalText(normalizedPlanText, event.currentTarget);
  }, "copy"));
  actions.appendChild(createPlanProposalAction("plan.action.revise", () => {
    insertPlanPromptIntoComposer(`${t("plan.action.revisePrompt")}\n\n${normalizedPlanText}`, {
      interactionMode: "plan",
      planAction: "revise",
    });
  }, "revise"));
  actions.appendChild(createPlanProposalAction("plan.action.execute", () => {
    insertPlanPromptIntoComposer(`${t("plan.action.executePrompt")}\n\n${normalizedPlanText}`, {
      send: true,
      interactionMode: "agent",
      planAction: "execute",
    });
  }, "execute"));
  card.appendChild(actions);

  return card;
}

function normalizePlanItemStatus(value) {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["in_progress", "active", "current", "running", "started"].includes(status)) return "in_progress";
  return "pending";
}

function normalizePlanEventItems(evt) {
  const sourceItems = Array.isArray(evt?.items)
    ? evt.items
    : (Array.isArray(evt?.plan) ? evt.plan : []);
  return sourceItems
    .map((item) => (item && typeof item === "object" ? item : { text: item }))
    .map((item) => ({
      text: String(item.text || item.step || item.title || "").trim(),
      status: normalizePlanItemStatus(item.status || item.state || (item.completed === true ? "completed" : "pending")),
    }))
    .filter((item) => item.text);
}

function getPlanEventState(evt, items) {
  const state = String(evt?.status || evt?.state || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["drafting", "running", "in_progress", "started"].includes(state)) return "drafting";
  if (["awaiting_decision", "ready"].includes(state)) return "awaiting_decision";
  if (["completed", "complete", "done"].includes(state)) return "completed";
  if (["revising", "approved", "executing", "superseded", "failed", "cancelled"].includes(state)) return state;
  if (items.length > 0 && items.every((item) => item.status === "completed")) return "awaiting_decision";
  return "drafting";
}

function getPlanEventTitle(evt) {
  const title = String(evt?.title || "").trim();
  return title || getPlanProposalTitle(evt?.bodyMarkdown || "") || t("plan.card.codexTitle");
}

function getPlanEventSummary(items, state) {
  if (items.length === 0) return t(`plan.status.${state}`);
  const completed = items.filter((item) => item.status === "completed").length;
  return t("plan.card.summary", {
    completed,
    total: items.length,
    status: t(`plan.status.${state}`),
  });
}

function getPlanEventId(evt) {
  return String(evt?.planId || evt?.artifactId || "").trim();
}

function isPlanProgressEvent(evt) {
  const planIntent = String(evt?.planIntent || "").trim().toLowerCase();
  if (planIntent) return planIntent === "progress";
  return String(evt?.interactionMode || "").trim().toLowerCase() === "agent";
}

function isPlanActionStateUpdate(evt) {
  return String(evt?.source || "").trim() === "ragent-plan-action"
    && !isPlanProgressEvent(evt);
}

function getPlanProgressSummary(items) {
  if (items.length === 0) return t("plan.progress.empty");
  const completed = items.filter((item) => item.status === "completed").length;
  const current = items.find((item) => item.status === "in_progress")
    || items.find((item) => item.status === "pending")
    || items[items.length - 1];
  if (completed === items.length) {
    return t("plan.progress.complete", { completed, total: items.length });
  }
  return t("plan.progress.summary", {
    completed,
    total: items.length,
    current: current?.text || t("plan.progress.empty"),
  });
}

function formatPlanEventText(evt, items = normalizePlanEventItems(evt)) {
  const bodyMarkdown = String(evt?.bodyMarkdown || "").trim();
  if (bodyMarkdown) return bodyMarkdown;
  const title = getPlanEventTitle(evt);
  const lines = items.map((item) => {
    const marker = item.status === "completed" ? "[x]" : "[ ]";
    return `${marker} ${item.text}`;
  });
  return [title, "", ...lines].join("\n").trim();
}

function createPlanEventItemNode(item) {
  const row = document.createElement("li");
  row.className = `codex-plan-card__item codex-plan-card__item--${item.status}`;

  const marker = document.createElement("span");
  marker.className = "codex-plan-card__marker";
  marker.setAttribute("aria-hidden", "true");
  row.appendChild(marker);

  const text = document.createElement("span");
  text.className = "codex-plan-card__item-text";
  text.textContent = item.text;
  row.appendChild(text);

  return row;
}

function isPlanEventActionDisabled(evt, state, action) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  // 'cancelled' plans stay actionable from the card: execute/revise dispatch a
  // NEW run (plan_action) — they never touch the dead run the plan belonged to.
  if (normalizedAction === "revise") {
    return ["drafting", "revising", "executing", "superseded"].includes(state);
  }
  if (normalizedAction === "execute") {
    if (["drafting", "revising", "executing", "superseded", "failed"].includes(state)) return true;
    return state === "completed" && String(evt?.lastPlanAction || "").trim().toLowerCase() === "execute";
  }
  return false;
}

function createCodexPlanCard(evt, { collapsed } = {}) {
  const items = normalizePlanEventItems(evt);
  const state = getPlanEventState(evt, items);
  const planText = formatPlanEventText(evt, items);
  const planId = getPlanEventId(evt);
  const revision = Number.isInteger(evt?.revision) && evt.revision > 1 ? evt.revision : 0;
  const isProgress = isPlanProgressEvent(evt);
  const isCollapsed = typeof collapsed === "boolean" ? collapsed : isProgress;

  const card = document.createElement("section");
  card.className = `${isProgress ? "codex-plan-progress" : "plan-card codex-plan-card"}${isCollapsed ? " collapsed" : ""}`;
  card.dataset.state = state;
  if (planId) card.dataset.planId = planId;
  if (evt?.runId) card.dataset.runId = String(evt.runId);

  const header = document.createElement("button");
  header.type = "button";
  header.className = "plan-card__header codex-plan-card__header";
  header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");

  const titleBlock = document.createElement("div");
  titleBlock.className = `plan-card__title-block${isProgress ? " codex-plan-progress__line" : ""}`;

  if (isProgress) {
    const heading = document.createElement("div");
    heading.className = "plan-card__title";
    heading.textContent = t("plan.progress.label");
    titleBlock.appendChild(heading);

    const summary = document.createElement("div");
    summary.className = "codex-plan-card__summary";
    summary.textContent = getPlanProgressSummary(items);
    titleBlock.appendChild(summary);
  } else {
    // The kind label ("方案"/"Plan") is the headline; the generic Codex title
    // only echoed it. Keep the progress count glanceable, but drop the bare
    // status word (e.g. "ready") until the plan actually has steps.
    const label = document.createElement("div");
    label.className = "plan-card__label";
    label.textContent = revision ? `${t("plan.card.label")} v${revision}` : t("plan.card.label");
    titleBlock.appendChild(label);

    if (items.length > 0) {
      const summary = document.createElement("div");
      summary.className = "codex-plan-card__summary";
      summary.textContent = getPlanEventSummary(items, state);
      titleBlock.appendChild(summary);
    }
  }
  header.appendChild(titleBlock);

  const chevron = document.createElement("span");
  chevron.className = "codex-plan-card__chevron";
  chevron.innerHTML = renderUiIcon("chevron-down");
  header.appendChild(chevron);
  card.appendChild(header);
  if (!isProgress) card.appendChild(createPlanCopyButton(planText));

  const body = document.createElement("div");
  body.className = "plan-card__body codex-plan-card__body";
  body.hidden = isCollapsed;
  if (items.length > 0) {
    const list = document.createElement("ol");
    list.className = "codex-plan-card__list";
    for (const item of items) {
      list.appendChild(createPlanEventItemNode(item));
    }
    body.appendChild(list);
  } else if (String(evt?.bodyMarkdown || "").trim()) {
    body.classList.add("md-content");
    renderMarkdownFragmentIntoNode(body, String(evt.bodyMarkdown || "").trim());
  } else {
    const empty = document.createElement("div");
    empty.className = "codex-plan-card__empty";
    empty.textContent = t("plan.card.empty");
    body.appendChild(empty);
  }
  card.appendChild(body);

  header.addEventListener("click", () => {
    const nextCollapsed = !card.classList.contains("collapsed");
    card.classList.toggle("collapsed", nextCollapsed);
    body.hidden = nextCollapsed;
    header.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
  });

  if (!isProgress) {
    const actions = document.createElement("div");
    actions.className = "plan-card__actions";
    actions.appendChild(createPlanProposalAction("plan.action.copy", (event) => {
      void copyPlanProposalText(planText, event.currentTarget);
    }, "copy"));
    const reviseAction = createPlanProposalAction("plan.action.revise", () => {
      insertPlanPromptIntoComposer(planId ? t("plan.action.revisePrompt") : `${t("plan.action.revisePrompt")}\n\n${planText}`, {
        interactionMode: "plan",
        planAction: "revise",
        planId,
      });
    }, "revise");
    reviseAction.disabled = isPlanEventActionDisabled(evt, state, "revise");
    actions.appendChild(reviseAction);
    const executeAction = createPlanProposalAction("plan.action.execute", async (event) => {
      if (planId && await submitPlanArtifactAction("execute", planId, { button: event.currentTarget })) {
        // The proposal is on its way to execution — close the sheet if this
        // plan was its pending prompt (id-guarded, so unrelated sheets stay).
        window.RagentDecisions?.acknowledgeResponse?.({ approvalId: planApprovalIdFromPlan(planId), sessionId: currentSessionId }, {
          approvalId: planApprovalIdFromPlan(planId),
          sessionId: currentSessionId,
        });
        return;
      }
      insertPlanPromptIntoComposer(`${t("plan.action.executePrompt")}\n\n${planText}`, {
        send: true,
        interactionMode: "agent",
        planAction: "execute",
        planId,
      });
    }, "execute");
    executeAction.disabled = isPlanEventActionDisabled(evt, state, "execute");
    actions.appendChild(executeAction);
    card.appendChild(actions);
  }

  return card;
}

function findRenderedPlanCard(container, evt) {
  if (!container || !evt?.planId || typeof container.querySelectorAll !== "function") return null;
  const planId = String(evt.planId);
  const eventRunId = String(evt?.runId || "").trim();
  const isProgressUpdate = isPlanProgressEvent(evt);
  for (const node of container.querySelectorAll(".codex-plan-card[data-plan-id]")) {
    if (node?.dataset?.planId !== planId) continue;
    if (!isProgressUpdate) return node;
    const nodeRunId = String(node?.dataset?.runId || "").trim();
    if ((eventRunId || nodeRunId) && eventRunId !== nodeRunId) continue;
    return node;
  }
  return null;
}

function renderPlanApprovalCard(evt, { livePrompt = false } = {}) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  renderPlanApprovalCardInto(messagesInner, evt, { livePrompt });
}

function updatePlanApprovalCardOnResponse(evt) {
  updatePlanApprovalCardOnResponseInto(messagesInner, evt);
}

// In-stream plan card for Claude Code plan-kind approvals (ExitPlanMode),
// mirroring the codex proposal card so the plan stays visible in the
// conversation after the sheet closes. Approve/deny actions are only enabled
// for the live pending approval (the sheet gate); history replays render the
// card inert and approval_response flips it to its final state.
function renderPlanApprovalCardInto(container, evt, { livePrompt = false } = {}) {
  if (!container) return null;
  const approvalId = getApprovalEventId(evt);
  if (!approvalId) return null;
  const cardKey = `approval:${approvalId}`;
  const existing = typeof container.querySelector === "function"
    ? container.querySelector(`.plan-approval-card[data-plan-id="${cardKey}"]`)
    : null;
  if (existing?.parentNode) existing.remove();

  const card = document.createElement("section");
  card.className = "plan-card codex-plan-card plan-approval-card";
  card.dataset.planId = cardKey;
  card.dataset.state = "pending";
  if (evt?.runId) card.dataset.runId = String(evt.runId);

  const header = document.createElement("div");
  header.className = "plan-card__header";
  const titleBlock = document.createElement("div");
  titleBlock.className = "plan-card__title-block";
  const label = document.createElement("div");
  label.className = "plan-card__label";
  label.textContent = t("plan.card.label");
  titleBlock.appendChild(label);
  const heading = document.createElement("div");
  heading.className = "plan-card__title";
  heading.textContent = getApprovalTitle(evt);
  titleBlock.appendChild(heading);
  header.appendChild(titleBlock);
  card.appendChild(header);
  card.appendChild(createPlanCopyButton(reason));

  const body = document.createElement("div");
  body.className = "plan-card__body md-content";
  const reason = String(evt?.reason || "").trim();
  if (reason) {
    renderMarkdownFragmentIntoNode(body, reason);
  } else {
    const empty = document.createElement("div");
    empty.className = "codex-plan-card__empty";
    empty.textContent = t("plan.card.empty");
    body.appendChild(empty);
  }
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "plan-card__actions";
  actions.appendChild(createPlanApprovalActionButton(evt, "approve", livePrompt));
  actions.appendChild(createPlanApprovalModifyButton(evt, livePrompt, card));
  actions.appendChild(createPlanApprovalActionButton(evt, "deny", livePrompt));
  card.appendChild(actions);
  container.appendChild(card);
  return card;
}

function createPlanApprovalActionButton(evt, decision, livePrompt) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plan-card__action";
  button.dataset.approvalDecision = decision;
  button.textContent = String(evt?.kind || "").toLowerCase() === "plan" && decision === "approve"
    ? t("plan.action.execute")
    : t(`approval.action.${decision}`);
  button.disabled = !livePrompt;
  button.addEventListener("click", () => {
    void submitRuntimeApprovalDecision(evt, decision, button);
  });
  return button;
}

function createPlanApprovalModifyButton(evt, livePrompt, card) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plan-card__action";
  button.dataset.planAction = "revise";
  button.textContent = t("plan.action.revise");
  button.disabled = !livePrompt;
  button.addEventListener("click", () => {
    if (!livePrompt) return;
    let editor = card?.querySelector?.(".plan-card__modifier");
    if (!editor) {
      editor = document.createElement("div");
      editor.className = "decision-sheet__plan-editor plan-card__modifier";
      const row = document.createElement("div");
      row.className = "decision-sheet__plan-editor-row";
      const input = document.createElement("textarea");
      input.className = "decision-sheet__plan-editor-input";
      input.rows = 1;
      input.maxLength = 8000;
      input.placeholder = t("plan.action.modifyPlaceholder");
      input.setAttribute("aria-label", t("plan.action.modifyPlaceholder"));
      input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = `${Math.min(220, Math.max(52, input.scrollHeight))}px`;
        send.hidden = !input.value.trim();
        full.hidden = input.scrollHeight < 150;
      });
      row.appendChild(input);
      const full = document.createElement("button");
      full.type = "button";
      full.className = "decision-sheet__plan-editor-full";
      full.textContent = t("plan.action.fullscreen");
      full.hidden = true;
      full.addEventListener("click", () => {
        insertPlanPromptIntoComposer(input.value, { interactionMode: "plan", planAction: "revise" });
        window.RagentComposerFullscreen?.open?.();
      });
      row.appendChild(full);
      editor.appendChild(row);
      const send = document.createElement("button");
      send.type = "button";
      send.className = "decision-sheet__plan-editor-send";
      send.textContent = t("plan.action.sendRevision");
      send.hidden = true;
      send.addEventListener("click", async () => {
        const text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        const ok = await submitRuntimeApprovalDecision(evt, "deny", send);
        if (ok) insertPlanPromptIntoComposer(text, { send: true, interactionMode: "plan", planAction: "revise" });
        else send.disabled = false;
      });
      editor.appendChild(send);
      card.insertBefore(editor, card.querySelector(".plan-card__actions"));
    }
    editor.hidden = false;
    editor.querySelector("textarea")?.focus?.({ preventScroll: true });
  });
  return button;
}

// approval_response for a plan-kind request: flip the in-stream card to its
// final state (approved/denied), hide its actions, and pin a status label.
function updatePlanApprovalCardOnResponseInto(container, evt) {
  if (!container || typeof container.querySelector !== "function") return null;
  const approvalId = getApprovalEventId(evt);
  if (!approvalId) return null;
  const card = container.querySelector(`.plan-approval-card[data-plan-id="approval:${approvalId}"]`);
  if (!card) return null;
  const status = normalizeApprovalStatus(evt?.status);
  card.dataset.state = status;
  const actions = typeof card.querySelector === "function"
    ? card.querySelector(".plan-card__actions")
    : null;
  if (actions) actions.hidden = true;
  if (typeof card.querySelector === "function" && !card.querySelector(".plan-card__status")) {
    const statusNode = document.createElement("div");
    statusNode.className = "plan-card__status";
    statusNode.textContent = getApprovalStatusLabel(evt);
    card.appendChild(statusNode);
  }
  return card;
}

function renderPlanEventInto(container, evt) {
  if (!container) return null;
  const existing = findRenderedPlanCard(container, evt);
  if (!existing && isPlanActionStateUpdate(evt)) return null;
  const card = createCodexPlanCard(evt, existing
    ? { collapsed: existing.classList?.contains("collapsed") === true }
    : {});
  if (existing?.parentNode) {
    existing.parentNode.replaceChild(card, existing);
  } else {
    container.appendChild(card);
  }
  movePlanProgressCardToEnd(container, evt?.runId);
  return card;
}

function movePlanProgressCardToEnd(container, runId) {
  if (!container || typeof container.querySelectorAll !== "function") return null;
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) return null;
  let target = null;
  for (const node of container.querySelectorAll(".codex-plan-progress[data-run-id]")) {
    if (node?.parentNode === container && node?.dataset?.runId === normalizedRunId) {
      target = node;
    }
  }
  return target;
}

function getApprovalEventId(evt) {
  return String(evt?.approvalId || "").trim();
}

// Sheet identity for a plan artifact ("plan:<planId>"). Must match
// planApprovalIdForPlanEvent in realtime-render.js — the store keys pending
// proposals on this id so the sheet and the in-stream card agree.
function planApprovalIdFromPlan(planId) {
  const normalized = String(planId || "").trim();
  return normalized ? `plan:${normalized}` : "";
}

function isSessionConfirmationApproval(evt) {
  return String(evt?.source || "").trim() === "ragent-confirmation"
    || String(evt?.kind || "").trim().toLowerCase() === "confirmation";
}

function getApprovalKindLabel(evt) {
  const kind = String(evt?.kind || "").trim().toLowerCase();
  if (kind === "command") return t("approval.kind.command");
  if (kind === "file_change") return t("approval.kind.fileChange");
  if (kind === "permissions") return t("approval.kind.permissions");
  if (kind === "plan") return t("approval.kind.plan");
  if (kind === "confirmation") return t("approval.kind.confirmation");
  if (kind === "question") return t("approval.kind.question");
  return t("approval.kind.generic");
}

function getApprovalTitle(evt) {
  const kind = String(evt?.kind || "").trim().toLowerCase();
  const question = Array.isArray(evt?.questions) ? evt.questions[0] : evt;
  const humanText = kind === "question"
    ? question?.question || question?.prompt || evt?.question
    : evt?.summary || evt?.reason || evt?.bodyMarkdown || evt?.description;
  const human = String(humanText || "").trim().replace(/\s+/g, " ");
  const genericHuman = /run a shell command|execute a command|request permission|approval required|approval needed/i.test(human);
  if (human && !genericHuman) return human.length <= 88 ? human : `${human.slice(0, 87).trimEnd()}…`;
  const title = String(evt?.title || "").trim();
  if (title && !/run a shell command|execute a command|request permission|approval required|approval needed/i.test(title)) {
    return title;
  }
  // Keep the fallback state-first and type-free. The command, path and
  // permission scope are available only after the user asks for details.
  return t("attention.approval.title");
}

function normalizeApprovalStatus(value) {
  const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["approved", "approve", "accepted", "allowed"].includes(status)) return "approved";
  if (["denied", "deny", "declined", "rejected"].includes(status)) return "denied";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["resolved", "ended", "expired", "stale", "gone"].includes(status)) return "resolved";
  if (["submitting", "pending_submission"].includes(status)) return "submitting";
  return "pending";
}

function getApprovalStatusLabel(evt) {
  const status = normalizeApprovalStatus(evt?.status);
  if (status === "approved") return t("approval.status.approved");
  if (status === "denied") return t("approval.status.denied");
  if (status === "cancelled") return t("approval.status.cancelled");
  if (status === "resolved") return t("approval.status.resolved");
  if (status === "submitting") return t("approval.status.submitting");
  return t("approval.status.pending");
}

function createApprovalDetail(label, value, { code = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  const row = document.createElement("div");
  row.className = "runtime-approval-card__detail";
  const labelNode = document.createElement("div");
  labelNode.className = "runtime-approval-card__detail-label";
  labelNode.textContent = label;
  row.appendChild(labelNode);
  const valueNode = document.createElement(code ? "pre" : "div");
  valueNode.className = code
    ? "runtime-approval-card__code"
    : "runtime-approval-card__detail-value";
  valueNode.textContent = normalized;
  row.appendChild(valueNode);
  return row;
}

function describeApprovalPermissions(permissions) {
  if (!permissions || typeof permissions !== "object") return "";
  const parts = [];
  if (permissions.network && typeof permissions.network === "object") {
    if (permissions.network.enabled === true) parts.push(t("approval.permissions.network"));
  }
  const fileSystem = permissions.fileSystem && typeof permissions.fileSystem === "object"
    ? permissions.fileSystem
    : null;
  if (fileSystem) {
    const reads = Array.isArray(fileSystem.read) ? fileSystem.read.length : 0;
    const writes = Array.isArray(fileSystem.write) ? fileSystem.write.length : 0;
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries.length : 0;
    if (reads > 0) parts.push(t("approval.permissions.read", { count: reads }));
    if (writes > 0) parts.push(t("approval.permissions.write", { count: writes }));
    if (entries > 0) parts.push(t("approval.permissions.entries", { count: entries }));
  }
  if (parts.length > 0) return parts.join(" · ");
  // Unknown permission shapes (e.g. AskUserQuestion leaking { suggestions: [] }) should
  // render nothing rather than dumping raw JSON into the approval card.
  return "";
}

function createRuntimeApprovalSummary(evt) {
  const approvalId = getApprovalEventId(evt);
  const status = normalizeApprovalStatus(evt?.status);
  const title = String(evt?.title || getApprovalTitle(evt)).trim();
  const summary = document.createElement("div");
  summary.className = "runtime-approval-summary";
  summary.dataset.status = status;
  summary.dataset.approvalTitle = title;
  if (approvalId) summary.dataset.approvalId = approvalId;
  summary.setAttribute("role", "status");
  summary.textContent = status === "denied"
    ? t("approval.summary.denied", { title })
    : t("approval.summary.approved", { title });
  return summary;
}

async function submitRuntimeApprovalDecision(evt, decision, button, choices, customAnswer = "", extra = null) {
  const normalizeCustomAnswersList = (raw) => {
    if (Array.isArray(raw)) {
      return raw.map((v) => (typeof v === "string" ? v.trim().slice(0, 8000) : ""));
    }
    if (raw && typeof raw === "object") {
      const indices = Object.keys(raw).map((k) => Number(k)).filter((n) => Number.isInteger(n) && n >= 0);
      if (indices.length === 0) return [];
      const len = Math.max(...indices) + 1;
      const out = Array.from({ length: len }, () => "");
      for (const k of Object.keys(raw)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && idx >= 0 && typeof raw[k] === "string") {
          out[idx] = raw[k].trim().slice(0, 8000);
        }
      }
      return out;
    }
    return [];
  };
  const customAnswersList = normalizeCustomAnswersList(extra?.customAnswers);
  const hasMultiChoices = Array.isArray(extra?.multiChoices) && extra.multiChoices.length > 0;
  const hasPerQuestionAnswers = customAnswersList.some((v) => Boolean(v));
  const wireDecision = decision === "approve" && extra?.emptySkip !== true
    ? (hasMultiChoices
      ? "approve_with_multi_choices"
      : (hasPerQuestionAnswers ? "approve_with_answers" : decision))
    : decision;
  const approvalId = getApprovalEventId(evt);
  if (!approvalId || typeof dispatchAction !== "function") return false;
  const sessionId = String(currentSessionId || evt?.sessionId || "").trim();
  const runId = String(evt?.runId || "").trim();
  // In-stream approval card removed 2026-08-04 — the Decision Sheet owns its
  // own button state (disabled/aria-busy) and the auditable summary line
  // renders from the approval_response event, so there is no card DOM here.
  try {
    const ok = isSessionConfirmationApproval(evt)
      ? await dispatchAction({
          action: "session_confirmation",
          sessionId,
          approvalId,
          decision,
        })
      : await dispatchAction({
          action: "runtime_approval",
          sessionId,
          runId: String(evt?.runId || "").trim(),
          approvalId,
          decision: wireDecision,
          ...(Array.isArray(choices) && choices.length > 0 ? { choices } : {}),
          ...(hasMultiChoices
            ? { multiChoices: extra.multiChoices, customAnswers: customAnswersList }
            : (hasPerQuestionAnswers ? { customAnswers: customAnswersList } : {})),
          ...(typeof customAnswer === "string" && customAnswer.trim()
            ? { customAnswer: customAnswer.trim().slice(0, 8000) }
            : {}),
          ...(extra?.emptySkip === true ? { emptySkip: true } : {}),
          ...(extra?.answers && typeof extra.answers === "object" && !Array.isArray(extra.answers)
            ? { answers: extra.answers }
            : {}),
          ...(extra?.elicitationResponse && typeof extra.elicitationResponse === "object"
            ? { elicitationResponse: extra.elicitationResponse }
            : {}),
          ...(typeof extra?.decisionSource === "string" && extra.decisionSource.trim()
            ? { decisionSource: extra.decisionSource.trim() }
            : {}),
        });
    if (ok) {
      // A successful HTTP response means Ragent accepted the decision. The
      // provider may still need another turn to consume it, so do not keep the
      // interactive sheet blocked while waiting for the later durable
      // approval_response event. The store records a scoped tombstone to stop
      // a delayed replay from reopening this approval.
      globalThis.RagentDecisions?.acknowledgeResponse?.(evt, {
        sessionId,
        runId,
        approvalId,
        decision,
      });
      return true;
    }
  } catch (error) {
    console.error("Approval failed:", error?.message || error);
  }
  return false;
}

function readApprovalPromptText(source, keys = []) {
  if (!(source && typeof source === "object")) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeApprovalPromptOption(option) {
  if (typeof option === "string") {
    const label = option.trim();
    return label ? { label, value: label } : null;
  }
  if (!(option && typeof option === "object")) return null;
  const label = readApprovalPromptText(option, ["label", "title", "text", "name", "value", "id"]);
  if (!label) return null;
  const value = readApprovalPromptText(option, ["value", "id", "key"]) || label;
  const description = readApprovalPromptText(option, ["description", "detail", "note", "help"]);
  return {
    label,
    value,
    ...(description ? { description } : {}),
  };
}

function collectApprovalPromptOptions(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeApprovalPromptOption)
    .filter(Boolean);
}

function getApprovalPromptSections(evt) {
  const sections = [];
  const rootBlocking = evt?.isBlocking !== false;
  if (Array.isArray(evt?.questions)) {
    for (const entry of evt.questions) {
      const question = typeof entry === "string" ? { question: entry } : entry;
      if (!(question && typeof question === "object")) continue;
      const header = readApprovalPromptText(question, ["header", "title", "label"]);
      const id = readApprovalPromptText(question, ["id", "key", "name", "questionId"]);
      const text = readApprovalPromptText(question, ["question", "prompt", "text", "message"]);
      const options = collectApprovalPromptOptions(question.options || question.choices);
      const multiSelect = question.multiSelect === true || question.isMultiSelect === true;
      const isOther = typeof question.isOther === "boolean"
        ? question.isOther
        : (typeof evt?.isOther === "boolean" ? evt.isOther : undefined);
      const isSecret = question.isSecret === true || evt?.isSecret === true;
      const isBlocking = question.isBlocking === false ? false : rootBlocking;
      if (header || id || text || options.length > 0) {
        sections.push({ header, id, question: text, options, multiSelect, isOther, isSecret, isBlocking });
      }
    }
  }
  if (sections.length > 0) return sections;

  const question = readApprovalPromptText(evt, ["question", "prompt"]);
  const header = readApprovalPromptText(evt, ["header", "title"]);
  const id = readApprovalPromptText(evt, ["questionId", "id", "key"]);
  const options = collectApprovalPromptOptions(evt?.options || evt?.choices);
  const multiSelect = evt?.multiSelect === true || evt?.isMultiSelect === true;
  const isOther = typeof evt?.isOther === "boolean" ? evt.isOther : undefined;
  const isSecret = evt?.isSecret === true;
  if (question || header || options.length > 0) {
    sections.push({
      header,
      id,
      question,
      options,
      multiSelect,
      isOther,
      isSecret,
      isBlocking: rootBlocking,
    });
  }
  return sections;
}

function uiTranslate(key, vars, fallback = "") {
  if (typeof globalThis.t === "function") {
    const out = globalThis.t(key, vars);
    if (typeof out === "string" && out !== key) return out;
  }
  let text = fallback || key;
  if (vars && typeof vars === "object") {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v ?? ""));
    }
  }
  return text;
}

function parseQuestionReplyEnvelopeCompat(text) {
  if (typeof globalThis.parseQuestionReplyEnvelope === "function") {
    return globalThis.parseQuestionReplyEnvelope(text);
  }
  const source = typeof text === "string" ? text : "";
  const tagRe = /<send_user_message_question_reply\b[^>]*>([\s\S]*?)<\/send_user_message_question_reply>/gi;
  let matched = false;
  const replies = [];
  const answeredIds = [];
  const stripped = source.replace(tagRe, (_m, inner) => {
    matched = true;
    try {
      const parsed = JSON.parse(String(inner || "").trim());
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.replies) ? parsed.replies : [parsed]);
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const questionItemId = String(item.questionItemId ?? item.question_item_id ?? item.itemId ?? item.id ?? "").trim();
        const question = String(item.question ?? item.prompt ?? "").trim();
        const answer = String(item.answer ?? item.reply ?? "").trim();
        if (!questionItemId && !question && !answer) continue;
        replies.push({ questionItemId, question, answer });
        if (questionItemId && !answeredIds.includes(questionItemId)) answeredIds.push(questionItemId);
      }
    } catch {
      // ignore malformed JSON
    }
    return "\n";
  });
  if (!matched) {
    return { hasEnvelope: false, replies: [], answeredIds: [], trailingText: source, displayText: source };
  }
  const trailingText = stripped.replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
  const lines = replies.map((r) => (r.question && r.answer ? `${r.question}: ${r.answer}` : (r.answer || r.question))).filter(Boolean);
  const parts = [];
  if (lines.length) parts.push(lines.join("\n"));
  if (trailingText) parts.push(trailingText);
  return {
    hasEnvelope: true,
    replies,
    answeredIds,
    trailingText,
    displayText: parts.join("\n\n").trim(),
  };
}

function hasApprovalSecretQuestion(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (evt.isSecret === true) return true;
  if (Array.isArray(evt.questions)) {
    return evt.questions.some((q) => q && typeof q === "object" && q.isSecret === true);
  }
  return false;
}

function redactApprovalSecretValue(value) {
  const str = String(value ?? "").trim();
  if (!str) return "";
  return uiTranslate("approval.secret.redacted", null, "••••••");
}

function isSafeExternalHttpUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return { safe: false, href: "" };
  try {
    const parsed = new URL(value);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      return { safe: true, href: parsed.href, url: parsed };
    }
  } catch {
    // invalid URL
  }
  return { safe: false, href: value };
}

function isElicitationSchemaEmpty(schema) {
  if (!schema || typeof schema !== "object") return true;
  const props = schema.properties;
  return !props || typeof props !== "object" || Object.keys(props).length === 0;
}

function classifyCodexElicitation(evt) {
  const elicitation = evt?.elicitation && typeof evt.elicitation === "object" ? evt.elicitation : null;
  if (!elicitation) return null;
  const rawMode = String(elicitation.mode || "").trim();
  const mode = rawMode.toLowerCase();
  const codexKind = String(elicitation.codexApprovalKind || "").trim().toLowerCase();
  const schema = elicitation.requestedSchema && typeof elicitation.requestedSchema === "object"
    ? elicitation.requestedSchema
    : null;
  const schemaEmpty = isElicitationSchemaEmpty(schema);
  const serverName = String(elicitation.serverName || evt?.serverName || "").trim();
  const message = String(elicitation.message || evt?.reason || "").trim();

  if ((codexKind === "mcp_tool_call" || (!mode && !elicitation.url)) && schemaEmpty) {
    return { kind: "compact_mcp", mode: mode || codexKind, elicitation, serverName, message };
  }
  if (mode === "form" || mode === "openai/form" || mode === "openaiform" || (!mode && !schemaEmpty)) {
    return { kind: "form", mode: rawMode || "form", elicitation, schema: schema || { properties: {} }, serverName, message };
  }
  if (mode === "url" || (!!elicitation.url && !mode)) {
    return { kind: "url", mode: rawMode || "url", elicitation, url: String(elicitation.url || "").trim(), serverName, message };
  }
  return { kind: "unsupported", mode: rawMode || codexKind || "unknown", elicitation, serverName, message };
}

function isSimpleElicitationForm(schema) {
  if (!schema || typeof schema !== "object" || !schema.properties) return true;
  const entries = Object.entries(schema.properties);
  if (entries.length > 2) return false;
  return entries.every(([, prop]) => {
    const type = String(prop?.type || "string").toLowerCase();
    return type !== "object" && type !== "array";
  });
}

function getSchemaEnumOptions(prop) {
  if (Array.isArray(prop?.enum)) {
    return prop.enum.map((val, idx) => ({
      value: val,
      label: Array.isArray(prop.enumNames) && prop.enumNames[idx] !== undefined
        ? String(prop.enumNames[idx])
        : String(val),
    }));
  }
  const variants = Array.isArray(prop?.oneOf) ? prop.oneOf : (Array.isArray(prop?.anyOf) ? prop.anyOf : null);
  if (variants) {
    const out = [];
    for (const v of variants) {
      if (!v || typeof v !== "object") continue;
      if (v.const !== undefined) {
        out.push({ value: v.const, label: String(v.title ?? v.label ?? v.const) });
      } else if (Array.isArray(v.enum) && v.enum.length === 1) {
        out.push({ value: v.enum[0], label: String(v.title ?? v.label ?? v.enum[0]) });
      }
    }
    if (out.length > 0) return out;
  }
  return null;
}

function createSecretRevealButton(inputEl, { buttonClassName = "runtime-approval-card__secret-toggle", tr = uiTranslate } = {}) {
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = buttonClassName;
  toggleBtn.setAttribute("aria-pressed", "false");
  toggleBtn.setAttribute("aria-label", tr("approval.secret.reveal", null, "Show secret answer"));
  toggleBtn.textContent = "👁";
  toggleBtn.addEventListener("click", () => {
    const revealed = inputEl.type === "text";
    inputEl.type = revealed ? "password" : "text";
    toggleBtn.setAttribute("aria-pressed", revealed ? "false" : "true");
    toggleBtn.setAttribute(
      "aria-label",
      revealed
        ? tr("approval.secret.reveal", null, "Show secret answer")
        : tr("approval.secret.hide", null, "Hide secret answer")
    );
  });
  return toggleBtn;
}

function buildElicitationSchemaForm(schema, { tr = uiTranslate, onInputChange = null } = {}) {
  const form = document.createElement("div");
  form.className = "elicitation-form";
  const props = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const requiredSet = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fieldControllers = [];

  for (const [key, rawProp] of Object.entries(props)) {
    const prop = rawProp && typeof rawProp === "object" ? rawProp : {};
    const fieldWrap = document.createElement("div");
    fieldWrap.className = "elicitation-field";
    fieldWrap.dataset.fieldKey = key;

    const labelText = String(prop.title || key).trim();
    const isRequired = requiredSet.has(key);
    const errorEl = document.createElement("div");
    errorEl.className = "elicitation-field__error";
    errorEl.hidden = true;

    const rawType = Array.isArray(prop.type)
      ? (prop.type.find((t) => t !== "null") || "string")
      : String(prop.type || "string").toLowerCase();
    const enumOptions = getSchemaEnumOptions(prop);

    let readAndValidate = null;
    let focusTarget = null;

    if (rawType === "boolean") {
      const checkRow = document.createElement("label");
      checkRow.className = "elicitation-field__checkbox-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = prop.default === true;
      checkbox.dataset.fieldKey = key;
      checkbox.addEventListener("change", () => {
        errorEl.hidden = true;
        onInputChange?.();
      });
      const textSpan = document.createElement("span");
      textSpan.textContent = labelText;
      checkRow.appendChild(checkbox);
      checkRow.appendChild(textSpan);
      if (isRequired) {
        const req = document.createElement("span");
        req.className = "elicitation-field__required";
        req.textContent = "*";
        checkRow.appendChild(req);
      }
      fieldWrap.appendChild(checkRow);
      if (prop.description) {
        const desc = document.createElement("div");
        desc.className = "elicitation-field__description";
        desc.textContent = String(prop.description);
        fieldWrap.appendChild(desc);
      }
      focusTarget = checkbox;
      readAndValidate = () => ({ valid: true, include: true, value: Boolean(checkbox.checked), error: "" });
    } else if (rawType === "array" && Array.isArray(prop.items?.enum)) {
      const labelEl = document.createElement("div");
      labelEl.className = "elicitation-field__label";
      labelEl.textContent = labelText;
      if (isRequired) {
        const req = document.createElement("span");
        req.className = "elicitation-field__required";
        req.textContent = "*";
        labelEl.appendChild(req);
      }
      fieldWrap.appendChild(labelEl);
      if (prop.description) {
        const desc = document.createElement("div");
        desc.className = "elicitation-field__description";
        desc.textContent = String(prop.description);
        fieldWrap.appendChild(desc);
      }
      const defaultArr = Array.isArray(prop.default) ? new Set(prop.default.map(String)) : new Set();
      const checkboxes = [];
      for (const itemVal of prop.items.enum) {
        const row = document.createElement("label");
        row.className = "elicitation-field__checkbox-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = String(itemVal);
        cb.checked = defaultArr.has(String(itemVal));
        cb.addEventListener("change", () => {
          errorEl.hidden = true;
          onInputChange?.();
        });
        row.appendChild(cb);
        row.appendChild(document.createTextNode(String(itemVal)));
        fieldWrap.appendChild(row);
        checkboxes.push({ cb, typedValue: itemVal });
      }
      focusTarget = checkboxes[0]?.cb || null;
      readAndValidate = () => {
        const chosen = checkboxes.filter((entry) => entry.cb.checked).map((entry) => entry.typedValue);
        if (isRequired && chosen.length === 0) {
          return {
            valid: false,
            include: false,
            value: chosen,
            error: tr("elicitation.validation.required", { field: labelText }, `Please fill required field: ${labelText}`),
          };
        }
        if (!isRequired && chosen.length === 0) return { valid: true, include: false, value: chosen, error: "" };
        return { valid: true, include: true, value: chosen, error: "" };
      };
    } else {
      const labelEl = document.createElement("label");
      labelEl.className = "elicitation-field__label";
      labelEl.textContent = labelText;
      if (isRequired) {
        const req = document.createElement("span");
        req.className = "elicitation-field__required";
        req.textContent = "*";
        labelEl.appendChild(req);
      }
      fieldWrap.appendChild(labelEl);
      if (prop.description) {
        const desc = document.createElement("div");
        desc.className = "elicitation-field__description";
        desc.textContent = String(prop.description);
        fieldWrap.appendChild(desc);
      }

      if (enumOptions) {
        const selectEl = document.createElement("select");
        selectEl.className = "elicitation-field__input";
        selectEl.dataset.fieldKey = key;
        const placeholderOpt = document.createElement("option");
        placeholderOpt.value = "";
        placeholderOpt.textContent = tr("elicitation.selectPlaceholder", null, "Select an option…");
        selectEl.appendChild(placeholderOpt);
        selectEl.value = "";
        enumOptions.forEach((opt, idx) => {
          const optionEl = document.createElement("option");
          optionEl.value = String(idx);
          optionEl.textContent = opt.label;
          if (prop.default !== undefined && opt.value === prop.default) {
            optionEl.selected = true;
            selectEl.value = String(idx);
          }
          selectEl.appendChild(optionEl);
        });
        selectEl.addEventListener("change", () => {
          errorEl.hidden = true;
          onInputChange?.();
        });
        fieldWrap.appendChild(selectEl);
        focusTarget = selectEl;
        readAndValidate = () => {
          const rawIdx = selectEl.value;
          if (rawIdx === "") {
            if (isRequired) {
              return {
                valid: false,
                include: false,
                value: undefined,
                error: tr("elicitation.validation.required", { field: labelText }, `Please fill required field: ${labelText}`),
              };
            }
            return { valid: true, include: false, value: undefined, error: "" };
          }
          const matched = enumOptions[Number(rawIdx)];
          return { valid: true, include: true, value: matched ? matched.value : rawIdx, error: "" };
        };
      } else {
        const wrap = document.createElement("div");
        wrap.className = "elicitation-field__input-wrap";
        const fieldInput = document.createElement("input");
        fieldInput.className = "elicitation-field__input";
        fieldInput.dataset.fieldKey = key;
        fieldInput.setAttribute("autocomplete", "off");
        fieldInput.setAttribute("spellcheck", "false");

        const isSecretField = prop.format === "password" || prop.writeOnly === true;
        if (rawType === "number" || rawType === "integer") {
          fieldInput.type = "number";
          fieldInput.step = rawType === "integer" ? "1" : "any";
          if (Number.isFinite(Number(prop.minimum))) fieldInput.min = String(prop.minimum);
          if (Number.isFinite(Number(prop.maximum))) fieldInput.max = String(prop.maximum);
        } else if (isSecretField) {
          fieldInput.type = "password";
          fieldInput.dataset.secret = "true";
        } else if (prop.format === "email") {
          fieldInput.type = "email";
        } else if (prop.format === "uri" || prop.format === "url") {
          fieldInput.type = "url";
        } else {
          fieldInput.type = "text";
        }

        if (prop.default !== undefined && prop.default !== null) {
          fieldInput.value = String(prop.default);
        }
        fieldInput.addEventListener("input", () => {
          errorEl.hidden = true;
          onInputChange?.();
        });
        wrap.appendChild(fieldInput);
        if (isSecretField) {
          wrap.appendChild(createSecretRevealButton(fieldInput, { tr }));
        }
        fieldWrap.appendChild(wrap);
        focusTarget = fieldInput;

        readAndValidate = () => {
          const rawVal = fieldInput.value;
          const trimmed = rawVal.trim();
          if (!trimmed) {
            if (isRequired) {
              return {
                valid: false,
                include: false,
                value: "",
                error: tr("elicitation.validation.required", { field: labelText }, `Please fill required field: ${labelText}`),
              };
            }
            return { valid: true, include: false, value: "", error: "" };
          }
          if (rawType === "number" || rawType === "integer") {
            const num = Number(trimmed);
            if (!Number.isFinite(num)) {
              return {
                valid: false,
                include: false,
                value: undefined,
                error: tr("elicitation.validation.number", { field: labelText }, `Enter a valid number for ${labelText}`),
              };
            }
            if (rawType === "integer" && !Number.isInteger(num)) {
              return {
                valid: false,
                include: false,
                value: undefined,
                error: tr("elicitation.validation.integer", { field: labelText }, `Enter a whole number for ${labelText}`),
              };
            }
            if ((Number.isFinite(Number(prop.minimum)) && num < Number(prop.minimum))
                || (Number.isFinite(Number(prop.maximum)) && num > Number(prop.maximum))) {
              return {
                valid: false,
                include: false,
                value: undefined,
                error: tr("elicitation.validation.range", { field: labelText }, `${labelText} is out of allowed range`),
              };
            }
            return { valid: true, include: true, value: num, error: "" };
          }
          if ((Number.isFinite(Number(prop.minLength)) && rawVal.length < Number(prop.minLength))
              || (Number.isFinite(Number(prop.maxLength)) && rawVal.length > Number(prop.maxLength))) {
            return {
              valid: false,
              include: false,
              value: undefined,
              error: tr("elicitation.validation.length", { field: labelText }, `${labelText} length is out of allowed range`),
            };
          }
          return { valid: true, include: true, value: rawVal, error: "" };
        };
      }
    }

    fieldWrap.appendChild(errorEl);
    form.appendChild(fieldWrap);
    if (readAndValidate) {
      fieldControllers.push({ key, errorEl, focusTarget, readAndValidate });
    }
  }

  return {
    element: form,
    hasFields: fieldControllers.length > 0,
    collectAndValidate(showErrors = true) {
      const content = {};
      let valid = true;
      let firstInvalid = null;
      for (const ctrl of fieldControllers) {
        const res = ctrl.readAndValidate();
        if (!res.valid) {
          valid = false;
          if (!firstInvalid && ctrl.focusTarget) firstInvalid = ctrl.focusTarget;
          if (showErrors && res.error) {
            ctrl.errorEl.textContent = res.error;
            ctrl.errorEl.hidden = false;
          }
        } else {
          ctrl.errorEl.hidden = true;
          if (res.include) content[ctrl.key] = res.value;
        }
      }
      if (!valid && showErrors && firstInvalid?.focus) {
        firstInvalid.focus();
      }
      return { valid, content };
    },
  };
}

function buildElicitationUrlCard(elicitation, { tr = uiTranslate, buttonClassName = "decision-sheet__url-btn" } = {}) {
  const card = document.createElement("div");
  card.className = "elicitation-url-card";
  const serverName = String(elicitation?.serverName || "").trim();
  const message = String(elicitation?.message || "").trim();
  const urlCheck = isSafeExternalHttpUrl(elicitation?.url);

  if (serverName) {
    const serverRow = document.createElement("div");
    serverRow.className = "runtime-approval-card__detail";
    const lbl = document.createElement("span");
    lbl.className = "runtime-approval-card__detail-label";
    lbl.textContent = tr("elicitation.serverLabel", null, "MCP Server");
    const val = document.createElement("span");
    val.className = "runtime-approval-card__detail-value";
    val.textContent = serverName;
    serverRow.appendChild(lbl);
    serverRow.appendChild(val);
    card.appendChild(serverRow);
  }
  if (message) {
    const msgEl = document.createElement("div");
    msgEl.className = "runtime-approval-card__detail-value";
    msgEl.textContent = message;
    card.appendChild(msgEl);
  }

  const urlBox = document.createElement("div");
  urlBox.className = "elicitation-url-card__url";
  urlBox.textContent = urlCheck.href || String(elicitation?.url || "");
  card.appendChild(urlBox);

  if (!urlCheck.safe) {
    const warn = document.createElement("div");
    warn.className = "elicitation-url-card__warning";
    warn.textContent = tr("elicitation.invalidUrl", null, "Blocked unsafe URL (only http/https links are allowed).");
    card.appendChild(warn);
    return { element: card, safeUrl: "", valid: false };
  }

  const hint = document.createElement("div");
  hint.className = "elicitation-field__description";
  hint.textContent = tr("elicitation.urlSecurityHint", null, "Open and verify this link in your browser only if you trust the destination.");
  card.appendChild(hint);

  const actions = document.createElement("div");
  actions.className = "elicitation-url-card__actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = buttonClassName;
  openBtn.textContent = tr("elicitation.openLink", null, "Open link");
  openBtn.addEventListener("click", () => {
    globalThis.open?.(urlCheck.href, "_blank", "noopener,noreferrer");
  });
  actions.appendChild(openBtn);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = buttonClassName;
  copyBtn.textContent = tr("elicitation.copyLink", null, "Copy URL");
  copyBtn.addEventListener("click", async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText?.(urlCheck.href);
      copyBtn.textContent = tr("elicitation.copiedLink", null, "Copied");
      globalThis.setTimeout?.(() => {
        copyBtn.textContent = tr("elicitation.copyLink", null, "Copy URL");
      }, 1500);
    } catch {
      // ignore clipboard errors in constrained tests
    }
  });
  actions.appendChild(copyBtn);

  card.appendChild(actions);
  return { element: card, safeUrl: urlCheck.href, valid: true };
}

function buildElicitationUnsupportedCard(elicitation, mode, { tr = uiTranslate } = {}) {
  const card = document.createElement("div");
  card.className = "elicitation-unsupported";
  const serverName = String(elicitation?.serverName || "").trim();
  if (serverName) {
    const serverRow = document.createElement("div");
    serverRow.className = "runtime-approval-card__detail";
    const lbl = document.createElement("span");
    lbl.className = "runtime-approval-card__detail-label";
    lbl.textContent = tr("elicitation.serverLabel", null, "MCP Server");
    const val = document.createElement("span");
    val.className = "runtime-approval-card__detail-value";
    val.textContent = serverName;
    serverRow.appendChild(lbl);
    serverRow.appendChild(val);
    card.appendChild(serverRow);
  }
  const notice = document.createElement("div");
  notice.className = "elicitation-unsupported__notice";
  notice.textContent = tr(
    "elicitation.unsupportedBody",
    { mode: String(mode || "unknown") },
    `This request requires "${String(mode || "unknown")}", which is not supported in this client.`
  );
  card.appendChild(notice);
  if (elicitation?.message) {
    const msgEl = document.createElement("div");
    msgEl.className = "runtime-approval-card__detail-value";
    msgEl.textContent = String(elicitation.message);
    card.appendChild(msgEl);
  }
  return card;
}

function createQuestionCustomInputRow(section, sectionIndex, {
  rowClassName = "runtime-approval-card__custom-row",
  inputClassName = "runtime-approval-card__custom-input",
  toggleClassName = "runtime-approval-card__secret-toggle",
  onInput = null,
  tr = uiTranslate,
} = {}) {
  const isSecret = section?.isSecret === true;
  const row = document.createElement("div");
  row.className = rowClassName;
  row.dataset.questionIndex = String(sectionIndex);

  const label = document.createElement("label");
  label.className = "runtime-approval-card__custom-label";
  const titleText = section?.header || section?.question || "";
  label.textContent = titleText
    ? tr("approval.customAnswer.labelFor", { question: titleText }, `${titleText} — Other`)
    : tr("approval.customAnswer.label", null, "Other response");
  row.appendChild(label);

  const inputWrap = document.createElement("div");
  inputWrap.className = isSecret ? "runtime-approval-card__secret-wrap" : "decision-sheet__prompt-custom-row";

  const field = document.createElement("input");
  field.type = isSecret ? "password" : "text";
  field.className = inputClassName;
  field.dataset.questionIndex = String(sectionIndex);
  if (isSecret) field.dataset.secret = "true";
  field.setAttribute("autocomplete", "off");
  field.setAttribute("spellcheck", "false");
  field.placeholder = isSecret
    ? tr("approval.secret.placeholder", null, "Enter secret response…")
    : tr("approval.customAnswer.placeholder", null, "Write your own response…");
  if (typeof onInput === "function") {
    field.addEventListener("input", () => onInput(field.value, field));
  }
  inputWrap.appendChild(field);
  if (isSecret) {
    inputWrap.appendChild(createSecretRevealButton(field, { buttonClassName: toggleClassName, tr }));
  }
  row.appendChild(inputWrap);
  return { row, input: field };
}

function enhanceApprovalPromptSectionDom(sectionEl, section, sectionIndex = 0, {
  renderCustomInput = false,
  customRowClassName = "runtime-approval-card__custom-row",
  customInputClassName = "runtime-approval-card__custom-input",
  toggleClassName = "runtime-approval-card__secret-toggle",
  onCustomInput = null,
  tr = uiTranslate,
} = {}) {
  if (!sectionEl) return sectionEl;
  sectionEl.dataset.questionIndex = String(sectionIndex);
  sectionEl.dataset.multiSelect = section?.multiSelect === true ? "true" : "false";
  sectionEl.dataset.isSecret = section?.isSecret === true ? "true" : "false";
  sectionEl.dataset.isOther = section?.isOther === false
    ? "false"
    : (section?.isOther === true ? "true" : "auto");

  const optionList = sectionEl.querySelector?.(".runtime-approval-card__option-list");
  if (optionList && section?.multiSelect === true) {
    optionList.dataset.multiSelect = "true";
    optionList.setAttribute("role", "group");
    if (!sectionEl.querySelector?.(".runtime-approval-card__multi-hint")) {
      const hint = document.createElement("div");
      hint.className = "runtime-approval-card__multi-hint";
      hint.textContent = tr("approval.multiSelect.hint", null, "Select one or more");
      optionList.parentNode?.insertBefore(hint, optionList);
    }
    optionList.querySelectorAll(".runtime-approval-card__option").forEach((optBtn) => {
      optBtn.setAttribute("role", "checkbox");
      optBtn.setAttribute("aria-checked", optBtn.classList.contains("is-selected") ? "true" : "false");
    });
  }

  const optionsCount = Array.isArray(section?.options) ? section.options.length : 0;
  const shouldShowCustom = section?.isOther === false && optionsCount > 0 ? false : true;
  if (renderCustomInput && shouldShowCustom && !sectionEl.querySelector?.(`.${customRowClassName.split(" ")[0]}`)) {
    const { row } = createQuestionCustomInputRow(section, sectionIndex, {
      rowClassName: customRowClassName,
      inputClassName: customInputClassName,
      toggleClassName,
      onInput: onCustomInput,
      tr,
    });
    sectionEl.appendChild(row);
  }
  return sectionEl;
}

if (typeof globalThis !== "undefined") {
  globalThis.parseQuestionReplyEnvelopeCompat = parseQuestionReplyEnvelopeCompat;
  globalThis.hasApprovalSecretQuestion = hasApprovalSecretQuestion;
  globalThis.redactApprovalSecretValue = redactApprovalSecretValue;
  globalThis.isSafeExternalHttpUrl = isSafeExternalHttpUrl;
  globalThis.classifyCodexElicitation = classifyCodexElicitation;
  globalThis.isSimpleElicitationForm = isSimpleElicitationForm;
  globalThis.buildElicitationSchemaForm = buildElicitationSchemaForm;
  globalThis.buildElicitationUrlCard = buildElicitationUrlCard;
  globalThis.buildElicitationUnsupportedCard = buildElicitationUnsupportedCard;
  globalThis.createQuestionCustomInputRow = createQuestionCustomInputRow;
  globalThis.enhanceApprovalPromptSectionDom = enhanceApprovalPromptSectionDom;
}

// Single-select an option within its question group and enable the card's submit button.
function selectApprovalOption(option) {
  if (!option || option.dataset?.sheetBound === "true") return;
  const list = typeof option.closest === "function" ? option.closest(".runtime-approval-card__option-list") : null;
  if (list) {
    if (list.dataset?.multiSelect === "true") {
      const next = !option.classList.contains("is-selected");
      option.classList.toggle("is-selected", next);
      option.setAttribute("aria-checked", next ? "true" : "false");
    } else {
      list.querySelectorAll(".runtime-approval-card__option").forEach((node) => {
        node.classList.toggle("is-selected", node === option);
      });
    }
  }
  const card = typeof option.closest === "function" ? option.closest(".runtime-approval-card") : null;
  if (card) {
    const submit = card.querySelector('.runtime-approval-card__action[data-approval-decision="approve"]');
    if (submit) submit.disabled = false;
  }
}

function createApprovalPromptSection(section, questionIndex = 0) {
  const wrap = document.createElement("div");
  wrap.className = "runtime-approval-card__prompt";
  if (section.id) wrap.dataset.questionId = section.id;
  wrap.dataset.questionIndex = String(questionIndex);

  if (section.header) {
    const header = document.createElement("div");
    header.className = "runtime-approval-card__prompt-header";
    header.textContent = section.header;
    wrap.appendChild(header);
  }

  if (section.question) {
    const question = document.createElement("div");
    question.className = "runtime-approval-card__question";
    question.textContent = section.question;
    wrap.appendChild(question);
  }

  if (section.options.length > 0) {
    const options = document.createElement("div");
    options.className = "runtime-approval-card__option-list";
    options.setAttribute("role", "list");
    section.options.forEach((optionData, optionIndex) => {
      const option = document.createElement("div");
      option.className = "runtime-approval-card__option";
      option.setAttribute("role", "option");
      option.setAttribute("tabindex", "0");
      option.dataset.optionIndex = String(optionIndex);
      option.dataset.questionIndex = String(questionIndex);
      if (optionData.value) option.dataset.optionValue = optionData.value;
      // Label + description share a text wrapper so the option row can lead with
      // the sheet-scoped radio indicator (::before on .runtime-approval-card__option)
      // without splitting description into a second flex column.
      const text = document.createElement("div");
      text.className = "runtime-approval-card__option-text";
      const label = document.createElement("div");
      label.className = "runtime-approval-card__option-label";
      label.textContent = optionData.label;
      text.appendChild(label);
      if (optionData.description) {
        const description = document.createElement("div");
        description.className = "runtime-approval-card__option-description";
        description.textContent = optionData.description;
        text.appendChild(description);
      }
      option.appendChild(text);
      option.addEventListener("click", (event) => {
        event.preventDefault();
        selectApprovalOption(event.currentTarget);
      });
      // The option carries tabindex=0/role=option, so keyboard users must be able
      // to select it with Enter/Space just like a native listbox option.
      option.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          selectApprovalOption(event.currentTarget);
        }
      });
      options.appendChild(option);
    });
    wrap.appendChild(options);
  }

  return wrap;
}

// In-stream approval request card removed 2026-08-04 — the Decision Sheet is
// the single approval surface on every viewport. Only the auditable summary
// line still renders into the conversation, from the approval_response event.

function renderApprovalResponseInto(container, evt) {
  if (!container) return null;
  const summary = createRuntimeApprovalSummary(evt);
  container.appendChild(summary);
  return summary;
}

let activeMessageTouchMenu = null;
let activeMessageTouchMenuCleanup = null;
// Fire before Android/Chrome's native text-selection callout takes over the
// gesture, while keeping the gesture clearly distinct from a normal tap.
const MESSAGE_LONG_PRESS_DELAY_MS = 360;
const MESSAGE_LONG_PRESS_MOVE_TOLERANCE_PX = 24;

function getMessageActionText(evt, role = "assistant") {
  const source = typeof evt?.content === "string" && evt.content
    ? evt.content
    : (typeof evt?.bodyPreview === "string" ? evt.bodyPreview : "");
  let parsed = null;
  if (typeof parseQuestionReplyEnvelopeCompat === "function") {
    parsed = parseQuestionReplyEnvelopeCompat(source);
  } else if (typeof parseQuestionReplyEnvelope === "function") {
    parsed = parseQuestionReplyEnvelope(source);
  } else if (source && /<send_user_message_question_reply\b/i.test(source)) {
    const lines = [];
    const stripped = source.replace(
      /<send_user_message_question_reply\b[^>]*>([\s\S]*?)<\/send_user_message_question_reply>/gi,
      (_m, inner) => {
        try {
          const json = JSON.parse(String(inner || "").trim());
          const arr = Array.isArray(json) ? json : (Array.isArray(json?.replies) ? json.replies : [json]);
          for (const item of arr) {
            if (!item || typeof item !== "object") continue;
            const q = String(item.question ?? item.prompt ?? "").trim();
            const a = String(item.answer ?? item.reply ?? "").trim();
            if (q && a) lines.push(`${q}: ${a}`);
            else if (a || q) lines.push(a || q);
          }
        } catch {
          // ignore
        }
        return "\n";
      }
    ).replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
    parsed = { hasEnvelope: true, displayText: [lines.join("\n"), stripped].filter(Boolean).join("\n\n").trim(), trailingText: stripped };
  }
  if (parsed?.hasEnvelope) {
    return parsed.displayText || parsed.trailingText || "";
  }
  if (typeof formatDecodedDisplayText === "function") {
    return formatDecodedDisplayText(source);
  }
  return source;
}

function getMessageActionAttachments(evt) {
  return Array.isArray(evt?.attachments) && evt.attachments.length > 0
    ? evt.attachments
    : (Array.isArray(evt?.images) ? evt.images : []);
}

function restoreMessageIntoComposer(text, attachments = []) {
  if (!msgInput) return false;
  const nextText = typeof text === "string" ? text : "";
  msgInput.value = nextText;
  if (typeof writeStoredDraft === "function") {
    writeStoredDraft(currentSessionId, nextText);
  }
  const nextAttachments = attachments.map((attachment) => ({
    ...attachment,
    uploadState: attachment?.uploadState || "ready",
  }));
  if (typeof replaceComposerAttachmentsSnapshot === "function") {
    replaceComposerAttachmentsSnapshot(currentSessionId, nextAttachments);
  }
  if (typeof autoResizeInput === "function") {
    autoResizeInput();
  }
  try {
    msgInput.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
    // Best effort for tiny DOM test shims.
  }
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: false });
  } else if (typeof msgInput.focus === "function") {
    msgInput.focus();
  }
  if (typeof msgInput.setSelectionRange === "function") {
    const cursor = msgInput.value.length;
    msgInput.setSelectionRange(cursor, cursor);
  }
  return true;
}

async function clearQueuedFollowUpsAfterMessageEdit() {
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  const sessionId = session?.id || currentSessionId;
  if (!sessionId || !Array.isArray(session?.queuedMessages) || session.queuedMessages.length === 0) {
    return null;
  }
  const optimisticSession = {
    ...session,
    activity: {
      ...(session.activity || {}),
      queue: {
        ...(session.activity?.queue || {}),
        state: "idle",
        count: 0,
      },
    },
    queuedMessages: [],
  };
  if (typeof upsertSession === "function") {
    upsertSession(optimisticSession);
  }
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(optimisticSession);
  }
  if (typeof fetchJsonOrRedirect !== "function") return optimisticSession;
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "clear" }),
    revalidate: false,
  });
  if (data?.session) {
    if (typeof upsertSession === "function") {
      upsertSession(data.session);
    }
    if (typeof renderQueuedMessagePanel === "function") {
      renderQueuedMessagePanel(data.session);
    }
  }
  return data?.session || optimisticSession;
}

function createMessageActionButton(action, label, iconName, handler, textLabel = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `msg-action-btn msg-action-btn--${action}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.action = action;
  button.innerHTML = renderUiIcon(iconName);
  // Optional visible label: used by the long-press touch menu rows so the
  // action reads as "复制 / 编辑并重发" instead of two bare icons (meta-row
  // buttons stay icon-only and pass no textLabel).
  if (textLabel) {
    const labelNode = document.createElement("span");
    labelNode.className = "msg-action-btn__label";
    labelNode.textContent = textLabel;
    button.appendChild(labelNode);
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handler(event);
  });
  return button;
}

function setMessageActionIcon(button, iconName) {
  if (!button) return;
  const labelNode = button.querySelector?.(".msg-action-btn__label") || null;
  button.innerHTML = renderUiIcon(iconName);
  if (labelNode) button.appendChild(labelNode);
}

function setMessageActionCopied(button, copied) {
  if (!button) return;
  button.classList.toggle("copied", copied === true);
  setMessageActionIcon(button, copied ? "check" : "copy");
  button.title = copied ? t("action.copied") : t("action.copy");
  button.setAttribute("aria-label", copied ? t("action.copied") : t("action.copy"));
  const labelNode = button.querySelector?.(".msg-action-btn__label");
  if (labelNode) labelNode.textContent = copied ? t("action.copied") : t("action.copy");
}

async function copyMessageActionText(text, button) {
  try {
    if (typeof copyText === "function") {
      await copyText(text);
    } else if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard unavailable");
    }
    setMessageActionCopied(button, true);
    window.clearTimeout(button?._copyResetTimer);
    button._copyResetTimer = window.setTimeout(() => {
      setMessageActionCopied(button, false);
      button._copyResetTimer = null;
    }, 1400);
  } catch (error) {
    console.warn("[copy] Failed to copy message:", error?.message || error);
  }
}

function canEditCurrentSessionMessages() {
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) return false;
  if (typeof visitorMode !== "undefined" && visitorMode) return false;
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  return session?.archived !== true;
}

// Edit-resend re-runs the message's own run, and the server only allows that
// once the run is finished (completed/failed/cancelled). While the session is
// busy, the last user message is either still queued (a follow-up inserted
// mid-run) or currently executing — its run is not terminal yet — so hide the
// edit affordance instead of letting the user hit a server rejection.
function canEditUserMessageForResend(evt) {
  if (!canEditCurrentSessionMessages()) return false;
  const requestId = typeof evt?.requestId === "string" ? evt.requestId.trim() : "";
  if (!requestId) return false;
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  if (Array.isArray(session?.queuedMessages)
    && session.queuedMessages.some((item) => item?.requestId === requestId)) {
    return false;
  }
  const runId = typeof evt?.runId === "string" ? evt.runId.trim() : "";
  const activeRun = session?.activity?.run || null;
  if (runId && activeRun?.runId === runId && activeRun?.state === "running") {
    return false;
  }
  return true;
}

function canForkMessageFromUi(evt, role) {
  if (!evt || (role !== "user" && role !== "assistant")) return false;
  if (evt.type === "attachment_delivery") return false;
  if (!Number.isInteger(Number(evt.seq)) || Number(evt.seq) < 1) return false;
  if (typeof canForkSessions === "function" && !canForkSessions()) return false;
  if (typeof visitorMode !== "undefined" && visitorMode) return false;
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  return session?.archived !== true && session?.activity?.run?.state !== "running";
}

function getMessageForkAnchorSeq(node, evt) {
  const datasetSeq = Number.parseInt(node?.dataset?.forkEndSeq || "", 10);
  if (Number.isInteger(datasetSeq) && datasetSeq > 0) return datasetSeq;
  const eventSeq = Number(evt?.mergedEndSeq || evt?.seq);
  return Number.isInteger(eventSeq) && eventSeq > 0 ? eventSeq : 0;
}

function setMessageForkBoundary(node, evt) {
  if (!node || !evt) return;
  const seq = Number(evt.seq);
  const endSeq = Number(evt.mergedEndSeq || evt.seq);
  if (Number.isInteger(seq) && seq > 0) node.dataset.eventSeq = String(seq);
  if (Number.isInteger(endSeq) && endSeq > 0) node.dataset.forkEndSeq = String(endSeq);
}

function makeForkIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `fork_at_${crypto.randomUUID()}`;
  }
  return `fork_at_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function requestMessageFork(node, evt, role, button = null) {
  const anchorSeq = getMessageForkAnchorSeq(node, evt);
  const sessionId = typeof currentSessionId === "string" ? currentSessionId : "";
  if (!sessionId || !anchorSeq || !canForkMessageFromUi(evt, role)) return;
  if (button?.dataset?.forkBusy === "true") return;
  if (button) {
    button.dataset.forkBusy = "true";
    button.disabled = true;
    button.classList.add("is-forking");
    button.title = t("message.forking");
    button.setAttribute("aria-label", t("message.forking"));
  }
  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/fork-at`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anchorSeq,
        mode: role === "user" ? "user-continue" : "assistant-continue",
        idempotencyKey: makeForkIdempotencyKey(),
      }),
      revalidate: false,
    });
    if (!data?.session?.id) throw new Error(data?.error || "fork failed");
    if (typeof upsertSession === "function") upsertSession(data.session);
    if (typeof renderSessionList === "function") renderSessionList();
    if (typeof window !== "undefined" && typeof window.ragentOpenSessionReference === "function") {
      await window.ragentOpenSessionReference(data.session.id, { forceFresh: true });
    }
  } catch (error) {
    console.warn("[fork-at] Failed:", error?.message || error);
    if (typeof showSystemToast === "function") showSystemToast(t("message.forkFailed"), "error");
  } finally {
    if (button) {
      button.dataset.forkBusy = "false";
      button.disabled = false;
      button.classList.remove("is-forking");
      button.title = t("message.forkFromHere");
      button.setAttribute("aria-label", t("message.forkFromHere"));
    }
  }
}

function closeMessageTouchMenu() {
  activeMessageTouchMenuCleanup?.();
  activeMessageTouchMenuCleanup = null;
  activeMessageTouchMenu?.remove?.();
  activeMessageTouchMenu = null;
}

function isMessageTouchMode() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function"
    && window.matchMedia("(hover: none), (pointer: coarse)").matches) {
    return true;
  }
  // Do not use the layout breakpoint as the touch decision. A phone in
  // desktop-site mode, a large tablet, or a touch laptop can still deliver a
  // real touch gesture while `isDesktop` is true.
  if (typeof navigator !== "undefined" && Number(navigator.maxTouchPoints) > 0) {
    return true;
  }
  return "ontouchstart" in window;
}

function editUserMessageForResend(evt) {
  const text = getMessageActionText(evt, "user");
  const attachments = getMessageActionAttachments(evt);
  const requestId = typeof evt?.requestId === "string" && evt.requestId
    ? evt.requestId
    : "";
  const sessionId = (typeof currentSessionId !== "undefined" && currentSessionId)
    ? currentSessionId
    : (typeof getCurrentSession === "function" ? getCurrentSession()?.id : "");
  // Real edit-resend: remember which message is being edited so the next Send
  // replaces that run (version-rail fold + fresh thread) instead of appending
  // a new message. The composer refill below stays as the edit surface.
  if (requestId && sessionId && typeof setComposerPendingEditResend === "function") {
    setComposerPendingEditResend({ sessionId, requestId, prompt: text, attachments });
    if (typeof syncComposerEditResendControls === "function") {
      syncComposerEditResendControls();
    }
  }
  restoreMessageIntoComposer(text, attachments);
  void clearQueuedFollowUpsAfterMessageEdit().catch((error) => {
    console.warn("[message-edit] Failed to clear queued follow-ups:", error?.message || error);
    if (typeof refreshCurrentSession === "function") {
      refreshCurrentSession().catch(() => {});
    }
  });
}

// A1 edit-resend: replace a user message bubble's content (text + attachment
// strip) with the edited version, keeping the node's dataset (requestId, fork
// boundary) and meta row intact. Idempotent — safe for both the optimistic
// patch after the resend-edited API call and the run_regenerate replay.
function applyEditedUserMessageContent(requestId, prompt, images = []) {
  if (!requestId || typeof messagesInner === "undefined" || !messagesInner) return false;
  const node = Array.from(messagesInner.querySelectorAll(".msg-user[data-request-id]"))
    .find((candidate) => candidate.dataset?.requestId === requestId) || null;
  if (!node) return false;
  const nextImages = Array.isArray(images) ? images : [];
  const replacement = createUserMessageNode(
    {
      requestId,
      runId: node.dataset?.runId || "",
      content: prompt,
      images: nextImages,
    },
    {},
  );
  if (!replacement) return false;
  const wasEditable = node.classList?.contains?.("is-editable") === true;
  if (typeof node.replaceChildren === "function") {
    node.replaceChildren(...Array.from(replacement.childNodes || replacement.children || []));
    delete node.dataset.bodyPending;
    delete node.dataset.bodyRender;
    delete node.dataset.preview;
    for (const [key, value] of Object.entries(replacement.dataset || {})) {
      if (!(key in node.dataset)) node.dataset[key] = value;
    }
    if (typeof syncEditableMessageActions === "function") {
      syncEditableMessageActions();
    } else if (wasEditable) {
      node.classList?.add?.("is-editable");
      node.querySelectorAll?.(".msg-action-btn--edit")?.forEach?.((button) => {
        button.hidden = false;
      });
    }
    if (typeof attachMessageLongPressMenu === "function") {
      attachMessageLongPressMenu(node, {
        requestId,
        runId: node.dataset?.runId || "",
        content: prompt,
        images: nextImages,
      }, "user");
    }
    return true;
  }
  for (const key of Object.keys(node.dataset || {})) {
    if (key === "bodyPending" || key === "bodyRender" || key === "preview") continue;
    replacement.dataset[key] = node.dataset[key];
  }
  if (wasEditable) {
    replacement.classList?.add?.("is-editable");
    replacement.querySelectorAll?.(".msg-action-btn--edit")?.forEach?.((button) => {
      button.hidden = false;
    });
  }
  node.replaceWith(replacement);
  if (typeof syncEditableMessageActions === "function") {
    syncEditableMessageActions();
  }
  return true;
}

function resolveMessageTouchTarget(wrap, evt, role) {
  if (wrap?.isConnected) return wrap;
  if (!messagesInner || (role !== "user" && role !== "assistant")) return null;
  const requestId = typeof evt?.requestId === "string" ? evt.requestId.trim() : "";
  const sessionId = typeof evt?.sessionId === "string"
    ? evt.sessionId.trim()
    : (typeof wrap?.dataset?.sessionId === "string" ? wrap.dataset.sessionId.trim() : "");
  if (!requestId) return null;
  const selector = role === "user" ? ".msg-user[data-request-id]" : ".msg-assistant[data-request-id]";
  return Array.from(messagesInner.querySelectorAll(selector))
    .reverse()
    .find((candidate) => {
      if (candidate.dataset.requestId !== requestId) return false;
      return !sessionId || !candidate.dataset.sessionId || candidate.dataset.sessionId === sessionId;
    }) || null;
}

function showMessageTouchMenu(wrap, evt, role) {
  const targetWrap = resolveMessageTouchTarget(wrap, evt, role);
  if (!targetWrap) return;
  closeMessageTouchMenu();
  const bubble = role === "user"
    ? (targetWrap.querySelector?.(".msg-user-bubble") || targetWrap)
    : targetWrap;
  const triggerHaptic = (ms = 10) => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(ms); } catch {}
    }
  };
  const eventData = {
    ...(targetWrap.__ragentMessageEvent || {}),
    ...(evt || {}),
  };
  if (!eventData.requestId && targetWrap.dataset?.requestId) {
    eventData.requestId = targetWrap.dataset.requestId;
  }
  if (!eventData.runId && targetWrap.dataset?.runId) {
    eventData.runId = targetWrap.dataset.runId;
  }
  if ((!eventData.seq || !Number.isInteger(Number(eventData.seq))) && targetWrap.dataset?.timelineEndSeq) {
    eventData.seq = Number(targetWrap.dataset.timelineEndSeq);
  }
  if ((!eventData.seq || !Number.isInteger(Number(eventData.seq))) && targetWrap.dataset?.eventSeq) {
    eventData.seq = Number(targetWrap.dataset.eventSeq);
  }

  const menu = document.createElement("div");
  menu.className = "msg-touch-menu";
  menu.setAttribute("role", "menu");
  const text = role === "assistant"
    ? (targetWrap.querySelector?.(".msg-assistant-body")?.textContent?.trim() || targetWrap.textContent?.trim() || "")
    : (getMessageActionText(eventData, role) || targetWrap.querySelector?.(".msg-user-bubble .md-content")?.textContent?.trim() || targetWrap.querySelector?.(".msg-user-bubble")?.textContent?.trim() || "");
  const copyButton = createMessageActionButton("copy", t("action.copy"), "copy", (event) => {
    triggerHaptic(10);
    void copyMessageActionText(text, event.currentTarget);
    window.setTimeout(() => {
      closeMessageTouchMenu();
    }, 420);
  }, t("action.copy"));
  menu.appendChild(copyButton);
  if (canForkMessageFromUi(eventData, role)) {
    menu.appendChild(createMessageActionButton("fork", t("message.forkFromHere"), "fork", (event) => {
      triggerHaptic(10);
      void requestMessageFork(targetWrap, eventData, role, event.currentTarget).finally(() => closeMessageTouchMenu());
    }, t("message.forkFromHere")));
  }
  if (role === "user" && targetWrap.classList.contains("is-editable") && canEditUserMessageForResend(eventData)) {
    menu.appendChild(createMessageActionButton("edit", t("message.editAndResend"), "edit", () => {
      triggerHaptic(10);
      editUserMessageForResend(eventData);
      closeMessageTouchMenu();
    }, t("message.editAndResend")));
  }
  if (role === "assistant" && !targetWrap.classList.contains("is-live") && !targetWrap.classList.contains("msg-delivery")) {
    const requestId = targetWrap.dataset?.requestId || (typeof eventData?.requestId === "string" ? eventData.requestId : "");
    if (requestId) {
      menu.appendChild(createMessageActionButton("regenerate", t("message.regenerate"), "refresh", () => {
        triggerHaptic(10);
        closeMessageTouchMenu();
        void requestMessageRegenerate(targetWrap);
      }, t("message.regenerate")));
    }
  }
  // Portal the menu to the document root so it is visually and semantically
  // separate from the message bubble. This also prevents the bubble's
  // overflow/stacking context from clipping the menu near the viewport edge.
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  activeMessageTouchMenu = menu;

  const positionMenu = () => {
    if (!activeMessageTouchMenu || activeMessageTouchMenu !== menu || !bubble.isConnected) return;
    const anchorRect = bubble.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const edge = 12;
    const gap = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const preferredLeft = role === "user"
      ? anchorRect.right - menuRect.width
      : anchorRect.left;
    const left = Math.max(edge, Math.min(preferredLeft, viewportWidth - menuRect.width - edge));
    const belowTop = anchorRect.bottom + gap;
    const aboveTop = anchorRect.top - menuRect.height - gap;
    const openAbove = !(belowTop + menuRect.height <= viewportHeight - edge || aboveTop < edge);
    const top = openAbove
      ? Math.max(edge, Math.min(aboveTop, viewportHeight - menuRect.height - edge))
      : Math.max(edge, Math.min(belowTop, viewportHeight - menuRect.height - edge));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.dataset.placement = openAbove ? "above" : "below";
    menu.style.transformOrigin = openAbove ? "bottom right" : "top right";
    menu.style.visibility = "visible";
    menu.classList.add("is-open");
  };

  const closeOnOutsidePointer = (event) => {
    if (menu.contains(event.target) || bubble.contains(event.target)) return;
    closeMessageTouchMenu();
  };
  const closeOnEscape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeMessageTouchMenu();
  };
  const closeOnViewportChange = () => closeMessageTouchMenu();
  activeMessageTouchMenuCleanup = () => {
    document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    document.removeEventListener("keydown", closeOnEscape, true);
    document.removeEventListener("scroll", closeOnViewportChange, true);
    window.removeEventListener("resize", closeOnViewportChange);
  };
  document.addEventListener("pointerdown", closeOnOutsidePointer, true);
  document.addEventListener("keydown", closeOnEscape, true);
  document.addEventListener("scroll", closeOnViewportChange, true);
  window.addEventListener("resize", closeOnViewportChange);
  positionMenu();
}

function attachMessageLongPressMenu(wrap, evt, role) {
  if (!wrap || (role !== "user" && role !== "assistant") || typeof wrap.addEventListener !== "function") return;
  wrap.__ragentMessageEvent = evt || wrap.__ragentMessageEvent || {};
  wrap.__ragentMessageRole = role || wrap.__ragentMessageRole || "user";
  if (wrap.__ragentLongPressAttached) return;
  wrap.__ragentLongPressAttached = true;

  const getBubble = () => (role === "user" ? (wrap.querySelector?.(".msg-user-bubble") || wrap) : wrap);
  let timer = null;
  let startX = 0;
  let startY = 0;
  let pointerGestureActive = false;
  let touchGestureActive = false;
  const getTouchPoint = (event) => event?.touches?.[0] || event?.changedTouches?.[0] || event || {};
  const clearTimer = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
    getBubble()?.classList?.remove?.("is-touch-pressing");
  };
  const startLongPress = (event, { source = "pointer" } = {}) => {
    const pointerType = String(event?.pointerType || "").trim().toLowerCase();
    if (!isMessageTouchMode() && pointerType !== "touch" && pointerType !== "pen") return;
    if (pointerType === "mouse") return;
    if (event.target?.closest?.("button, a, input, textarea, select, pre")) return;
    const point = getTouchPoint(event);
    startX = Number(point.clientX) || 0;
    startY = Number(point.clientY) || 0;
    clearTimer();
    getBubble()?.classList?.add?.("is-touch-pressing");
    timer = window.setTimeout(() => {
      timer = null;
      getBubble()?.classList?.remove?.("is-touch-pressing");
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try { navigator.vibrate(12); } catch {}
      }
      showMessageTouchMenu(wrap, wrap.__ragentMessageEvent || evt, role);
    }, MESSAGE_LONG_PRESS_DELAY_MS);
    if (source === "touch") touchGestureActive = true;
    else pointerGestureActive = true;
  };
  const moveLongPress = (event, { holdGesture = false } = {}) => {
    if (!timer) return;
    const point = getTouchPoint(event);
    const dx = (Number(point.clientX) || 0) - startX;
    const dy = (Number(point.clientY) || 0) - startY;
    if ((dx * dx + dy * dy) > (MESSAGE_LONG_PRESS_MOVE_TOLERANCE_PX * MESSAGE_LONG_PRESS_MOVE_TOLERANCE_PX)) {
      clearTimer();
      return;
    }
    // A real finger always drifts a few pixels during a hold. With
    // `touch-action: pan-y` the platform claims the vertical pan once that
    // drift crosses its own scroll slop (≈8px, well inside our tolerance) and
    // fires pointercancel — the press dies before the menu threshold and the
    // menu never opens on phones. While the drift is still inside our
    // tolerance, block the pan so the gesture stays ours; past the tolerance
    // we release it and the transcript scrolls as usual.
    if (holdGesture && event.cancelable && event.isPrimary !== false && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  };
  const finishLongPress = () => {
    clearTimer();
    pointerGestureActive = false;
    touchGestureActive = false;
  };
  wrap.addEventListener("pointerdown", (event) => {
    // Browsers that expose both event families can emit pointerdown and
    // touchstart for one finger. One active gesture keeps them idempotent.
    if (touchGestureActive) return;
    startLongPress(event);
  });
  wrap.addEventListener("pointermove", moveLongPress);
  wrap.addEventListener("pointerup", finishLongPress);
  wrap.addEventListener("pointercancel", finishLongPress);
  // Some embedded mobile browsers expose Touch Events without delivering
  // Pointer Events. Keep the same gesture state machine as a compatibility
  // path instead of relying on the browser's native context menu event.
  wrap.addEventListener("touchstart", (event) => {
    if (pointerGestureActive) return;
    startLongPress(event, { source: "touch" });
  }, { passive: true });
  // Non-passive on purpose: the hold must be able to block the platform pan
  // (see moveLongPress) or every phone kills the press with pointercancel.
  wrap.addEventListener("touchmove", (event) => {
    moveLongPress(event, { holdGesture: true });
  }, { passive: false });
  wrap.addEventListener("touchend", finishLongPress, { passive: true });
  wrap.addEventListener("touchcancel", finishLongPress, { passive: true });
  wrap.addEventListener("contextmenu", (event) => {
    if (!isMessageTouchMode()) return;
    event.preventDefault();
    finishLongPress();
    showMessageTouchMenu(wrap, wrap.__ragentMessageEvent || evt || {}, role);
  });
}

window.attachMessageLongPressMenu = attachMessageLongPressMenu;

function ensureMessageLongPressBinding(target) {
  if (!target || typeof target.closest !== "function") return null;
  const userWrap = target.closest(".msg-user");
  if (userWrap && !userWrap.__ragentLongPressAttached) {
    attachMessageLongPressMenu(userWrap, userWrap.__ragentMessageEvent || {}, "user");
    return userWrap;
  }
  const assistantWrap = target.closest(".msg-assistant");
  if (assistantWrap && !assistantWrap.__ragentLongPressAttached) {
    attachMessageLongPressMenu(assistantWrap, assistantWrap.__ragentMessageEvent || {}, "assistant");
    return assistantWrap;
  }
  return null;
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("pointerdown", (event) => {
    ensureMessageLongPressBinding(event.target);
  }, true);
  document.addEventListener("touchstart", (event) => {
    ensureMessageLongPressBinding(event.target);
  }, true);
  document.addEventListener("contextmenu", (event) => {
    ensureMessageLongPressBinding(event.target);
  }, true);
}

function appendMessageMeta(container, evt, role, { live = false } = {}) {
  if (!container) return null;
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (live) container.classList.add("is-live");
  if (typeof appendMessageTimestamp === "function") {
    appendMessageTimestamp(meta, evt?.timestamp, role === "user" ? "msg-user-time" : "msg-assistant-time");
  }
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const text = getMessageActionText(evt, role);
  if (text) {
    actions.appendChild(createMessageActionButton("copy", t("action.copy"), "copy", (event) => {
      void copyMessageActionText(text, event.currentTarget);
    }));
  }
  if (canForkMessageFromUi(evt, role)) {
    actions.appendChild(createMessageActionButton("fork", t("message.forkFromHere"), "fork", (event) => {
      void requestMessageFork(container, evt, role, event.currentTarget);
    }));
  }
  if (role === "user") {
    actions.appendChild(createMessageActionButton("edit", t("message.editAndResend"), "edit", () => {
      editUserMessageForResend(evt);
    }));
  }
  if (role === "assistant" && !live && !container.classList.contains("msg-delivery")) {
    actions.appendChild(createMessageActionButton("regenerate", t("message.regenerate"), "refresh", (event) => {
      void requestMessageRegenerate(container);
    }));
  }
  if (actions.children.length > 0) {
    meta.appendChild(actions);
  }
  if (meta.children.length === 0) return null;
  container.appendChild(meta);
  return meta;
}

function isAssistantMessageLive(target = null) {
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  const activeRun = session?.activity?.run || null;
  if (activeRun?.state !== "running") return false;
  const activeRunId = String(activeRun.runId || "").trim();
  if (!activeRunId) return false;
  const targetRunId = String(target?.runId || target?.dataset?.runId || "").trim();
  return targetRunId === activeRunId;
}

function finalizeLiveMessageMetadata() {
  if (!messagesInner) return;
  messagesInner.querySelectorAll(".msg-assistant.is-live").forEach((node) => {
    node.classList.remove("is-live");
  });
  if (typeof syncRegenerateActions === "function") {
    syncRegenerateActions();
  }
}

const RUN_MOTION_TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
let lastRunMotionState = "";
let runMotionTerminalTimer = null;
let observedRunSessionId = "";
const observedRunIds = new Set();
const confirmedTerminalRunIds = new Set();
const pendingRunChecks = new Set();
let runCheckTimer = null;

window.ragentHasUnresolvedRun = (sessionId) =>
  String(sessionId || "") === observedRunSessionId && observedRunIds.size > 0;

function reconcileMissingObservedRuns(sessionId, activeIds) {
  for (const runId of observedRunIds) {
    if (activeIds.has(runId) || pendingRunChecks.has(runId)) continue;
    pendingRunChecks.add(runId);
    Promise.resolve().then(() => fetchJsonOrRedirect(`/api/runs/${encodeURIComponent(runId)}`, { revalidate: false }))
      .then((data) => {
        const run = data?.run;
        if (String(run?.id || "") !== runId || String(run?.sessionId || "") !== sessionId) return;
        applyDurableRunTerminal({ runId, state: run.state }, sessionId);
      }).catch(() => { /* Keep the run unresolved until durable status can be read. */ })
      .finally(() => {
        pendingRunChecks.delete(runId);
        if (sessionId !== observedRunSessionId) return;
        if (!observedRunIds.has(runId) && typeof updateStatus === "function" && typeof getCurrentSession === "function") {
          const connected = typeof isConnectionRecoveryTransportUp === "function" && isConnectionRecoveryTransportUp();
          updateStatus(connected ? "connected" : "disconnected", getCurrentSession());
        }
        if (observedRunIds.has(runId) && !runCheckTimer) {
          runCheckTimer = window.setTimeout(() => {
            runCheckTimer = null;
            if (sessionId === observedRunSessionId && typeof getCurrentSession === "function") {
              observeSessionRunIds(getCurrentSession());
            }
          }, 5000);
        }
      });
  }
}

function observeSessionRunIds(session) {
  const sessionId = String(session?.id || "");
  if (sessionId !== observedRunSessionId) {
    observedRunSessionId = sessionId;
    observedRunIds.clear();
    confirmedTerminalRunIds.clear();
    pendingRunChecks.clear();
    if (runCheckTimer) window.clearTimeout(runCheckTimer);
    runCheckTimer = null;
  }
  const activeIds = new Set();
  for (const run of Array.isArray(session?.activeRuns) ? session.activeRuns : []) {
    const id = String(run?.id || "");
    if (!id || RUN_MOTION_TERMINAL_STATES.has(String(run?.state || "").toLowerCase())) continue;
    activeIds.add(id);
    if (!confirmedTerminalRunIds.has(id)) observedRunIds.add(id);
  }
  if (session?.activity?.run?.runId && session.activity.run.state !== "idle") {
    const id = String(session.activity.run.runId);
    if (!confirmedTerminalRunIds.has(id)) observedRunIds.add(id);
    if (!Array.isArray(session?.activeRuns)) activeIds.add(id);
  }
  if (Array.isArray(session?.activeRuns)) reconcileMissingObservedRuns(sessionId, activeIds);
}

function applyDurableRunTerminal(event, sessionId) {
  const runId = String(event?.runId || "").trim();
  const state = String(event?.state || "").trim().toLowerCase();
  if (String(sessionId || "") !== observedRunSessionId || !runId
      || !observedRunIds.has(runId) || !RUN_MOTION_TERMINAL_STATES.has(state)) return;
  observedRunIds.delete(runId);
  confirmedTerminalRunIds.add(runId);
  if (observedRunIds.size === 0) {
    syncRunMotionState(state, { confirmedTerminal: true });
    finalizeLiveMessageMetadata();
  }
}
window.applyDurableRunTerminal = applyDurableRunTerminal;

function normalizeRunMotionState(runState = "") {
  const normalized = String(runState || "").trim().toLowerCase();
  return normalized || "idle";
}

// Derive one visual state from the existing session state. This is not a second
// business-state machine: it gives the live message, composer slot and status
// surfaces one atomic hand-off when a run starts or settles.
function syncRunMotionState(runState = "", { confirmedTerminal = false } = {}) {
  const normalized = normalizeRunMotionState(runState);
  const previous = lastRunMotionState;
  lastRunMotionState = normalized;
  const targets = [
    typeof messagesInner !== "undefined" ? messagesInner : null,
    typeof inputArea !== "undefined" ? inputArea : null,
    typeof document !== "undefined" ? document.body : null,
  ].filter(Boolean);
  for (const target of targets) target.dataset.runMotionState = normalized;

  const enteredTerminal = (previous === "running" || confirmedTerminal)
    && RUN_MOTION_TERMINAL_STATES.has(normalized);
  if (enteredTerminal) {
    if (runMotionTerminalTimer) window.clearTimeout(runMotionTerminalTimer);
    const liveNodes = typeof messagesInner !== "undefined"
      ? messagesInner.querySelectorAll?.(".msg-assistant.is-live") || []
      : [];
    for (const node of liveNodes) {
      node.classList.add("run-terminal-settle");
      node.dataset.runTerminalState = normalized;
    }
    window.RagentStreamingPresentation?.settleTerminal?.(
      normalized,
    );
    runMotionTerminalTimer = window.setTimeout(() => {
      runMotionTerminalTimer = null;
      for (const node of liveNodes) {
        node.classList.remove("run-terminal-settle");
        delete node.dataset.runTerminalState;
      }
    }, 360);
  }

  if (previous !== normalized) {
    window.dispatchEvent?.(new CustomEvent("ragent:run-motion-state", {
      detail: { previous, state: normalized },
    }));
  }
}

function syncLiveMessageMetadataForRunState(runState = "") {
  const normalized = normalizeRunMotionState(runState);
  syncRunMotionState(normalized);
  if (RUN_MOTION_TERMINAL_STATES.has(normalized)) {
    finalizeLiveMessageMetadata();
  }
}

// A1 regenerate: only the latest assistant reply is re-runnable. Mark exactly
// one node `.is-regenerable` so the action surfaces as a permanent meta-row
// button next to copy on every breakpoint (user decision 2026-08-05: no
// long-press menu on assistant output). Nodes inside a version rail are
// historical, not current, so they never qualify.
function isNodeInsideVersionRail(node) {
  return !!node?.closest?.(".msg-version-rail");
}

function syncRegenerateActions() {
  if (!messagesInner) return;
  const previous = messagesInner.querySelectorAll(".msg-assistant.is-regenerable");
  for (const node of Array.from(previous)) {
    node.classList.remove("is-regenerable");
  }
  if (typeof sessionStatus !== "undefined" && sessionStatus === "running") return;
  const candidates = Array.from(messagesInner.querySelectorAll(".msg-assistant[data-request-id]"))
    .filter((node) => !isNodeInsideVersionRail(node) && !node.classList.contains("is-live"));
  const last = candidates[candidates.length - 1] || null;
  if (last) {
    last.classList.add("is-regenerable");
  }
}

function assistantReplyHasToolMarkers(node) {
  if (!node) return false;
  return !!node.querySelector(".tool-use, .operation, .file-change, .approval-card, .plan-card");
}

async function requestMessageRegenerate(node) {
  const requestId = node?.dataset?.requestId || "";
  if (!requestId) return;
  if (sessionStatus === "running") {
    if (typeof showSystemToast === "function") {
      showSystemToast(t("message.regenerate.busy"), "info");
    }
    return;
  }
  if (assistantReplyHasToolMarkers(node)) {
    const confirmed = typeof window.confirm === "function"
      && window.confirm(t("message.regenerate.confirm"));
    if (!confirmed) return;
  }
  const sessionId = (typeof currentSessionId !== "undefined" && currentSessionId)
    ? currentSessionId
    : (typeof getCurrentSession === "function" ? getCurrentSession()?.id : "");
  if (!sessionId) return;
  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      revalidate: false,
    });
    if (data?.error) throw new Error(data.error);
  } catch (error) {
    console.warn("[regenerate] Failed:", error?.message || error);
    if (typeof showSystemToast === "function") {
      showSystemToast(t("message.regenerate.failed"), "error");
    }
  }
}

function syncEditableMessageActions() {
  if (!messagesInner) return;
  const editableAllowed = canEditCurrentSessionMessages();
  const nodes = Array.from(messagesInner.querySelectorAll(".msg-user[data-request-id]"))
    .filter((node) => !node.classList.contains("msg-user-local-echo"));
  const editableNode = editableAllowed ? nodes[nodes.length - 1] || null : null;
  for (const node of nodes) {
    const editable = node === editableNode
      && canEditUserMessageForResend({
        requestId: node.dataset?.requestId || "",
        runId: node.dataset?.runId || "",
      });
    node.classList.toggle("is-editable", editable);
    node.querySelectorAll(".msg-action-btn--edit").forEach((button) => {
      button.hidden = !editable;
    });
  }
}

function renderPlanAwareMarkdownIntoNode(node, visibleSource, { preserveLineBreaks = false } = {}) {
  const source = String(visibleSource || "");
  const regex = /<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/gi;
  let match = regex.exec(source);
  if (!match) return false;

  node.innerHTML = "";
  let lastIndex = 0;
  while (match) {
    const before = source.slice(lastIndex, match.index).trim();
    if (before) {
      const beforeNode = document.createElement("div");
      beforeNode.className = "plan-card-context md-content";
      renderMarkdownFragmentIntoNode(beforeNode, before, { preserveLineBreaks });
      node.appendChild(beforeNode);
    }

    const planText = String(match[1] || "").trim();
    if (planText) {
      node.appendChild(renderPlanProposalCard(planText));
    }

    lastIndex = regex.lastIndex;
    match = regex.exec(source);
  }

  const after = source.slice(lastIndex).trim();
  if (after) {
    const afterNode = document.createElement("div");
    afterNode.className = "plan-card-context md-content";
    renderMarkdownFragmentIntoNode(afterNode, after, { preserveLineBreaks });
    node.appendChild(afterNode);
  }

  return node.children.length > 0;
}

function renderMarkdownIntoNode(node, markdown, { deferEnhance = false, preserveLineBreaks = true } = {}) {
  const source = typeof markdown === "string" ? markdown : "";
  const visibleSource = formatDecodedDisplayText(source);
  if (!deferEnhance && renderPlanAwareMarkdownIntoNode(node, visibleSource, { preserveLineBreaks })) {
    return true;
  }
  return renderMarkdownFragmentIntoNode(node, visibleSource, { deferEnhance, preserveLineBreaks });
}

function markLazyEventBodyNode(node, evt, { preview = "", renderMode = "text" } = {}) {
  if (!node || !evt?.bodyAvailable || evt.bodyLoaded) return false;
  if (!Number.isInteger(evt.seq) || evt.seq < 1) return false;
  node.dataset.eventSeq = String(evt.seq);
  node.dataset.bodyPending = "true";
  node.dataset.bodyRender = renderMode;
  const resolvedPreview = typeof preview === "string" && preview
    ? preview
    : (evt.bodyPreview || "");
  if (resolvedPreview) {
    node.dataset.preview = resolvedPreview;
  } else {
    delete node.dataset.preview;
  }
  return true;
}

function getAttachmentDisplayName(attachment) {
  const originalName = typeof attachment?.originalName === "string"
    ? attachment.originalName.trim()
    : "";
  if (originalName) return originalName;
  const filename = typeof attachment?.filename === "string"
    ? attachment.filename.trim()
    : "";
  return filename || "attachment";
}

function getAttachmentKind(attachment) {
  const mimeType = typeof attachment?.mimeType === "string"
    ? attachment.mimeType
    : "";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function getAttachmentSource(attachment) {
  if (typeof attachment?.objectUrl === "string" && attachment.objectUrl) {
    return attachment.objectUrl;
  }
  if (typeof attachment?.downloadUrl === "string" && attachment.downloadUrl) {
    return attachment.downloadUrl;
  }
  if (typeof attachment?.url === "string" && attachment.url) {
    return attachment.url;
  }
  if (typeof attachment?.assetId === "string" && attachment.assetId) {
    return resolveUiProductPath(`/api/assets/${encodeURIComponent(attachment.assetId)}/download`);
  }
  if (typeof attachment?.filename === "string" && attachment.filename) {
    return resolveUiProductPath(`/api/media/${encodeURIComponent(attachment.filename)}`);
  }
  return "";
}

function getAttachmentDownloadSource(attachment) {
  const downloadUrl = typeof attachment?.downloadUrl === "string"
    ? attachment.downloadUrl.trim()
    : "";
  if (downloadUrl) {
    if (!/^(?:\/(?:api\/assets\/[^/]+\/download|share-asset\/[^/]+\/[^/?#]+)|(?:\.\.\/)?share-asset\/[^/]+\/[^/?#]+)(?:[?#]|$)/.test(downloadUrl)) {
      return downloadUrl;
    }
    if (/[?&]download=1(?:&|$)/.test(downloadUrl)) {
      return downloadUrl;
    }
    return downloadUrl.includes("?") ? `${downloadUrl}&download=1` : `${downloadUrl}?download=1`;
  }
  const shareUrl = typeof attachment?.url === "string"
    ? attachment.url.trim()
    : "";
  if (shareUrl) {
    if (!/^(?:\/share-asset\/[^/]+\/[^/?#]+|(?:\.\.\/)?share-asset\/[^/]+\/[^/?#]+)(?:[?#]|$)/.test(shareUrl)) {
      return shareUrl;
    }
    if (/[?&]download=1(?:&|$)/.test(shareUrl)) {
      return shareUrl;
    }
    return shareUrl.includes("?") ? `${shareUrl}&download=1` : `${shareUrl}?download=1`;
  }
  const assetId = typeof attachment?.assetId === "string"
    ? attachment.assetId.trim()
    : "";
  if (assetId) {
    return resolveUiProductPath(`/api/assets/${encodeURIComponent(assetId)}/download?download=1`);
  }
  return getAttachmentSource(attachment);
}

function getAttachmentArtifactFileId(attachment) {
  const explicit = typeof attachment?.artifactFileId === "string"
    ? attachment.artifactFileId.trim()
    : "";
  if (explicit) return explicit;
  const assetId = typeof attachment?.assetId === "string"
    ? attachment.assetId.trim()
    : "";
  if (assetId) return `artifact_asset_${assetId}`;
  return "";
}

function getAttachmentTypeLabel(attachment) {
  const displayName = getAttachmentDisplayName(attachment);
  const lastDot = displayName.lastIndexOf(".");
  const extension = lastDot >= 0 ? displayName.slice(lastDot + 1).trim() : "";
  const normalizedExtension = extension.replace(/[^a-z0-9]+/gi, "").toUpperCase();
  if (normalizedExtension) return normalizedExtension.slice(0, 8);
  const kind = getAttachmentKind(attachment);
  if (kind === "audio") return "AUDIO";
  if (kind === "video") return "VIDEO";
  if (kind === "image") return "IMAGE";
  return "FILE";
}

function normalizeAttachmentSizeBytes(attachment) {
  const numeric = Number.parseInt(String(attachment?.sizeBytes || ""), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function formatAttachmentSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded} ${units[unitIndex]}`;
}

function shouldRenderAttachmentAsFileCard(attachment) {
  return attachment?.renderAs === "file" || getAttachmentKind(attachment) === "file";
}

function createAttachmentFileNode(attachment, { compact = false } = {}) {
  const label = getAttachmentDisplayName(attachment);
  const sizeLabel = formatAttachmentSize(normalizeAttachmentSizeBytes(attachment));
  const fileEl = document.createElement("div");
  fileEl.className = compact ? "attachment-file attachment-file-compact" : "attachment-file";
  fileEl.title = label;

  const iconEl = document.createElement("div");
  iconEl.className = "attachment-file-icon";
  iconEl.innerHTML = renderUiIcon("file-download");

  const metaEl = document.createElement("div");
  metaEl.className = "attachment-file-meta";

  const nameEl = document.createElement("div");
  nameEl.className = "attachment-file-name";
  nameEl.textContent = label;

  const typeEl = document.createElement("div");
  typeEl.className = "attachment-file-type";
  typeEl.textContent = sizeLabel
    ? `${getAttachmentTypeLabel(attachment)} · ${sizeLabel}`
    : getAttachmentTypeLabel(attachment);

  metaEl.appendChild(nameEl);
  metaEl.appendChild(typeEl);
  fileEl.appendChild(iconEl);
  fileEl.appendChild(metaEl);
  return fileEl;
}

function createMessageAttachmentNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const kind = getAttachmentKind(attachment);
  const label = getAttachmentDisplayName(attachment);
  const downloadSource = getAttachmentDownloadSource(attachment) || source;
  const renderAsFileCard = shouldRenderAttachmentAsFileCard(attachment);

  if (!renderAsFileCard && kind === "image") {
    const imgEl = document.createElement("img");
    imgEl.src = source;
    imgEl.alt = label;
    imgEl.loading = "lazy";
    imgEl.onclick = () => window.open(source, "_blank");
    return imgEl;
  }

  if (!renderAsFileCard && kind === "video") {
    const videoEl = document.createElement("video");
    videoEl.src = source;
    videoEl.controls = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    return videoEl;
  }

  if (!renderAsFileCard && kind === "audio") {
    const audioEl = document.createElement("audio");
    audioEl.src = source;
    audioEl.controls = true;
    audioEl.preload = "metadata";
    return audioEl;
  }

  const card = document.createElement("div");
  card.className = "attachment-card attachment-card-row artifact-row";
  card.title = label;
  const artifactFileId = getAttachmentArtifactFileId(attachment);
  if (artifactFileId) {
    card.dataset.artifactFileId = artifactFileId;
  }
  card.appendChild(createAttachmentFileNode(attachment));

  const downloadLink = document.createElement("a");
  const downloadLabel = typeof t === "function" ? t("action.download") : "Download";
  downloadLink.href = downloadSource;
  downloadLink.target = "_blank";
  downloadLink.rel = "noopener noreferrer";
  downloadLink.className = "attachment-download-btn attachment-download-btn--icon";
  downloadLink.title = `${downloadLabel}: ${label}`;
  downloadLink.setAttribute("aria-label", downloadLabel);
  downloadLink.download = label;
  const downloadIcon = (typeof window !== "undefined" && window.RagentIcons && typeof window.RagentIcons.render === "function") ? window.RagentIcons.render("download") : "";
  downloadLink.innerHTML = downloadIcon || downloadLabel;

  card.appendChild(downloadLink);
  return card;
}

let activeMessageImageViewer = null;
let activeMessageImageViewerBackEntryId = null;
let activeMessageImageViewerRestoreFocus = null;

function closeMessageImageViewer({ fromBack = false } = {}) {
  const viewer = activeMessageImageViewer;
  if (!viewer) return;
  const backEntryId = activeMessageImageViewerBackEntryId;
  const restoreFocus = activeMessageImageViewerRestoreFocus;
  activeMessageImageViewer = null;
  activeMessageImageViewerBackEntryId = null;
  activeMessageImageViewerRestoreFocus = null;
  document.removeEventListener("keydown", viewer._closeOnEscape, true);
  viewer.remove();
  document.body.classList.remove("message-image-viewer-open");
  if (!fromBack && backEntryId && window.RagentBackHandler?.pop) {
    window.RagentBackHandler.pop(backEntryId);
  }
  if (restoreFocus && typeof restoreFocus.focus === "function") {
    restoreFocus.focus({ preventScroll: true });
  }
}

function openMessageImageViewer({ source, downloadSource, label } = {}) {
  if (!source || !document.body) return;
  closeMessageImageViewer();
  const viewer = document.createElement("div");
  viewer.className = "message-image-viewer is-open";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", label || "Image preview");

  const toolbar = document.createElement("div");
  toolbar.className = "message-image-viewer__toolbar";

  const downloadLabel = typeof t === "function" ? t("action.download") : "Download";
  const downloadLink = document.createElement("a");
  downloadLink.className = "composer-action-btn message-image-viewer__action";
  downloadLink.href = downloadSource || source;
  downloadLink.target = "_blank";
  downloadLink.rel = "noopener noreferrer";
  downloadLink.download = label || "image";
  downloadLink.title = `${downloadLabel}: ${label || "image"}`;
  downloadLink.setAttribute("aria-label", `${downloadLabel}: ${label || "image"}`);
  const downloadIcon = window.RagentIcons?.render?.("download") || downloadLabel;
  downloadLink.innerHTML = downloadIcon;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "composer-action-btn message-image-viewer__action";
  closeButton.title = typeof t === "function" ? t("action.close") : "Close";
  closeButton.setAttribute("aria-label", closeButton.title);
  closeButton.innerHTML = window.RagentIcons?.render?.("close") || "×";
  closeButton.addEventListener("click", () => closeMessageImageViewer());
  toolbar.append(downloadLink, closeButton);

  const image = document.createElement("img");
  image.className = "message-image-viewer__image";
  image.src = source;
  image.alt = label || "";
  image.draggable = false;

  const stage = document.createElement("div");
  stage.className = "message-image-viewer__stage";
  stage.appendChild(image);
  viewer.append(toolbar, stage);
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) closeMessageImageViewer();
  });
  const closeOnEscape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeMessageImageViewer();
  };
  viewer._closeOnEscape = closeOnEscape;
  document.addEventListener("keydown", closeOnEscape, true);
  activeMessageImageViewerRestoreFocus = document.activeElement;
  activeMessageImageViewer = viewer;
  document.body.classList.add("message-image-viewer-open");
  document.body.appendChild(viewer);
  activeMessageImageViewerBackEntryId = window.RagentBackHandler?.push?.({
    id: "message-image-viewer",
    onBack: () => {
      closeMessageImageViewer({ fromBack: true });
      return true;
    },
  }) || null;
  closeButton.focus({ preventScroll: true });
}

function createDeliveryImagePreviewNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const label = getAttachmentDisplayName(attachment);
  const downloadSource = getAttachmentDownloadSource(attachment) || source;
  const tile = document.createElement("div");
  tile.className = "delivery-image-preview";
  tile.title = label;

  const image = document.createElement("img");
  image.src = source;
  image.alt = label;
  image.loading = "lazy";
  image.onclick = () => openMessageImageViewer({
    source,
    downloadSource,
    label,
  });
  tile.appendChild(image);

  const downloadLabel = typeof t === "function" ? t("action.download") : "Download";
  const downloadLink = document.createElement("a");
  downloadLink.href = downloadSource;
  downloadLink.target = "_blank";
  downloadLink.rel = "noopener noreferrer";
  downloadLink.className = "attachment-download-btn attachment-download-btn--icon delivery-image-download";
  downloadLink.title = `${downloadLabel}: ${label}`;
  downloadLink.setAttribute("aria-label", `${downloadLabel}: ${label}`);
  downloadLink.download = label;
  const downloadIcon = (typeof window !== "undefined" && window.RagentIcons && typeof window.RagentIcons.render === "function")
    ? window.RagentIcons.render("download")
    : "";
  downloadLink.innerHTML = downloadIcon || downloadLabel;
  tile.appendChild(downloadLink);
  return tile;
}

function createAttachmentDeliveryCard(evt, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const imageAttachments = attachments.filter((attachment) => getAttachmentKind(attachment) === "image");
  const fileAttachments = attachments.filter((attachment) => getAttachmentKind(attachment) !== "image");
  const singleNonImageDelivery = imageAttachments.length === 0 && fileAttachments.length === 1;
  const card = document.createElement("section");
  card.className = "delivery-card artifact-group";
  card.setAttribute("aria-label", typeof t === "function" ? t("action.download") : "Download");

  if (fileAttachments.length > 0) {
    const list = document.createElement("div");
    list.className = singleNonImageDelivery
      ? "delivery-card-files"
      : "delivery-card-files artifact-group-list";
    for (const attachment of fileAttachments) {
      const node = createMessageAttachmentNode({
        ...(attachment && typeof attachment === "object" ? attachment : {}),
        renderAs: "file",
      });
      if (!node) continue;
      node.classList.add("delivery-card-file", "artifact-row");
      list.appendChild(node);
    }
    if (list.children.length > 0) card.appendChild(list);
  }

  if (imageAttachments.length > 0) {
    const gallery = document.createElement("div");
    gallery.className = "delivery-card-images";
    gallery.setAttribute("aria-label", typeof t === "function" ? t("attachment.imagePreview") : "Image attachments");
    for (const attachment of imageAttachments) {
      const node = createDeliveryImagePreviewNode(attachment);
      if (node) gallery.appendChild(node);
    }
    if (gallery.children.length > 0) card.appendChild(gallery);
  }

  if (card.children.length === 0) return null;
  return card;
}

function createComposerAttachmentPreviewNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const kind = getAttachmentKind(attachment);
  if (kind === "image") {
    const imgEl = document.createElement("img");
    imgEl.src = source;
    imgEl.alt = getAttachmentDisplayName(attachment);
    return imgEl;
  }
  if (kind === "video") {
    const videoEl = document.createElement("video");
    videoEl.src = source;
    videoEl.muted = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    return videoEl;
  }
  return createAttachmentFileNode(attachment, { compact: true });
}

function getComposerPendingInlineStatusText(stage) {
  const key =
    stage === "uploading"
      ? "compose.inline.uploading"
      : stage === "checking"
        ? "compose.inline.checking"
        : stage === "processing"
          ? "compose.inline.processing"
          : "compose.inline.sending";
  const translated = typeof t === "function" ? t(key) : key;
  if (translated && translated !== key) {
    return translated;
  }
  switch (stage) {
    case "uploading":
      return "Uploading attachment…";
    case "checking":
      return "Sent, confirming route…";
    case "processing":
      return "Received, waiting for activity…";
    default:
      return "Sending…";
  }
}

function resolveComposerPendingInlineStatus(pendingSend) {
  const fallbackStage = pendingSend?.stage || "sending";
  const fallback = {
    text: getComposerPendingInlineStatusText(fallbackStage),
    stage: fallbackStage,
  };
  if (!pendingSend || typeof window === "undefined") {
    return fallback;
  }
  const model = window.RagentSessionStateModel;
  if (!model || typeof model.getSessionTaskFlowStage !== "function") {
    return fallback;
  }
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  const status = model.getSessionTaskFlowStage(session, {
    pendingSend,
    includeIdle: false,
  });
  if (!status?.label) {
    return fallback;
  }
  return {
    text: status.label,
    stage: status.key || fallbackStage,
  };
}

function findUserMessageNodesByRequestId(requestId) {
  if (!messagesInner || !requestId) return [];
  return Array.from(messagesInner.querySelectorAll(".msg-user"))
    .filter((node) => (
      (node.dataset?.requestId || "") === requestId
      && (!node.dataset?.sessionId || node.dataset.sessionId === currentSessionId)
    ));
}

function findCommittedUserMessageNode(requestId) {
  return findUserMessageNodesByRequestId(requestId)
    .find((node) => !node.classList.contains("msg-user-local-echo")) || null;
}

function findLocalEchoUserMessageNode(requestId) {
  return findUserMessageNodesByRequestId(requestId)
    .find((node) => node.classList.contains("msg-user-local-echo")) || null;
}

// Move the committed node's identity and content onto the optimistic echo
// element, so the element the user is watching keeps its identity through the
// sending -> committed hand-off. This is what keeps the launch flight alive:
// an Animation is bound to its element, so replacing the echo with a freshly
// built committed node would cancel the ascent mid-air and teleport the bubble
// to the dock whenever the ACK lands inside the flight (the common case on a
// fast round-trip). The long-press menu binding stays untouched: it was
// attached at echo creation with the same requestId/content the committed
// event carries, and re-attaching would stack duplicate listeners.
function adoptCommittedUserMessageIntoEcho(echoNode, committedNode) {
  if (!echoNode || !committedNode) return echoNode;
  echoNode.classList?.remove?.("msg-user-local-echo");
  for (const [key, value] of Object.entries(committedNode.dataset || {})) {
    echoNode.dataset[key] = value;
  }
  delete echoNode.dataset.sendStage;
  delete echoNode.dataset.sendAwaitingCommit;
  delete echoNode.dataset.sendBaselineSeq;
  echoNode.removeAttribute?.("aria-busy");
  const incoming = Array.from(committedNode.childNodes || committedNode.children || []);
  if (typeof echoNode.replaceChildren === "function") {
    echoNode.replaceChildren(...incoming);
  } else {
    while (echoNode.children?.length) echoNode.removeChild(echoNode.children[0]);
    for (const child of incoming) echoNode.appendChild(child);
  }
  echoNode.querySelector(".msg-user-bubble")?.classList?.remove("msg-pending");
  if (typeof attachMessageLongPressMenu === "function") {
    attachMessageLongPressMenu(echoNode, committedNode?.__ragentMessageEvent || {}, "user");
  }
  return echoNode;
}

// A run can become terminal before the persisted user message reaches the
// browser's event stream. Keep the optimistic bubble as a sent-looking
// placeholder until renderMessageInto can atomically swap in the committed
// node; otherwise the cleanup pass creates a visible message disappearance and
// the later refresh appears to "bring it back".
function markLocalEchoAwaitingCommit(requestId) {
  const wrap = findLocalEchoUserMessageNode(requestId);
  if (!wrap) return false;
  wrap.dataset.sendAwaitingCommit = "true";
  wrap.dataset.sendStage = "sent";
  wrap.removeAttribute("aria-busy");
  wrap.querySelector(".msg-user-bubble")?.classList?.remove("msg-pending");
  setComposerSendStatus(wrap, false);
  if (typeof patchComposerRetainedSendState === "function") {
    patchComposerRetainedSendState(requestId, {
      awaitingCommit: true,
      stage: "sent",
    });
  }
  return true;
}

function getProtectedComposerEchoRequestIds(keepRequestId = "", keepRequestIds = []) {
  const protectedRequestIds = new Set(
    Array.isArray(keepRequestIds) ? keepRequestIds.filter(Boolean) : [],
  );
  if (keepRequestId) protectedRequestIds.add(keepRequestId);
  if (typeof getComposerRetainedSendsState === "function") {
    for (const retainedSend of getComposerRetainedSendsState(currentSessionId)) {
      if (retainedSend?.localEcho !== false && retainedSend.requestId) {
        protectedRequestIds.add(retainedSend.requestId);
      }
    }
  }
  return protectedRequestIds;
}

function removeComposerPendingUserStatuses({ keepRequestId = "", keepRequestIds = [] } = {}) {
  if (!messagesInner) return;
  const protectedRequestIds = getProtectedComposerEchoRequestIds(keepRequestId, keepRequestIds);
  const wraps = Array.from(messagesInner.querySelectorAll(".msg-user"));
  for (const wrap of wraps) {
    if (protectedRequestIds.has(wrap.dataset?.requestId || "")) continue;
    const bubble = wrap.querySelector(".msg-user-bubble");
    const status = bubble?.querySelector?.(".msg-user-status[data-owned-by=\"composer-pending\"]");
    if (status) status.remove();
    wrap.querySelector?.(".msg-user-send-status[data-owned-by=\"composer-pending\"]")?.remove?.();
    if (wrap.classList.contains("msg-user-local-echo")) {
      if (wrap.dataset?.sendAwaitingCommit === "true") {
        wrap.querySelector(".msg-user-bubble")?.classList?.remove("msg-pending");
        continue;
      }
      wrap.remove();
      continue;
    }
    bubble?.classList?.remove("msg-pending");
  }
}

function setUserMessageStatus(wrap, text, stage = "") {
  if (!wrap) return;
  const bubble = wrap.querySelector(".msg-user-bubble");
  if (!bubble) return;
  const existing = bubble.querySelector(".msg-user-status[data-owned-by=\"composer-pending\"]");
  if (!text) {
    existing?.remove();
    bubble.classList.remove("msg-pending");
    return;
  }

  const status = existing || document.createElement("div");
  status.className = "msg-user-status";
  if (stage) status.classList.add(`msg-user-status-${stage}`);
  status.dataset.ownedBy = "composer-pending";

  let dot = status.querySelector(".msg-user-status-dot");
  if (!dot) {
    dot = document.createElement("span");
    dot.className = "msg-user-status-dot";
    status.appendChild(dot);
  }

  let label = status.querySelector(".msg-user-status-text");
  if (!label) {
    label = document.createElement("span");
    label.className = "msg-user-status-text";
    status.appendChild(label);
  }
  label.textContent = text;

  const meta = bubble.querySelector(":scope > .msg-meta");
  const timestamp = bubble.querySelector(":scope > .msg-timestamp");
  const anchor = meta || timestamp;
  if (existing) {
    existing.className = status.className;
    existing.dataset.ownedBy = status.dataset.ownedBy;
    const existingLabel = existing.querySelector(".msg-user-status-text");
    if (existingLabel) existingLabel.textContent = text;
  } else if (anchor) {
    bubble.insertBefore(status, anchor);
  } else {
    bubble.appendChild(status);
  }

  bubble.classList.add("msg-pending");
}

function setComposerSendStatus(wrap, visible) {
  if (!wrap) return;
  const existing = wrap.querySelector?.(".msg-user-send-status[data-owned-by=\"composer-pending\"]");
  if (!visible) {
    existing?.remove?.();
    return;
  }

  const status = existing || document.createElement("div");
  status.className = "msg-user-send-status";
  status.dataset.ownedBy = "composer-pending";
  status.setAttribute("role", "status");
  status.textContent = typeof t === "function"
    ? t("message.sendStatus.sending")
    : "sending";
  if (!existing) wrap.appendChild(status);
}

// Failed-send recovery (A2): a failed send leaves the local echo bubble in
// the transcript while restoreFailedSendState puts the text back into the
// composer. Give that bubble in-place retry/edit/discard actions so the
// error can be recovered at the error site instead of via a toast alone.

// A new send supersedes earlier failed echoes: drop every local echo that
// still carries the failed-recovery actions (they would act on the user's
// NEW draft), keeping the requestId being reused by a retry.
function removeStaleFailedEchoes(keepRequestId = "") {
  if (!messagesInner) return;
  const wraps = Array.from(messagesInner.querySelectorAll(".msg-user"));
  for (const wrap of wraps) {
    if (keepRequestId && (wrap.dataset?.requestId || "") === keepRequestId) continue;
    if (wrap.querySelector?.(".msg-failed-actions")) {
      wrap.remove();
    }
  }
}

function markComposerSendFailed(sessionId, requestId, { text = "", images = [] } = {}) {
  const wrap = typeof findLocalEchoUserMessageNode === "function"
    ? findLocalEchoUserMessageNode(requestId)
    : null;
  if (!wrap) return;
  const bubble = wrap.querySelector(".msg-user-bubble");
  if (!bubble) return;
  if (wrap.querySelector(".msg-failed-actions")) return;
  wrap.classList.add("msg-user--failed");
  bubble.classList.add("msg-failed");
  setComposerSendStatus(wrap, false);

  const status = document.createElement("div");
  status.className = "msg-failed-status";
  const statusDot = document.createElement("span");
  statusDot.className = "msg-failed-status-dot";
  statusDot.setAttribute("aria-hidden", "true");
  const statusText = document.createElement("span");
  statusText.className = "msg-failed-status-text";
  statusText.textContent = t("operation.state.failed");
  status.append(statusDot, statusText);

  const actions = document.createElement("div");
  actions.className = "msg-failed-actions";
  const stripFailedUi = () => {
    wrap.classList.remove("msg-user--failed");
    bubble.classList.remove("msg-failed");
    status.remove();
    actions.remove();
  };
  const refillComposerWithOriginal = () => {
    if (typeof restoreFailedSendState === "function") {
      // forceRefill: recovery acts on the failed message, not on whatever
      // the user typed into the composer after the failure.
      restoreFailedSendState(sessionId, text, images, requestId, true);
    }
  };

  const clearComposerCompletely = () => {
    if (typeof clearDraft === "function") clearDraft(sessionId);
    if (typeof replaceComposerAttachmentsSnapshot === "function") {
      replaceComposerAttachmentsSnapshot(sessionId, []);
    }
    if (typeof renderImagePreviews === "function") renderImagePreviews();
    if (typeof msgInput !== "undefined" && msgInput) {
      msgInput.value = "";
      if (typeof autoResizeInput === "function") autoResizeInput();
      if (typeof saveDraft === "function") saveDraft();
    }
  };

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "msg-retry-btn";
  retryButton.textContent = t("message.retry");
  retryButton.addEventListener("click", () => {
    stripFailedUi();
    // Keep the echo node: resending with the same requestId reuses it as the
    // live pending echo instead of stacking a second copy.
    if (typeof currentSessionId !== "undefined" && sessionId === currentSessionId) {
      refillComposerWithOriginal();
      if (typeof focusComposer === "function") focusComposer({ force: true });
      if (typeof sendMessage === "function") sendMessage(requestId);
    } else {
      wrap.remove();
      if (typeof focusComposer === "function") focusComposer({ force: true });
    }
  });

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "msg-edit-btn";
  editButton.textContent = t("message.editAndResend");
  editButton.addEventListener("click", () => {
    stripFailedUi();
    wrap.remove();
    refillComposerWithOriginal();
    if (typeof focusComposer === "function") focusComposer({ force: true });
  });

  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.className = "msg-discard-btn";
  discardButton.textContent = t("message.discard");
  discardButton.addEventListener("click", () => {
    stripFailedUi();
    wrap.remove();
    // Discard means the user gave up on this message: clear the restored
    // composer state too (stored draft, attachments, and the visible input),
    // otherwise pressing Send would re-send exactly what was just discarded.
    clearComposerCompletely();
    if (typeof focusComposer === "function") focusComposer({ force: true });
  });

  actions.append(retryButton, editButton, discardButton);
  wrap.append(status, actions);
}

function shouldCollapseUserMessageContent(content) {
  const text = typeof content === "string" ? content : "";
  const lineBreaks = (text.match(/\n/g) || []).length;
  return text.length > 220
    || lineBreaks >= 5
    || text.includes("```")
    || (text.includes("|") && lineBreaks >= 3);
}

function appendUserMessageDisclosure(bubble, contentNode, content) {
  if (!shouldCollapseUserMessageContent(content)) return;

  contentNode.classList.add("msg-user-content--collapsed");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "msg-user-disclosure";
  toggle.setAttribute("aria-expanded", "false");

  const sync = (expanded) => {
    contentNode.classList.toggle("msg-user-content--collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? t("message.collapse") : t("message.expand");
  };

  sync(false);
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    sync(toggle.getAttribute("aria-expanded") !== "true");
  });
  bubble.appendChild(toggle);
}

function createUserMessageNode(evt, {
  pending = false,
  localEcho = false,
  statusText = "",
  statusStage = "",
} = {}) {
  const wrap = document.createElement("div");
  wrap.className = "msg-user";
  if (localEcho) {
    wrap.classList.add("msg-user-local-echo");
  }
  setMessageForkBoundary(wrap, evt);
  if (evt?.requestId) {
    wrap.dataset.requestId = evt.requestId;
  }
  if (currentSessionId) {
    wrap.dataset.sessionId = currentSessionId;
  }
  if (evt?.runId) {
    wrap.dataset.runId = String(evt.runId);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-user-bubble";
  if (pending) {
    bubble.classList.add("msg-pending");
  }

  const userAttachments = Array.isArray(evt?.attachments) && evt.attachments.length > 0
    ? evt.attachments
    : (Array.isArray(evt?.images) ? evt.images : []);
  if (userAttachments.length > 0) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "msg-images";
    for (const img of userAttachments) {
      const attachmentNode = createMessageAttachmentNode(img);
      if (!attachmentNode) continue;
      imgWrap.appendChild(attachmentNode);
    }
    // Attachments are a companion to the sent turn, not part of the text
    // surface. Keeping the strip as a sibling also lets it align independently
    // on narrow screens without changing the bubble's text width.
    if (imgWrap.children.length > 0) {
      wrap.appendChild(imgWrap);
    }
  }
  if (evt?.content || evt?.bodyAvailable || (Array.isArray(evt?.asyncQuestionReplies) && evt.asyncQuestionReplies.length > 0)) {
    const preview = evt.content || evt.bodyPreview || "";
    const parsedReply = typeof parseQuestionReplyEnvelopeCompat === "function"
      ? parseQuestionReplyEnvelopeCompat(preview)
      : (typeof parseQuestionReplyEnvelope === "function"
        ? parseQuestionReplyEnvelope(preview)
        : (() => {
            if (!preview || !/<send_user_message_question_reply\b/i.test(preview)) {
              return { hasEnvelope: false, replies: [], trailingText: preview };
            }
            const replies = [];
            const stripped = preview.replace(
              /<send_user_message_question_reply\b[^>]*>([\s\S]*?)<\/send_user_message_question_reply>/gi,
              (_m, inner) => {
                try {
                  const json = JSON.parse(String(inner || "").trim());
                  const arr = Array.isArray(json) ? json : (Array.isArray(json?.replies) ? json.replies : [json]);
                  for (const item of arr) {
                    if (!item || typeof item !== "object") continue;
                    const q = String(item.question ?? item.prompt ?? "").trim();
                    const a = String(item.answer ?? item.reply ?? "").trim();
                    if (q || a) replies.push({ questionItemId: String(item.questionItemId || ""), question: q, answer: a });
                  }
                } catch {
                  // ignore
                }
                return "\n";
              }
            );
            return { hasEnvelope: true, replies, trailingText: stripped.replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n") };
          })());
    const replyItems = parsedReply.hasEnvelope && parsedReply.replies.length > 0
      ? parsedReply.replies
      : (Array.isArray(evt?.asyncQuestionReplies) ? evt.asyncQuestionReplies : []);
    if (replyItems.length > 0) {
      const replyList = document.createElement("div");
      replyList.className = "user-question-reply-list";
      for (const item of replyItems) {
        const chip = document.createElement("div");
        chip.className = "user-question-reply-chip";
        if (item.questionItemId) chip.dataset.questionItemId = item.questionItemId;
        const qLabel = document.createElement("div");
        qLabel.className = "user-question-reply-chip__question";
        qLabel.textContent = String(
          item.question
          || (typeof uiTranslate === "function" ? uiTranslate("asyncQuestion.replyChipTitle", null, "Answered question") : "Answered question")
        );
        const aVal = document.createElement("div");
        aVal.className = "user-question-reply-chip__answer";
        aVal.textContent = String(item.answer || "");
        chip.appendChild(qLabel);
        chip.appendChild(aVal);
        replyList.appendChild(chip);
      }
      bubble.appendChild(replyList);
    }

    const visiblePreview = parsedReply.hasEnvelope ? parsedReply.trailingText : preview;
    let span = null;
    if (visiblePreview) {
      span = document.createElement("span");
      span.className = "md-content";
      if (typeof renderMarkdownIntoNode === "function" && renderMarkdownIntoNode(span, visiblePreview)) {
        // markdown rendered successfully
      } else {
        span.textContent = typeof formatDecodedDisplayText === "function"
          ? formatDecodedDisplayText(visiblePreview)
          : visiblePreview;
      }
      bubble.appendChild(span);
      appendUserMessageDisclosure(bubble, span, visiblePreview);
    }
    if (span && markLazyEventBodyNode(span, evt, {
      preview: evt.bodyPreview || evt.content || "",
      renderMode: "markdown",
    })) {
      if (typeof queueHydrateLazyNodes === "function") {
        queueHydrateLazyNodes(wrap);
      }
    }
  }

  if (typeof appendMessageMeta === "function") {
    appendMessageMeta(bubble, evt, "user");
  } else if (typeof appendMessageTimestamp === "function") {
    appendMessageTimestamp(bubble, evt?.timestamp, "msg-user-time");
  }
  wrap.appendChild(bubble);
  if (statusText) {
    setUserMessageStatus(wrap, statusText, statusStage);
  }
  if (typeof attachMessageLongPressMenu === "function") {
    attachMessageLongPressMenu(wrap, evt, "user");
  }
  return wrap;
}

function createAssistantPendingNode({ requestId = "", sessionId = currentSessionId } = {}) {
  removeAssistantPendingNode({ immediate: true });
  if (!messagesInner || typeof document === "undefined") return null;
  // The send window shows the same three-dot "Working…" action row that backs
  // the live activity line — not a skeleton card. syncMobileLiveActivityLine
  // adopts this very node once the run goes live, so there is no swap (and no
  // indicator gap) when the send commits and the run starts.
  const node = buildMobileLiveActivityLineRow();
  node.id = "msgAssistantPending";
  if (requestId) node.dataset.requestId = requestId;
  if (sessionId) node.dataset.sessionId = sessionId;
  const label = node.querySelector(".mobile-live-activity-line__label");
  if (label) label.textContent = getMobileLiveActivityFallbackText();
  return node;
}

function removeAssistantPendingNode({ immediate = false } = {}) {
  if (typeof document === "undefined") return;
  const existing = document.getElementById("msgAssistantPending");
  if (!existing) return;
  // If the run already went live, the working row is handed over to the live
  // activity line instead of being torn down: sync adopts the node and clears
  // its id, so the indicator persists seamlessly across the send-to-run seam.
  if (typeof syncMobileLiveActivityLine === "function") {
    syncMobileLiveActivityLine();
  }
  if (!document.getElementById("msgAssistantPending")) return;
  if (immediate) {
    existing.remove();
    return;
  }
  existing.classList.add("is-leaving");
  setTimeout(() => {
    if (existing && existing.parentNode) existing.remove();
    // The fade-out only toggled paint properties; this delayed removal is the
    // moment real layout height disappears. The turn runway is computed with
    // zero slack (scrollHeight - clientHeight === scrollTop), so without
    // re-syncing here the browser clamps scrollTop and the transcript dips by
    // exactly the pending row's height right after the send commits.
    if (typeof syncTurnViewportSpacerOnGrowth === "function") {
      syncTurnViewportSpacerOnGrowth();
    }
  }, 140);
}

function getOrCreateTurnViewportSpacer() {
  if (!messagesInner || typeof document === "undefined") return null;
  let spacer = document.getElementById("turnViewportSpacer");
  if (!spacer) {
    spacer = document.createElement("div");
    spacer.id = "turnViewportSpacer";
    spacer.className = "turn-viewport-spacer";
    spacer.setAttribute("aria-hidden", "true");
  }
  if (spacer.parentNode !== messagesInner || messagesInner.lastElementChild !== spacer) {
    messagesInner.appendChild(spacer);
  }
  return spacer;
}

function removeTurnViewportSpacer({ immediate = false } = {}) {
  if (typeof document === "undefined") return;
  const spacer = document.getElementById("turnViewportSpacer");
  if (!spacer) return;
  if (immediate) {
    spacer.remove();
    return;
  }
  if (spacer.style) {
    spacer.style.height = "0px";
  }
  setTimeout(() => {
    if (spacer && spacer.parentNode && (!spacer.style || spacer.style.height === "0px")) {
      spacer.remove();
    }
  }, 240);
}

const TOP_DOCK_MARGIN_PX = 24;

function getActiveTurnSpacerHeight(userNode, pendingNode) {
  if (typeof messagesEl === "undefined" || !messagesEl || !userNode) return 0;
  const clientH = Number(messagesEl.clientHeight) || 0;
  if (clientH <= 0) return 0;
  const userH = Number(userNode?.offsetHeight) || 56;
  const pendingH = pendingNode ? (Number(pendingNode.offsetHeight) || 60) : 0;
  const userTop = Number(userNode?.offsetTop) || 0;
  const targetScrollTop = Math.max(0, userTop - TOP_DOCK_MARGIN_PX);
  const contentBottom = userTop + userH + pendingH;
  const minNeededScrollHeight = targetScrollTop + clientH;
  return Math.max(0, minNeededScrollHeight - contentBottom);
}

function dockTurnToTop(wrap) {
  if (!wrap || typeof messagesEl === "undefined" || !messagesEl) return;
  const userTop = Number(wrap.offsetTop) || 0;
  const targetScrollTop = Math.max(0, userTop - TOP_DOCK_MARGIN_PX);
  if (typeof markMessageViewportProgrammaticScroll === "function") {
    markMessageViewportProgrammaticScroll();
  }
  messagesEl.scrollTop = targetScrollTop;
  if (typeof syncMessageViewportStabilitySnapshot === "function") {
    syncMessageViewportStabilitySnapshot();
  }
}

function syncTurnViewportSpacerOnGrowth() {
  if (typeof document === "undefined" || typeof messagesEl === "undefined" || !messagesEl || !messagesInner) return null;
  const clientH = Number(messagesEl.clientHeight) || 0;
  if (clientH <= 0) return null;

  const spacer = document.getElementById("turnViewportSpacer");
  if (!spacer || !spacer.style) return null;

  if (messagesInner.lastElementChild !== spacer) {
    messagesInner.appendChild(spacer);
  }

  let latestUserNode = null;
  for (let i = messagesInner.children.length - 1; i >= 0; i--) {
    const child = messagesInner.children[i];
    if (child === spacer) continue;
    if (child.classList?.contains("msg-user")) {
      latestUserNode = child;
      break;
    }
  }
  if (!latestUserNode) return null;

  const topY = Number(latestUserNode.offsetTop) || 0;
  const targetScrollTop = Math.max(0, topY - TOP_DOCK_MARGIN_PX);

  const prevChild = spacer.previousElementSibling;
  const bottomY = (prevChild && prevChild !== latestUserNode)
    ? (Number(prevChild.offsetTop) + (Number(prevChild.offsetHeight) || 0))
    : (topY + (Number(latestUserNode.offsetHeight) || 0));

  const turnContentHeight = Math.max(0, bottomY - topY);
  const turnHeightInViewport = turnContentHeight + TOP_DOCK_MARGIN_PX;
  const filledScreen = turnHeightInViewport > clientH;

  const isDetached = typeof isStreamingUserScrollDetached === "function"
    ? isStreamingUserScrollDetached()
    : false;

  if (!filledScreen) {
    const remaining = Math.max(0, clientH - turnHeightInViewport);
    spacer.style.height = `${remaining}px`;
    if (!isDetached) {
      if (typeof markMessageViewportProgrammaticScroll === "function") {
        markMessageViewportProgrammaticScroll();
      }
      messagesEl.scrollTop = targetScrollTop;
      if (typeof syncMessageViewportStabilitySnapshot === "function") {
        syncMessageViewportStabilitySnapshot();
      }
    }
  } else {
    spacer.style.height = "0px";
    if (!isDetached) {
      if (typeof markMessageViewportProgrammaticScroll === "function") {
        markMessageViewportProgrammaticScroll();
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (typeof syncMessageViewportStabilitySnapshot === "function") {
        syncMessageViewportStabilitySnapshot();
      }
    }
  }

  return {
    handled: true,
    filledScreen,
    targetScrollTop,
    remaining: !filledScreen ? Math.max(0, clientH - turnHeightInViewport) : 0,
  };
}

function launchUserMessageToTop(wrap, { sessionId = currentSessionId } = {}) {
  if (!wrap) return;
  const composerEl = typeof document !== "undefined"
    ? (document.getElementById("inputArea") || document.getElementById("composerEditor"))
    : null;
  const composerRect = typeof composerEl?.getBoundingClientRect === "function"
    ? composerEl.getBoundingClientRect()
    : null;
  const wrapRect = typeof wrap.getBoundingClientRect === "function"
    ? wrap.getBoundingClientRect()
    : null;

  const reducedMotion = typeof prefersReducedScrollMotion === "function"
    ? prefersReducedScrollMotion()
    : (typeof window?.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  if (reducedMotion) {
    return;
  }

  if (composerRect && wrapRect) {
    const launchDeltaY = Math.max(0, composerRect.top - wrapRect.top);
    // Imperative Web-Animations flight instead of a CSS class + keyframe pair.
    // A class here has to be scrubbed by animationend/timeout races and its
    // removal re-triggers the base entry animation; an Animation object simply
    // ends at the element's natural (docked) position with nothing to unwind,
    // and it survives the sending -> committed swap because the element itself
    // is never replaced (see adoptCommittedUserMessageIntoEcho).
    if (launchDeltaY > 8 && typeof wrap.animate === "function") {
      const flight = wrap.animate(
        [
          { opacity: 0.88, transform: `translateY(${Math.round(launchDeltaY)}px) scale(0.96)` },
          { opacity: 1, offset: 0.5 },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        {
          duration: 380,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        },
      );

      // The transcript can grow while the flight is in progress (ACK, the
      // shared working row, keyboard/viewport changes).  Those layout changes
      // can move the element after the initial measurement, so explicitly
      // settle against the latest offset instead of trusting the old natural
      // position at the animation's end.
      if (flight && flight.finished && typeof flight.finished.then === "function") {
        Promise.resolve(flight.finished)
          .then(() => {
            if (wrap.parentNode && sessionId === currentSessionId) {
              dockTurnToTop(wrap);
            }
          })
          .catch(() => {});
      }
    }
  }
}

if (typeof window !== "undefined") {
  window.createAssistantPendingNode = createAssistantPendingNode;
  window.removeAssistantPendingNode = removeAssistantPendingNode;
  window.getOrCreateTurnViewportSpacer = getOrCreateTurnViewportSpacer;
  window.removeTurnViewportSpacer = removeTurnViewportSpacer;
  window.syncTurnViewportSpacerOnGrowth = syncTurnViewportSpacerOnGrowth;
  window.launchUserMessageToTop = launchUserMessageToTop;
  window.dockTurnToTop = dockTurnToTop;

  const onViewportResizeSyncSpacer = () => {
    if (typeof syncTurnViewportSpacerOnGrowth === "function") {
      syncTurnViewportSpacerOnGrowth();
    }
  };
  if (typeof window.addEventListener === "function") {
    window.addEventListener("resize", onViewportResizeSyncSpacer, { passive: true });
  }
  if (typeof window.visualViewport?.addEventListener === "function") {
    window.visualViewport.addEventListener("resize", onViewportResizeSyncSpacer, { passive: true });
  }
}

function insertComposerLocalEcho({
  requestId = "",
  text = "",
  images = [],
  sessionId = currentSessionId,
  baselineEventSeq = null,
  scroll = true,
}) {
  if (!requestId || !messagesInner || typeof createUserMessageNode !== "function") return false;
  if (sessionId && sessionId !== currentSessionId) return false;
  if (findLocalEchoUserMessageNode(requestId) || findCommittedUserMessageNode(requestId)) return false;
  // Keep transport feedback outside the bubble so the message content remains
  // readable while the optimistic echo is waiting for its committed event.
  const wrap = createUserMessageNode(
    { requestId, content: text, images },
    {
      pending: true,
      localEcho: true,
    },
  );
  if (!wrap) return false;
  wrap.dataset.sessionId = sessionId || currentSessionId || "";
  wrap.dataset.sendStage = "sending";
  const pendingBaseline = typeof getComposerPendingSendSnapshot === "function"
    ? getComposerPendingSendSnapshot()?.baselineEventSeq
    : null;
  const resolvedBaseline = Number.isInteger(baselineEventSeq) && baselineEventSeq >= 0
    ? baselineEventSeq
    : Number.isInteger(pendingBaseline) && pendingBaseline >= 0
      ? pendingBaseline
      : 0;
  wrap.dataset.sendBaselineSeq = String(resolvedBaseline);
  wrap.setAttribute("aria-busy", "true");
  setComposerSendStatus(wrap, true);
  if (emptyState?.parentNode === messagesInner) emptyState.remove();
  messagesInner.appendChild(wrap);
  const pendingAssistant = createAssistantPendingNode({ requestId, sessionId });
  if (pendingAssistant) {
    messagesInner.appendChild(pendingAssistant);
  }
  const spacerHeight = getActiveTurnSpacerHeight(wrap, pendingAssistant);
  if (spacerHeight > 0) {
    const spacer = getOrCreateTurnViewportSpacer();
    if (spacer && spacer.style) {
      spacer.style.height = `${spacerHeight}px`;
    }
  }
  if (scroll) {
    dockTurnToTop(wrap);
    if (typeof launchUserMessageToTop === "function") {
      launchUserMessageToTop(wrap, { sessionId });
    }
  }
  return true;
}

function ensureLocalEchoAwaitingCommit(requestId) {
  if (!requestId || typeof currentSessionId !== "string") return false;
  let localEchoNode = findLocalEchoUserMessageNode(requestId);
  if (!localEchoNode && typeof getComposerRetainedSendState === "function") {
    const retainedSend = getComposerRetainedSendState(requestId);
    if (
      retainedSend?.localEcho !== false
      && retainedSend.sessionId === currentSessionId
      && typeof insertComposerLocalEcho === "function"
    ) {
      insertComposerLocalEcho({
        requestId,
        text: retainedSend.text || "",
        images: retainedSend.images || [],
        sessionId: currentSessionId,
        baselineEventSeq: retainedSend.baselineEventSeq,
        scroll: false,
      });
      localEchoNode = findLocalEchoUserMessageNode(requestId);
    }
  }
  return !!localEchoNode && markLocalEchoAwaitingCommit(requestId);
}

function restoreComposerRetainedEchoesForCurrentSession() {
  if (typeof getComposerRetainedSendsState !== "function") return false;
  let restored = false;
  for (const retainedSend of getComposerRetainedSendsState(currentSessionId)) {
    if (retainedSend?.localEcho === false || !retainedSend.requestId) continue;
    if (findCommittedUserMessageNode(retainedSend.requestId)) {
      if (typeof clearComposerRetainedSendState === "function") {
        clearComposerRetainedSendState(retainedSend.requestId);
      }
      continue;
    }
    if (ensureLocalEchoAwaitingCommit(retainedSend.requestId)) restored = true;
  }
  return restored;
}

function syncComposerPendingTurnFeedback() {
  if (!messagesInner) return;
  const pendingSend = typeof getComposerPendingSendSnapshot === "function"
    ? getComposerPendingSendSnapshot()
    : null;
  const activePending = pendingSend && pendingSend.sessionId === currentSessionId
    ? pendingSend
    : null;

  if (!activePending?.requestId) {
    removeComposerPendingUserStatuses({
      keepRequestIds: getProtectedComposerEchoRequestIds(),
    });
    removeAssistantPendingNode();
    if (typeof syncTurnViewportSpacerOnGrowth === "function") {
      syncTurnViewportSpacerOnGrowth();
    }
    if (typeof syncEditableMessageActions === "function") {
      syncEditableMessageActions();
    }
    return;
  }

  const requestId = activePending.requestId;
  removeComposerPendingUserStatuses({
    keepRequestId: requestId,
    keepRequestIds: getProtectedComposerEchoRequestIds(requestId),
  });

  const committedNode = findCommittedUserMessageNode(requestId);
  const localEchoNode = findLocalEchoUserMessageNode(requestId);
  if (committedNode) {
    if (localEchoNode) {
      localEchoNode.remove();
    }
    removeAssistantPendingNode();
    committedNode.classList.remove("msg-user-local-echo");
    delete committedNode.dataset.sendStage;
    committedNode.removeAttribute("aria-busy");
    committedNode.querySelector(".msg-user-bubble")?.classList?.remove("msg-pending");
    if (typeof clearComposerRetainedSendState === "function") {
      clearComposerRetainedSendState(requestId);
    }
    if (typeof syncTurnViewportSpacerOnGrowth === "function") {
      syncTurnViewportSpacerOnGrowth();
    }
    if (typeof syncEditableMessageActions === "function") {
      syncEditableMessageActions();
    }
    return;
  }

  // The optimistic echo is still uncommitted — keep it (no inline status
  // text by user preference) until the server-committed node replaces it.
  if (localEchoNode) {
    const stage = typeof activePending.stage === "string" && activePending.stage.trim()
      ? activePending.stage.trim()
      : "sending";
    localEchoNode.dataset.sendStage = stage;
    localEchoNode.setAttribute("aria-busy", "true");
    setComposerSendStatus(localEchoNode, stage === "sending");
  }
  if (typeof syncEditableMessageActions === "function") {
    syncEditableMessageActions();
  }
}

// ---- Render functions ----
function getAssistantRunMergeKeyForRender(evt) {
  if (!(evt && typeof evt === "object")) return "";
  if (evt.type === "attachment_delivery") return "";
  if (evt.role !== "assistant") return "";
  const runId = typeof evt.runId === "string" ? evt.runId.trim() : "";
  if (runId) return `run:${runId}`;
  const requestId = typeof evt.requestId === "string" ? evt.requestId.trim() : "";
  if (requestId) return `request:${requestId}`;
  const responseId = typeof evt.responseId === "string" ? evt.responseId.trim() : "";
  if (responseId) return `response:${responseId}`;
  return "";
}

function hasElementClass(node, className) {
  const classText = typeof node?.className === "string" ? node.className : "";
  return ` ${classText} `.includes(` ${className} `);
}

function getDirectChildByClass(node, className) {
  for (const child of Array.from(node?.children || [])) {
    if (hasElementClass(child, className)) return child;
  }
  return null;
}

function isAssistantRunMergeBoundaryNode(node) {
  return hasElementClass(node, "msg-user") || hasElementClass(node, "thinking-block");
}

function findAssistantRunMergeNode(container, mergeKey) {
  if (!container || !mergeKey) return null;
  const children = Array.from(container.children || []);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (isAssistantRunMergeBoundaryNode(child)) return null;
    if (child?.dataset?.assistantRunMergeKey === mergeKey) return child;
  }
  return null;
}

function insertAssistantBubbleChildBeforeMeta(bubble, child) {
  const anchor = getDirectChildByClass(bubble, "msg-images")
    || getDirectChildByClass(bubble, "msg-meta")
    || getDirectChildByClass(bubble, "msg-timestamp");
  if (anchor && typeof bubble.insertBefore === "function") {
    bubble.insertBefore(child, anchor);
    return;
  }
  bubble.appendChild(child);
}

function renderAssistantMergedContent(bubble, content) {
  if (!bubble) return false;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return false;
  // Authoritative full merges replace any previously appended segments.
  if (typeof bubble.querySelectorAll === "function") {
    for (const segment of Array.from(bubble.querySelectorAll(".msg-assistant-body"))) {
      segment.remove();
    }
  }
  let body = getDirectChildByClass(bubble, "msg-assistant-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "msg-assistant-body";
    insertAssistantBubbleChildBeforeMeta(bubble, body);
  }
  if (typeof renderMarkdownIntoNode === "function" && renderMarkdownIntoNode(body, text)) {
    return true;
  }
  body.textContent = text;
  return true;
}

function renderAssistantMergedContentSegment(bubble, content) {
  if (!bubble) return false;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return false;
  // Incremental merge: render only the new part into its own body segment so
  // a long multi-part run does not re-render the whole accumulated markdown.
  const segment = document.createElement("div");
  segment.className = "msg-assistant-body";
  let didRender = false;
  if (typeof renderMarkdownIntoNode === "function" && renderMarkdownIntoNode(segment, text)) {
    didRender = true;
  } else {
    segment.textContent = text;
    didRender = true;
  }
  if (didRender) {
    insertAssistantBubbleChildBeforeMeta(bubble, segment);
  }
  return didRender;
}

function getAssistantMessageRenderAttachments(evt) {
  return Array.isArray(evt?.attachments) && evt.attachments.length > 0
    ? evt.attachments
    : (Array.isArray(evt?.images) ? evt.images : []);
}

function getAttachmentRenderIdentity(attachment, index = 0) {
  if (!(attachment && typeof attachment === "object")) return `unknown:${index}`;
  const assetId = typeof attachment.assetId === "string" ? attachment.assetId.trim() : "";
  if (assetId) return `asset:${assetId}`;
  const downloadUrl = typeof attachment.downloadUrl === "string" ? attachment.downloadUrl.trim() : "";
  if (downloadUrl) return `download:${downloadUrl}`;
  const filename = typeof attachment.filename === "string" ? attachment.filename.trim() : "";
  if (filename) return `filename:${filename}`;
  const originalName = typeof attachment.originalName === "string" ? attachment.originalName.trim() : "";
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
  return `meta:${originalName}:${mimeType}:${index}`;
}

function appendAssistantAttachmentsToBubble(bubble, attachments) {
  if (!bubble || !Array.isArray(attachments) || attachments.length === 0) return false;
  let imgWrap = getDirectChildByClass(bubble, "msg-images");
  if (!imgWrap) {
    imgWrap = document.createElement("div");
    imgWrap.className = "msg-images";
    insertAssistantBubbleChildBeforeMeta(bubble, imgWrap);
  }
  const seen = new Set(String(bubble.dataset.assistantAttachmentKeys || "").split("|").filter(Boolean));
  let appended = false;
  for (const attachment of attachments) {
    const identity = getAttachmentRenderIdentity(attachment, seen.size);
    if (identity && seen.has(identity)) continue;
    const attachmentNode = createMessageAttachmentNode(attachment);
    if (!attachmentNode) continue;
    imgWrap.appendChild(attachmentNode);
    if (identity) seen.add(identity);
    appended = true;
  }
  bubble.dataset.assistantAttachmentKeys = Array.from(seen).join("|");
  return appended;
}

const ASSISTANT_SNAPSHOT_OVERLAP_MIN_CHARS = 12;
const ASSISTANT_SNAPSHOT_OVERLAP_SCAN_CAP = 2000;

// Mirrors chat/session-display-events.mjs chainSnapshotBodiesRelate: a live
// Claude finalized snapshot whose body is contained in — or shifted-overlapped
// with — the bubble's accumulated text is a relay re-emission revision, not a
// second message.
function assistantSnapshotBodiesRelate(previousText, nextText) {
  if (!previousText || !nextText) return false;
  if (previousText === nextText
    || previousText.includes(nextText)
    || nextText.includes(previousText)) return true;
  const shorterLength = Math.min(previousText.length, nextText.length);
  if (shorterLength < ASSISTANT_SNAPSHOT_OVERLAP_MIN_CHARS * 2) return false;
  const scanCap = Math.min(ASSISTANT_SNAPSHOT_OVERLAP_SCAN_CAP, previousText.length, nextText.length);
  let overlap = 0;
  for (const [left, right] of [[previousText, nextText], [nextText, previousText]]) {
    for (let k = scanCap; k >= ASSISTANT_SNAPSHOT_OVERLAP_MIN_CHARS; k -= 1) {
      if (left.slice(left.length - k) === right.slice(0, k)) {
        overlap = Math.max(overlap, k);
        break;
      }
    }
  }
  return overlap >= ASSISTANT_SNAPSHOT_OVERLAP_MIN_CHARS && overlap * 2 >= shorterLength;
}

function mergeAssistantMessageIntoExistingBubble(
  container,
  bubble,
  evt,
  attachments,
  { preservePosition = false } = {},
) {
  if (!container || !bubble) return null;
  const previous = typeof bubble.dataset.assistantRunMergedContent === "string"
    ? bubble.dataset.assistantRunMergedContent.trim()
    : "";
  const nextPart = typeof evt?.content === "string" ? evt.content.trim() : "";
  const authoritativeMergedContent = evt?.mergedAssistantRunMessage === true;
  // Claude finalized-assistant snapshots can re-arrive under a fresh provider
  // id (relay re-emission) as an identical, truncated, or extended body. That
  // is a revision of what this bubble already shows: replace with the longer
  // text instead of appending a duplicate-looking second segment. Unrelated
  // bodies keep the existing multi-part append behavior.
  const snapshotRevision = evt?.providerSnapshotKind === "finalized-assistant"
    && Boolean(previous)
    && Boolean(nextPart)
    && assistantSnapshotBodiesRelate(previous, nextPart);
  const mergedContent = authoritativeMergedContent
    ? (nextPart || previous)
    : snapshotRevision
    ? (nextPart.length >= previous.length ? nextPart : previous)
    : previous && nextPart && previous !== nextPart
    ? `${previous}\n\n${nextPart}`
    : (nextPart || previous);
  if (mergedContent) {
    bubble.dataset.assistantRunMergedContent = mergedContent;
    if (authoritativeMergedContent || (snapshotRevision && mergedContent !== previous)) {
      renderAssistantMergedContent(bubble, mergedContent);
    } else if (!snapshotRevision && nextPart && previous !== nextPart) {
      renderAssistantMergedContentSegment(bubble, nextPart);
    }
  }
  appendAssistantAttachmentsToBubble(bubble, attachments);
  if (typeof isAssistantMessageLive === "function" && isAssistantMessageLive(bubble) && bubble.classList?.add) {
    bubble.classList.add("is-live");
  }
  if (!preservePosition && container.lastElementChild !== bubble) {
    container.appendChild(bubble);
  }
  return bubble;
}

function renderMessageInto(container, evt, {
  finalizeActiveThinkingBlock = false,
  mergeAssistantRunMessages = true,
  preservePosition = false,
  deferEnhance = false,
} = {}) {
  if (!container) return null;
  const role = evt.role || "assistant";

  if (finalizeActiveThinkingBlock && inThinkingBlock) {
    finalizeThinkingBlock();
  }

  if (role === "user") {
    const requestId = typeof evt?.requestId === "string" ? evt.requestId.trim() : "";
    const committedNode = requestId && typeof findCommittedUserMessageNode === "function"
      ? findCommittedUserMessageNode(requestId)
      : null;
    if (committedNode) {
      if (typeof clearComposerRetainedSendState === "function") {
        clearComposerRetainedSendState(requestId);
      }
      if (typeof syncEditableMessageActions === "function") {
        syncEditableMessageActions();
      }
      return committedNode;
    }
    const localEcho = requestId && typeof findLocalEchoUserMessageNode === "function"
      ? findLocalEchoUserMessageNode(requestId)
      : null;
    const wrap = createUserMessageNode(evt);
    if (localEcho && localEcho.parentNode === container) {
      // Upgrade the optimistic echo in place instead of swapping nodes: one
      // element owns the whole journey (echo -> committed), so the launch
      // flight is never cancelled and no paint ever shows both bubbles.
      adoptCommittedUserMessageIntoEcho(localEcho, wrap);
      if (requestId && typeof clearComposerRetainedSendState === "function") {
        clearComposerRetainedSendState(requestId);
      }
      if (typeof syncEditableMessageActions === "function") {
        syncEditableMessageActions();
      }
      return localEcho;
    }
    container.appendChild(wrap);
    if (requestId && typeof clearComposerRetainedSendState === "function") {
      clearComposerRetainedSendState(requestId);
    }
    if (typeof syncEditableMessageActions === "function") {
      syncEditableMessageActions();
    }
    return wrap;
  }

  // Server-side per-message system prompts (e.g. skill-usage reminders that
  // the agent's app config attaches to every assistant reply) render as a
  // compact note instead of a chat bubble.
  if (role === "system") {
    const content = typeof evt?.content === "string" ? evt.content.trim() : "";
    if (!content) return null;
    const note = document.createElement("div");
    note.className = "msg-system-note";
    note.textContent = content;
    container.appendChild(note);
    return note;
  } else {
    const div = document.createElement("div");
    div.className = "msg-assistant md-content";
    const assistantAttachments = getAssistantMessageRenderAttachments(evt);
    const hasAttachments = assistantAttachments.length > 0;
    if (!evt.content && !evt.bodyAvailable && !hasAttachments) {
      return null;
    }

    if (evt.type === "attachment_delivery") {
      const deliveryCard = createAttachmentDeliveryCard(evt, assistantAttachments);
      if (!deliveryCard) return null;
      div.classList.add("msg-delivery");
      div.appendChild(deliveryCard);
      if (typeof appendMessageMeta === "function") {
        appendMessageMeta(div, evt, "assistant", {
          live: false,
        });
      } else if (typeof appendMessageTimestamp === "function") {
        appendMessageTimestamp(div, evt.timestamp, "msg-assistant-time");
      }
      container.appendChild(div);
      if (typeof syncRegenerateActions === "function") {
        syncRegenerateActions();
      }
      return div;
    }

    const mergeKey = getAssistantRunMergeKeyForRender(evt);
    const existingRunBubble = mergeAssistantRunMessages
      ? findAssistantRunMergeNode(container, mergeKey)
      : null;
    if (existingRunBubble) {
      setMessageForkBoundary(existingRunBubble, evt);
      return mergeAssistantMessageIntoExistingBubble(
        container,
        existingRunBubble,
        evt,
        assistantAttachments,
        { preservePosition },
      );
    }
    if (mergeKey) {
      div.dataset.assistantRunMergeKey = mergeKey;
      div.dataset.assistantRunMergedContent = typeof evt.content === "string" ? evt.content.trim() : "";
    }
    if (evt?.requestId) {
      div.dataset.requestId = String(evt.requestId);
    }
    setMessageForkBoundary(div, evt);
    if (evt?.runId) {
      div.dataset.runId = String(evt.runId);
    }

    if (evt.content || evt.bodyAvailable) {
      const content = document.createElement("div");
      content.className = "msg-assistant-body";
      let shouldAppendContent = false;
      if (evt.content) {
        const didRender = renderMarkdownIntoNode(content, evt.content, { deferEnhance });
        if (didRender) {
          shouldAppendContent = true;
        } else if (!hasAttachments) {
          return null;
        }
      } else if (evt.bodyAvailable) {
        if (evt.bodyPreview) {
          renderMarkdownIntoNode(content, evt.bodyPreview, { deferEnhance });
        }
        shouldAppendContent = true;
      }
      if (shouldAppendContent) {
        div.appendChild(content);
      }
      if (markLazyEventBodyNode(content, evt, {
        preview: evt.bodyPreview || "",
        renderMode: "markdown",
      })) {
        if (typeof queueHydrateLazyNodes === "function") {
          queueHydrateLazyNodes(div);
        }
      }
    }

    if (hasAttachments) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      const attachmentKeys = [];
      for (const img of assistantAttachments) {
        const attachmentNode = createMessageAttachmentNode(img);
        if (!attachmentNode) continue;
        imgWrap.appendChild(attachmentNode);
        attachmentKeys.push(getAttachmentRenderIdentity(img, attachmentKeys.length));
      }
      if (imgWrap.children.length > 0) {
        div.appendChild(imgWrap);
        div.dataset.assistantAttachmentKeys = attachmentKeys.filter(Boolean).join("|");
      }
    }

    if (div.children.length === 0) {
      return null;
    }
    if (typeof appendMessageMeta === "function") {
      appendMessageMeta(div, evt, "assistant", {
        live: typeof isAssistantMessageLive === "function" ? isAssistantMessageLive(evt) : false,
      });
    } else if (typeof appendMessageTimestamp === "function") {
      appendMessageTimestamp(div, evt.timestamp, "msg-assistant-time");
    }
    container.appendChild(div);
    if (typeof attachMessageLongPressMenu === "function") {
      attachMessageLongPressMenu(div, evt, "assistant");
    }
    if (typeof syncRegenerateActions === "function") {
      syncRegenerateActions();
    }
    return div;
  }
}

function renderMessage(evt) {
  return renderMessageInto(messagesInner, evt, {
    finalizeActiveThinkingBlock: true,
  });
}

if (typeof getApprovalTitle === "function") {
  const baseGetApprovalTitle = getApprovalTitle;
  getApprovalTitle = function enhancedGetApprovalTitle(evt) {
    const elicitationInfo = classifyCodexElicitation(evt);
    if (elicitationInfo && elicitationInfo.kind !== "compact_mcp") {
      if (evt?.title) return String(evt.title).trim();
      const modeTitle = elicitationInfo.kind === "url"
        ? uiTranslate("elicitation.mode.url", null, "External authorization")
        : (elicitationInfo.kind === "form"
          ? uiTranslate("elicitation.mode.form", null, "Input requested")
          : uiTranslate("elicitation.mode.unsupported", null, "Unsupported request"));
      return elicitationInfo.serverName ? `${elicitationInfo.serverName} · ${modeTitle}` : modeTitle;
    }
    return baseGetApprovalTitle(evt);
  };
  if (typeof globalThis !== "undefined") {
    globalThis.getApprovalTitle = getApprovalTitle;
  }
}

if (typeof createApprovalPromptSection === "function") {
  const baseCreateApprovalPromptSection = createApprovalPromptSection;
  createApprovalPromptSection = function enhancedCreateApprovalPromptSection(section, sectionIndex = 0, options = {}) {
    const el = baseCreateApprovalPromptSection(section, sectionIndex, options);
    return enhanceApprovalPromptSectionDom(el, section, sectionIndex, options);
  };
  if (typeof globalThis !== "undefined") {
    globalThis.createApprovalPromptSection = createApprovalPromptSection;
  }
}

if (typeof renderMessageInto === "function") {
  const baseRenderMessageInto = renderMessageInto;
  renderMessageInto = function enhancedRenderMessageInto(container, evt, options = {}) {
    const resultNode = baseRenderMessageInto(container, evt, options);
    const asyncApi = globalThis.RagentAsyncQuestions;
    const isAsyncMsg = asyncApi?.isAsyncQuestionMessage
      ? asyncApi.isAsyncQuestionMessage(evt)
      : (evt?.role === "assistant" && (
        evt?.messageDelivery === "async"
        || evt?.delivery === "async"
        || (Array.isArray(evt?.asyncQuestions) && evt.asyncQuestions.length > 0)
      ));
    if (!isAsyncMsg || !container) return resultNode;

    let targetNode = resultNode;
    if (!targetNode) {
      targetNode = document.createElement("div");
      targetNode.className = "msg msg-assistant";
      if (Number.isFinite(Number(evt?.seq))) targetNode.dataset.eventSeq = String(evt.seq);
      if (evt?.itemId) targetNode.dataset.itemId = String(evt.itemId);
      const cardNode = asyncApi?.renderInStreamMessageQuestions?.(evt, {
        sessionId: evt?.sessionId || (typeof currentSessionId === "string" ? currentSessionId : ""),
      });
      if (cardNode) targetNode.appendChild(cardNode);
      if (typeof appendMessageMeta === "function") {
        appendMessageMeta(targetNode, evt, "assistant", {
          live: typeof isAssistantMessageLive === "function" ? isAssistantMessageLive(evt) : false,
        });
      }
      container.appendChild(targetNode);
      targetNode.dataset.messageDelivery = "async";
      return targetNode;
    }
    targetNode.dataset.messageDelivery = "async";
    if (!targetNode.querySelector?.(".async-question-stream-group, .async-followup-card")) {
      const cardNode = asyncApi?.renderInStreamMessageQuestions?.(evt, {
        sessionId: evt?.sessionId || (typeof currentSessionId === "string" ? currentSessionId : ""),
      });
      if (cardNode) {
        const metaNode = targetNode.querySelector?.(".msg-meta, .msg-assistant-time");
        if (metaNode && metaNode.parentNode === targetNode) {
          targetNode.insertBefore(cardNode, metaNode);
        } else {
          targetNode.appendChild(cardNode);
        }
      }
    }
    return targetNode;
  };
  if (typeof globalThis !== "undefined") {
    globalThis.renderMessageInto = renderMessageInto;
  }
}

function clearStreamingSettlementStyles(node) {
  if (!node?.style) return;
  if (node.__ragentSettleFrame) {
    window.cancelAnimationFrame?.(node.__ragentSettleFrame);
    node.__ragentSettleFrame = null;
  }
  if (node.__ragentSettleTimer) {
    window.clearTimeout(node.__ragentSettleTimer);
    node.__ragentSettleTimer = null;
  }
  node.classList?.remove("stream-settling");
  node.style.removeProperty("opacity");
  node.style.removeProperty("transform");
  streamingSettlementNodes.delete(node);
}

const streamingSettlementNodes = new Set();

window.RagentMotion?.subscribeReducedMotion?.((reduced) => {
  if (!reduced) return;
  for (const node of Array.from(streamingSettlementNodes)) {
    clearStreamingSettlementStyles(node);
  }
});

// Settle crossfade: when the streaming placeholder is replaced by the final
// markdown render, the node briefly dims and lifts, then settles in place.
// Only compositor properties (opacity + transform) animate — never height or
// other layout properties — so scroll anchoring and the viewport stay put.
// The swap and the reduced state are written in the same task, so the first
// painted frame already shows the final content without flicker.
function animateStreamingMessageSettlement(node) {
  if (!node?.style || node.isConnected === false) return;
  const prefersReducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    clearStreamingSettlementStyles(node);
    return;
  }
  node.classList?.add("stream-settling");
  streamingSettlementNodes.add(node);
  node.style.opacity = "0.72";
  node.style.transform = "translateY(3px)";
  void node.offsetHeight;

  node.__ragentSettleFrame = requestAnimationFrame(() => {
    node.__ragentSettleFrame = null;
    if (node.isConnected === false) return;
    node.style.opacity = "1";
    node.style.transform = "translateY(0)";
  });

  node.__ragentSettleTimer = window.setTimeout(() => {
    node.__ragentSettleTimer = null;
    clearStreamingSettlementStyles(node);
  }, 320);
}

function renderMessageIntoStreamingNode(streamingNode, evt) {
  if (!streamingNode || streamingNode.parentNode !== messagesInner) return null;
  const staging = document.createElement("div");
  const finalNode = renderMessageInto(staging, evt, {
    finalizeActiveThinkingBlock: true,
  });
  if (!finalNode) {
    streamingNode.remove();
    return null;
  }

  streamingNode.className = finalNode.className;
  for (const key of Object.keys(streamingNode.dataset || {})) {
    delete streamingNode.dataset[key];
  }
  Object.assign(streamingNode.dataset, finalNode.dataset || {});
  streamingNode.replaceChildren(...Array.from(finalNode.childNodes));
  if (typeof attachMessageLongPressMenu === "function") {
    attachMessageLongPressMenu(streamingNode, evt, "assistant");
  }
  animateStreamingMessageSettlement(streamingNode);
  return streamingNode;
}

function createToolCard(evt) {
  const card = document.createElement("div");
  card.className = "tool-card";

  const header = document.createElement("div");
  header.className = "tool-header";
  header.innerHTML = `<span class="tool-name">${esc(evt.toolName || t("ui.toolFallback"))}</span>
    <span class="tool-toggle">${renderUiIcon("chevron-right")}</span>`;

  const body = document.createElement("div");
  body.className = "tool-body";
  body.id = "tool_" + evt.id;
  const pre = document.createElement("pre");
  pre.textContent = evt.toolInput || "";
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    pre.dataset.eventSeq = String(evt.seq || "");
    pre.dataset.bodyPending = "true";
    pre.dataset.preview = evt.toolInput || "";
  }
  body.appendChild(pre);

  header.addEventListener("click", async () => {
    header.classList.toggle("expanded");
    body.classList.toggle("expanded");
    if (body.classList.contains("expanded")) {
      await hydrateLazyNodes(body);
    }
  });

  card.appendChild(header);
  card.appendChild(body);
  card.dataset.toolId = evt.id;
  if (evt.providerToolUseId) {
    card.dataset.providerToolUseId = evt.providerToolUseId;
  }
  return { card, body };
}

function findPendingToolCard(root, evt = {}) {
  const cards = root?.querySelectorAll?.(".tool-card") || [];
  const providerToolUseId = typeof evt?.providerToolUseId === "string"
    ? evt.providerToolUseId.trim()
    : "";
  if (providerToolUseId) {
    for (let index = cards.length - 1; index >= 0; index -= 1) {
      if (
        cards[index].dataset?.providerToolUseId === providerToolUseId
        && !cards[index].querySelector(".tool-result")
      ) {
        return cards[index];
      }
    }
    return null;
  }
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    if (!cards[index].querySelector(".tool-result")) {
      return cards[index];
    }
  }
  return null;
}

// --- File Edit Diff Rendering ---
const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function parseFileEditToolInput(toolName, toolInput) {
  if (!FILE_EDIT_TOOLS.has(toolName)) return null;
  let input;
  try {
    input = typeof toolInput === "string" ? JSON.parse(toolInput) : toolInput;
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const filePath = input.file_path || input.path || input.notebook_path || "";
  if (!filePath) return null;

  switch (toolName) {
    case "Write":
      return {
        filePath,
        changeType: "add",
        edits: [{ oldText: "", newText: input.content || "" }],
      };
    case "Edit":
      return {
        filePath,
        changeType: "edit",
        edits: [{
          oldText: input.old_string || "",
          newText: input.new_string || "",
        }],
      };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits)
        ? input.edits.map((e) => ({
            oldText: e.old_string || "",
            newText: e.new_string || "",
          }))
        : [];
      return { filePath, changeType: "edit", edits };
    }
    case "NotebookEdit": {
      const editMode = String(input.edit_mode || "").toLowerCase();
      const hasKnownBefore = typeof input.old_source === "string";
      const canComputeDiff = editMode === "insert" || hasKnownBefore;
      return {
        filePath,
        changeType: editMode === "delete" ? "delete" : "edit",
        edits: canComputeDiff
          ? [{ oldText: input.old_source || "", newText: input.new_source || input.source || "" }]
          : [],
      };
    }
    default:
      return null;
  }
}

function computeLineDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) {
    return newLines.map((text, i) => ({ type: "add", newLine: i + 1, text }));
  }
  if (newLines.length === 0) {
    return oldLines.map((text, i) => ({ type: "remove", oldLine: i + 1, text }));
  }

  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > RAGENT_UI_MAX_DIFF_CELLS) return null;
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: "equal", oldLine: i, newLine: j, text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: "add", newLine: j, text: newLines[j - 1] });
      j--;
    } else {
      diff.unshift({ type: "remove", oldLine: i, text: oldLines[i - 1] });
      i--;
    }
  }
  return diff;
}

function getFileNameForEditingStatus(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  return parts.pop() || String(filePath || "") || t("ui.toolFallback");
}

function summarizeFileEditEvent(evt) {
  const editInfo = parseFileEditToolInput(evt.toolName, evt.toolInput);
  if (!editInfo) return null;

  let totalAdded = 0;
  let totalRemoved = 0;
  const allDiffs = [];
  for (const edit of editInfo.edits) {
    const diff = computeLineDiff(edit.oldText, edit.newText);
    if (!diff) {
      const oldLineCount = String(edit.oldText || "").split("\n").length;
      const newLineCount = String(edit.newText || "").split("\n").length;
      totalAdded += newLineCount;
      totalRemoved += oldLineCount;
      allDiffs.push([{
        type: "equal",
        text: `[diff omitted: ${oldLineCount} old lines → ${newLineCount} new lines]`,
        truncated: true,
      }]);
      continue;
    }
    allDiffs.push(diff);
    for (const entry of diff) {
      if (entry.type === "add") totalAdded++;
      if (entry.type === "remove") totalRemoved++;
    }
  }
  return {
    ...editInfo,
    fileName: getFileNameForEditingStatus(editInfo.filePath),
    totalAdded,
    totalRemoved,
    allDiffs,
  };
}

function readEditingStatNumber(event, keys) {
  for (const key of keys) {
    const value = Number(event?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function summarizeFileChangeEditingEvent(evt) {
  if (evt?.type !== "file_change") return null;
  const filePath = evt.filePath || "";
  if (!filePath) return null;
  const totalAdded = readEditingStatNumber(evt, ["added", "additions", "linesAdded", "addedLines"]);
  const totalRemoved = readEditingStatNumber(evt, ["removed", "deletions", "linesRemoved", "removedLines"]);
  return {
    filePath,
    fileName: getFileNameForEditingStatus(filePath),
    totalAdded,
    totalRemoved,
    hasLineStats: totalAdded > 0 || totalRemoved > 0,
  };
}

function renderEditingStatsHtml(summary, { showUnknown = false } = {}) {
  if (summary?.hasLineStats === false) {
    if (!showUnknown) return "";
    return `<span class="diff-stat-add editing-stat editing-stat-unknown">+…</span>
      <span class="diff-stat-del editing-stat editing-stat-unknown">-…</span>`;
  }
  return `<span class="diff-stat-add editing-stat">+${summary.totalAdded || 0}</span>
    <span class="diff-stat-del editing-stat">-${summary.totalRemoved || 0}</span>`;
}

function getEditingStatsAriaLabel(summary) {
  if (summary?.hasLineStats === false) return t("workbench.editingStatsUnknown");
  return t("workbench.editingStats", {
    added: summary?.totalAdded || 0,
    removed: summary?.totalRemoved || 0,
  });
}

function clearThinkingHeaderEditingState(block) {
  if (!block) return;
  block.classList.remove("editing");
  const label = block.querySelector?.(".thinking-label");
  const stats = block.querySelector?.(".thinking-edit-stats");
  if (label) {
    label.removeAttribute("title");
  }
  if (stats) {
    stats.remove();
  }
}

function applyEditingSummaryToThinkingBlock(block, summary) {
  if (!block || !summary) return false;
  const header = block.querySelector?.(".thinking-header");
  const label = header?.querySelector?.(".thinking-label");
  if (!header || !label) return false;
  const nextFilePath = summary.filePath || "";
  const nextHasLineStats = summary.hasLineStats !== false;
  if (
    !nextHasLineStats
    && block.dataset?.editingHasLineStats === "true"
    && block.dataset?.editingFilePath
    && block.dataset.editingFilePath === nextFilePath
  ) {
    return true;
  }
  block.classList.add("editing");
  if (block.dataset) {
    block.dataset.editingFilePath = nextFilePath;
    block.dataset.editingHasLineStats = nextHasLineStats ? "true" : "false";
  }
  label.title = summary.filePath || summary.fileName || "";
  label.innerHTML = `<span class="thinking-edit-action">${esc(t("workbench.editing"))}</span>
    <span class="thinking-edit-file">${esc(summary.fileName)}</span>`;

  const statsHtml = renderEditingStatsHtml(summary, { showUnknown: true });
  let stats = header.querySelector(".thinking-edit-stats");
  if (!statsHtml) {
    if (stats) stats.remove();
    return true;
  }
  if (!stats) {
    stats = document.createElement("span");
    stats.className = "thinking-edit-stats";
    const chevron = header.querySelector(".thinking-chevron");
    if (chevron) {
      header.insertBefore(stats, chevron);
    } else {
      header.appendChild(stats);
    }
  }
  stats.setAttribute("aria-label", getEditingStatsAriaLabel(summary));
  stats.innerHTML = statsHtml;
  return true;
}

function getContainingThinkingBlock(node) {
  if (!node) return null;
  if (typeof node.closest === "function") {
    return node.closest(".thinking-block");
  }
  let current = node;
  while (current) {
    if (current.classList?.contains?.("thinking-block")) return current;
    current = current.parentElement || current.parentNode || null;
  }
  return null;
}

function shouldUseLiveThinkingBlockForEditing(container, liveThinkingBlock) {
  if (!liveThinkingBlock) return false;
  if (!container) return true;
  if (container === liveThinkingBlock) return true;
  if (typeof currentThinkingBlock !== "undefined" && currentThinkingBlock) {
    if (container === currentThinkingBlock.body || container === currentThinkingBlock.el || container === currentThinkingBlock.block) {
      return true;
    }
  }
  const currentContainer = typeof getCurrentEventContainer === "function" ? getCurrentEventContainer() : null;
  return Boolean(currentContainer && container === currentContainer);
}

function renderFileEditInlineStatusInto(container, evt, { updateThinkingHeader = true } = {}) {
  const summary = summarizeFileEditEvent(evt);
  if (!summary) return null;

  if (updateThinkingHeader) {
    const liveThinkingBlock = typeof currentThinkingBlock !== "undefined" && currentThinkingBlock
      ? (currentThinkingBlock.el || currentThinkingBlock.block || null)
      : null;
    const thinkingBlock = getContainingThinkingBlock(container)
      || (shouldUseLiveThinkingBlockForEditing(container, liveThinkingBlock) ? liveThinkingBlock : null);
    if (applyEditingSummaryToThinkingBlock(thinkingBlock, summary)) {
      if (typeof currentThinkingBlock !== "undefined" && currentThinkingBlock && thinkingBlock === liveThinkingBlock) {
        currentThinkingBlock.editingSummary = summary;
      }
      return thinkingBlock;
    }
  }

  if (!container) return null;
  const statsHtml = renderEditingStatsHtml(summary);
  const row = document.createElement("div");
  row.className = "thinking-edit-status";
  row.dataset.toolId = evt.id || "";
  if (evt.providerToolUseId) {
    row.dataset.providerToolUseId = evt.providerToolUseId;
  }
  row.innerHTML = `<span class="thinking-edit-status-dot" aria-hidden="true"></span>
    <span class="thinking-edit-action">${esc(t("workbench.editing"))}</span>
    <span class="thinking-edit-file" title="${esc(summary.filePath)}">${esc(summary.fileName)}</span>
    ${statsHtml ? `<span class="thinking-edit-stats" aria-label="${esc(t("workbench.editingStats", { added: summary.totalAdded || 0, removed: summary.totalRemoved || 0 }))}">
      ${statsHtml}
    </span>` : ""}`;
  container.appendChild(row);
  return row;
}

function renderFileChangeEditingStatusInto(container, evt, { updateThinkingHeader = true } = {}) {
  const summary = summarizeFileChangeEditingEvent(evt);
  if (!summary || !updateThinkingHeader) return null;
  const liveThinkingBlock = typeof currentThinkingBlock !== "undefined" && currentThinkingBlock
    ? (currentThinkingBlock.el || currentThinkingBlock.block || null)
    : null;
  const thinkingBlock = getContainingThinkingBlock(container)
    || (shouldUseLiveThinkingBlockForEditing(container, liveThinkingBlock) ? liveThinkingBlock : null);
  if (applyEditingSummaryToThinkingBlock(thinkingBlock, summary)) {
    if (typeof currentThinkingBlock !== "undefined" && currentThinkingBlock && thinkingBlock === liveThinkingBlock) {
      currentThinkingBlock.editingSummary = summary;
    }
    return thinkingBlock;
  }
  return null;
}

function renderFileEditDiffCard(evt) {
  const summary = summarizeFileEditEvent(evt);
  if (!summary) return null;

  const card = document.createElement("div");
  card.className = "tool-card diff-card editing-card";
  card.dataset.toolId = evt.id;
  if (evt.providerToolUseId) {
    card.dataset.providerToolUseId = evt.providerToolUseId;
  }

  const header = document.createElement("div");
  header.className = "diff-header editing-header";
  header.innerHTML = `<span class="editing-status-icon" aria-hidden="true">${renderUiIcon("edit", "editing-icon")}</span>
    <span class="editing-label">${esc(t("workbench.editing"))}</span>
    <span class="editing-file-name" title="${esc(summary.filePath)}">${esc(summary.fileName)}</span>
    <span class="diff-stats editing-stats" aria-label="${esc(t("workbench.editingStats", { added: summary.totalAdded || 0, removed: summary.totalRemoved || 0 }))}">
      ${renderEditingStatsHtml(summary)}
    </span>
    <span class="tool-toggle">${renderUiIcon("chevron-right")}</span>`;

  const body = document.createElement("div");
  body.className = "diff-body tool-body";
  body.id = "tool_" + evt.id;

  const MAX_DIFF_LINES = 200;
  let lineCount = 0;
  for (const diff of summary.allDiffs) {
    for (const entry of diff) {
      if (lineCount >= MAX_DIFF_LINES) break;
      const row = document.createElement("div");
      row.className = `diff-line diff-line-${entry.type}`;
      const oldNum = document.createElement("span");
      oldNum.className = "diff-num diff-num-old";
      oldNum.textContent = (entry.type === "remove" || entry.type === "equal") && entry.oldLine ? entry.oldLine : "";
      const newNum = document.createElement("span");
      newNum.className = "diff-num diff-num-new";
      newNum.textContent = (entry.type === "add" || entry.type === "equal") && entry.newLine ? entry.newLine : "";
      const prefix = document.createElement("span");
      prefix.className = "diff-prefix";
      prefix.textContent = entry.type === "add" ? "+" : entry.type === "remove" ? "-" : " ";
      const text = document.createElement("span");
      text.className = "diff-text";
      text.textContent = entry.text;
      row.appendChild(oldNum);
      row.appendChild(newNum);
      row.appendChild(prefix);
      row.appendChild(text);
      body.appendChild(row);
      lineCount++;
    }
  }

  header.addEventListener("click", () => {
    header.classList.toggle("expanded");
    body.classList.toggle("expanded");
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function renderToolUseInto(container, evt, { toolTracker = null } = {}) {
  if (!container) return null;
  if (toolTracker && evt.toolName) {
    toolTracker.add(evt.toolName);
  }
  const { card } = createToolCard(evt);
  container.appendChild(card);
  return card;
}

function renderToolResultInto(container, evt) {
  const targetCard = findPendingToolCard(container, evt);
  if (!targetCard) return null;

  const body = targetCard.querySelector(".tool-body");
  if (!body) return null;

  if (targetCard.classList.contains("diff-card")) {
    const isSuccess = evt.exitCode === 0 || evt.exitCode === undefined;
    const header = targetCard.querySelector(".diff-header");
    if (header && !header.querySelector(".diff-result-badge")) {
      const badge = document.createElement("span");
      badge.className = `diff-result-badge ${isSuccess ? "success" : "fail"}`;
      badge.innerHTML = isSuccess
        ? renderUiIcon("check")
        : renderUiIcon("close");
      const toggle = header.querySelector(".tool-toggle");
      if (toggle) {
        header.insertBefore(badge, toggle);
      } else {
        header.appendChild(badge);
      }
    }
    const marker = document.createElement("span");
    marker.className = "tool-result";
    marker.hidden = true;
    body.appendChild(marker);
    return targetCard;
  }

  const label = document.createElement("div");
  label.className = "tool-result-label";
  label.innerHTML =
    esc(t("ui.toolResult")) +
    (evt.exitCode !== undefined
      ? `<span class="exit-code ${evt.exitCode === 0 ? "ok" : "fail"}">${esc(t("ui.toolExitCode", { code: evt.exitCode }))}</span>`
      : "");
  const pre = document.createElement("pre");
  pre.className = "tool-result";
  pre.textContent = evt.output || "";
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    pre.dataset.eventSeq = String(evt.seq || "");
    pre.dataset.bodyPending = "true";
    pre.dataset.preview = evt.output || "";
  }
  body.appendChild(label);
  body.appendChild(pre);
  return targetCard;
}

function renderFileChangeInto(container, evt) {
  if (!container) return null;
  const div = document.createElement("div");
  div.className = "file-card";
  const kind = normalizeFileChangeType(evt.changeType || "edit");
  const filePath = evt.filePath || "";
  const pathMarkup = `<span class="file-path">${esc(filePath)}</span>`;
  const changeLabel = formatFileChangeTypeLabel(kind);
  div.innerHTML = `${pathMarkup}
    <span class="change-type ${kind}">${esc(changeLabel)}</span>`;
  container.appendChild(div);
  return div;
}

function ensureOperationRenderState() {
  if (!(renderedEventState.operationNodesById instanceof Map)) {
    renderedEventState.operationNodesById = new Map();
  }
  if (!(renderedEventState.operationSnapshotsById instanceof Map)) {
    renderedEventState.operationSnapshotsById = new Map();
  }
  if (!(renderedEventState.expandedOperationIds instanceof Set)) {
    renderedEventState.expandedOperationIds = new Set();
  }
  return renderedEventState;
}

const MAX_OPERATION_RENDER_INDEX_ENTRIES = 4096;

function setBoundedOperationIndex(map, key, value) {
  if (!(map instanceof Map) || !key) return;
  map.set(key, value);
  while (map.size > MAX_OPERATION_RENDER_INDEX_ENTRIES) {
    map.delete(map.keys().next().value);
  }
}

function getOperationEventId(evt) {
  return String(evt?.toolCall?.toolCallId || evt?.toolCallId || evt?.operationId || evt?.id || "").trim();
}

function normalizeOperationState(value) {
  const state = String(value || "running").trim().toLowerCase();
  if (["running", "in_progress", "started"].includes(state)) return "running";
  if (["pending", "waiting_approval"].includes(state)) return "waiting_approval";
  return ["completed", "failed", "declined", "interrupted", "uncertain"].includes(state)
    ? state
    : "uncertain";
}

function getOperationLifecycle(evt) {
  return evt?.state
    || evt?.toolCall?._meta?.ragent?.lifecycle
    || evt?.toolCall?.status
    || "uncertain";
}

function parseActivityTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatActivityElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getOperationStateLabel(evt) {
  const state = normalizeOperationState(getOperationLifecycle(evt));
  if (state === "running") {
    const key = "operation.state.running";
    const translated = t(key);
    if (translated !== key) return translated;
    const kind = String(evt?.presentation?.labelKind || evt?.toolCall?.kind || evt?.kind || "working").trim().toLowerCase();
    const kindKey = `activity.label.${kind}`;
    const kindLabel = t(kindKey);
    // 未知 kind 不回退服务端英文 title，统一走翻译层 working 兜底
    return kindLabel === kindKey ? t("activity.label.working") : kindLabel;
  }
  return t(`operation.state.${state}`);
}

function getOperationActivitySummary(evt) {
  const presentation = evt?.presentation && typeof evt.presentation === "object" ? evt.presentation : {};
  const input = evt?.toolCall?.input && typeof evt.toolCall.input === "object" ? evt.toolCall.input : {};
  const description = [evt, presentation].find((candidate) =>
    ["tool_input_description", "provider_title"].includes(candidate?.activityDescriptionSource)
      && typeof candidate.activityDescription === "string" && candidate.activityDescription.trim()) || {};
  const state = normalizeOperationState(getOperationLifecycle(evt));
  const activity = {
    state,
    operationState: state,
    kind: presentation.kind || evt?.toolCall?.kind || evt?.kind || "working",
    labelKind: presentation.labelKind || evt?.toolCall?.kind || evt?.kind || "working",
    subject: presentation.subject || "",
    detail: presentation.detail || evt?.detail || evt?.command || input.command || input.path || input.query || "",
    ...(presentation.group ? { group: presentation.group } : {}),
    operationId: evt?.operationId || "",
    toolCallId: evt?.toolCallId || evt?.toolCall?.toolCallId || "",
    providerItemId: evt?.providerItemId || "",
    providerToolUseId: evt?.providerToolUseId || "",
    runId: evt?.runId || "",
    webAction: evt?.webAction || presentation.webAction || evt?.toolCall?._meta?.ragent?.webAction || "",
    operationProgress: evt?.operationProgress || presentation.operationProgress || "",
    activityDescription: description.activityDescription || "",
    activityDescriptionSource: description.activityDescriptionSource || "",
  };
  const live = globalThis?.RagentRunActivity?.getActivity?.();
  const sameOperation = ["operationId", "toolCallId", "providerItemId", "providerToolUseId"]
    .some((key) => activity[key] && live?.[key] && activity[key] === live[key]);
  if (state === "running" && sameOperation && activity.runId && activity.runId === live.runId) {
    if (!activity.activityDescription && live.activityDescription) {
      activity.activityDescription = live.activityDescription;
      activity.activityDescriptionSource = live.activityDescriptionSource;
    }
    activity.operationProgress ||= live.operationProgress || "";
    activity.webAction ||= live.webAction || "";
  }
  const formatter = globalThis?.RagentRunActivity?.formatOperationActivity;
  if (typeof formatter === "function") {
    const formatted = formatter(activity);
    if (formatted) return formatted;
  }
  return getOperationStateLabel(evt);
}

function getOperationElapsedMs(evt, now = Date.now()) {
  const durationMs = Number(evt?.durationMs ?? evt?.toolCall?._meta?.ragent?.durationMs);
  if (Number.isFinite(durationMs) && durationMs >= 0) return durationMs;
  const startedAt = parseActivityTimestamp(evt?.startedAt || evt?.timestamp);
  const completedAt = parseActivityTimestamp(evt?.completedAt);
  if (!startedAt) return 0;
  return Math.max(0, (completedAt || now) - startedAt);
}

function buildOperationPreviewLines(outputPreview) {
  const preview = outputPreview && typeof outputPreview === "object" ? outputPreview : {};
  const lines = [];
  for (const line of Array.isArray(preview.head) ? preview.head : []) {
    lines.push(String(line));
  }
  const omittedLines = Math.max(0, Number(preview.omittedLines) || 0);
  if (omittedLines > 0) lines.push(t("operation.output.omitted", { count: omittedLines }));
  for (const line of Array.isArray(preview.tail) ? preview.tail : []) {
    lines.push(String(line));
  }
  return lines;
}

function setOperationExpanded(node, expanded) {
  if (!node) return false;
  const operationId = String(node.dataset?.operationId || "").trim();
  const body = node.querySelector?.(".live-operation-row__body") || null;
  const summary = node.querySelector?.(".live-operation-row__summary") || null;
  const shouldExpand = expanded === true && !!body;
  node.classList.toggle("is-expanded", shouldExpand);
  if (body) body.hidden = !shouldExpand;
  if (summary) summary.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
  const state = ensureOperationRenderState();
  if (operationId) {
    if (shouldExpand) state.expandedOperationIds.add(operationId);
    else state.expandedOperationIds.delete(operationId);
    while (state.expandedOperationIds.size > MAX_OPERATION_RENDER_INDEX_ENTRIES) {
      state.expandedOperationIds.delete(state.expandedOperationIds.values().next().value);
    }
  }
  if (shouldExpand && typeof hydrateLazyNodes === "function") {
    hydrateLazyNodes(body).catch(() => {});
  }
  return shouldExpand;
}

function createOperationBody(evt) {
  const outputPreview = evt?.presentation?.outputPreview && typeof evt.presentation.outputPreview === "object"
    ? evt.presentation.outputPreview
    : (evt?.toolCall?.output && typeof evt.toolCall.output === "object"
      ? evt.toolCall.output
    : (evt?.outputPreview && typeof evt.outputPreview === "object"
      ? evt.outputPreview
      : null));
  const fileChanges = Array.isArray(evt?.presentation?.fileChanges)
    ? evt.presentation.fileChanges
    : (Array.isArray(evt?.toolCall?.content?.fileChanges)
      ? evt.toolCall.content.fileChanges
      : (Array.isArray(evt?.fileChanges) ? evt.fileChanges : []));
  const previewLines = buildOperationPreviewLines(outputPreview);
  const input = evt?.toolCall?.input && typeof evt.toolCall.input === "object" ? evt.toolCall.input : {};
  const detail = String(
    evt?.presentation?.detail
    || evt?.presentation?.subject
    || input.command
    || input.path
    || input.query
    || evt?.detail
    || evt?.command
    || "",
  ).trim();
  if (previewLines.length === 0 && fileChanges.length === 0 && !detail) return null;

  const body = document.createElement("div");
  body.className = "live-operation-row__body";
  body.hidden = true;

  if (detail) {
    const detailNode = document.createElement("code");
    detailNode.className = "live-operation-row__detail-body";
    detailNode.textContent = detail;
    detailNode.title = detail;
    body.appendChild(detailNode);
  }

  const runtime = [
    evt?.presentation?.shellKind || evt?.shellKind,
    evt?.presentation?.executionPlatform || evt?.executionPlatform,
    evt?.cwd,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (runtime.length > 0) {
    const runtimeNode = document.createElement("div");
    runtimeNode.className = "live-operation-row__runtime";
    runtimeNode.textContent = runtime.join(" · ");
    body.appendChild(runtimeNode);
  }

  if (fileChanges.length > 0) {
    const fileList = document.createElement("div");
    fileList.className = "live-operation-row__files";
    fileList.setAttribute("aria-label", t("operation.files.changed", { count: fileChanges.length }));
    for (const change of fileChanges) {
      const item = document.createElement("div");
      item.className = "live-operation-row__file";
      const filePath = String(change?.filePath || "").trim();
      item.textContent = filePath;
      item.title = filePath;
      fileList.appendChild(item);
    }
    body.appendChild(fileList);
  }

  if (previewLines.length > 0) {
    const output = document.createElement("pre");
    output.className = "live-operation-row__output";
    output.textContent = previewLines.join("\n");
    if (outputPreview?.bodyAvailable === true && Number.isInteger(outputPreview.bodySeq)) {
      output.dataset.eventSeq = String(outputPreview.bodySeq);
      output.dataset.bodyPending = "true";
      output.dataset.bodyRender = "text";
      output.dataset.preview = output.textContent;
    }
    body.appendChild(output);
  }
  return body;
}

function renderOperationNodeContent(node, evt, { expanded = false } = {}) {
  node.__ragentOperationEvent = evt;
  const operationId = getOperationEventId(evt);
  const state = normalizeOperationState(getOperationLifecycle(evt));
  const input = evt?.toolCall?.input && typeof evt.toolCall.input === "object" ? evt.toolCall.input : {};
  const detail = String(
    evt?.presentation?.subject
    || evt?.presentation?.detail
    || input.command
    || input.path
    || input.query
    || evt?.detail
    || evt?.command
    || "",
  ).trim();
  const elapsed = formatActivityElapsed(getOperationElapsedMs(evt));
  const exitCode = Number(evt?.exitCode ?? evt?.toolCall?._meta?.ragent?.exitCode);

  const displayKind = String(evt?.presentation?.kind || evt?.toolCall?.kind || evt?.kind || "other").trim() || "other";
  const activitySummary = getOperationActivitySummary(evt);
  const outputPreview = evt?.presentation?.outputPreview || evt?.outputPreview || null;
  const renderSignature = JSON.stringify([
    operationId,
    state,
    displayKind,
    activitySummary,
    detail,
    Number.isFinite(exitCode) ? exitCode : null,
    outputPreview?.totalLines || 0,
    outputPreview?.omittedLines || 0,
    Array.isArray(outputPreview?.head) ? outputPreview.head.join("\n").slice(-200) : "",
    Array.isArray(outputPreview?.tail) ? outputPreview.tail.join("\n").slice(-200) : "",
    Array.isArray(evt?.fileChanges) ? evt.fileChanges.length : 0,
  ]);
  if (node.dataset?.renderSignature === renderSignature) {
    const elapsedNode = node.querySelector?.(".live-operation-row__elapsed");
    if (elapsedNode) elapsedNode.textContent = elapsed;
    return node;
  }
  node.className = `live-operation-row state-${state} kind-${displayKind}`;
  node.dataset.operationId = operationId;
  node.dataset.operationState = state;
  node.dataset.renderSignature = renderSignature;
  node.tabIndex = -1;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else node.innerHTML = "";

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "live-operation-row__summary";

  const mark = document.createElement("span");
  mark.className = "live-operation-row__mark";
  mark.setAttribute("aria-hidden", "true");
  summary.appendChild(mark);

  const copy = document.createElement("span");
  copy.className = "live-operation-row__copy";
  const label = document.createElement("span");
  label.className = "live-operation-row__label";
  label.textContent = getOperationStateLabel(evt);
  const primary = document.createElement("span");
  primary.className = "live-operation-row__summary-text";
  const summaryText = activitySummary || detail || getOperationStateLabel(evt);
  primary.textContent = summaryText;
  primary.title = activitySummary || detail || getOperationStateLabel(evt);
  copy.appendChild(primary);
  copy.appendChild(label);
  summary.appendChild(copy);

  const meta = document.createElement("span");
  meta.className = "live-operation-row__meta";
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    const exit = document.createElement("span");
    exit.className = "live-operation-row__exit";
    exit.textContent = t("operation.exitCode", { code: exitCode });
    meta.appendChild(exit);
  }
  const elapsedNode = document.createElement("span");
  elapsedNode.className = "live-operation-row__elapsed";
  elapsedNode.textContent = elapsed;
  meta.appendChild(elapsedNode);
  summary.appendChild(meta);

  const body = createOperationBody(evt);
  if (body) {
    const chevron = document.createElement("span");
    chevron.className = "live-operation-row__chevron";
    chevron.innerHTML = renderUiIcon("chevron-right");
    summary.appendChild(chevron);
    summary.setAttribute("aria-expanded", "false");
    summary.addEventListener("click", () => {
      setOperationExpanded(node, !node.classList.contains("is-expanded"));
    });
  } else {
    summary.disabled = true;
  }

  node.appendChild(summary);
  if (body) node.appendChild(body);
  setOperationExpanded(node, expanded);
  return node;
}

function getOperationDisplayKind(evt) {
  return String(evt?.presentation?.kind || evt?.toolCall?.kind || evt?.kind || "other").trim() || "other";
}

function getOperationNodeKind(node) {
  for (const token of String(node?.className || "").split(/\s+/)) {
    if (token.startsWith("kind-")) return token.slice("kind-".length);
  }
  return "";
}

function findFoldContainer(node) {
  let current = node?.parentNode || null;
  while (current) {
    if (typeof current?.classList?.contains === "function" && current.classList.contains("live-operation-fold")) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function setFoldCountLabel(fold, count) {
  const label = fold?.querySelector?.(".live-operation-fold__count");
  if (label) {
    const key = String(fold?.dataset?.foldKind || "") === "exploring"
      ? "activity.fold.exploring"
      : "activity.fold.nActions";
    label.textContent = t(key, { count });
  }
}

function toggleFoldExpanded(fold, expanded) {
  if (!fold) return;
  const body = fold.querySelector?.(".live-operation-fold__body") || null;
  const summary = fold.querySelector?.(".live-operation-fold__summary") || null;
  const shouldExpand = expanded === true && !!body;
  fold.classList.toggle("is-expanded", shouldExpand);
  if (body) body.hidden = !shouldExpand;
  if (summary) summary.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
}

function createFoldContainer(kind) {
  const fold = document.createElement("div");
  fold.className = "live-operation-fold";
  fold.dataset.foldKind = kind;
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "live-operation-fold__summary";
  const count = document.createElement("span");
  count.className = "live-operation-fold__count";
  summary.appendChild(count);
  const chevron = document.createElement("span");
  chevron.className = "live-operation-fold__chevron";
  chevron.innerHTML = renderUiIcon("chevron-right");
  summary.appendChild(chevron);
  summary.addEventListener("click", () => {
    toggleFoldExpanded(fold, !fold.classList.contains("is-expanded"));
  });
  const body = document.createElement("div");
  body.className = "live-operation-fold__body";
  body.hidden = true;
  fold.appendChild(summary);
  fold.appendChild(body);
  return fold;
}

function appendOperationNode(container, node, evt) {
  if (normalizeOperationState(getOperationLifecycle(evt)) !== "completed") {
    container.appendChild(node);
    return node;
  }
  const kind = getOperationDisplayKind(evt);
  const actionGroupId = String(evt?.presentation?.group?.id || '').trim();
  const last = container?.lastElementChild || null;
  let fold = null;
  if (actionGroupId && last?.classList?.contains?.("live-operation-fold")
    && String(last?.dataset?.actionGroupId || "") === actionGroupId) {
    fold = last;
  } else if (last?.classList?.contains?.("live-operation-fold") && String(last?.dataset?.foldKind || "") === kind) {
    fold = last;
  } else if (
    last?.classList?.contains?.("live-operation-row")
    && last.classList.contains("state-completed")
    && getOperationNodeKind(last) === kind
  ) {
    fold = createFoldContainer(kind);
    last.remove();
    fold.querySelector(".live-operation-fold__body").appendChild(last);
    container.appendChild(fold);
  }
  if (!fold) {
    if (actionGroupId) {
      fold = createFoldContainer('exploring');
      fold.dataset.actionGroupId = actionGroupId;
      fold.querySelector(".live-operation-fold__body").appendChild(node);
      container.appendChild(fold);
      setFoldCountLabel(fold, 1);
      return node;
    }
    container.appendChild(node);
    return node;
  }
  fold.querySelector(".live-operation-fold__body").appendChild(node);
  setFoldCountLabel(fold, fold.querySelectorAll(".live-operation-row").length);
  return node;
}

function refreshFoldCountForNode(node) {
  const fold = findFoldContainer(node);
  if (!fold) return;
  setFoldCountLabel(fold, fold.querySelectorAll(".live-operation-row").length);
}

function updateOperationNode(evt) {
  const operationId = getOperationEventId(evt);
  if (!operationId) return null;
  const state = ensureOperationRenderState();
  setBoundedOperationIndex(state.operationSnapshotsById, operationId, evt);
  const node = state.operationNodesById.get(operationId) || null;
  if (!node) return null;
  const expanded = node.classList.contains("is-expanded") || state.expandedOperationIds.has(operationId);
  const result = renderOperationNodeContent(node, evt, { expanded });
  refreshFoldCountForNode(node);
  return result;
}

function renderOperationInto(container, evt) {
  if (!container) return null;
  const operationId = getOperationEventId(evt);
  if (!operationId) return null;
  const state = ensureOperationRenderState();
  const existing = state.operationNodesById.get(operationId) || null;
  setBoundedOperationIndex(state.operationSnapshotsById, operationId, evt);
  if (existing) return updateOperationNode(evt);
  const node = document.createElement("div");
  const expanded = state.expandedOperationIds.has(operationId);
  renderOperationNodeContent(node, evt, { expanded });
  setBoundedOperationIndex(state.operationNodesById, operationId, node);
  appendOperationNode(container, node, evt);
  return node;
}

function getExpandedOperationIds() {
  const state = ensureOperationRenderState();
  const expanded = new Set(state.expandedOperationIds);
  for (const [operationId, node] of state.operationNodesById.entries()) {
    if (node?.classList?.contains("is-expanded")) expanded.add(operationId);
  }
  return expanded;
}

function rebuildRenderedOperationIndexes(root, events = []) {
  const state = ensureOperationRenderState();
  state.operationNodesById.clear();
  state.operationSnapshotsById.clear();
  for (const event of Array.isArray(events) ? events : []) {
    const operationId = getOperationEventId(event);
    if (event?.type === "operation" && operationId) {
      setBoundedOperationIndex(state.operationSnapshotsById, operationId, event);
    }
  }
  const nodes = root?.querySelectorAll?.("[data-operation-id]") || [];
  for (const node of nodes) {
    const operationId = String(node?.dataset?.operationId || "").trim();
    if (!operationId) continue;
    setBoundedOperationIndex(state.operationNodesById, operationId, node);
    if (node.classList?.contains("is-expanded")) state.expandedOperationIds.add(operationId);
  }
}

function renderReasoningInto(container, evt) {
  if (!container) return null;
  const div = document.createElement("div");
  div.className = "reasoning md-content";
  if (evt.content) {
    const didRender = renderMarkdownIntoNode(div, evt.content);
    if (!didRender && !evt.bodyAvailable) return null;
  } else if (evt.bodyAvailable && evt.bodyPreview) {
    renderMarkdownIntoNode(div, evt.bodyPreview);
  } else if (!evt.bodyAvailable) {
    return null;
  }
  if (markLazyEventBodyNode(div, evt, {
    preview: evt.bodyPreview || evt.content || "",
    renderMode: "markdown",
  })) {
    if (typeof queueHydrateLazyNodes === "function") {
      queueHydrateLazyNodes(div);
    }
  }
  container.appendChild(div);
  return div;
}

function renderManagerContextInto(container, evt) {
  if (!container) return null;
  const wrap = document.createElement("div");
  wrap.className = "manager-context";

  const label = document.createElement("div");
  label.className = "msg-system";
  label.textContent = t("ui.managerContext");
  wrap.appendChild(label);

  const body = document.createElement("div");
  body.className = "reasoning md-content";
  if (evt.content) {
    const didRender = renderMarkdownIntoNode(body, evt.content);
    if (!didRender && !evt.bodyAvailable) return null;
  } else if (evt.bodyAvailable && evt.bodyPreview) {
    renderMarkdownIntoNode(body, evt.bodyPreview);
  } else if (!evt.bodyAvailable) {
    return null;
  }

  if (markLazyEventBodyNode(body, evt, {
    preview: evt.bodyPreview || evt.content || "",
    renderMode: "markdown",
  })) {
    if (typeof queueHydrateLazyNodes === "function") {
      queueHydrateLazyNodes(wrap);
    }
  }

  wrap.appendChild(body);
  container.appendChild(wrap);
  return wrap;
}

function collectHiddenBlockToolNames(events) {
  const names = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "tool_use") continue;
    const name = typeof event?.toolName === "string" ? event.toolName.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatToolListLabel(names, max) {
  if (names.length <= max) return names.join(", ");
  return names.slice(0, max).join(", ") + ` +${names.length - max}`;
}

function buildLoadedHiddenBlockLabel(events) {
  const toolNames = collectHiddenBlockToolNames(events);
  if (toolNames.length > 0) {
    return t("thinking.usedTools", { tools: formatToolListLabel(toolNames, 3) });
  }
  return t("thinking.done");
}

function createDeferredThinkingBlock(label, { collapsed = true } = {}) {
  const block = document.createElement("div");
  block.className = `thinking-block${collapsed ? " collapsed" : ""}`;

  const header = document.createElement("div");
  header.className = "thinking-header";
  header.innerHTML = `${renderUiIcon("gear", "thinking-icon")}
    <span class="thinking-label">${esc(label || t("thinking.active"))}</span>
    <span class="thinking-chevron">${renderUiIcon("chevron-down")}</span>`;

  const body = document.createElement("div");
  body.className = "thinking-body";

  block.appendChild(header);
  block.appendChild(body);
  return {
    block,
    header,
    body,
    label: header.querySelector(".thinking-label"),
  };
}

function parseEventBlockSeq(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function getRenderedEventBlockStartSeq(body) {
  if (!body) return 0;
  return parseEventBlockSeq(body.dataset.renderedBlockStartSeq);
}

function getRenderedEventBlockEndSeq(body) {
  if (!body) return 0;
  return parseEventBlockSeq(body.dataset.renderedBlockEndSeq);
}

function setRenderedEventBlockRange(body, startSeq, endSeq) {
  if (!body) return;
  body.dataset.renderedBlockStartSeq = String(startSeq > 0 ? startSeq : 0);
  body.dataset.renderedBlockEndSeq = String(endSeq > 0 ? endSeq : 0);
}

function hasRenderedEventBlockContent(body) {
  if (!body) return false;
  if (Number.isInteger(body.childElementCount)) {
    return body.childElementCount > 0;
  }
  return Array.isArray(body.children) ? body.children.length > 0 : false;
}

function shouldAppendEventBlockContent(body, evt) {
  if (!body) return false;
  const nextStartSeq = parseEventBlockSeq(evt?.blockStartSeq);
  const nextEndSeq = parseEventBlockSeq(evt?.blockEndSeq);
  const renderedStartSeq = getRenderedEventBlockStartSeq(body);
  const renderedEndSeq = getRenderedEventBlockEndSeq(body);
  if (nextStartSeq < 1 || nextEndSeq < 1) return false;
  if (renderedStartSeq !== nextStartSeq) return false;
  if (renderedEndSeq < 1 || nextEndSeq <= renderedEndSeq) return false;
  return hasRenderedEventBlockContent(body);
}

function clearEventBlockBody(body) {
  if (!body) return;
  body.innerHTML = "";
}

function renderEventBlockBody(body, hiddenEvents) {
  if (!body) return;
  clearEventBlockBody(body);
  renderHiddenBlockEventsInto(body, hiddenEvents);
}

function renderHiddenBlockEventsInto(container, events) {
  if (!container) return;
  for (const event of Array.isArray(events) ? events : []) {
    switch (event?.type) {
      case "message":
        renderMessageInto(container, event);
        break;
      case "reasoning":
        renderReasoningInto(container, event);
        break;
      case "manager_context":
        renderManagerContextInto(container, event);
        break;
      case "plan":
        renderPlanEventInto(container, event);
        break;
      // approval_request no longer renders into the message stream (2026-08-04)
      // — the Decision Sheet handles it; the sheet is fed via decisions-store.
      case "approval_request":
        break;
      case "approval_response":
        renderApprovalResponseInto(container, event);
        break;
      case "tool_use":
        if (typeof FILE_EDIT_TOOLS !== "undefined" && FILE_EDIT_TOOLS.has(event.toolName)) {
          const editStatus = renderFileEditInlineStatusInto(container, event);
          if (editStatus) {
            break;
          }
        }
        renderToolUseInto(container, event);
        break;
      case "tool_result":
        if (!renderToolResultInto(container, event)) {
          renderToolResultInto(messagesInner, event);
        }
        break;
      case "file_change":
        renderFileChangeEditingStatusInto(container, event);
        renderFileChangeInto(container, event);
        break;
      case "status":
        renderStatusInto(container, event);
        break;
      case "context_barrier":
        renderContextBarrierInto(container, event);
        break;
      case "context_operation":
        renderContextOperationInto(container, event);
        break;
      case "usage":
        renderUsageInto(container, event);
        break;
      default:
        renderUnknownEventInto(container, event);
        break;
    }
  }
}

async function ensureEventBlockLoaded(sessionId, body, evt) {
  if (!body || !evt) return;
  const nextStartSeq = parseEventBlockSeq(evt?.blockStartSeq);
  const nextEndSeq = parseEventBlockSeq(evt?.blockEndSeq);
  const rangeKey = `${nextStartSeq}-${nextEndSeq}`;
  const currentRangeKey = body.dataset.blockRange || "";
  const renderedStartSeq = getRenderedEventBlockStartSeq(body);
  const renderedEndSeq = getRenderedEventBlockEndSeq(body);
  if (
    currentRangeKey === rangeKey
    && renderedStartSeq === nextStartSeq
    && renderedEndSeq >= nextEndSeq
  ) {
    return;
  }

  const appendMode = shouldAppendEventBlockContent(body, evt);
  const previousRenderedEndSeq = renderedEndSeq;

  body.dataset.blockRange = rangeKey;
  body.dataset.blockStartSeq = String(nextStartSeq);
  body.dataset.blockEndSeq = String(nextEndSeq);

  try {
    const data = await fetchEventBlock(sessionId, evt.blockStartSeq, evt.blockEndSeq);
    if ((body.dataset.blockRange || "") !== rangeKey) return;
    const hiddenEvents = Array.isArray(data?.events) ? data.events : [];
    if (hiddenEvents.length === 0) return;

    if (appendMode) {
      const appendedEvents = hiddenEvents.filter(
        (event) => Number.isInteger(event?.seq) && event.seq > previousRenderedEndSeq,
      );
      if (appendedEvents.length > 0) {
        renderHiddenBlockEventsInto(body, appendedEvents);
      } else if (
        getRenderedEventBlockStartSeq(body) !== nextStartSeq
        || getRenderedEventBlockEndSeq(body) < previousRenderedEndSeq
      ) {
        renderEventBlockBody(body, hiddenEvents);
      }
    } else {
      renderEventBlockBody(body, hiddenEvents);
    }

    const updatedRenderedStartSeq = Number.isInteger(hiddenEvents[0]?.seq)
      ? hiddenEvents[0].seq
      : nextStartSeq;
    const updatedRenderedEndSeq = Number.isInteger(hiddenEvents[hiddenEvents.length - 1]?.seq)
      ? hiddenEvents[hiddenEvents.length - 1].seq
      : nextEndSeq;
    setRenderedEventBlockRange(body, updatedRenderedStartSeq, updatedRenderedEndSeq);
  } catch (error) {
    if ((body.dataset.blockRange || "") !== rangeKey) return;
    console.warn("[event-block] Failed to load hidden block:", error.message);
  }
}

function isRunningThinkingBlockEvent(evt) {
  return evt?.state === "running";
}

function shouldOpenThinkingBlocksFromPreference() {
  return typeof window.ragentShouldExpandThinkingBlocksByDefault === "function"
    ? window.ragentShouldExpandThinkingBlocksByDefault()
    : false;
}

function getThinkingBlockLabel(evt) {
  if (typeof evt?.label === "string" && evt.label.trim()) {
    return evt.label;
  }
  return isRunningThinkingBlockEvent(evt) ? t("thinking.active") : t("thinking.done");
}

// The compact activity presentation is the shared Web timeline policy for
// phone and desktop. Execution details remain available in Run Sheet.
function shouldCompactMobileThinking() {
  return true;
}

let mobileLiveActivityLine = null;

function removeMobileLiveActivityLine() {
  if (mobileLiveActivityLine?.parentNode) mobileLiveActivityLine.remove();
  mobileLiveActivityLine = null;
}

function getMobileLiveRunState() {
  const sessionId = typeof currentSessionId === "string" ? currentSessionId.trim() : "";
  if (!sessionId) return "idle";
  if (typeof hasAttachedSession !== "undefined" && hasAttachedSession !== true) return "idle";

  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  if (session) {
    return String(session?.activity?.run?.state || "idle").trim().toLowerCase() || "idle";
  }

  const renderedState = typeof renderedEventState !== "undefined" ? renderedEventState : null;
  if (
    renderedState?.sessionId === sessionId
    && typeof renderedState?.runState === "string"
  ) {
    return renderedState.runState.trim().toLowerCase() || "idle";
  }
  return typeof sessionStatus !== "undefined"
    ? (String(sessionStatus || "idle").trim().toLowerCase() || "idle")
    : "";
}

function isMobileLiveRunState(value) {
  return ["running", "waiting_user"].includes(String(value || "").trim().toLowerCase());
}

function getMobileLiveActivityFallbackText() {
  const label = String(t("activity.label.working") || "Working").trim();
  if (!label) return "Working…";
  return /[….]$/.test(label) ? label : `${label}…`;
}

function buildMobileLiveActivityLineRow() {
  const row = document.createElement("div");
  row.className = "mobile-live-activity-line";
  row.setAttribute("aria-live", "polite");
  row.setAttribute("aria-atomic", "true");
  const dots = document.createElement("span");
  dots.className = "mobile-live-activity-line__dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "mobile-live-activity-line__dot";
    dots.appendChild(dot);
  }
  const label = document.createElement("span");
  label.className = "mobile-live-activity-line__label";
  row.appendChild(dots);
  row.appendChild(label);
  return row;
}

function syncMobileLiveActivityLine(presentation = window.RagentRunActivity?.getPresentation?.()) {
  if (!shouldCompactMobileThinking() || !messagesInner) {
    removeMobileLiveActivityLine();
    return;
  }
  const sessionRunState = getMobileLiveRunState();
  const activityState = String(window.RagentRunActivity?.getActivity?.()?.state || presentation?.activity?.state || "").trim().toLowerCase();
  const runIsActive = isMobileLiveRunState(sessionRunState) || isMobileLiveRunState(activityState);
  // The session projection is authoritative for lifecycle. A durable refresh
  // can report `idle`/terminal before the ephemeral activity store receives
  // its reset; letting that stale activity keep the row alive causes a ghost
  // "Working…" line after completion and can leak the previous action into a
  // newly started run. Clear the ephemeral store when the canonical run is no
  // longer live, then remove the row in the same turn.
  const terminal = ["idle", "completed", "failed", "cancelled", "canceled"].includes(sessionRunState);
  if (terminal && activityState && typeof window.RagentRunActivity?.reset === "function") {
    window.RagentRunActivity.reset();
  }
  const activityText = String(presentation?.text || "").trim();
  const text = activityText || (runIsActive ? getMobileLiveActivityFallbackText() : "");
  if (terminal || !text || (!runIsActive && !presentation?.inlineVisible)) {
    removeMobileLiveActivityLine();
    return;
  }
  if (!mobileLiveActivityLine || mobileLiveActivityLine.parentNode !== messagesInner) {
    // Adopt the send-pending working row when one is parked beneath the echo:
    // same node, same look, so the working indicator never blinks across the
    // send-commit-to-run-start seam.
    const pendingRow = document.getElementById("msgAssistantPending");
    if (!mobileLiveActivityLine && pendingRow?.parentNode === messagesInner) {
      delete pendingRow.dataset.requestId;
      delete pendingRow.dataset.sessionId;
      pendingRow.removeAttribute("id");
      mobileLiveActivityLine = pendingRow;
    } else {
      mobileLiveActivityLine = buildMobileLiveActivityLineRow();
    }
  }
  const label = mobileLiveActivityLine.querySelector(".mobile-live-activity-line__label");
  const currentLabelText = window.RagentLiveActionTransition?.getText
    ? window.RagentLiveActionTransition.getText(label)
    : (label ? label.textContent : "");
  if (label && currentLabelText !== text) {
    if (window.RagentLiveActionTransition?.setText) {
      window.RagentLiveActionTransition.setText(label, text, { suffix: presentation?.suffix });
    } else {
      label.textContent = text;
    }
  }
  mobileLiveActivityLine.dataset.sourceSeq = String(Number(presentation?.sourceSeq) || 0);
  // The turn runway spacer is invisible scroll padding parked at the end of
  // the transcript; live content must stay in front of it or the row renders
  // below the fold exactly while the user bubble is docked at the top.
  const turnSpacer = document.getElementById("turnViewportSpacer");
  const spacerIsLast = turnSpacer
    && turnSpacer.parentNode === messagesInner
    && messagesInner.lastElementChild === turnSpacer;
  if (spacerIsLast) {
    if (mobileLiveActivityLine !== turnSpacer.previousElementSibling) {
      messagesInner.insertBefore(mobileLiveActivityLine, turnSpacer);
    }
  } else if (mobileLiveActivityLine.parentNode !== messagesInner || messagesInner.lastElementChild !== mobileLiveActivityLine) {
    messagesInner.appendChild(mobileLiveActivityLine);
  }
}

function hasActiveMobileRunActivity() {
  const runState = getMobileLiveRunState();
  if (runState) return isMobileLiveRunState(runState);
  const state = String(window.RagentRunActivity?.getActivity?.()?.state || "");
  return state !== "" && state !== "idle";
}

window.RagentRunActivity?.subscribe?.((presentation) => {
  syncMobileLiveActivityLine(presentation);
  for (const node of messagesInner?.querySelectorAll?.(".live-operation-row.state-running") || []) {
    if (node.__ragentOperationEvent) renderOperationNodeContent(node, node.__ragentOperationEvent,
      { expanded: node.classList.contains("is-expanded") });
  }
});

function getActiveMobileThinkingGroup() {
  if (!shouldCompactMobileThinking()) return null;
  const block = messagesInner?.lastElementChild || null;
  if (block?.dataset?.mobileThinkingGroup !== "true") return null;
  const body = block.querySelector?.(":scope > .thinking-body") || null;
  if (!body) return null;
  return {
    block,
    body,
    label: block.querySelector?.(":scope > .thinking-header .thinking-label") || null,
  };
}

function loadMobileThinkingGroup(group) {
  if (!group?.body) return;
  for (const child of group.body.children || []) {
    if (typeof child?.ragentLoadEventBlock === "function") {
      child.ragentLoadEventBlock();
    }
  }
}

function updateMobileThinkingGroup(group, evt) {
  if (!group?.block) return;
  const running = isRunningThinkingBlockEvent(evt)
    || (evt?.type === "operation" && normalizeOperationState(evt?.state) === "running");
  group.block.classList.toggle("running", running);
  if (group.label) {
    group.label.textContent = running ? t("thinking.active") : t("thinking.done");
  }
  if (evt?.type !== "operation" && Number.isInteger(evt?.seq)) {
    group.block.dataset.eventSeq = String(evt.seq);
  }
}

function createMobileThinkingGroup(evt = {}, { beforeNode = null } = {}) {
  const thinking = createDeferredThinkingBlock(getThinkingBlockLabel(evt), {
    collapsed: true,
  });
  thinking.block.dataset.mobileThinkingGroup = "true";
  thinking.block.dataset.eventSeq = String(Number.isInteger(evt?.seq) ? evt.seq : 0);
  thinking.header.addEventListener("click", () => {
    thinking.block.classList.toggle("collapsed");
    const expanded = !thinking.block.classList.contains("collapsed");
    if (typeof setRunningEventBlockExpanded === "function") {
      setRunningEventBlockExpanded(currentSessionId, expanded);
    }
    if (!expanded) return;
    loadMobileThinkingGroup({ block: thinking.block, body: thinking.body, label: thinking.label });
    if (thinking.block.classList.contains("running") && typeof refreshCurrentSession === "function") {
      refreshCurrentSession().catch(() => {});
    }
  });
  if (beforeNode?.parentNode === messagesInner) {
    messagesInner.insertBefore(thinking.block, beforeNode);
  } else {
    messagesInner.appendChild(thinking.block);
  }
  const group = {
    block: thinking.block,
    body: thinking.body,
    label: thinking.label,
  };
  updateMobileThinkingGroup(group, evt);
  return group;
}

function appendMobileThinkingSegment(group, sessionId, evt) {
  if (!group?.body) return null;
  const segment = document.createElement("div");
  segment.className = "mobile-thinking-segment";
  segment.dataset.eventSeq = String(Number.isInteger(evt?.seq) ? evt.seq : 0);
  segment.dataset.blockRange = "";
  segment.dataset.blockStartSeq = String(Number.isInteger(evt?.blockStartSeq) ? evt.blockStartSeq : 0);
  segment.dataset.blockEndSeq = String(Number.isInteger(evt?.blockEndSeq) ? evt.blockEndSeq : 0);
  segment.ragentLoadEventBlock = () => {
    if (parseEventBlockSeq(evt?.blockStartSeq) < 1 || parseEventBlockSeq(evt?.blockEndSeq) < 1) {
      return;
    }
    ensureEventBlockLoaded(sessionId, segment, evt).catch(() => {});
  };
  group.body.appendChild(segment);
  if (!group.block.classList.contains("collapsed")) {
    segment.ragentLoadEventBlock();
  }
  return segment;
}

function getMobileThinkingBlockBody(block) {
  return block?.querySelector?.(":scope > .thinking-body")
    || block?.querySelector?.(".thinking-body")
    || null;
}

function getMobileThinkingBlockLabel(block) {
  return block?.querySelector?.(":scope > .thinking-header .thinking-label")
    || block?.querySelector?.(".thinking-label")
    || null;
}

function isMobileCommandOperationNode(node) {
  return !!node?.classList?.contains("live-operation-row")
    && node.classList.contains("kind-command");
}

function isMobileThinkingBlockNode(node) {
  return !!node?.classList?.contains("thinking-block");
}

function isMobileThinkingGroupNode(node) {
  return isMobileThinkingBlockNode(node) && node?.dataset?.mobileThinkingGroup === "true";
}

function isMobileThinkingCompactionNode(node) {
  return isMobileThinkingBlockNode(node) || isMobileCommandOperationNode(node);
}

function getMobileThinkingNodeSeq(node) {
  const ownSeq = parseEventBlockSeq(node?.dataset?.eventSeq);
  if (ownSeq > 0) return ownSeq;
  const segment = node?.querySelector?.(".mobile-thinking-segment[data-event-seq]") || null;
  return parseEventBlockSeq(segment?.dataset?.eventSeq);
}

function syncMobileThinkingGroupLabel(group, nodes = []) {
  if (!group?.block) return;
  const running = nodes.some((node) => node?.classList?.contains("running"))
    || group.block.classList.contains("running");
  group.block.classList.toggle("running", running);
  if (group.label) {
    group.label.textContent = running ? t("thinking.active") : t("thinking.done");
  }
  let latestSeq = parseEventBlockSeq(group.block.dataset?.eventSeq);
  for (const node of nodes) {
    latestSeq = Math.max(latestSeq, getMobileThinkingNodeSeq(node));
  }
  if (latestSeq > 0) group.block.dataset.eventSeq = String(latestSeq);
}

function createMobileThinkingSegmentFromBlock(block) {
  const body = getMobileThinkingBlockBody(block);
  const segment = document.createElement("div");
  segment.className = "mobile-thinking-segment";
  const eventSeq = parseEventBlockSeq(block?.dataset?.eventSeq);
  const blockStartSeq = parseEventBlockSeq(body?.dataset?.blockStartSeq || block?.dataset?.blockStartSeq);
  const blockEndSeq = parseEventBlockSeq(body?.dataset?.blockEndSeq || block?.dataset?.blockEndSeq);
  const blockRange = body?.dataset?.blockRange || "";
  segment.dataset.eventSeq = String(eventSeq);
  segment.dataset.blockRange = blockRange;
  segment.dataset.blockStartSeq = String(blockStartSeq);
  segment.dataset.blockEndSeq = String(blockEndSeq);
  segment.dataset.renderedBlockStartSeq = String(parseEventBlockSeq(body?.dataset?.renderedBlockStartSeq));
  segment.dataset.renderedBlockEndSeq = String(parseEventBlockSeq(body?.dataset?.renderedBlockEndSeq));
  segment.ragentLoadEventBlock = () => {
    const nextStartSeq = parseEventBlockSeq(segment.dataset.blockStartSeq);
    const nextEndSeq = parseEventBlockSeq(segment.dataset.blockEndSeq);
    if (nextStartSeq < 1 || nextEndSeq < 1) return;
    ensureEventBlockLoaded(currentSessionId, segment, {
      seq: eventSeq,
      blockStartSeq: nextStartSeq,
      blockEndSeq: nextEndSeq,
    }).catch(() => {});
  };
  if (body) {
    while (body.firstChild) {
      segment.appendChild(body.firstChild);
    }
  }
  return segment;
}

function mergeMobileThinkingNodesIntoGroup(group, nodes) {
  if (!group?.body || !Array.isArray(nodes) || nodes.length === 0) return;
  for (const node of nodes) {
    if (!node || node === group.block) continue;
    if (isMobileThinkingGroupNode(node)) {
      const body = getMobileThinkingBlockBody(node);
      if (body) {
        while (body.firstChild) {
          group.body.appendChild(body.firstChild);
        }
      }
      node.remove();
      continue;
    }
    if (isMobileThinkingBlockNode(node)) {
      group.body.appendChild(createMobileThinkingSegmentFromBlock(node));
      node.remove();
      continue;
    }
    if (isMobileCommandOperationNode(node)) {
      group.body.appendChild(node);
    }
  }
  syncMobileThinkingGroupLabel(group, nodes);
}

function compactMobileThinkingTimeline() {
  if (!messagesInner) return false;
  if (!shouldCompactMobileThinking()) {
    removeMobileLiveActivityLine();
    return false;
  }
  let changed = false;
  for (const node of Array.from(messagesInner.children || [])) {
    if (!isMobileThinkingCompactionNode(node)) continue;
    node.remove();
    changed = true;
  }
  syncMobileLiveActivityLine();
  return changed;
}

function findRenderedThinkingBlock(seq) {
  if (!Number.isInteger(seq)) return null;
  const targetSeq = String(seq);
  for (const node of messagesInner.children || []) {
    if (!node?.classList?.contains("thinking-block")) continue;
    if (node?.dataset?.eventSeq === targetSeq) return node;
    if (
      node?.dataset?.mobileThinkingGroup === "true"
      && node.querySelector?.(`.mobile-thinking-segment[data-event-seq="${targetSeq}"]`)
    ) {
      return node;
    }
  }
  return null;
}

function findLatestRunningThinkingBlock() {
  const nodes = messagesInner?.children || [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node?.classList?.contains("thinking-block") && node.classList.contains("running")) {
      return node;
    }
  }
  return null;
}

function getEditingStatusContainer() {
  if (typeof currentThinkingBlock !== "undefined" && currentThinkingBlock?.body) {
    return currentThinkingBlock.body;
  }
  const runningBlock = findLatestRunningThinkingBlock();
  if (runningBlock) {
    return runningBlock.querySelector(".thinking-body") || runningBlock;
  }
  return getThinkingBody();
}

function refreshExpandedRunningThinkingBlock(sessionId, evt) {
  if (!sessionId || !evt) return false;
  const block = findRenderedThinkingBlock(evt.seq);
  if (!block || block.classList?.contains("collapsed")) return false;
  const label = block.querySelector(".thinking-label");
  if (label) {
    label.textContent = getThinkingBlockLabel(evt);
  }
  if (block.dataset?.mobileThinkingGroup === "true") {
    const targetSeq = String(Number.isInteger(evt?.seq) ? evt.seq : 0);
    const segment = Array.from(block.querySelectorAll?.(".mobile-thinking-segment") || [])
      .find((node) => node?.dataset?.eventSeq === targetSeq) || null;
    if (!segment) return false;
    segment.dataset.blockStartSeq = String(Number.isInteger(evt?.blockStartSeq) ? evt.blockStartSeq : 0);
    segment.dataset.blockEndSeq = String(Number.isInteger(evt?.blockEndSeq) ? evt.blockEndSeq : 0);
    ensureEventBlockLoaded(sessionId, segment, evt).catch(() => {});
    return true;
  }
  block.dataset.blockStartSeq = String(Number.isInteger(evt?.blockStartSeq) ? evt.blockStartSeq : 0);
  block.dataset.blockEndSeq = String(Number.isInteger(evt?.blockEndSeq) ? evt.blockEndSeq : 0);
  const body = block.querySelector(".thinking-body");
  if (!body) return false;
  body.dataset.blockStartSeq = block.dataset.blockStartSeq;
  body.dataset.blockEndSeq = block.dataset.blockEndSeq;
  ensureEventBlockLoaded(sessionId, body, evt).catch(() => {});
  return true;
}

function renderCollapsedBlock(evt) {
  renderThinkingBlockEvent({
    ...(evt && typeof evt === "object" ? evt : {}),
    state: typeof evt?.state === "string" ? evt.state : "completed",
  });
}

function renderThinkingBlockEvent(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }

  const sessionId = currentSessionId;
  if (shouldCompactMobileThinking()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    if (isRunningThinkingBlockEvent(evt) && typeof setRunningEventBlockExpanded === "function") {
      setRunningEventBlockExpanded(sessionId, false);
    }
    return;
  }
  const running = isRunningThinkingBlockEvent(evt);
  const expandedByDefault = running
    ? renderedEventState?.runningBlockExpanded === true
    : shouldOpenThinkingBlocksFromPreference();
  const thinking = createDeferredThinkingBlock(getThinkingBlockLabel(evt), {
    collapsed: !expandedByDefault,
  });
  if (running) thinking.block.classList.add("running");
  thinking.block.dataset.eventSeq = String(Number.isInteger(evt?.seq) ? evt.seq : 0);
  thinking.block.dataset.blockStartSeq = String(Number.isInteger(evt?.blockStartSeq) ? evt.blockStartSeq : 0);
  thinking.block.dataset.blockEndSeq = String(Number.isInteger(evt?.blockEndSeq) ? evt.blockEndSeq : 0);
  thinking.body.dataset.blockRange = "";
  thinking.body.dataset.blockStartSeq = thinking.block.dataset.blockStartSeq;
  thinking.body.dataset.blockEndSeq = thinking.block.dataset.blockEndSeq;

  if (running && typeof setRunningEventBlockExpanded === "function") {
    setRunningEventBlockExpanded(sessionId, expandedByDefault);
  }

  thinking.header.addEventListener("click", () => {
    thinking.block.classList.toggle("collapsed");
    const expanded = !thinking.block.classList.contains("collapsed");
    if (running && typeof setRunningEventBlockExpanded === "function") {
      setRunningEventBlockExpanded(sessionId, expanded);
    }
    if (!expanded) return;
    ensureEventBlockLoaded(sessionId, thinking.body, evt).catch(() => {});
    if (running && typeof refreshCurrentSession === "function") {
      refreshCurrentSession().catch(() => {});
    }
  });

  messagesInner.appendChild(thinking.block);
  if (expandedByDefault) {
    ensureEventBlockLoaded(sessionId, thinking.body, evt).catch(() => {});
  }
}

function renderToolUse(evt) {
  if (shouldCompactMobileThinking()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  if (typeof FILE_EDIT_TOOLS !== "undefined" && FILE_EDIT_TOOLS.has(evt.toolName)) {
    const container = getEditingStatusContainer();
    const editStatus = renderFileEditInlineStatusInto(container, evt);
    if (editStatus) {
      if (currentThinkingBlock?.tools && evt.toolName) {
        currentThinkingBlock.tools.add(evt.toolName);
      }
      return;
    }
  }
  const container = getThinkingBody();
  renderToolUseInto(container, evt, {
    toolTracker: currentThinkingBlock?.tools || null,
  });
}

function renderToolResult(evt) {
  if (shouldCompactMobileThinking()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  const searchRoot =
    inThinkingBlock && currentThinkingBlock
      ? currentThinkingBlock.body
      : messagesInner;
  let result = renderToolResultInto(searchRoot, evt);
  if (!result && searchRoot !== messagesInner) {
    result = renderToolResultInto(messagesInner, evt);
  }
}

function renderFileChange(evt) {
  if (shouldCompactMobileThinking()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  const container = getThinkingBody();
  renderFileChangeEditingStatusInto(container, evt);
  renderFileChangeInto(container, evt);
}

function renderOperation(evt) {
  if (inThinkingBlock) finalizeThinkingBlock();
  if (shouldCompactMobileThinking()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  renderOperationInto(messagesInner, evt);
}

function renderReasoning(evt) {
  if (shouldCompactMobileThinking()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  const container = getThinkingBody();
  renderReasoningInto(container, evt);
}

function renderPlanEvent(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  window.RagentRunActivity?.noteProgressPlan?.(evt);
  renderPlanEventInto(messagesInner, evt);
}

// renderApprovalRequest removed 2026-08-04 — the Decision Sheet owns the
// approval request surface; only the summary line renders on response.

function renderApprovalResponse(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  renderApprovalResponseInto(messagesInner, evt);
}

function isReplySelfCheckStatusEvent(evt) {
  return evt?.type === "status"
    && typeof evt?.content === "string"
    && evt.content.startsWith("Assistant self-check:");
}

function isReplySelfCheckOperationEvent(evt) {
  return evt?.type === "context_operation"
    && evt?.operation === "continue_turn"
    && evt?.trigger === "automatic";
}

function getContainerLastElement(container) {
  if (!container) return null;
  if (container.lastElementChild) return container.lastElementChild;
  if (Array.isArray(container.children) && container.children.length > 0) {
    return container.children[container.children.length - 1] || null;
  }
  return null;
}

function getOrCreateReplySelfCheckDrawer(container) {
  if (!container) return null;
  const existing = replySelfCheckDrawerByContainer.get(container);
  if (
    existing?.drawer
    && existing.drawer.parentNode === container
    && getContainerLastElement(container) === existing.drawer
  ) {
    return existing;
  }

  const drawer = document.createElement("details");
  drawer.className = "turn-collapse-drawer reply-self-check-drawer";

  const summary = document.createElement("summary");
  summary.className = "turn-collapse-summary";
  summary.textContent = t("replySelfCheck.drawerSummary");
  drawer.appendChild(summary);

  const body = document.createElement("div");
  body.className = "turn-collapse-body";
  drawer.appendChild(body);

  container.appendChild(drawer);
  const created = { drawer, summary, body };
  replySelfCheckDrawerByContainer.set(container, created);
  return created;
}

function renderStatusInto(container, evt, { allowReplySelfCheckCollapse = true } = {}) {
  if (!container) return null;
  if (typeof evt?.content !== "string") {
    return null;
  }
  if (isCodexAppServerLifecycleStatusEvent(evt)) {
    return null;
  }
  if (isProviderUsageLimitStatusEvent(evt)) {
    return null;
  }
  if (
    !evt.content
    || evt.content === "[object Object]"
    || evt.content === "completed"
    || evt.content === "thinking"
  ) {
    return null;
  }
  if (allowReplySelfCheckCollapse && isReplySelfCheckStatusEvent(evt)) {
    const drawer = getOrCreateReplySelfCheckDrawer(container);
    if (!drawer?.body) return null;
    return renderStatusInto(drawer.body, evt, {
      allowReplySelfCheckCollapse: false,
    });
  }
  const div = document.createElement("div");
  div.className = "msg-system";
  div.textContent = evt.content;
  container.appendChild(div);
  return div;
}

function renderStatusMsg(evt) {
  if (isCodexAppServerTerminalLifecycleStatusEvent(evt)) {
    if (inThinkingBlock) {
      finalizeThinkingBlock();
    }
    finalizeLiveMessageMetadata();
    return;
  }
  if (isCodexAppServerLifecycleStatusEvent(evt)) {
    return;
  }
  if (isProviderUsageLimitStatusEvent(evt)) {
    return;
  }
  if (shouldCompactMobileThinking() && hasActiveMobileRunActivity()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  // Finalize thinking block when the AI turn ends (completed/error)
  if (inThinkingBlock && evt.content !== "thinking") {
    finalizeThinkingBlock();
  }
  if (evt.content && evt.content !== "thinking") {
    finalizeLiveMessageMetadata();
  }
  renderStatusInto(messagesInner, evt);
}

function renderContextBarrierInto(container, evt) {
  if (!container) return null;
  const div = document.createElement("div");
  div.className = "context-barrier";
  div.textContent = evt.content || t("context.barrier");
  container.appendChild(div);
  return div;
}

function renderContextBarrier(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  if (shouldCompactMobileThinking() && hasActiveMobileRunActivity()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  renderContextBarrierInto(messagesInner, evt);
}

function humanizeContextOperationValue(value) {
  return String(value || "").trim().replace(/_/g, " ");
}

function renderContextOperationInto(container, evt, { allowReplySelfCheckCollapse = true } = {}) {
  if (!container) return null;
  if (allowReplySelfCheckCollapse && isReplySelfCheckOperationEvent(evt)) {
    const drawer = getOrCreateReplySelfCheckDrawer(container);
    if (!drawer?.body) return null;
    return renderContextOperationInto(drawer.body, evt, {
      allowReplySelfCheckCollapse: false,
    });
  }
  const card = document.createElement("div");
  card.className = "context-operation";
  if (evt?.phase) card.dataset.phase = evt.phase;
  if (evt?.operation) card.dataset.operation = evt.operation;

  const title = document.createElement("div");
  title.className = "context-operation-title";
  title.textContent = evt?.title || evt?.content || t("context.barrier");
  card.appendChild(title);

  const summaryText = typeof evt?.summary === "string" ? evt.summary.trim() : "";
  if (summaryText) {
    const summary = document.createElement("div");
    summary.className = "context-operation-summary";
    summary.textContent = summaryText;
    card.appendChild(summary);
  }

  const metaParts = [];
  const phaseText = humanizeContextOperationValue(evt?.phase);
  if (phaseText) metaParts.push(phaseText);
  const triggerText = humanizeContextOperationValue(evt?.trigger);
  if (triggerText) metaParts.push(triggerText);
  if (Number.isInteger(evt?.compactedThroughSeq) && evt.compactedThroughSeq > 0) {
    metaParts.push(`through #${evt.compactedThroughSeq}`);
  }
  if (metaParts.length > 0) {
    const meta = document.createElement("div");
    meta.className = "context-operation-meta";
    meta.textContent = metaParts.join(" · ");
    card.appendChild(meta);
  }

  const reasonText = typeof evt?.reason === "string" ? evt.reason.trim() : "";
  if (reasonText) {
    const reason = document.createElement("div");
    reason.className = "context-operation-reason";
    reason.textContent = reasonText;
    card.appendChild(reason);
  }

  container.appendChild(card);
  return card;
}

function renderContextOperation(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  if (shouldCompactMobileThinking() && hasActiveMobileRunActivity()) {
    window.RagentRunActivity?.applyEvent?.(evt);
    syncMobileLiveActivityLine();
    return;
  }
  renderContextOperationInto(messagesInner, evt);
}

function formatCompactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  return `${Math.round(n / 1000)}K`;
}

function getContextTokens(evt) {
  if (Number.isFinite(evt?.contextTokens)) return evt.contextTokens;
  return 0;
}

function getContextWindowTokens(evt) {
  if (Number.isFinite(evt?.contextWindowTokens)) return evt.contextWindowTokens;
  return 0;
}

function getContextPercent(contextSize, contextWindowSize) {
  if (!(contextSize > 0) || !(contextWindowSize > 0)) return null;
  return (contextSize / contextWindowSize) * 100;
}

function formatContextPercent(percent, { precise = false } = {}) {
  if (!Number.isFinite(percent)) return "";
  if (precise) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function updateContextDisplay(contextSize, contextWindowSize) {
  currentTokens = contextSize;
  if (contextSize > 0 && currentSessionId) {
    contextTokens.textContent = "";
    contextTokens.title = "";
    contextTokens.style.display = "none";
    compactBtn.style.display = "";
    dropToolsBtn.style.display = "";
    if (typeof syncComposerModeUi === "function") {
      syncComposerModeUi();
    }
  }
}

function renderUsageInto(container, evt, { updateContext = false } = {}) {
  const contextSize = getContextTokens(evt);
  if (!(contextSize > 0)) return null;
  const contextWindowSize = getContextWindowTokens(evt);
  if (updateContext) {
    updateContextDisplay(contextSize, contextWindowSize);
  }
  return null;
}

function renderUsage(evt) {
  renderUsageInto(messagesInner, evt, { updateContext: true });
}

function renderUnknownEventInto(container, evt) {
  // Unknown provider/runtime events are intentionally not transcript content.
  // Rendering their full payload leaks protocol metadata (and makes a new
  // event type look like an assistant response). Add an explicit renderer when
  // a future event is meant to be user-visible.
  void container;
  void evt;
  return null;
}

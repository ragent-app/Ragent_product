"use strict";

// Decision Sheet — non-modal surface on every viewport (mobile + desktop) that
// grows upward from the Live Bar when a runtime approval is pending. It is the
// thumb-reachable "decision-downplacement" entry (哲学：决策下置). Since
// 2026-08-04 the in-stream approval card is removed — the sheet is the single
// approval surface; the .runtime-approval-summary line stays in the
// conversation as the auditable record. The sheet is NON-modal on purpose: no
// backdrop, no focus trap on the canvas, no dismiss-on-background — the user
// can scroll the conversation to review context while deciding. It persists
// until the user explicitly approves/denies (or the approval resolves).
//
// Data comes from window.AgentoCDecisions (decisions-store.js), fed by
// realtime-render.js. The actual decision dispatch reuses the existing
// submitRuntimeApprovalDecision() so behavior stays identical to the card.
(function attachDecisionSheet(root) {
  const doc = root.document;
  if (!doc) return;

  const SHEET_ID = "decisionSheet";
  const CSS_HREF_MARKER = "chat/chat-decision-sheet.css";
  // Collapse animation duration, aligned with the notification-style
  // .is-closing keyframes.
  const SHEET_HIDE_ANIMATION_MS = 180;

  let hostEl = null;       // #decisionSheet container
  let islandEl = null;     // #decisionIsland container
  let currentDecisionInfo = {
    kind: "",
    title: "",
    riskTier: "",
    evt: null,
  };
  let renderedApprovalId = "";
  let renderedBatchId = "";
  let renderedBatchSignature = "";
  let renderedActionBatchId = "";
  let renderedActionSignature = "";
  // Which surface is currently shown: "" | "approval" | "batch". The batch
  // (privileged danger ops) wins over a regular approval when both are pending.
  let renderedKind = "";
  let unsub = null;
  let unsubBatch = null;
  let unsubAction = null;
  let hideSheetTimer = null;
  let collapseIslandTimer = null;
  let islandExitTimer = null;
  let islandEnterTimer = null;
  let refreshFrame = null;
  let returnFocusEl = null;
  let keydownBound = false;

  function requestSheetLayout(reason = "decision-sheet") {
    root.AgentoCLayout?.requestPass?.(reason);
    root.AgentoCLayout?.syncChatBottomOverlaySpacing?.(reason);
  }

  function rememberReturnFocus() {
    const active = doc.activeElement;
    if (active && active !== doc.body && !hostEl?.contains?.(active)) returnFocusEl = active;
  }

  function restoreReturnFocus() {
    const target = returnFocusEl;
    returnFocusEl = null;
    if (!target?.isConnected || typeof target.focus !== "function") return;
    target.focus({ preventScroll: true });
  }

  function bindKeyboardDismissal() {
    if (keydownBound) return;
    keydownBound = true;
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (hostEl && !hostEl.hidden) {
        event.preventDefault();
        if (typeof collapseToIsland === "function") {
          collapseToIsland();
        } else {
          hideSheet();
        }
        return;
      }
      if (islandEl && !islandEl.hidden && islandEl.classList.contains("visible")) {
        event.preventDefault();
        hideIsland();
      }
    });
  }

  function tr(key, vars) {
    if (typeof root.agentocT === "function") return root.agentocT(key, vars);
    return key;
  }

  // A sheet can outlive its run when a reconnect replays an old request, or
  // when another surface already submitted the decision. These responses are
  // terminal acknowledgements for the UI. Keep 409 narrow: the privileged
  // endpoints also use 409 for a missing WebAuthn credential, which must stay
  // retryable instead of silently dismissing the approval.
  function isApprovalAlreadyEndedError(error) {
    const code = String(error?.code || "").trim().toUpperCase();
    if ([
      "APPROVAL_NOT_FOUND",
      "RUN_TERMINAL",
      "RUN_NOT_FOUND",
      "SESSION_NOT_FOUND",
      "PRIVILEGED_BATCH_NOT_FOUND",
      "APPROVED_ACTION_RUN_NOT_FOUND",
      "APPROVED_ACTION_SESSION_NOT_FOUND",
      "APPROVED_ACTION_BATCH_NOT_FOUND",
    ].includes(code)) return true;
    const status = Number(error?.status || 0);
    return status === 404 || status === 410;
  }

  function dismissPrivilegedBatchFromUi(batch) {
    root.AgentoCDecisions?.dismissPrivilegedBatch?.(batch, {
      sessionId: String(batch?.sessionId || currentSessionId || "").trim(),
      runId: String(batch?.runId || "").trim(),
      batchId: String(batch?.batchId || "").trim(),
    });
  }

  function dismissApprovedActionFromUi(evt) {
    root.AgentoCDecisions?.dismissApprovedAction?.(evt, {
      sessionId: String(evt?.sessionId || currentSessionId || "").trim(),
      runId: String(evt?.runId || "").trim(),
      batchId: String(evt?.batchId || "").trim(),
    });
  }

  function renderIcon(name, className) {
    if (typeof root.AgentoCIcons?.render !== "function") return "";
    return root.AgentoCIcons.render(name, { className });
  }

  // ---- risk-level interface (reserved hook) --------------------------------
  // The approval event has no risk field today. We expose a resolver + UI slot so
  // a future backend field (evt.risk / riskLevel / severity) lights up the badge
  // with ZERO UI changes. Until then it returns {tier:"none"} and stays hidden —
  // we do not fabricate a risk guess that could mislead.
  function resolveApprovalRisk(evt) {
    const raw = (typeof evt?.risk === "object" && evt?.risk !== null)
      ? (evt.risk.tier || evt.risk.level || evt.risk.severity)
      : (evt?.risk ?? evt?.riskLevel ?? evt?.severity ?? evt?.level);
    const norm = String(raw || "").trim().toLowerCase();
    let tier = "none";
    if (["high", "critical", "danger", "severe", "elevated"].includes(norm)) tier = "high";
    else if (["medium", "moderate", "warn", "warning"].includes(norm)) tier = "medium";
    else if (["low", "info", "minor", "safe"].includes(norm)) tier = "low";
    if (tier === "none") return { tier: "none", label: "" };
    return { tier, label: tr(`decisionSheet.risk.${tier}`) };
  }

  // ---- privileged batch approvals (Phase 5) --------------------------------
  // A danger-tier turn surfaces as ONE privileged_batch_request event carrying
  // two independent popup groups: `other` (privileged non-delete ops, checked
  // by default) and `delete` (destructive deletes, unchecked by default). Each
  // group resolves through its own WebAuthn assertion (service-side manifest-
  // bound challenge — P4 already ships the crypto, the surface layer is new).
  const BATCH_CATEGORIES = ["other", "delete"];

  function batchRenderSignature(evt, resolved) {
    const resolvedCategories = Array.from(resolved || []).map((value) => String(value)).sort();
    const seen = new Set();
    const normalize = (value, key = "") => {
      // Replayed history/WS projections may carry a new transport timestamp
      // or sequence while the approval itself is unchanged. Exclude those
      // volatile fields so the batch surface is not rebuilt (and animated)
      // repeatedly while it waits for the owner.
      if (["timestamp", "createdAt", "updatedAt", "seq", "startSeq", "endSeq", "eventId"].includes(key)) {
        return undefined;
      }
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      let normalized;
      if (Array.isArray(value)) {
        normalized = value.map(normalize);
      } else {
        normalized = {};
        for (const key of Object.keys(value).sort()) {
          const child = normalize(value[key], key);
          if (child !== undefined) normalized[key] = child;
        }
      }
      seen.delete(value);
      return normalized;
    };
    try {
      return JSON.stringify(normalize({ event: evt, resolved: resolvedCategories }));
    } catch {
      // Approval payloads are JSON in production. Keep a useful fallback for
      // connector/test objects that contain a cycle rather than rebuilding on
      // every replay of the same batch.
      return `${String(evt?.batchId || "")}|${resolvedCategories.join(",")}`;
    }
  }

  function batchCategoryLabel(category) {
    return tr(`decisionSheet.privileged.category.${category}`);
  }

  function batchCategoryCount(evt, category) {
    return Array.isArray(evt?.[category]) ? evt[category].length : 0;
  }

  function batchTitle(evt) {
    const operation = ["other", "delete"]
      .flatMap((category) => Array.isArray(evt?.[category]) ? evt[category] : [])
      .find((item) => String(item?.description || item?.reason || "").trim());
    const text = String(operation?.description || operation?.reason || evt?.reason || "")
      .trim().replace(/\s+/g, " ");
    if (text) return text.length <= 88 ? text : `${text.slice(0, 87).trimEnd()}…`;
    return tr("decisionSheet.privileged.title");
  }

  // ---- 人话解释区（summary/reason/saferAlternative） -----------------------
  // 共享渲染：批量 op（op.explanation）与普通审批（evt.explanation）同款。
  // 人话先行，技术细节（targetPaths/sudo/...）随后。
  function displayApprovalExplanation(explanation) {
    return typeof root.agentocApprovalExplanation === "function"
      ? root.agentocApprovalExplanation(explanation, tr) : explanation;
  }

  function appendExplanation(explanation, container, skipSummary = false) {
    if (!explanation || typeof explanation !== "object") return;
    explanation = displayApprovalExplanation(explanation);
    const fields = [
      [tr("decisionSheet.explanation.summary"), skipSummary ? "" : explanation.summary],
      [tr("decisionSheet.explanation.reason"), explanation.reason],
      [tr("decisionSheet.explanation.safer"), explanation.saferAlternative],
    ].filter(([, value]) => String(value || "").trim());
    if (fields.length === 0) return;
    const wrap = el("div", "decision-sheet__explanation");
    wrap.appendChild(el("div", "decision-sheet__explanation-title", tr("decisionSheet.explanation.title")));
    for (const [label, value] of fields) {
      const row = el("div", "decision-sheet__explanation-row");
      row.appendChild(el("div", "decision-sheet__explanation-label", label));
      const valueNode = el("div", "decision-sheet__explanation-value", String(value));
      valueNode.setAttribute("dir", "auto");
      row.appendChild(valueNode);
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  // -- signals detail rows (② risk detail) ---------------------------------
  // Per-op risk.signals from the gate classifier: target paths, sudo flag,
  // reversibility, file-count estimate and the human-readable reasons.
  function appendRiskSignals(op, container) {
    appendExplanation(op?.explanation, container);
    const risk = op?.risk && typeof op.risk === "object" ? op.risk : null;
    if (!risk) return;
    const signals = risk.signals && typeof risk.signals === "object" ? risk.signals : null;
    if (!signals) return;
    const rows = [];
    if (Array.isArray(signals.targetPaths) && signals.targetPaths.length > 0) {
      rows.push([tr("decisionSheet.risk.detail.paths"), signals.targetPaths.join("\n")]);
    }
    if (signals.sudo === true) {
      rows.push([tr("decisionSheet.risk.detail.sudo"), tr("decisionSheet.risk.detail.yes")]);
    }
    if (signals.reversible === false) {
      rows.push([tr("decisionSheet.risk.detail.reversible"), tr("decisionSheet.risk.detail.no")]);
    }
    const fileCount = String(signals.fileCountEstimate || "");
    if (fileCount && fileCount !== "one") {
      rows.push([tr("decisionSheet.risk.detail.files"), tr(`decisionSheet.risk.detail.files.${fileCount}`)]);
    }
    if (Array.isArray(signals.reasons) && signals.reasons.length > 0) {
      rows.push([tr("decisionSheet.risk.detail.reasons"), signals.reasons.join("\n")]);
    }
    if (rows.length === 0) return;
    const wrap = el("div", "decision-sheet__batch-op-signals");
    for (const [label, value] of rows) {
      const row = el("div", "decision-sheet__batch-op-signal");
      row.appendChild(el("div", "decision-sheet__batch-op-signal-label", label));
      const valueNode = el("div", "decision-sheet__batch-op-signal-value", value);
      valueNode.setAttribute("dir", "auto");
      row.appendChild(valueNode);
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  // -- base64url helpers (WebAuthn assertion encoding) -----------------------
  function toBase64Url(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    if (typeof btoa !== "function") return "";
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // WebAuthn JSON options use base64url strings on the wire, while the
  // browser API requires ArrayBuffer values for challenge and credential ids.
  // Keep this conversion here because the decision sheet is loaded separately
  // from the realtime interaction flow in realtime.js.
  function fromBase64Url(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  function hydrateWebAuthnPublicKey(publicKey = {}) {
    const hydrated = { ...publicKey };
    if (publicKey.challenge) hydrated.challenge = fromBase64Url(publicKey.challenge);
    for (const key of ["allowCredentials", "excludeCredentials"]) {
      if (Array.isArray(publicKey[key])) {
        hydrated[key] = publicKey[key].map((credential) => ({
          ...credential,
          id: fromBase64Url(credential.id),
        }));
      }
    }
    return hydrated;
  }

  function batchEndpoint(runId, batchId, category, extra = "") {
    const enc = (value) => encodeURIComponent(String(value || "").trim());
    return `/api/runs/${enc(runId)}/privileged-batches/${enc(batchId)}/categories/${enc(category)}${extra}`;
  }

  // Get the currently checked op ids for one category group from the DOM.
  function collectCheckedOpIds(category) {
    if (!hostEl) return [];
    const ids = [];
    hostEl.querySelectorAll(`.decision-sheet__batch-op-check[data-category="${category}"]`).forEach((box) => {
      if (box.checked) ids.push(String(box.value || "").trim());
    });
    return ids.filter(Boolean);
  }

  // ③ WebAuthn flow: challenge -> navigator.credentials.get() -> proof.
  async function obtainWebAuthnProof(category, checkedOpIds, batchOverride = null) {
    const batch = batchOverride || root.AgentoCDecisions?.getPendingBatch?.();
    if (!batch) throw new Error(tr("decisionSheet.privileged.error.noBatch"));
    const challengeRes = await (window.agentocFetch || fetch)(batchEndpoint(batch.runId, batch.batchId, category, "/webauthn-challenge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkedOpIds }),
    });
    if (!challengeRes.ok) {
      let message = `${challengeRes.status}`;
      let payload = {};
      try {
        payload = await challengeRes.json();
        if (payload?.error) message = payload.error;
        if (challengeRes.status === 409 && payload?.code === "WEBAUTHN_CREDENTIAL_REQUIRED") {
          message = tr("decisionSheet.privileged.error.noCredential");
        }
      } catch { /* non-JSON error body */ }
      const error = new Error(message);
      error.status = challengeRes.status;
      error.code = String(payload?.code || "").trim();
      throw error;
    }
    const options = await challengeRes.json();
    if (typeof navigator?.credentials?.get !== "function") {
      throw new Error(tr("decisionSheet.privileged.error.noBiometrics"));
    }
    const credential = await navigator.credentials.get({
      publicKey: hydrateWebAuthnPublicKey(options?.publicKey || {}),
    });
    if (!credential?.response) throw new Error(tr("decisionSheet.privileged.error.assertion"));
    const response = credential.response;
    const proof = {
      id: String(credential.id || "").trim(),
      rawId: credential.rawId ? toBase64Url(credential.rawId) : String(credential.id || "").trim(),
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.authenticatorData),
        signature: toBase64Url(response.signature),
        ...(response.userHandle && response.userHandle.byteLength > 0
          ? { userHandle: toBase64Url(response.userHandle) }
          : {}),
      },
    };
    return proof;
  }

  async function submitBatchCategory(category, { checkedOpIds = [], webauthnProof, batchOverride = null } = {}) {
    const batch = batchOverride || root.AgentoCDecisions?.getPendingBatch?.();
    if (!batch) throw new Error(tr("decisionSheet.privileged.error.noBatch"));
    const res = await (window.agentocFetch || fetch)(batchEndpoint(batch.runId, batch.batchId, category), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkedOpIds,
        ...(webauthnProof ? { webauthnProof } : {}),
      }),
    });
    if (!res.ok) {
      let message = `${res.status}`;
      let payload = {};
      try {
        payload = await res.json();
        if (payload?.error) message = payload.error;
      } catch { /* non-JSON error body */ }
      const error = new Error(message);
      error.status = res.status;
      error.code = String(payload?.code || "").trim();
      throw error;
    }
    // The HTTP response is authoritative. Do not wait for a separate WS
    // invalidation to collapse the category: that event can be delayed or
    // lost while the run is being finalized.
    const payload = typeof res.json === "function" ? await res.json().catch(() => ({})) : {};
    const responseEvent = payload?.responseEvent && typeof payload.responseEvent === "object"
      ? payload.responseEvent
      : { type: "privileged_batch_response", batchId: batch.batchId, runId: batch.runId, category };
    root.AgentoCDecisions?.notePrivilegedBatchResponse?.(responseEvent, {
      sessionId: String(batch?.sessionId || currentSessionId || "").trim(),
      runId: String(batch?.runId || responseEvent?.runId || "").trim(),
    });
    return true;
  }

  // Approve one category group: passkey assertion when the server still
  // requires it, then submit. The privileged_batch_response event arriving
  // afterwards collapses the group. With the owner-click policy the proof is
  // skipped and the submit carries the explicit owner click alone.
  function batchPasskeyRequired(batch) {
    // Older persisted events carry no flag; treat missing as required.
    return batch?.passkeyRequired !== false;
  }

  async function approveBatchCategory(category, button) {
    if (button) button.setAttribute("aria-busy", "true");
    const checkedOpIds = collectCheckedOpIds(category);
    const batch = root.AgentoCDecisions?.getPendingBatch?.();
    let ok = false;
    let errorMessage = "";
    try {
      const proof = batchPasskeyRequired(batch) ? await obtainWebAuthnProof(category, checkedOpIds) : null;
      ok = await submitBatchCategory(category, { checkedOpIds, webauthnProof: proof });
    } catch (error) {
      if (isApprovalAlreadyEndedError(error)) {
        dismissPrivilegedBatchFromUi(batch);
        return true;
      }
      errorMessage = error?.message || String(error || "");
      // User cancelled the biometric prompt (NotAllowedError) is not a failure
      // of the approval — keep the sheet open so they can retry or deny.
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        errorMessage = tr("decisionSheet.privileged.error.cancelled");
      }
      if (error?.status === 409) {
        errorMessage = tr("decisionSheet.privileged.error.noCredential");
      }
    }
    if (button) button.removeAttribute("aria-busy");
    if (!ok && errorMessage) showBatchError(category, errorMessage);
    return ok;
  }

  // Deny one category group: submit with zero checked ops (no biometrics —
  // denying is not a privileged action).
  async function denyBatchCategory(category, button) {
    if (button) button.setAttribute("aria-busy", "true");
    const batch = root.AgentoCDecisions?.getPendingBatch?.();
    let ok = false;
    try {
      ok = await submitBatchCategory(category, { checkedOpIds: [] });
    } catch (error) {
      if (isApprovalAlreadyEndedError(error)) {
        dismissPrivilegedBatchFromUi(batch);
        ok = true;
      } else {
        showBatchError(category, error?.message || String(error || ""));
      }
    }
    if (button) button.removeAttribute("aria-busy");
    return ok;
  }

  // The global attention popup can receive a privileged request for a
  // background session without putting that session into the Decision Sheet
  // store. Reuse the exact same WebAuthn-bound endpoint and proof flow here
  // whenever the server still requires the passkey checkpoint.
  async function submitPrivilegedBatchCategory(batch, category, decision = "deny", checkedOpIds = []) {
    try {
      const selected = decision === "approve" ? checkedOpIds : [];
      if (decision === "approve") {
        const proof = batchPasskeyRequired(batch) ? await obtainWebAuthnProof(category, selected, batch) : null;
        return submitBatchCategory(category, {
          checkedOpIds: selected,
          webauthnProof: proof,
          batchOverride: batch,
        });
      }
      return submitBatchCategory(category, { checkedOpIds: [], batchOverride: batch });
    } catch (error) {
      if (isApprovalAlreadyEndedError(error)) {
        dismissPrivilegedBatchFromUi(batch);
        // The attention popup owns a separate queue entry for background
        // sessions, so tell it to remove the whole batch rather than merely
        // marking the clicked category as resolved.
        return { ok: true, alreadyEnded: true };
      }
      throw error;
    }
  }

  function showBatchError(category, message) {
    if (!hostEl) return;
    const section = hostEl.querySelector(`.decision-sheet__batch-section[data-category="${category}"]`);
    const slot = section?.querySelector(".decision-sheet__batch-error");
    if (!slot) return;
    slot.textContent = message;
    slot.hidden = false;
    slot.setAttribute("role", "alert");
  }

  function clearBatchError(section) {
    const slot = section?.querySelector(".decision-sheet__batch-error");
    if (!slot) return;
    slot.textContent = "";
    slot.hidden = true;
    slot.removeAttribute("role");
  }

  // Keep the group's approve button disabled until at least one op is checked
  // (delete groups default to unchecked — approving nothing would still burn a
  // biometric assertion for zero effect).
  function defaultSelectedForCategory(evt, category) {
    const selected = evt?.defaultSelected;
    if (!selected || typeof selected !== "object") return [];
    // The event's operation arrays use the short display keys (`other` and
    // `delete`), while the classifier/category contract uses the canonical
    // names (`privileged_other` and `destructive_delete`). Accept both forms
    // so persisted requests and newly emitted requests render identically.
    const keys = category === "other"
      ? ["other", "privileged_other"]
      : category === "delete"
        ? ["delete", "destructive_delete"]
        : [category];
    for (const key of keys) {
      if (Array.isArray(selected[key])) return selected[key];
    }
    return [];
  }

  function syncBatchApproveState(section) {
    const category = String(section?.dataset?.category || "");
    const approve = section?.querySelector('.oneui-notification__action[data-batch-decision="approve"]');
    if (!approve) return;
    // renderBatchSection is assembled off-DOM. Query the section itself so
    // the initial state is derived from the checkboxes we just created rather
    // than from hostEl, which does not contain the section yet.
    const checked = Array.from(section.querySelectorAll?.(
      `.decision-sheet__batch-op-check[data-category="${category}"]:checked`,
    ) || []).map((node) => String(node.value || "").trim()).filter(Boolean);
    approve.disabled = checked.length === 0;
  }

  function renderBatchSection(evt, category, resolved, footerActions = null) {
    const ops = Array.isArray(evt?.[category]) ? evt[category] : [];
    if (ops.length === 0) return null;
    const unavailable = evt?.executorUnavailableReasonCode === "macos_administrator_unavailable";
    const section = el("section", "oneui-notification__batch decision-sheet__batch-section");
    section.dataset.category = category;
    const head = el("div", "decision-sheet__batch-section-head");
    const label = el("div", "oneui-notification__batch-title decision-sheet__batch-section-title");
    label.textContent = `${batchCategoryLabel(category)} · ${ops.length}`;
    head.appendChild(label);
    if (resolved.has(category)) {
      head.appendChild(el("span", "decision-sheet__batch-result", tr("decisionSheet.privileged.resolved")));
    }
    section.appendChild(head);
    const list = el("div", "decision-sheet__batch-ops");
    for (const op of ops) {
      const row = el("label", "oneui-notification__operation decision-sheet__batch-op");
      const box = doc.createElement("input");
      box.type = "checkbox";
      box.className = "decision-sheet__batch-op-check";
      box.dataset.category = category;
      box.value = String(op?.opId || "").trim();
      const defaults = defaultSelectedForCategory(evt, category);
      box.checked = Array.isArray(defaults) && defaults.includes(String(op?.opId || "").trim());
      box.disabled = unavailable || resolved.has(category);
      box.addEventListener("change", () => syncBatchApproveState(section));
      row.appendChild(box);
      const body = el("span", "decision-sheet__batch-op-body");
      const code = el("code", "oneui-notification__code decision-sheet__batch-op-command", String(op?.command || op?.description || ""));
      body.appendChild(code);
      const opRisk = resolveApprovalRisk(op);
      if (opRisk.tier !== "none") {
        const badge = el("span", "decision-sheet__batch-op-risk");
        badge.dataset.tier = opRisk.tier;
        badge.textContent = opRisk.label;
        body.appendChild(badge);
      }
      appendRiskSignals(op, body);
      row.appendChild(body);
      list.appendChild(row);
    }
    section.appendChild(list);
    const error = el("div", "decision-sheet__batch-error");
    error.hidden = true;
    section.appendChild(error);
    if (!resolved.has(category)) {
      const actions = el("div", "oneui-notification__actions oneui-notification__batch-actions decision-sheet__batch-actions");
      const approve = el("button", "oneui-notification__action oneui-notification__action--primary");
      approve.type = "button";
      approve.dataset.batchDecision = "approve";
      approve.dataset.category = category;
      approve.dataset.approvalDecision = "approve";
      approve.appendChild(el("span", "oneui-notification__action-label", tr(batchPasskeyRequired(root.AgentoCDecisions?.getPendingBatch?.())
        ? "decisionSheet.privileged.action.approve"
        : "decisionSheet.approvedAction.approve")));
      approve.addEventListener("click", () => {
        clearBatchError(section);
        void approveBatchCategory(category, approve);
      });
      const deny = el("button", "oneui-notification__action oneui-notification__action--quiet");
      deny.type = "button";
      deny.dataset.batchDecision = "deny";
      deny.dataset.category = category;
      deny.dataset.approvalDecision = "deny";
      deny.appendChild(el("span", "oneui-notification__action-label", tr("decisionSheet.privileged.action.deny")));
      deny.addEventListener("click", () => {
        clearBatchError(section);
        void denyBatchCategory(category, deny);
      });
      if (!unavailable) actions.appendChild(approve);
      actions.appendChild(deny);
      if (footerActions) {
        const group = el("div", "decision-sheet__batch-footer-group");
        group.dataset.category = category;
        group.appendChild(el("div", "decision-sheet__batch-footer-label", batchCategoryLabel(category)));
        group.appendChild(actions);
        footerActions.appendChild(group);
      } else {
        section.appendChild(actions);
      }
      syncBatchApproveState(section);
    }
    return section;
  }

  function renderBatchSheet(evt, resolved, opts = {}) {
    if (!hostEl) hostEl = injectDOM();
    if (!hostEl) return;
    if (renderedKind === "action") return;
    const batchId = String(evt?.batchId || "");
    const signature = batchRenderSignature(evt, resolved);
    // Idempotent for the already-visible batch, unless refresh is requested
    // (a category just resolved — the groups need to collapse in place). A
    // replay can still pass refresh=true, so the content signature is the
    // authoritative guard against restarting the details animation/layout.
    if (!hostEl.hidden && renderedKind === "batch" && renderedBatchId === batchId
      && renderedBatchSignature === signature) return;
    if (hostEl.hidden) rememberReturnFocus();
    if (hideSheetTimer) {
      clearTimeout(hideSheetTimer);
      hideSheetTimer = null;
    }
    if (collapseIslandTimer) {
      clearTimeout(collapseIslandTimer);
      collapseIslandTimer = null;
    }
    const keepExpanded = Boolean(opts?.refresh && hostEl.classList.contains("oneui-notification--detailed"));
    hostEl.classList.remove("is-closing", "oneui-notification--detailed", "oneui-notification--danger");
    hostEl.classList.add("oneui-notification--danger");
    hostEl.replaceChildren();
    renderedKind = "batch";
    renderedBatchId = batchId;
    renderedBatchSignature = signature;

    const risk = resolveApprovalRisk(evt);
    currentDecisionInfo = {
      kind: "batch",
      title: batchTitle(evt),
      riskTier: "danger",
      evt,
    };
    const header = createNotificationHeader(batchTitle(evt), risk, { expanded: keepExpanded });
    const content = el("div", "oneui-notification__content");
    content.id = "decisionSheetContent";
    const details = el("div", "oneui-notification__details decision-sheet__details");
    const body = el("div", "decision-sheet__batch");
    if (evt?.executorUnavailableReasonCode === "macos_administrator_unavailable") {
      const zh = String(root.agentocGetActiveUiLanguage?.() || "").toLowerCase().startsWith("zh");
      body.appendChild(el("p", "decision-sheet__batch-unavailable", zh
        ? "此 Mac 暂不支持托管管理员执行，无法批准执行；你可以拒绝该请求。"
        : "Managed administrator execution is not available on this Mac. You can decline this request."));
    }
    const footerActions = el("div", "decision-sheet__batch-footer-actions");
    for (const category of BATCH_CATEGORIES) {
      const section = renderBatchSection(evt, category, resolved, footerActions);
      if (section) body.appendChild(section);
    }
    details.appendChild(body);
    content.appendChild(details);
    hostEl.append(header, content);
    if (footerActions.children.length) {
      const footer = el("footer", "oneui-notification__footer decision-sheet__batch-footer");
      footer.appendChild(footerActions);
      hostEl.appendChild(footer);
    }

    hostEl.hidden = false;
    setSheetExpanded(keepExpanded);
    requestSheetLayout("decision-sheet-open");
    window.AgentoCBackHandler?.push?.({
      id: "decision-sheet",
      onBack: () => {
        if (typeof collapseToIsland === "function") {
          collapseToIsland();
        } else {
          hideSheet();
        }
        return true;
      },
    });
  }

  // ---- DOM bootstrap (mirrors run-sheet.js injectDOM) ----------------------
  function ensureStylesheet() {
    if (doc.querySelector(`link[data-decision-sheet]`)) return;
    const existing = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))
      .find((link) => String(link.getAttribute("href") || "").includes(CSS_HREF_MARKER));
    if (existing) return;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    // Fallback path only (stale template without the <link>); the canonical
    // versioned href lives in chat.html. No build-global is exposed client-side,
    // so omit the cache-bust query here — the primary link handles versioning.
    link.href = CSS_HREF_MARKER;
    link.setAttribute("data-decision-sheet", "");
    const head = doc.head || doc.querySelector("head");
    if (head) head.appendChild(link);
  }

  function injectDOM() {
    let el = doc.getElementById(SHEET_ID);
    if (el) {
      root.AgentoCLayout?.observeOverlay?.(el);
      return el;
    }
    // Direct child of the composer area (position:relative, z-index:3). The sheet
    // is position:absolute full-width, anchored just above the composer via the
    // same bottom calc the Live Bar slot uses, so it floats over the bottom of the
    // conversation without displacing it (non-modal). The Live Bar is hidden
    // while the sheet is open so this surface owns the composer zone.
    const host = doc.getElementById("inputArea") || doc.querySelector(".input-area");
    if (!host) return null;
    el = doc.createElement("section");
    el.id = SHEET_ID;
    // The in-session surface deliberately reuses the same Material 3
    // notification component as the cross-session attention popup. Its only
    // distinct behavior is the composer anchor below it.
    el.className = "decision-sheet oneui-notification";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-labelledby", "decisionSheetTitle");
    el.setAttribute("aria-describedby", "decisionSheetContent");
    el.tabIndex = -1;
    el.hidden = true;
    host.appendChild(el);
    root.AgentoCLayout?.observeOverlay?.(el);
    return el;
  }

  // ---- Dynamic Island (灵动岛) ---------------------------------------------
  const ISLAND_ID = "decisionIsland";

  function ensureIslandDOM() {
    if (islandEl && islandEl.isConnected) return islandEl;
    let el = doc.getElementById(ISLAND_ID);
    if (el) {
      islandEl = el;
      root.AgentoCLayout?.observeOverlay?.(el);
      return el;
    }
    const stack = doc.querySelector(".input-stack") || doc.getElementById("inputArea") || doc.body;
    if (!stack) return null;
    el = doc.createElement("div");
    el.id = ISLAND_ID;
    el.className = "decision-island";
    el.hidden = true;

    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "decision-island__button";
    btn.setAttribute("aria-label", tr("decisionSheet.island.title") || "Pending Decision");
    btn.addEventListener("click", (evt) => {
      evt.preventDefault();
      expandFromIsland();
    });

    const indicator = doc.createElement("span");
    indicator.className = "decision-island__indicator decision-island__indicator--approval";
    const pulse = doc.createElement("span");
    pulse.className = "decision-island__pulse";
    indicator.appendChild(pulse);

    const iconSpan = doc.createElement("span");
    iconSpan.className = "decision-island__icon";
    indicator.appendChild(iconSpan);

    const label = doc.createElement("span");
    label.className = "decision-island__label";
    label.textContent = tr("decisionSheet.island.defaultLabel") || "Pending Approval";

    const hint = doc.createElement("span");
    hint.className = "decision-island__action-hint";
    const hintText = doc.createElement("span");
    hintText.className = "decision-island__hint-text";
    hintText.textContent = tr("decisionSheet.island.view") || "View";
    const chevron = doc.createElement("span");
    chevron.className = "decision-island__chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "↑";
    hint.append(hintText, chevron);

    btn.append(indicator, label, hint);
    el.appendChild(btn);

    const qp = doc.getElementById("queuedPanel");
    if (qp && qp.parentNode === stack) {
      stack.insertBefore(el, qp);
    } else {
      stack.appendChild(el);
    }

    islandEl = el;
    root.AgentoCLayout?.observeOverlay?.(el);
    return el;
  }

  function renderDangerIcon() {
    return `<svg class="rl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="m10.29 3.86-8.6 14.89A2 2 0 0 0 3.42 21h17.16a2 2 0 0 0 1.73-2.25l-8.6-14.89a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
  }

  function updateIslandContent(info = {}) {
    ensureIslandDOM();
    if (!islandEl) return;
    const labelEl = islandEl.querySelector(".decision-island__label");
    const indicatorEl = islandEl.querySelector(".decision-island__indicator");
    const iconEl = islandEl.querySelector(".decision-island__icon");
    const btnEl = islandEl.querySelector(".decision-island__button");

    const kind = String(info?.kind || "").toLowerCase();
    const riskTier = String(info?.riskTier || "").toLowerCase();
    const title = info?.title || tr("decisionSheet.island.defaultLabel") || "Pending Approval";

    if (labelEl) {
      labelEl.textContent = title;
    }
    if (btnEl) {
      const hint = tr("decisionSheet.island.title") || "Pending Decision";
      btnEl.setAttribute("aria-label", `${title} - ${hint}`);
    }

    if (indicatorEl) {
      indicatorEl.classList.remove(
        "decision-island__indicator--danger",
        "decision-island__indicator--question",
        "decision-island__indicator--approval"
      );
      if (riskTier === "danger" || riskTier === "high" || kind === "batch" || kind === "action") {
        indicatorEl.classList.add("decision-island__indicator--danger");
      } else if (kind === "question") {
        indicatorEl.classList.add("decision-island__indicator--question");
      } else {
        indicatorEl.classList.add("decision-island__indicator--approval");
      }
    }

    if (iconEl) {
      if (riskTier === "danger" || riskTier === "high" || kind === "batch" || kind === "action") {
        iconEl.innerHTML = renderDangerIcon();
      } else if (kind === "question") {
        iconEl.innerHTML = renderIcon("question", "rl-icon") || "?";
      } else {
        iconEl.innerHTML = renderIcon("shield", "rl-icon") || renderIcon("check", "rl-icon") || "✓";
      }
    }
  }

  function showIsland({ animated = true } = {}) {
    const el = ensureIslandDOM();
    if (!el) return;
    if (islandEnterTimer) {
      clearTimeout(islandEnterTimer);
      islandEnterTimer = null;
    }
    if (islandExitTimer) {
      clearTimeout(islandExitTimer);
      islandExitTimer = null;
    }
    el.hidden = false;
    el.classList.remove("is-exiting");
    if (animated && !window.AgentoCMotion?.prefersReducedMotion?.()) {
      el.classList.add("is-entering");
      islandEnterTimer = setTimeout(() => {
        islandEnterTimer = null;
        el.classList.remove("is-entering");
        el.classList.add("visible");
      }, 240);
    } else {
      el.classList.add("visible");
    }
    requestSheetLayout("decision-island-visible");
  }

  function hideIsland({ immediate = false, animated = true, keepPending = false } = {}) {
    if (!keepPending) {
      window.AgentoCBackHandler?.pop?.("decision-island");
    }
    if (islandEnterTimer) {
      clearTimeout(islandEnterTimer);
      islandEnterTimer = null;
    }
    if (islandExitTimer) {
      clearTimeout(islandExitTimer);
      islandExitTimer = null;
    }
    if (!islandEl || islandEl.hidden) return;
    const isReduced = immediate || window.AgentoCMotion?.prefersReducedMotion?.();
    if (isReduced || !animated) {
      islandEl.classList.remove("visible", "is-entering", "is-exiting");
      islandEl.hidden = true;
      requestSheetLayout("decision-island-hidden");
      return;
    }
    islandEl.classList.remove("visible", "is-entering");
    islandEl.classList.add("is-exiting");
    islandExitTimer = setTimeout(() => {
      islandExitTimer = null;
      if (!islandEl) return;
      islandEl.classList.remove("is-exiting");
      islandEl.hidden = true;
      requestSheetLayout("decision-island-hidden");
    }, 180);
  }

  function collapseToIsland() {
    if (!hostEl || hostEl.hidden) return;
    const isReduced = window.AgentoCMotion?.prefersReducedMotion?.();

    if (collapseIslandTimer) {
      clearTimeout(collapseIslandTimer);
      collapseIslandTimer = null;
    }

    ensureIslandDOM();
    updateIslandContent(currentDecisionInfo);

    window.AgentoCBackHandler?.pop?.("decision-sheet");
    window.AgentoCBackHandler?.push?.({
      id: "decision-island",
      onBack: () => {
        hideIsland();
        return true;
      },
    });

    restoreReturnFocus();

    if (isReduced) {
      hostEl.hidden = true;
      hostEl.dataset.state = "collapsed";
      showIsland({ animated: false });
      requestSheetLayout("decision-island-collapsed");
      return;
    }

    hostEl.classList.remove("is-expanding-from-island");
    hostEl.classList.add("is-closing", "is-collapsing-to-island");

    collapseIslandTimer = setTimeout(() => {
      collapseIslandTimer = null;
      hostEl?.classList.remove("is-closing", "is-collapsing-to-island");
      if (hostEl) {
        hostEl.hidden = true;
        hostEl.dataset.state = "collapsed";
      }
      showIsland({ animated: true });
      requestSheetLayout("decision-island-collapsed");
    }, 220);
  }

  function expandFromIsland() {
    if (collapseIslandTimer) {
      clearTimeout(collapseIslandTimer);
      collapseIslandTimer = null;
    }
    if (hostEl && hostEl.hidden) rememberReturnFocus();
    const isReduced = window.AgentoCMotion?.prefersReducedMotion?.();
    hideIsland({ immediate: isReduced, animated: !isReduced, keepPending: true });

    if (!hostEl || hostEl.childElementCount === 0) {
      reopen();
    } else {
      hostEl.classList.remove("is-closing", "is-collapsing-to-island");
      hostEl.hidden = false;
      hostEl.dataset.state = "open";
      requestSheetLayout("decision-sheet-open");
      window.AgentoCBackHandler?.pop?.("decision-island");
      window.AgentoCBackHandler?.push?.({
        id: "decision-sheet",
        onBack: () => {
          if (typeof collapseToIsland === "function") {
            collapseToIsland();
          } else {
            hideSheet();
          }
          return true;
        },
      });
    }

    if (!isReduced && hostEl) {
      hostEl.classList.remove("is-collapsing-to-island");
      hostEl.classList.add("is-expanding-from-island");
      setTimeout(() => {
        hostEl?.classList.remove("is-expanding-from-island");
      }, 260);
    }
  }

  // ---- small DOM helpers ---------------------------------------------------
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---- scope detail rows (reuse ui.js helpers when present) ----------------
  function appendScope(body, evt) {
    const permText = typeof root.describeApprovalPermissions === "function"
      ? root.describeApprovalPermissions(evt?.permissions)
      : "";
    const heading = displayApprovalExplanation(evt?.explanation)?.operation ? compactApprovalText(evt)
      : (typeof root.getApprovalTitle === "function" ? root.getApprovalTitle(evt) : compactApprovalText(evt));
    const fields = [
      // Plan approvals (Claude Code ExitPlanMode) carry the drafted plan body
      // in `reason` as markdown; render it first as the card's core content
      // through the shared md pipeline — raw code text would dump the
      // heading/bullet markers at the user.
      ...(String(evt?.kind || "").toLowerCase() === "plan"
        ? [[tr("approval.detail.plan"), evt?.reason, "markdown"]]
        : []),
      ...(String(evt?.kind || "").toLowerCase() !== "plan" && evt?.reason && String(evt.reason).trim() !== heading ? [[tr("decisionSheet.providerDescription"), evt.reason, false]] : []),
      [tr("approval.detail.command"), evt?.command, true],
      [tr("approval.detail.cwd"), evt?.cwd, false],
      [tr("approval.detail.files"),
        Array.isArray(evt?.filePaths) ? evt.filePaths.join("\n") : "", false],
      [tr("approval.detail.grantRoot"), evt?.grantRoot, false],
      [tr("approval.detail.permissions"), permText, false],
    ];
    const scope = el("div", "decision-sheet__scope");
    for (const [label, value, mode] of fields) {
      if (!value || (typeof value === "string" && !value.trim())) continue;
      if (mode === "markdown") {
        // Plan body rows reuse the conversation markdown renderer
        // (renderMarkdownIntoNode — same marked pipeline, math + enhance).
        // The fallback keeps the raw plan readable if the renderer is absent.
        const row = el("div", "oneui-notification__detail decision-sheet__plan-detail");
        row.appendChild(el("div", "oneui-notification__detail-label", label));
        const copy = el("button", "decision-sheet__plan-copy");
        copy.type = "button";
        copy.setAttribute("aria-label", tr("plan.action.copy"));
        copy.innerHTML = renderIcon("copy", "decision-sheet__plan-copy-icon");
        copy.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof navigator?.clipboard?.writeText !== "function") return;
          navigator.clipboard.writeText(String(value)).then(() => {
            copy.innerHTML = renderIcon("check", "decision-sheet__plan-copy-icon");
            window.setTimeout(() => {
              copy.innerHTML = renderIcon("copy", "decision-sheet__plan-copy-icon");
            }, 1200);
          }).catch(() => {});
        });
        row.appendChild(copy);
        const bodyNode = doc.createElement("div");
        bodyNode.className = "decision-sheet__plan-body md-content";
        const rendered = typeof root.renderMarkdownIntoNode === "function"
          ? root.renderMarkdownIntoNode(bodyNode, String(value))
          : false;
        if (!rendered) bodyNode.textContent = String(value);
        row.appendChild(bodyNode);
        scope.appendChild(row);
        continue;
      }
      const row = el("div", "oneui-notification__detail");
      row.appendChild(el("div", "oneui-notification__detail-label", label));
      if (mode) {
        row.appendChild(el("code", "oneui-notification__code decision-sheet__code", String(value)));
      } else {
        const text = el("div", "oneui-notification__detail-value", String(value));
        text.setAttribute("dir", "auto");
        row.appendChild(text);
      }
      scope.appendChild(row);
    }
    if (scope.childElementCount > 0) body.appendChild(scope);
    // 人话解释区：审批事件的 explanation 快照（LLM 缓存命中或模板兜底）。
    // 技术细节（command/cwd/files/...）之后渲染——用户先核对"要执行什么"，
    // 再读"为什么/有没有更安全的做法"。
    const display = displayApprovalExplanation(evt?.explanation);
    appendExplanation(evt?.explanation, body, Boolean((!display?.operation && display?.riskCode) || (display?.summary && display.summary === compactApprovalText(evt))));
  }

  function compactApprovalText(evt) {
    const raw = String(
      (displayApprovalExplanation(evt?.explanation)?.operation && displayApprovalExplanation(evt.explanation)?.summary)
      || evt?.summary
      || evt?.reason
      || evt?.description
      || (evt?.explanation?.riskCode && displayApprovalExplanation(evt.explanation)?.summary)
      || tr("approval.status.pending")
    ).trim().replace(/\s+/g, " ");
    if (raw.length <= 116) return raw;
    return `${raw.slice(0, 115).trimEnd()}…`;
  }

  function appendCompactApproval(body, evt) {
    appendScope(body, evt);
  }

  // The Decision Sheet shares the attention popup's compact disclosure header:
  // one readable summary, a chevron at the right edge, and technical context
  // revealed by the same brief/detailed state rather than a second local UI.
  function setSheetExpanded(expanded) {
    if (!hostEl || hostEl.hidden) return;
    const detailed = Boolean(expanded);
    hostEl.classList.toggle("oneui-notification--detailed", detailed);
    hostEl.dataset.state = detailed ? "detailed" : "brief";
    hostEl.setAttribute("aria-expanded", String(detailed));
    const summary = hostEl.querySelector(".decision-sheet__summary");
    summary?.setAttribute("aria-expanded", String(detailed));
    requestSheetLayout(detailed ? "decision-sheet-expanded" : "decision-sheet-collapsed");
  }

  function createNotificationHeader(titleText, risk, { expanded = false } = {}) {
    const header = el("header", "oneui-notification__header");
    const summary = doc.createElement("button");
    summary.type = "button";
    summary.className = "oneui-notification__summary decision-sheet__summary";
    summary.setAttribute("aria-controls", "decisionSheetContent");
    summary.setAttribute("aria-expanded", String(Boolean(expanded)));
    const title = el("div", "oneui-notification__title", titleText);
    title.id = "decisionSheetTitle";
    summary.appendChild(title);
    const disclosure = el("span", "oneui-notification__disclosure");
    disclosure.setAttribute("aria-hidden", "true");
    disclosure.innerHTML = renderIcon("chevron-right", "oneui-notification__disclosure-icon");
    summary.appendChild(disclosure);
    summary.addEventListener("click", () => {
      setSheetExpanded(!hostEl?.classList.contains("oneui-notification--detailed"));
    });
    header.appendChild(summary);
    if (risk?.tier && risk.tier !== "none") {
      const meta = el("div", "decision-sheet__meta");
      const badge = el("span", "decision-sheet__risk");
      badge.dataset.tier = risk.tier;
      badge.textContent = risk.label;
      meta.appendChild(badge);
      header.appendChild(meta);
    }
    return header;
  }

  // ---- question-kind options (sheet-scoped selection) ----------------------
  // createApprovalPromptSection uses runtime-approval-card__* classes; we render
  // it inside the sheet and manage selection locally (the shared
  // selectApprovalOption can't enable our sheet submit button).
  function enableSubmitOnSelect() {
    if (!hostEl) return;
    const submit = hostEl.querySelector('.oneui-notification__action[data-approval-decision="approve"]');
    if (submit) submit.disabled = false;
  }

  // ---- code-row copy affordance -------------------------------------------
  // Commands, paths and permission scopes are exactly the strings a user wants
  // to verify or reuse elsewhere. Each code row gets a small copy button that
  // flips to a check for ~1.2s after copying.
  function bindSheetCodeCopies() {
    if (!hostEl || typeof navigator?.clipboard?.writeText !== "function") return;
    hostEl.querySelectorAll(".decision-sheet__scope .decision-sheet__code").forEach((code) => {
      if (code.dataset.sheetCopy === "true") return;
      code.dataset.sheetCopy = "true";
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "decision-sheet__code-copy";
      btn.setAttribute("aria-label", tr("approval.copy"));
      btn.innerHTML = renderIcon("copy", "decision-sheet__code-copy-icon");
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const value = String(code.textContent || "").trim();
        navigator.clipboard.writeText(value).then(() => {
          btn.innerHTML = renderIcon("check", "decision-sheet__code-copy-icon");
          window.setTimeout(() => {
            btn.innerHTML = renderIcon("copy", "decision-sheet__code-copy-icon");
          }, 1200);
        }).catch(() => { /* clipboard blocked — keep the copy affordance visible */ });
      });
      code.appendChild(btn);
    });
  }

  function bindSheetOptions() {
    if (!hostEl) return;
    hostEl.querySelectorAll(".runtime-approval-card__prompt-header").forEach((node) => {
      node.classList.add("oneui-notification__choice-question");
    });
    hostEl.querySelectorAll(".runtime-approval-card__question").forEach((node) => {
      node.classList.add("oneui-notification__message");
    });
    hostEl.querySelectorAll(".runtime-approval-card__option").forEach((option) => {
      if (option.dataset.sheetBound === "true") return;
      option.dataset.sheetBound = "true";
      option.classList.add("oneui-notification__choice");
      const choose = () => {
        const list = option.closest(".runtime-approval-card__option-list");
        if (list) list.querySelectorAll(".runtime-approval-card__option").forEach((n) => {
          n.classList.toggle("is-selected", n === option);
        });
        enableSubmitOnSelect();
      };
      option.addEventListener("click", (event) => { event.preventDefault(); choose(); });
      option.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          choose();
        }
      });
    });
  }

  function collectSheetChoices() {
    if (!hostEl) return [];
    const choices = [];
    hostEl.querySelectorAll(".runtime-approval-card__prompt").forEach((section) => {
      const selected = section.querySelector(".runtime-approval-card__option.is-selected");
      const raw = selected ? selected.dataset.optionIndex : "-1";
      const idx = Number.parseInt(String(raw ?? "-1"), 10);
      choices.push(Number.isInteger(idx) ? idx : -1);
    });
    return choices;
  }

  function getSheetCustomAnswer() {
    const input = hostEl?.querySelector?.(".decision-sheet__custom-answer");
    return typeof input?.value === "string" ? input.value.trim() : "";
  }

  function appendQuestionCustomAnswer(parent) {
    const wrap = el("div", "decision-sheet__custom-answer-wrap");
    const label = el("div", "decision-sheet__custom-answer-label", tr("approval.customAnswer.label"));
    wrap.appendChild(label);
    const input = doc.createElement("textarea");
    input.className = "oneui-notification__custom-answer decision-sheet__custom-answer";
    input.rows = 1;
    input.maxLength = 8000;
    input.autocomplete = "off";
    input.placeholder = tr("approval.customAnswer.placeholder");
    input.setAttribute("aria-label", tr("approval.customAnswer.label"));
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(180, Math.max(48, input.scrollHeight))}px`;
      const submit = hostEl?.querySelector?.('.oneui-notification__action[data-approval-decision="approve"]');
      if (submit && input.value.trim()) submit.disabled = false;
    });
    wrap.appendChild(input);
    parent.appendChild(wrap);
  }

  function revealPlanEditor() {
    const editor = hostEl?.querySelector?.(".decision-sheet__plan-editor");
    if (!editor) return false;
    editor.hidden = false;
    hostEl.classList.add("is-editing");
    const input = editor.querySelector("textarea");
    input?.focus?.({ preventScroll: true });
    return true;
  }

  function appendPlanEditor(parent, evt) {
    const editor = el("div", "decision-sheet__plan-editor");
    editor.hidden = true;
    const row = el("div", "decision-sheet__plan-editor-row");
    const input = doc.createElement("textarea");
    input.rows = 1;
    input.maxLength = 8000;
    input.autocomplete = "off";
    input.className = "decision-sheet__plan-editor-input";
    input.placeholder = tr("plan.action.modifyPlaceholder");
    input.setAttribute("aria-label", tr("plan.action.modifyPlaceholder"));
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(220, Math.max(52, input.scrollHeight))}px`;
      full.hidden = input.scrollHeight < 150;
      hostEl?.classList.add("is-editing");
    });
    row.appendChild(input);
    const full = el("button", "decision-sheet__plan-editor-full", tr("plan.action.fullscreen"));
    full.type = "button";
    full.hidden = true;
    full.addEventListener("click", () => {
      if (typeof root.insertPlanPromptIntoComposer === "function") {
        root.insertPlanPromptIntoComposer(input.value, { interactionMode: "plan", planAction: "revise" });
      }
      root.AgentoCComposerFullscreen?.open?.();
    });
    row.appendChild(full);
    editor.appendChild(row);
    const send = el("button", "decision-sheet__plan-editor-send", tr("plan.action.sendRevision"));
    send.type = "button";
    send.disabled = true;
    input.addEventListener("input", () => { send.disabled = !input.value.trim(); });
    send.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) return;
      const buttons = Array.from(hostEl.querySelectorAll(".oneui-notification__action, .decision-sheet__plan-editor-send"));
      buttons.forEach((button) => { button.disabled = true; });
      const planRef = evt?.planEventRef && typeof evt.planEventRef === "object" ? evt.planEventRef : null;
      const planId = typeof planRef?.planId === "string" ? planRef.planId.trim() : "";
      let ok = false;
      if (planId && typeof root.submitPlanArtifactAction === "function") {
        ok = await root.submitPlanArtifactAction("revise", planId, { text, button: send });
        if (ok && evt?.approvalId) root.AgentoCDecisions?.noteResponse({ approvalId: evt.approvalId });
      } else if (typeof root.submitRuntimeApprovalDecision === "function") {
        // ExitPlanMode has no plan artifact id. Deny the current gate, then
        // send the user's revision through the normal plan-mode composer.
        const denied = await root.submitRuntimeApprovalDecision(evt, "deny", null, undefined, text);
        if (denied && typeof root.insertPlanPromptIntoComposer === "function") {
          root.insertPlanPromptIntoComposer(text, { send: true, interactionMode: "plan", planAction: "revise" });
          ok = true;
        }
      }
      if (!ok) buttons.forEach((button) => { button.disabled = false; });
    });
    editor.appendChild(send);
    parent.appendChild(editor);
  }

  // ---- actions -------------------------------------------------------------
  function actionLabel(decision, evt) {
    if (String(evt?.kind || "").toLowerCase() === "plan") {
      if (decision === "approve") return tr("plan.action.execute");
      if (decision === "modify") return tr("plan.action.revise");
      if (decision === "deny") return tr("approval.action.deny");
    }
    const isConfirm = typeof root.isSessionConfirmationApproval === "function"
      && root.isSessionConfirmationApproval(evt);
    if (isConfirm) {
      if (decision === "approve") return String(evt?.confirmLabel || "").trim() || tr("approval.action.approve");
      if (decision === "deny") return String(evt?.denyLabel || "").trim() || tr("approval.action.deny");
    }
    if (decision === "approve") return tr("approval.action.approve");
    if (decision === "deny") return tr("approval.action.deny");
    if (decision === "approve_for_session") return tr("approval.action.approveForSession");
    return decision;
  }

  function makeAction(decision, evt, { primary = false, neutral = false } = {}) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "oneui-notification__action";
    if (primary) btn.classList.add("oneui-notification__action--primary");
    if (neutral) btn.classList.add("oneui-notification__action--quiet");
    btn.dataset.approvalDecision = decision;
    btn.appendChild(el("span", "oneui-notification__action-label", actionLabel(decision, evt)));
    btn.addEventListener("click", () => {
      void submitDecision(evt, decision, btn);
    });
    return btn;
  }

  async function submitDecision(evt, decision, button) {
    if (!hostEl) return;
    if (decision === "modify") {
      revealPlanEditor();
      return;
    }
    const buttons = Array.from(hostEl.querySelectorAll(".oneui-notification__action"));
    const isQuestion = String(evt?.kind || "") === "question";
    const choices = (isQuestion && decision === "approve") ? collectSheetChoices() : undefined;
    const customAnswer = isQuestion && decision === "approve" ? getSheetCustomAnswer() : "";
    buttons.forEach((b) => { b.disabled = true; });
    if (button) button.setAttribute("aria-busy", "true");
    let ok = false;
    try {
      // Codex proposal plans arrive as synthesized approval events carrying
      // planEventRef; approving executes the plan artifact, denying dismisses
      // the sheet (the proposal has no hard deny — the plan card stays in the
      // conversation and remains executable from there). Real provider
      // approvals (Claude ExitPlanMode etc.) delegate to the canonical handler
      // used by the in-stream card. The sheet button is not inside a
      // .runtime-approval-card, so the card-DOM side effects no-op; we manage
      // sheet-local button state ourselves and rely on the approval_response
      // event (noteResponse) to dismiss the sheet on ok.
      const planRef = evt?.planEventRef && typeof evt.planEventRef === "object"
        ? evt.planEventRef
        : null;
      const planId = planRef && typeof planRef.planId === "string" ? planRef.planId.trim() : "";
      const approvalId = String(evt?.approvalId || "").trim();
      if (planId) {
        if (decision === "approve") {
          ok = typeof root.submitPlanArtifactAction === "function"
            ? await root.submitPlanArtifactAction("execute", planId, { button })
            : false;
          if (ok && approvalId) root.AgentoCDecisions?.noteResponse({ approvalId });
        } else {
          // Deny on a proposal: dismiss the sheet; the plan stays pending and
          // can still be executed/revised from its in-stream card.
          ok = true;
          if (approvalId) root.AgentoCDecisions?.noteResponse({ approvalId });
        }
      } else {
        ok = typeof root.submitRuntimeApprovalDecision === "function"
          ? await root.submitRuntimeApprovalDecision(evt, decision, button, choices, customAnswer)
          : false;
      }
    } catch (error) {
      console.warn("[decision-sheet] submit failed:", error?.message || error);
    }
    if (!ok) {
      buttons.forEach((b) => { b.disabled = false; });
      if (button) button.removeAttribute("aria-busy");
    } else if (decision === "approve") {
      window.AgentoCHaptics?.approval?.();
    }
    // On ok: leave disabled; the pending approval resolves -> noteResponse -> hide.
  }

  // ---- render --------------------------------------------------------------
  function approvedActionEndpoint(evt, suffix = "") {
    const enc = (value) => encodeURIComponent(String(value || "").trim());
    return `/api/runs/${enc(evt?.runId)}/approved-actions/${enc(evt?.batchId)}${suffix}`;
  }

  function checkedApprovedActionIds(container = hostEl) {
    if (!container) return [];
    return Array.from(container.querySelectorAll("input[data-approved-action-id]:checked"))
      .map((node) => String(node.value || "").trim()).filter(Boolean);
  }

  async function obtainApprovedActionProof(evt, selectedActionIds) {
    const response = await (window.agentocFetch || fetch)(approvedActionEndpoint(evt, "/webauthn-challenge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedActionIds }),
    });
    if (!response.ok) {
      let message = `${response.status}`;
      let payload = {};
      try {
        payload = await response.json();
        message = payload?.error || message;
      } catch {}
      const error = new Error(message);
      error.status = response.status;
      error.code = String(payload?.code || "").trim();
      throw error;
    }
    const options = await response.json();
    if (typeof navigator?.credentials?.get !== "function") throw new Error("WebAuthn is unavailable");
    const credential = await navigator.credentials.get({
      publicKey: hydrateWebAuthnPublicKey(options?.publicKey || {}),
    });
    const result = credential?.response;
    if (!credential || !result) throw new Error("WebAuthn assertion was not returned");
    return {
      id: String(credential.id || "").trim(),
      rawId: credential.rawId ? toBase64Url(credential.rawId) : String(credential.id || "").trim(),
      response: {
        clientDataJSON: toBase64Url(result.clientDataJSON),
        authenticatorData: toBase64Url(result.authenticatorData),
        signature: toBase64Url(result.signature),
        ...(result.userHandle && result.userHandle.byteLength > 0 ? { userHandle: toBase64Url(result.userHandle) } : {}),
      },
    };
  }

  async function submitApprovedActionDecision(evt, button, approvalIntent = "approve", selectedActionIds = null) {
    const actionIds = Array.isArray(selectedActionIds) ? selectedActionIds : checkedApprovedActionIds();
    const actions = Array.isArray(evt?.actions) ? evt.actions : [];
    const decisions = Object.fromEntries(actions.map((action) => [
      String(action?.actionId || "").trim(), actionIds.includes(String(action?.actionId || "").trim()) ? "approve" : "deny",
    ]).filter(([id]) => id));
    // The passkey checkpoint follows the server-projected needsPasskey flag,
    // not the execution class: with the owner-click policy a host action is
    // approved by the explicit owner click alone and the warning UI stays.
    const selectedHost = actions
      .filter((action) => decisions[action.actionId] === "approve" && action.needsPasskey === true)
      .map((action) => action.actionId);
    if (button) button.setAttribute("aria-busy", "true");
    try {
      const webauthnProof = selectedHost.length > 0
        ? await obtainApprovedActionProof(evt, selectedHost)
        : null;
      const response = await (window.agentocFetch || fetch)(approvedActionEndpoint(evt, "/resolve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions,
          approvalIntent,
          ...(webauthnProof ? { webauthnProof } : {}),
        }),
      });
      if (!response.ok) {
        let message = `${response.status}`;
        let payload = {};
        try {
          payload = await response.json();
          message = payload?.error || message;
        } catch {}
        const error = new Error(message);
        error.status = response.status;
        error.code = String(payload?.code || "").trim();
        throw error;
      }
      const payload = typeof response.json === "function" ? await response.json().catch(() => ({})) : {};
      root.AgentoCDecisions?.noteApprovedActionResolution?.({
        type: "approved_action_batch_response",
        batchId: evt?.batchId,
        runId: evt?.runId,
        decisions,
        ...(Array.isArray(payload?.actions) ? { actions: payload.actions } : {}),
      }, {
        sessionId: String(evt?.sessionId || currentSessionId || "").trim(),
        runId: String(evt?.runId || "").trim(),
      });
      return true;
    } catch (error) {
      if (isApprovalAlreadyEndedError(error)) {
        dismissApprovedActionFromUi(evt);
        return true;
      }
      throw error;
    } finally {
      if (button) button.removeAttribute("aria-busy");
    }
  }

  function makeApprovedActionButton(label, { primary = false, neutral = false } = {}) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "oneui-notification__action";
    if (primary) btn.classList.add("oneui-notification__action--primary");
    if (neutral) btn.classList.add("oneui-notification__action--quiet");
    btn.appendChild(el("span", "oneui-notification__action-label", label));
    return btn;
  }

  function appendAgentDefinitionReview(action, container) {
    const definition = action?.agentDefinition;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) return;
    const disclosure = el("details", "decision-sheet__agent-definition");
    disclosure.appendChild(el("summary", "decision-sheet__agent-definition-summary", tr("decisionSheet.approvedAction.agentDefinition")));
    const body = el("div", "decision-sheet__agent-definition-body");
    const fields = [
      ["name", definition.name],
      ["tool", definition.tool],
      ["skills", Array.isArray(definition.skills) ? definition.skills.join("\n") : ""],
      ["welcomeMessage", definition.welcomeMessage],
      ["systemPrompt", definition.systemPrompt],
      ["perMessageSystemPrompt", definition.perMessageSystemPrompt
        ? JSON.stringify(definition.perMessageSystemPrompt, null, 2)
        : ""],
    ];
    for (const [label, value] of fields) {
      const row = el("div", "decision-sheet__agent-definition-row");
      row.appendChild(el("div", "decision-sheet__agent-definition-label", label));
      const text = el("pre", "decision-sheet__agent-definition-value", String(value || tr("decisionSheet.approvedAction.empty")));
      text.setAttribute("dir", "auto");
      row.appendChild(text);
      body.appendChild(row);
    }
    disclosure.appendChild(body);
    container.appendChild(disclosure);
  }

  function renderApprovedActionSheet(evt) {
    if (!hostEl) hostEl = injectDOM();
    if (!hostEl) return;
    if (renderedKind === "batch") return;
    const batchId = String(evt?.batchId || "");
    if (!batchId) return;
    const actionSignature = JSON.stringify((Array.isArray(evt?.actions) ? evt.actions : []).map((action) => [
      String(action?.actionId || ""), String(action?.state || ""), String(action?.resultRef?.error || ""),
    ]));
    if (!hostEl.hidden && renderedKind === "action" && renderedActionBatchId === batchId
      && renderedActionSignature === actionSignature && !hostEl.classList.contains("is-closing")) return;
    const keepExpanded = Boolean(!hostEl.hidden && hostEl.classList.contains("oneui-notification--detailed"));
    if (hostEl.hidden) rememberReturnFocus();
    if (hideSheetTimer) { clearTimeout(hideSheetTimer); hideSheetTimer = null; }
    if (collapseIslandTimer) { clearTimeout(collapseIslandTimer); collapseIslandTimer = null; }
    hostEl.classList.remove("is-closing", "oneui-notification--detailed", "oneui-notification--danger");
    hostEl.classList.add("oneui-notification--danger");
    hostEl.replaceChildren();
    renderedKind = "action";
    renderedActionBatchId = batchId;
    renderedActionSignature = actionSignature;
    renderedApprovalId = "";
    renderedBatchId = "";
    renderedBatchSignature = "";
    currentDecisionInfo = {
      kind: "action",
      title: tr("decisionSheet.approvedAction.title"),
      riskTier: "high",
      evt,
    };
    const header = createNotificationHeader(tr("decisionSheet.approvedAction.title"), {
      tier: "high",
      label: tr("decisionSheet.approvedAction.owner"),
    });
    const content = el("div", "oneui-notification__content");
    content.id = "decisionSheetContent";
    const details = el("div", "oneui-notification__details decision-sheet__details");
    // Warning copy follows the server-projected passkey checkpoint: the danger
    // framing stays, but the passkey sentence only appears when the server
    // still demands one.
    const actionList = Array.isArray(evt?.actions) ? evt.actions : [];
    const passkeyNeeded = actionList.some((action) => action?.needsPasskey === true);
    details.appendChild(el("p", "oneui-notification__message", tr(passkeyNeeded
      ? "decisionSheet.approvedAction.message"
      : "decisionSheet.approvedAction.messageClickOnly")));
    const list = el("div", "decision-sheet__batch");
    for (const action of Array.isArray(evt?.actions) ? evt.actions : []) {
      const row = el("label", "decision-sheet__batch-op");
      const check = doc.createElement("input");
      check.type = "checkbox";
      check.checked = !["denied", "cancelled", "expired"].includes(String(action?.state || ""));
      check.value = String(action?.actionId || "");
      check.dataset.approvedActionId = String(action?.actionId || "");
      check.disabled = ["denied", "cancelled", "expired", "completed", "failed"].includes(String(action?.state || ""));
      const text = el("span", "decision-sheet__batch-op-text");
      text.appendChild(el("strong", "decision-sheet__batch-op-description", String(action?.description || action?.reason || action?.actionId || "Action")));
      const code = el("code", "oneui-notification__code decision-sheet__code", String(action?.command || action?.summary || ""));
      text.appendChild(code);
      row.append(check, text);
      list.appendChild(row);
      appendAgentDefinitionReview(action, list);
    }
    details.appendChild(list);
    content.appendChild(details);
    const actions = el("div", "oneui-notification__actions");
    const approve = makeApprovedActionButton(tr("decisionSheet.approvedAction.approve"), { primary: true });
    const syncApproveState = () => {
      approve.disabled = !Array.from(hostEl.querySelectorAll("input[data-approved-action-id]:checked"))
        .some((input) => !input.disabled && String(input.value || "").trim());
    };
    list.querySelectorAll("input[data-approved-action-id]").forEach((input) => {
      input.addEventListener("change", syncApproveState);
    });
    syncApproveState();
    approve.addEventListener("click", () => {
      approve.disabled = true;
      void submitApprovedActionDecision(evt, approve, "approve").catch((error) => {
        approve.disabled = false;
        root.showSystemToast?.(error?.message || "Approval failed", "error");
      });
    });
    actions.appendChild(approve);
    const deny = makeApprovedActionButton(tr("decisionSheet.approvedAction.deny"), { neutral: true });
    deny.addEventListener("click", () => {
      hostEl.querySelectorAll("input[data-approved-action-id]").forEach((input) => { input.checked = false; });
      deny.disabled = true;
      void submitApprovedActionDecision(evt, deny, "deny").catch((error) => {
        deny.disabled = false;
        root.showSystemToast?.(error?.message || "Approval failed", "error");
      });
    });
    actions.appendChild(deny);
    const footer = el("footer", "oneui-notification__footer");
    footer.appendChild(actions);
    hostEl.append(header, content, footer);
    hostEl.hidden = false;
    setSheetExpanded(keepExpanded);
    requestSheetLayout("decision-sheet-approved-action-open");
    window.AgentoCBackHandler?.push?.({
      id: "decision-sheet",
      onBack: () => {
        if (typeof collapseToIsland === "function") {
          collapseToIsland();
        } else {
          hideSheet();
        }
        return true;
      },
    });
  }

  function renderSheet(evt) {
    if (!hostEl) hostEl = injectDOM();
    if (!hostEl) return;
    // The privileged batch surface wins over regular approvals (defense: the
    // decisions subscriber is gated too, but a late event could still race).
    if (renderedKind === "batch" || renderedKind === "action") return;
    const evtId = String(evt?.approvalId || "");
    // Idempotent for the already-visible approval, unless it is mid-collapse:
    // a reopen during the close animation must win and re-expand.
    if (!hostEl.hidden && renderedApprovalId === evtId && !hostEl.classList.contains("is-closing")) return;
    if (hostEl.hidden) rememberReturnFocus();
    const shouldCrossfade = !hostEl.hidden
      && Boolean(renderedApprovalId)
      && renderedApprovalId !== evtId
      && !hostEl.classList.contains("is-closing");
    // A collapse animation may still be in flight; showing a new (or the
    // same) approval must cancel it and re-enter cleanly.
    if (hideSheetTimer) {
      clearTimeout(hideSheetTimer);
      hideSheetTimer = null;
    }
    if (collapseIslandTimer) {
      clearTimeout(collapseIslandTimer);
      collapseIslandTimer = null;
    }
    hostEl.classList.remove("is-closing", "oneui-notification--detailed", "oneui-notification--danger");
    if (refreshFrame !== null) {
      if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(refreshFrame);
      refreshFrame = null;
    }
    if (shouldCrossfade) hostEl.classList.add("is-refreshing");
    hostEl.replaceChildren();
    renderedApprovalId = evtId;
    renderedKind = "approval";
    renderedBatchSignature = "";

    const titleText = displayApprovalExplanation(evt?.explanation)?.operation
      ? compactApprovalText(evt)
      : (typeof root.getApprovalTitle === "function" ? root.getApprovalTitle(evt) : compactApprovalText(evt));
    const risk = resolveApprovalRisk(evt);
    currentDecisionInfo = {
      kind: String(evt?.kind || "approval").toLowerCase(),
      title: titleText || compactApprovalText(evt),
      riskTier: risk?.tier || "approval",
      evt,
    };
    const header = createNotificationHeader(titleText || compactApprovalText(evt), risk);
    if (!displayApprovalExplanation(evt?.explanation)?.operation && evt?.reason && !["question", "plan"].includes(String(evt?.kind || "").toLowerCase())) {
      header.appendChild(el("div", "oneui-notification__detail-label", tr("decisionSheet.providerDescription")));
    }
    const content = el("div", "oneui-notification__content");
    content.id = "decisionSheetContent";
    const details = el("div", "oneui-notification__details decision-sheet__details");

    const isQuestion = String(evt?.kind || "") === "question";
    if (isQuestion && typeof root.getApprovalPromptSections === "function"
        && typeof root.createApprovalPromptSection === "function") {
      const sections = root.getApprovalPromptSections(evt);
      if (sections.length > 0) {
        const wrap = el("div", "oneui-notification__choices");
        sections.forEach((section, idx) => wrap.appendChild(root.createApprovalPromptSection(section, idx)));
        details.appendChild(wrap);
      }
      appendQuestionCustomAnswer(details);
    } else if (String(evt?.kind || "").toLowerCase() === "plan") {
      appendScope(details, evt);
      appendPlanEditor(details, evt);
    } else {
      appendCompactApproval(details, evt);
    }
    content.appendChild(details);

    const actions = el("div", "oneui-notification__actions");
    if (isQuestion) {
      const submit = makeAction("approve", evt, { primary: true });
      submit.querySelector(".oneui-notification__action-label").textContent = tr("approval.action.submitAnswer");
      submit.disabled = true; // enabled once an option is selected
      actions.appendChild(submit);
      // Cancel ≠ deny: a question dismissal is neutral, not a rejection of a
      // risky action — keep the red tint for command/permission denials only.
      actions.appendChild(makeAction("deny", evt, { neutral: true }));
    } else if (String(evt?.kind || "").toLowerCase() === "plan") {
      // ExitPlanMode is a plan decision, not a generic permission prompt.
      // Keep the provider's approve/deny semantics under the labels Execute/Deny
      // and give Modify a local editor so the user can revise without another
      // sheet or a second visual language.
      actions.appendChild(makeAction("approve", evt, { primary: true }));
      actions.appendChild(makeAction("modify", evt));
      actions.appendChild(makeAction("deny", evt));
    } else {
      actions.appendChild(makeAction("approve", evt, { primary: true }));
      const isConfirm = typeof root.isSessionConfirmationApproval === "function"
        && root.isSessionConfirmationApproval(evt);
      actions.appendChild(makeAction("deny", evt));
      // The scope-wide approval remains available but is no longer a second
      // competing primary decision. It lives with the expanded technical
      // context, where its longer-lived effect can be understood first.
      if (!isConfirm) {
        const sessionActions = el("div", "oneui-notification__actions decision-sheet__session-actions");
        sessionActions.appendChild(makeAction("approve_for_session", evt));
        details.appendChild(sessionActions);
      }
    }
    const footer = el("footer", "oneui-notification__footer");
    footer.appendChild(actions);
    hostEl.append(header, content, footer);

    bindSheetOptions();
    bindSheetCodeCopies();
    hostEl.hidden = false;
    setSheetExpanded(false);
    requestSheetLayout("decision-sheet-open");
    if (shouldCrossfade) {
      const releaseRefresh = () => {
        refreshFrame = null;
        hostEl?.classList.remove("is-refreshing");
      };
      refreshFrame = typeof root.requestAnimationFrame === "function"
        ? root.requestAnimationFrame(releaseRefresh)
        : setTimeout(releaseRefresh, 0);
    }
    // Android back button: collapse the approval surface without making a
    // decision — the pending approval stays pending in the store and will
    // surface again on the next state change.
    window.AgentoCBackHandler?.push?.({
      id: "decision-sheet",
      onBack: () => {
        if (typeof collapseToIsland === "function") {
          collapseToIsland();
        } else {
          hideSheet();
        }
        return true;
      },
    });
  }

  function finishHideSheet() {
    if (!hostEl) return;
    if (refreshFrame !== null) {
      if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(refreshFrame);
      refreshFrame = null;
    }
    hostEl.classList.remove("is-closing");
    hostEl.classList.remove("is-refreshing");
    hostEl.hidden = true;
    hostEl.dataset.state = "closed";
    hostEl.replaceChildren();
    renderedApprovalId = "";
    renderedBatchId = "";
    renderedBatchSignature = "";
    renderedActionBatchId = "";
    renderedActionSignature = "";
    renderedKind = "";
    currentDecisionInfo = { kind: "", title: "", riskTier: "", evt: null };
    if (collapseIslandTimer) {
      clearTimeout(collapseIslandTimer);
      collapseIslandTimer = null;
    }
    hideIsland({ immediate: true });
    restoreReturnFocus();
    requestSheetLayout("decision-sheet-closed");
  }

  function hideSheet({ immediate = false } = {}) {
    if (collapseIslandTimer) {
      clearTimeout(collapseIslandTimer);
      collapseIslandTimer = null;
    }
    hideIsland({ immediate });
    if (!hostEl || hostEl.hidden) {
      finishHideSheet();
      return;
    }
    // Multiple store channels can observe the same terminal event (approval,
    // batch, and action snapshots). Once the exit animation is scheduled,
    // leave its timer and geometry alone; repeated hide calls must not keep
    // restarting the closing transition.
    if (hostEl.classList.contains("is-closing")) {
      // A session transition is a hard visual boundary. If a normal approval
      // response already scheduled the 180ms exit, an immediate hide must
      // cancel that timer and finish now; otherwise the next session can race
      // the old closing DOM and flash during attach.
      if (immediate) {
        if (hideSheetTimer) {
          clearTimeout(hideSheetTimer);
          hideSheetTimer = null;
        }
        finishHideSheet();
      }
      return;
    }
    window.AgentoCBackHandler?.pop?.("decision-sheet");
    // Collapse animation for every path — resolved approvals and
    // back-button collapses alike (reduced-motion users skip straight to
    // the finish).
    if (immediate || window.AgentoCMotion?.prefersReducedMotion?.()) {
      finishHideSheet();
      return;
    }
    if (hideSheetTimer) clearTimeout(hideSheetTimer);
    hostEl.classList.add("is-closing");
    requestSheetLayout("decision-sheet-closing");
    hideSheetTimer = setTimeout(() => {
      hideSheetTimer = null;
      finishHideSheet();
    }, SHEET_HIDE_ANIMATION_MS);
  }

  function isSessionTransitioning() {
    // During attach the store already points at the target session, while the
    // old transcript/surface is still mounted. Never animate an approval across
    // that boundary; it is a stale visual state, not a user decision.
    if (typeof hasAttachedSession !== "undefined" && hasAttachedSession === false) return true;
    const pendingTarget = typeof pendingNavigationState === "object"
      ? String(pendingNavigationState?.sessionId || "").trim()
      : "";
    const attachedId = String(typeof currentSessionId === "string" ? currentSessionId : "").trim();
    return Boolean(pendingTarget && pendingTarget !== attachedId);
  }

  function onDecisions(snap) {
    if (isSessionTransitioning()) {
      hideSheet({ immediate: true });
      return;
    }
    // While a privileged batch surface is showing, regular approval events are
    // ignored entirely (they cannot coexist in a gated session, and letting a
    // resolve event hide the batch sheet would strand the pending batch).
    if (renderedKind === "batch" || renderedKind === "action") return;
    if (snap?.pending && snap.evt) {
      const id = String(snap.evt.approvalId || "");
      if (id !== renderedApprovalId || !hostEl || hostEl.hidden) {
        renderSheet(snap.evt);
      }
    } else {
      hideSheet();
    }
  }

  function onBatch(snap) {
    if (isSessionTransitioning()) {
      hideSheet({ immediate: true });
      return;
    }
    if (renderedKind === "action") return;
    if (!snap?.pending || !snap.evt) {
      if (renderedKind === "batch") hideSheet();
      return;
    }
    const batchId = String(snap.evt.batchId || "");
    const resolved = snap.resolved || new Set();
    if (!hostEl || hostEl.hidden || renderedKind !== "batch" || renderedBatchId !== batchId) {
      renderBatchSheet(snap.evt, resolved);
      return;
    }
    // Same batch still on screen: refresh in place so a just-resolved category
    // group collapses and remaining groups keep their buttons.
    renderBatchSheet(snap.evt, resolved, { refresh: true });
  }

  function onAction(snap) {
    if (isSessionTransitioning()) {
      hideSheet({ immediate: true });
      return;
    }
    if (!snap?.pending || !snap.evt) {
      if (renderedKind === "action") hideSheet();
      return;
    }
    const batchId = String(snap.evt.batchId || "");
    // A per-action state update changes the checkbox/disabled projection even
    // when the batch id is unchanged; let the signature guard decide whether
    // a real DOM refresh is needed.
    renderApprovedActionSheet(snap.evt);
  }

  // Re-opens the approval surface for the still-pending approval — the
  // path back in after the Android back button collapsed the sheet without
  // making a decision. The Live Bar taps this while an approval is pending.
  function reopen() {
    if (isSessionTransitioning()) return;
    if (hostEl) {
      hostEl.classList.remove("is-closing", "is-collapsing-to-island");
    }
    hideIsland({ immediate: true, keepPending: true });
    const pendingAction = root.AgentoCDecisions?.getPendingAction?.();
    if (pendingAction) {
      renderApprovedActionSheet(pendingAction);
      return;
    }
    const batchState = root.AgentoCDecisions?.getBatchState?.();
    if (batchState?.evt) {
      renderBatchSheet(batchState.evt, batchState.resolved || new Set());
      return;
    }
    const pending = root.AgentoCDecisions?.getPending?.();
    if (pending) renderSheet(pending);
  }

  // Session attach intentionally suppresses all decision notifications while
  // the old transcript is being torn down. Reconcile the store once the new
  // session has committed so an approval that was already pending is restored
  // exactly once, without replaying the close/open animation race.
  function resume() {
    if (isSessionTransitioning()) return;
    const pendingAction = root.AgentoCDecisions?.getPendingAction?.();
    if (pendingAction) {
      onAction({ pending: true, evt: pendingAction });
      return;
    }
    const batchState = root.AgentoCDecisions?.getBatchState?.();
    if (batchState?.evt) {
      onBatch({ pending: true, evt: batchState.evt, resolved: batchState.resolved || new Set() });
      return;
    }
    const pending = root.AgentoCDecisions?.getPending?.();
    onDecisions(pending ? { pending: true, evt: pending } : { pending: false, evt: null });
  }

  function suspend() {
    hideSheet({ immediate: true });
  }

  function init() {
    ensureStylesheet();
    bindKeyboardDismissal();
    hostEl = injectDOM();
    root.AgentoCDecisionSheet = Object.freeze({
      reopen,
      resume,
      suspend,
      collapseToIsland,
      expandFromIsland,
      hideIsland,
      submitPrivilegedBatchCategory,
      submitApprovedActionDecision,
    });
    if (root.AgentoCDecisions && typeof root.AgentoCDecisions.subscribe === "function") {
      unsub = root.AgentoCDecisions.subscribe(onDecisions);
    }
    if (root.AgentoCDecisions && typeof root.AgentoCDecisions.subscribeBatch === "function") {
      unsubBatch = root.AgentoCDecisions.subscribeBatch(onBatch);
    }
    if (root.AgentoCDecisions && typeof root.AgentoCDecisions.subscribeAction === "function") {
      unsubAction = root.AgentoCDecisions.subscribeAction(onAction);
    }
  }

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

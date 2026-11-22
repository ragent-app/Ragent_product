(function initRagentAsyncQuestions(root) {
  "use strict";

  const QUESTION_REPLY_TAG_RE = /<send_user_message_question_reply\b[^>]*>([\s\S]*?)<\/send_user_message_question_reply>/gi;
  const QUESTION_REPLY_OPEN_MARKER = "<send_user_message_question_reply>";
  const MAX_QUESTION_ITEM_ID_BYTES = 512;

  function tr(key, vars) {
    if (typeof root?.t === "function") {
      const value = root.t(key, vars);
      if (typeof value === "string" && value !== key) return value;
    }
    const fallbackMap = {
      "asyncQuestion.badge": "Question",
      "asyncQuestion.followUpBadge": "Follow-up",
      "asyncQuestion.pendingOne": "1 pending question",
      "asyncQuestion.pendingMany": "{count} pending questions",
      "asyncQuestion.questionProgress": "Question {index}",
      "asyncQuestion.customPlaceholder": "Write your reply…",
      "asyncQuestion.notePlaceholder": "Optional note with reply…",
      "asyncQuestion.sendReply": "Send reply",
      "asyncQuestion.sending": "Sending…",
      "asyncQuestion.answered": "Answered",
      "asyncQuestion.repliedWith": "Answered: {answer}",
      "asyncQuestion.replyChipTitle": "Answered question",
      "asyncQuestion.queuedSummary": "Reply to {question}: {answer}",
      "asyncQuestion.quickReply": "Reply below",
      "asyncQuestion.sendFailed": "Failed to send reply: {message}",
      "asyncQuestion.emptyError": "Choose an option or enter a reply first.",
    };
    let text = fallbackMap[key] || key;
    if (vars && typeof vars === "object") {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v ?? ""));
      }
    }
    return text;
  }

  function utf8ByteLength(value) {
    const str = String(value || "");
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(str).length;
    }
    let bytes = 0;
    for (let i = 0; i < str.length; i += 1) {
      const code = str.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function normalizeQuestionReplyEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const questionItemId = String(
      entry.questionItemId ?? entry.question_item_id ?? entry.itemId ?? entry.id ?? ""
    ).trim();
    const question = String(entry.question ?? entry.prompt ?? entry.title ?? "").trim();
    const answerRaw = entry.answer ?? entry.reply ?? entry.value ?? "";
    const answer = typeof answerRaw === "string"
      ? answerRaw.trim()
      : (Array.isArray(answerRaw) ? answerRaw.map((v) => String(v ?? "").trim()).filter(Boolean).join(", ") : String(answerRaw ?? "").trim());
    if (!questionItemId && !question && !answer) return null;
    return { questionItemId, question, answer };
  }

  function formatReplySummaryLine(reply) {
    const question = String(reply?.question || "").trim();
    const answer = String(reply?.answer || "").trim();
    if (question && answer) return `${question}: ${answer}`;
    return answer || question || "";
  }

  function parseQuestionReplyEnvelope(text) {
    const source = typeof text === "string" ? text : "";
    if (!source) {
      return {
        hasEnvelope: false,
        replies: [],
        answeredIds: [],
        trailingText: "",
        displayText: "",
      };
    }

    const replies = [];
    const answeredIds = [];
    const seenIds = new Set();
    let matchedTag = false;

    const stripped = source.replace(QUESTION_REPLY_TAG_RE, (_fullMatch, inner) => {
      matchedTag = true;
      const rawJson = String(inner || "").trim();
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson);
          const list = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.replies) ? parsed.replies : [parsed]);
          for (const candidate of list) {
            const normalized = normalizeQuestionReplyEntry(candidate);
            if (!normalized) continue;
            replies.push(normalized);
            if (normalized.questionItemId && !seenIds.has(normalized.questionItemId)) {
              seenIds.add(normalized.questionItemId);
              answeredIds.push(normalized.questionItemId);
            }
          }
        } catch {
          // Malformed JSON inside envelope: still strip raw XML block safely.
        }
      }
      return "\n";
    });

    if (!matchedTag) {
      return {
        hasEnvelope: false,
        replies: [],
        answeredIds: [],
        trailingText: source,
        displayText: source,
      };
    }

    const trailingText = stripped
      .replace(/^\s+|\s+$/g, "")
      .replace(/\n{3,}/g, "\n\n");
    const summaryLines = replies.map(formatReplySummaryLine).filter(Boolean);
    const displayParts = [];
    if (summaryLines.length > 0) displayParts.push(summaryLines.join("\n"));
    if (trailingText) displayParts.push(trailingText);

    return {
      hasEnvelope: true,
      replies,
      answeredIds,
      trailingText,
      displayText: displayParts.join("\n\n").trim(),
    };
  }

  function buildAsyncQuestionReplyText(replies, trailingText = "") {
    const normalized = (Array.isArray(replies) ? replies : [replies])
      .map(normalizeQuestionReplyEntry)
      .filter((entry) => entry && entry.answer);
    const trailing = typeof trailingText === "string" ? trailingText.trim() : "";
    if (normalized.length === 0) return trailing;

    const canUseEnvelope = normalized.every((entry) => {
      if (!entry.questionItemId) return false;
      return utf8ByteLength(entry.questionItemId) <= MAX_QUESTION_ITEM_ID_BYTES;
    });

    let body = "";
    if (canUseEnvelope) {
      body = `${QUESTION_REPLY_OPEN_MARKER}${JSON.stringify(normalized)}</send_user_message_question_reply>`;
    } else {
      body = normalized
        .map((entry) => {
          const title = entry.question || tr("asyncQuestion.badge");
          const quotedAnswer = entry.answer.replace(/\r?\n/g, "\n> ");
          return `> **${title}**\n> ${quotedAnswer}`;
        })
        .join("\n\n");
    }
    return trailing ? `${body}\n\n${trailing}` : body;
  }

  function el(tag, className, textContent) {
    const node = root.document?.createElement(tag);
    if (!node) return null;
    if (className) node.className = className;
    if (textContent !== undefined && textContent !== null) {
      node.textContent = String(textContent);
    }
    return node;
  }

  function createChevronSpan() {
    const span = el("span", "async-questions-panel__chevron");
    if (span) span.setAttribute("aria-hidden", "true");
    return span;
  }

  function normalizeAsyncOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) return [];
    const result = [];
    for (const entry of rawOptions) {
      if (typeof entry === "string") {
        const label = entry.trim();
        if (label) result.push({ label, value: label, description: "" });
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const label = String(entry.label ?? entry.title ?? entry.text ?? entry.value ?? "").trim();
      const value = String(entry.value ?? entry.label ?? entry.title ?? entry.text ?? "").trim();
      const description = String(entry.description ?? entry.subtitle ?? "").trim();
      if (label || value) {
        result.push({ label: label || value, value: value || label, description });
      }
    }
    return result;
  }

  function deriveFallbackQuestionId(evt, entry, index) {
    const rawId = String(entry?.id ?? entry?.questionItemId ?? entry?.itemId ?? "").trim();
    if (rawId) return rawId;
    const msgKey = String(evt?.itemId || evt?.id || evt?.seq || evt?.requestId || "").trim();
    if (msgKey) return `msg:${msgKey}:q:${Number.isFinite(Number(entry?.index)) ? Number(entry.index) : index}`;
    return "";
  }

  function isAsyncQuestionMessage(evt) {
    if (!evt || typeof evt !== "object") return false;
    const role = String(evt.role || "").trim().toLowerCase();
    if (role && role !== "assistant") return false;
    const delivery = String(evt.messageDelivery ?? evt.delivery ?? "").trim().toLowerCase();
    if (delivery === "async") return true;
    return Array.isArray(evt.asyncQuestions) && evt.asyncQuestions.length > 0;
  }

  function normalizeAsyncQuestionItem(evt, rawEntry, idx) {
    if (!rawEntry || typeof rawEntry !== "object") return null;
    const id = deriveFallbackQuestionId(evt, rawEntry, idx);
    if (!id) return null;
    const indexNum = Number.isFinite(Number(rawEntry.index)) ? Number(rawEntry.index) : idx;
    const title = String(rawEntry.title ?? rawEntry.header ?? "").trim();
    const question = String(rawEntry.question ?? rawEntry.prompt ?? rawEntry.text ?? title ?? "").trim();
    const options = normalizeAsyncOptions(rawEntry.options ?? rawEntry.choices);
    const allowFreeText = rawEntry.allowFreeText !== false;
    const multiSelect = rawEntry.multiSelect === true || rawEntry.isMultiSelect === true;
    const statusRaw = String(rawEntry.status || "pending").trim().toLowerCase();
    const answeredText = String(rawEntry.answeredText ?? rawEntry.answer ?? "").trim();
    const status = (statusRaw === "answered" || answeredText) ? "answered" : "pending";
    return {
      id,
      index: indexNum,
      title,
      question,
      options,
      allowFreeText,
      multiSelect,
      status,
      answeredText,
      messageSeq: Number.isFinite(Number(evt?.seq)) ? Number(evt.seq) : null,
      messageItemId: String(evt?.itemId || evt?.id || "").trim(),
      runId: String(evt?.runId || "").trim(),
    };
  }

  function extractUserReplyRecords(evt) {
    const records = [];
    if (!evt || typeof evt !== "object") return records;
    const role = String(evt.role || "").trim().toLowerCase();
    const isUser = !role || role === "user";
    if (!isUser) return records;

    if (Array.isArray(evt.answeredQuestionItemIds)) {
      for (const id of evt.answeredQuestionItemIds) {
        const cleanId = String(id || "").trim();
        if (cleanId) records.push({ questionItemId: cleanId, question: "", answer: "" });
      }
    }
    if (Array.isArray(evt.asyncQuestionReplies)) {
      for (const reply of evt.asyncQuestionReplies) {
        const norm = normalizeQuestionReplyEntry(reply);
        if (norm?.questionItemId) records.push(norm);
      }
    }
    const content = typeof evt.content === "string" && evt.content
      ? evt.content
      : (typeof evt.bodyPreview === "string" ? evt.bodyPreview : "");
    if (content && content.toLowerCase().includes(QUESTION_REPLY_OPEN_MARKER)) {
      const parsed = parseQuestionReplyEnvelope(content);
      for (const reply of parsed.replies) {
        if (reply.questionItemId) records.push(reply);
      }
    }
    return records;
  }

  function createSessionBucket() {
    return {
      itemsById: new Map(),
      order: [],
      answeredById: new Map(),
      draftById: new Map(),
      submittingIds: new Set(),
      expanded: false,
    };
  }

  const sessions = new Map();
  let activeSessionId = "";

  function resolveSessionId(explicitSessionId) {
    const candidate = String(explicitSessionId || "").trim();
    if (candidate) return candidate;
    if (typeof root?.currentSessionId === "string" && root.currentSessionId.trim()) {
      return root.currentSessionId.trim();
    }
    if (typeof root?.chatStore?.getState === "function") {
      const fromStore = String(root.chatStore.getState()?.currentSessionId || "").trim();
      if (fromStore) return fromStore;
    }
    return activeSessionId || "__default__";
  }

  function getBucket(sessionId, create = true) {
    const sid = resolveSessionId(sessionId);
    if (!sessions.has(sid) && create) {
      sessions.set(sid, createSessionBucket());
    }
    return { sid, bucket: sessions.get(sid) || null };
  }

  function getItemDraft(bucket, itemId) {
    if (!bucket.draftById.has(itemId)) {
      bucket.draftById.set(itemId, { selected: [], customText: "" });
    }
    return bucket.draftById.get(itemId);
  }

  function computeDraftAnswer(item, draft) {
    const selectedLabels = (Array.isArray(draft?.selected) ? draft.selected : [])
      .map((idx) => item?.options?.[idx]?.label || item?.options?.[idx]?.value || "")
      .filter(Boolean);
    const custom = String(draft?.customText || "").trim();
    if (selectedLabels.length > 0 && custom) {
      return `${selectedLabels.join(", ")} — ${custom}`;
    }
    if (selectedLabels.length > 0) return selectedLabels.join(", ");
    return custom;
  }

  function applyAnsweredRecord(bucket, questionItemId, answerText = "") {
    if (!questionItemId) return false;
    const prev = bucket.answeredById.get(questionItemId);
    const cleanAnswer = String(answerText || "").trim();
    const resolvedAnswer = cleanAnswer || prev?.answer || "";
    const wasAnswered = bucket.answeredById.has(questionItemId);
    bucket.answeredById.set(questionItemId, { answer: resolvedAnswer });
    bucket.submittingIds.delete(questionItemId);
    const existing = bucket.itemsById.get(questionItemId);
    let changed = !wasAnswered || (cleanAnswer && cleanAnswer !== prev?.answer);
    if (existing) {
      if (existing.status !== "answered" || (resolvedAnswer && existing.answeredText !== resolvedAnswer)) {
        existing.status = "answered";
        if (resolvedAnswer) existing.answeredText = resolvedAnswer;
        changed = true;
      }
    }
    return changed;
  }

  function upsertAssistantQuestionItem(bucket, evt, normalizedItem) {
    const id = normalizedItem.id;
    const existing = bucket.itemsById.get(id);
    const answeredRecord = bucket.answeredById.get(id);

    if (normalizedItem.status === "answered" || answeredRecord) {
      const answerText = normalizedItem.answeredText || answeredRecord?.answer || "";
      bucket.answeredById.set(id, { answer: answerText });
      normalizedItem.status = "answered";
      if (answerText) normalizedItem.answeredText = answerText;
    }

    if (!existing) {
      bucket.itemsById.set(id, normalizedItem);
      bucket.order.push(id);
      return true;
    }

    let changed = false;
    if (normalizedItem.status === "answered" && existing.status !== "answered") {
      existing.status = "answered";
      changed = true;
    }
    if (normalizedItem.answeredText && normalizedItem.answeredText !== existing.answeredText) {
      existing.answeredText = normalizedItem.answeredText;
      changed = true;
    }
    if (normalizedItem.question && !existing.question) {
      existing.question = normalizedItem.question;
      changed = true;
    }
    if (normalizedItem.title && !existing.title) {
      existing.title = normalizedItem.title;
      changed = true;
    }
    if (normalizedItem.options.length > 0 && existing.options.length === 0) {
      existing.options = normalizedItem.options;
      changed = true;
    }
    return changed;
  }

  function getResolvedItemState(bucket, item) {
    if (!item) return { status: "pending", answeredText: "" };
    if (bucket.submittingIds.has(item.id)) {
      return { status: "sending", answeredText: item.answeredText || "" };
    }
    const answered = bucket.answeredById.get(item.id);
    if (answered || item.status === "answered") {
      return {
        status: "answered",
        answeredText: answered?.answer || item.answeredText || "",
      };
    }
    return { status: "pending", answeredText: "" };
  }

  function getPendingQuestions(sessionId) {
    const { bucket } = getBucket(sessionId, false);
    if (!bucket) return [];
    const pending = [];
    for (const id of bucket.order) {
      const item = bucket.itemsById.get(id);
      if (!item) continue;
      const state = getResolvedItemState(bucket, item);
      if (state.status !== "answered") {
        pending.push({ ...item, ...state });
      }
    }
    return pending;
  }

  function notifyLayoutChanged() {
    root.RagentLayout?.syncChatBottomOverlaySpacing?.();
    if (typeof root.syncChatBottomOverlaySpacing === "function") {
      root.syncChatBottomOverlaySpacing();
    }
  }

  let panelResizeObserver = null;
  function ensurePanelObserved(panel) {
    if (!panel || panelResizeObserver || typeof root.ResizeObserver !== "function") return;
    panelResizeObserver = new root.ResizeObserver(() => {
      notifyLayoutChanged();
    });
    panelResizeObserver.observe(panel);
  }

  function notifyToast(message, durationMs = 2600) {
    if (typeof root?.showSystemToast === "function") {
      root.showSystemToast(message, durationMs);
    }
  }

  function createInteractiveQuestionCard(item, { sessionId = "", variant = "stream" } = {}) {
    const sid = resolveSessionId(sessionId);
    const { bucket } = getBucket(sid, true);
    const state = getResolvedItemState(bucket, item);
    const draft = getItemDraft(bucket, item.id);
    const card = el("div", `async-question-card async-question-card--${variant}`);
    if (!card) return null;
    card.dataset.asyncQuestionItemId = item.id;
    card.dataset.asyncQuestionState = state.status;
    card.dataset.sessionId = sid;

    if (state.status === "answered") {
      card.classList.add("is-answered");
      const summaryRow = el("div", "async-question-card__answered-row");
      const check = el("span", "async-question-card__answered-badge", tr("asyncQuestion.answered"));
      const questionLabel = el("span", "async-question-card__answered-question", item.question || item.title || item.id);
      const answerLabel = el(
        "span",
        "async-question-card__answered-text",
        state.answeredText ? tr("asyncQuestion.repliedWith", { answer: state.answeredText }) : tr("asyncQuestion.answered")
      );
      summaryRow.appendChild(check);
      if (item.question || item.title) summaryRow.appendChild(questionLabel);
      summaryRow.appendChild(answerLabel);
      card.appendChild(summaryRow);
      return card;
    }

    const header = el("div", "async-question-card__header");
    const badge = el("span", "async-question-card__badge", item.title || tr("asyncQuestion.badge"));
    header.appendChild(badge);
    if (variant === "panel" && Number.isFinite(Number(item.index))) {
      header.appendChild(
        el("span", "async-question-card__progress", tr("asyncQuestion.questionProgress", { index: Number(item.index) + 1 }))
      );
    }
    card.appendChild(header);

    if (item.question) {
      card.appendChild(el("div", "async-question-card__question", item.question));
    }

    const sendBtn = el(
      "button",
      "async-question-card__submit",
      state.status === "sending" ? tr("asyncQuestion.sending") : tr("asyncQuestion.sendReply")
    );
    sendBtn.type = "button";

    const syncSubmitDisabled = () => {
      const sending = bucket.submittingIds.has(item.id);
      const hasValue = Boolean(computeDraftAnswer(item, draft));
      sendBtn.disabled = sending || !hasValue;
      sendBtn.textContent = sending ? tr("asyncQuestion.sending") : tr("asyncQuestion.sendReply");
    };

    if (Array.isArray(item.options) && item.options.length > 0) {
      const optionList = el("div", "async-question-card__options");
      if (item.multiSelect) {
        optionList.dataset.multiSelect = "true";
      }
      item.options.forEach((opt, optIdx) => {
        const btn = el("button", "async-question-card__option");
        btn.type = "button";
        btn.dataset.optionIndex = String(optIdx);
        const isSelected = draft.selected.includes(optIdx);
        btn.classList.toggle("is-selected", isSelected);
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");

        const labelSpan = el("span", "async-question-card__option-label", opt.label);
        btn.appendChild(labelSpan);
        if (opt.description) {
          btn.appendChild(el("span", "async-question-card__option-description", opt.description));
        }

        btn.addEventListener("click", () => {
          if (bucket.submittingIds.has(item.id)) return;
          const idxPos = draft.selected.indexOf(optIdx);
          if (item.multiSelect) {
            if (idxPos >= 0) draft.selected.splice(idxPos, 1);
            else draft.selected.push(optIdx);
          } else if (idxPos >= 0) {
            draft.selected = [];
          } else {
            draft.selected = [optIdx];
          }
          optionList.querySelectorAll(".async-question-card__option").forEach((peer, peerIdx) => {
            const selectedNow = draft.selected.includes(peerIdx);
            peer.classList.toggle("is-selected", selectedNow);
            peer.setAttribute("aria-pressed", selectedNow ? "true" : "false");
          });
          syncSubmitDisabled();
        });
        optionList.appendChild(btn);
      });
      card.appendChild(optionList);
    }

    const actionsRow = el("div", "async-question-card__actions");
    if (item.allowFreeText !== false || item.options.length === 0) {
      const input = el("input", "async-question-card__input");
      input.type = "text";
      input.value = draft.customText || "";
      input.placeholder = item.options.length > 0
        ? tr("asyncQuestion.notePlaceholder")
        : tr("asyncQuestion.customPlaceholder");
      input.disabled = state.status === "sending";
      input.addEventListener("input", () => {
        draft.customText = input.value;
        syncSubmitDisabled();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (!sendBtn.disabled) {
            void submitSingleItemReply(sid, item);
          }
        }
      });
      actionsRow.appendChild(input);
    }

    sendBtn.addEventListener("click", () => {
      void submitSingleItemReply(sid, item);
    });
    syncSubmitDisabled();
    actionsRow.appendChild(sendBtn);
    card.appendChild(actionsRow);
    return card;
  }

  async function submitReplies(sessionId, replyEntries, trailingText = "") {
    const sid = resolveSessionId(sessionId);
    const { bucket } = getBucket(sid, true);
    const normalized = (Array.isArray(replyEntries) ? replyEntries : [replyEntries])
      .map(normalizeQuestionReplyEntry)
      .filter((entry) => entry && entry.answer);
    if (normalized.length === 0) {
      notifyToast(tr("asyncQuestion.emptyError"));
      return false;
    }

    const submittingIds = normalized.map((entry) => entry.questionItemId).filter(Boolean);
    for (const id of submittingIds) {
      bucket.submittingIds.add(id);
    }
    refreshRenderedCards(sid, submittingIds);
    renderFloatingPanel(sid);

    const requestId = typeof root?.createRequestId === "function"
      ? root.createRequestId()
      : `asyncq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const text = buildAsyncQuestionReplyText(normalized, trailingText);
    const payload = {
      sessionId: sid,
      requestId,
      text,
      steerIfRunning: true,
      asyncQuestionReplies: normalized,
    };

    let ok = false;
    let errorMessage = "";
    try {
      if (typeof root?.dispatchAction === "function") {
        const res = await root.dispatchAction({
          action: "send",
          ...payload,
        });
        ok = res !== false && !res?.error;
        if (!ok && res?.error) errorMessage = String(res.error);
      } else if (typeof root?.fetch === "function" && sid && sid !== "__default__") {
        const resp = await root.fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId,
            text,
            steerIfRunning: true,
            asyncQuestionReplies: normalized,
          }),
        });
        ok = Boolean(resp && resp.ok);
        if (!ok) {
          errorMessage = resp ? `HTTP ${resp.status}` : "Request failed";
        }
      }
    } catch (error) {
      errorMessage = error?.message || String(error || "");
      ok = false;
    }

    for (const id of submittingIds) {
      bucket.submittingIds.delete(id);
    }

    if (ok) {
      for (const entry of normalized) {
        if (entry.questionItemId) {
          applyAnsweredRecord(bucket, entry.questionItemId, entry.answer);
          bucket.draftById.delete(entry.questionItemId);
        }
      }
      refreshRenderedCards(sid, submittingIds);
      renderFloatingPanel(sid);
      return true;
    }

    refreshRenderedCards(sid, submittingIds);
    renderFloatingPanel(sid);
    notifyToast(tr("asyncQuestion.sendFailed", { message: errorMessage || "Error" }));
    return false;
  }

  async function submitSingleItemReply(sessionId, item) {
    const sid = resolveSessionId(sessionId);
    const { bucket } = getBucket(sid, true);
    const draft = getItemDraft(bucket, item.id);
    const answer = computeDraftAnswer(item, draft);
    if (!answer) {
      notifyToast(tr("asyncQuestion.emptyError"));
      return false;
    }
    return submitReplies(sid, [{
      questionItemId: item.id,
      question: item.question || item.title || "",
      answer,
    }]);
  }

  function refreshRenderedCards(sessionId, targetIds = null) {
    const doc = root.document;
    if (!doc) return;
    const sid = resolveSessionId(sessionId);
    if (activeSessionId && sid && activeSessionId !== sid) return;
    const { bucket } = getBucket(sid, false);
    if (!bucket) return;
    const idFilter = Array.isArray(targetIds) && targetIds.length > 0 ? new Set(targetIds) : null;
    const container = doc.getElementById("messagesInner");
    if (!container?.querySelectorAll) return;

    const nodes = container.querySelectorAll(".async-question-card[data-async-question-item-id]");
    nodes.forEach((existingCard) => {
      const itemId = existingCard.dataset?.asyncQuestionItemId || "";
      if (!itemId || (idFilter && !idFilter.has(itemId))) return;
      const item = bucket.itemsById.get(itemId);
      if (!item) return;
      const nextCard = createInteractiveQuestionCard(item, {
        sessionId: sid,
        variant: existingCard.classList?.contains("async-question-card--panel") ? "panel" : "stream",
      });
      if (nextCard && existingCard.parentNode) {
        existingCard.parentNode.replaceChild(nextCard, existingCard);
      }
    });
  }

  function renderFloatingPanel(explicitSessionId) {
    const doc = root.document;
    if (!doc) return;
    const panel = doc.getElementById("asyncQuestionsPanel");
    if (!panel) return;
    ensurePanelObserved(panel);

    const sid = resolveSessionId(explicitSessionId);
    if (activeSessionId && sid && activeSessionId !== sid) return;

    const { bucket } = getBucket(sid, false);
    const pending = getPendingQuestions(sid);
    if (pending.length === 0) {
      if (bucket) bucket.expanded = false;
      delete panel.dataset.syncedSession;
      delete panel.dataset.syncedStateSig;
      panel.classList.remove("visible", "is-expanded");
      panel.setAttribute("hidden", "");
      panel.innerHTML = "";
      notifyLayoutChanged();
      return;
    }

    const isExpanded = Boolean(bucket?.expanded);
    const sig = JSON.stringify([
      isExpanded,
      pending.map((p) => [p.id, p.status, p.question, p.options?.length || 0]),
    ]);
    if (
      panel.dataset.syncedSession === sid
      && panel.dataset.syncedStateSig === sig
      && panel.children.length > 0
      && panel.classList.contains("visible")
    ) {
      return;
    }

    panel.dataset.syncedSession = sid;
    panel.dataset.syncedStateSig = sig;
    panel.removeAttribute("hidden");
    panel.classList.add("visible");
    panel.classList.toggle("is-expanded", isExpanded);
    panel.innerHTML = "";

    const summaryBtn = el("button", "async-questions-panel__summary");
    summaryBtn.type = "button";
    summaryBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    summaryBtn.appendChild(el("span", "async-questions-panel__dot"));
    const countLabel = pending.length === 1
      ? tr("asyncQuestion.pendingOne")
      : tr("asyncQuestion.pendingMany", { count: pending.length });
    const firstPreview = pending[0]?.question || pending[0]?.title || "";
    const labelText = firstPreview && !isExpanded ? `${countLabel} · ${firstPreview}` : countLabel;
    summaryBtn.appendChild(el("span", "async-questions-panel__label", labelText));
    summaryBtn.appendChild(createChevronSpan());
    summaryBtn.addEventListener("click", () => {
      if (!bucket) return;
      bucket.expanded = !bucket.expanded;
      renderFloatingPanel(sid);
    });
    panel.appendChild(summaryBtn);

    if (isExpanded) {
      const list = el("div", "async-questions-panel__list");
      pending.forEach((item) => {
        const card = createInteractiveQuestionCard(item, { sessionId: sid, variant: "panel" });
        if (card) list.appendChild(card);
      });
      panel.appendChild(list);
    }

    notifyLayoutChanged();
  }

  function renderInStreamMessageQuestions(evt, { sessionId = "" } = {}) {
    if (!isAsyncQuestionMessage(evt)) return null;
    const sid = resolveSessionId(sessionId || evt?.sessionId);
    const { bucket } = getBucket(sid, true);
    const rawList = Array.isArray(evt.asyncQuestions) ? evt.asyncQuestions : [];

    if (rawList.length === 0) {
      const card = el("div", "async-followup-card");
      if (!card) return null;
      const header = el("div", "async-followup-card__header");
      header.appendChild(el("span", "async-question-card__badge async-question-card__badge--followup", tr("asyncQuestion.followUpBadge")));
      const quickReply = el("button", "async-followup-card__action", tr("asyncQuestion.quickReply"));
      quickReply.type = "button";
      quickReply.addEventListener("click", () => {
        const input = root.document?.getElementById("msgInput") || root.document?.querySelector?.("[data-composer-input]");
        input?.focus?.();
      });
      header.appendChild(quickReply);
      card.appendChild(header);
      return card;
    }

    const wrapper = el("div", "async-question-stream-group");
    rawList.forEach((rawEntry, idx) => {
      const norm = normalizeAsyncQuestionItem(evt, rawEntry, idx);
      if (!norm) return;
      upsertAssistantQuestionItem(bucket, evt, norm);
      const item = bucket.itemsById.get(norm.id) || norm;
      const card = createInteractiveQuestionCard(item, { sessionId: sid, variant: "stream" });
      if (card) wrapper.appendChild(card);
    });
    if (!wrapper.children.length) return null;
    return wrapper;
  }

  function ingestEvents(events, { sessionId = "" } = {}) {
    const sid = resolveSessionId(sessionId);
    if (!sid) return false;
    activeSessionId = sid;
    const { bucket } = getBucket(sid, true);
    const list = Array.isArray(events) ? events : (events ? [events] : []);
    if (list.length === 0) {
      renderFloatingPanel(sid);
      return false;
    }

    let changed = false;
    const updatedIds = [];

    for (const evt of list) {
      if (!evt || typeof evt !== "object") continue;

      if (isAsyncQuestionMessage(evt) && Array.isArray(evt.asyncQuestions)) {
        evt.asyncQuestions.forEach((rawEntry, idx) => {
          const norm = normalizeAsyncQuestionItem(evt, rawEntry, idx);
          if (!norm) return;
          if (upsertAssistantQuestionItem(bucket, evt, norm)) {
            changed = true;
            updatedIds.push(norm.id);
          }
        });
      }

      const replyRecords = extractUserReplyRecords(evt);
      for (const rec of replyRecords) {
        if (applyAnsweredRecord(bucket, rec.questionItemId, rec.answer)) {
          changed = true;
          updatedIds.push(rec.questionItemId);
        }
      }
    }

    if (changed && updatedIds.length > 0) {
      refreshRenderedCards(sid, updatedIds);
    }
    renderFloatingPanel(sid);
    return changed;
  }

  function resetSession(sessionId = "") {
    const sid = resolveSessionId(sessionId || activeSessionId);
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
    }
    if (!sessionId) {
      activeSessionId = resolveSessionId("");
    }
    renderFloatingPanel(sid || activeSessionId);
  }

  function setActiveSession(sessionId) {
    const sid = resolveSessionId(sessionId);
    activeSessionId = sid;
    renderFloatingPanel(sid);
  }

  const api = {
    parseQuestionReplyEnvelope,
    buildAsyncQuestionReplyText,
    isAsyncQuestionMessage,
    extractUserReplyRecords,
    ingestEvents,
    renderInStreamMessageQuestions,
    renderFloatingPanel,
    refreshRenderedCards,
    submitReplies,
    getPendingQuestions,
    resetSession,
    setActiveSession,
  };

  root.parseQuestionReplyEnvelope = parseQuestionReplyEnvelope;
  root.buildAsyncQuestionReplyText = buildAsyncQuestionReplyText;
  root.RagentAsyncQuestions = api;

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

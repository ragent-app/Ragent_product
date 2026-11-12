// ---- Send message ----
const fallbackStrings = {
  "compose.pending.uploading": "Uploading attachment\u2026",
  "compose.pending.sendingAttachment": "Sending attachment\u2026",
  "compose.pending.sending": "Sending\u2026",
  "compose.pending.checking": "Sent, confirming route\u2026",
  "compose.pending.processing": "Received, waiting for activity\u2026",
  "compose.inline.uploading": "Uploading attachment\u2026",
  "compose.inline.sending": "Sending\u2026",
  "compose.inline.checking": "Sent, confirming route\u2026",
  "compose.inline.processing": "Received, waiting for activity\u2026",
};

function fallbackTranslate(key) {
  return fallbackStrings[key] || key;
}

function t(key, vars) {
  return window.agentocT ? window.agentocT(key, vars) : fallbackTranslate(key);
}

function getComposerPendingSendSnapshot() {
  return typeof getComposerPendingSendState === "function"
    ? getComposerPendingSendState()
    : null;
}

function getComposerAttachmentsSnapshot(sessionId = currentSessionId) {
  if (!sessionId) return [];
  return typeof getComposerAttachmentsState === "function"
    ? getComposerAttachmentsState(sessionId)
    : [];
}

function syncComposerDraftState(sessionId = currentSessionId, text = "") {
  if (!sessionId) return;
  if (typeof setComposerDraftTextState === "function") {
    setComposerDraftTextState(text, { sessionId });
  }
}

function replaceComposerAttachmentsSnapshot(sessionId = currentSessionId, attachments = []) {
  if (!sessionId) return;
  if (typeof replaceComposerAttachmentsState === "function") {
    replaceComposerAttachmentsState(attachments, { sessionId });
  }
}

function clearComposerPendingSendSnapshot(requestId = "") {
  if (typeof clearComposerPendingSendState === "function") {
    clearComposerPendingSendState(requestId);
  }
}

function getComposerRetainedSendSnapshot(requestId = "") {
  return typeof getComposerRetainedSendState === "function"
    ? getComposerRetainedSendState(requestId)
    : null;
}

function retainComposerSendUntilCommit(retainedSend) {
  if (typeof setComposerRetainedSendState !== "function") return false;
  setComposerRetainedSendState(retainedSend);
  return true;
}

function patchComposerRetainedSend(requestId, patch = {}) {
  if (typeof patchComposerRetainedSendState !== "function") return false;
  patchComposerRetainedSendState(requestId, patch);
  return true;
}

function clearComposerRetainedSend(requestId = "") {
  if (typeof clearComposerRetainedSendState !== "function") return false;
  clearComposerRetainedSendState(requestId);
  return true;
}

function getComposerAssetUploadConfig() {
  return typeof getBootstrapAssetUploads === "function"
    ? getBootstrapAssetUploads()
    : { enabled: false, directUpload: false, provider: "" };
}

function shouldUseDirectComposerAssetUploads() {
  const config = getComposerAssetUploadConfig();
  return config.enabled === true
    && config.directUpload === true
    && typeof fetchJsonOrRedirect === "function";
}

const COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY = 3;
const composerAttachmentUploadQueue = [];
const composerAttachmentUploadPromises = new Map();
const composerAttachmentUploadControllers = new Map();
let activeComposerAttachmentUploads = 0;

function createComposerAttachmentAbortError() {
  const error = new Error("Attachment upload cancelled");
  error.name = "AbortError";
  return error;
}

function buildComposerAttachmentUploadKey(sessionId, localId) {
  return `${sessionId || ""}:${localId || ""}`;
}

function normalizeComposerAttachmentUploadState(value) {
  switch (value) {
    case "uploading":
    case "uploaded":
    case "failed":
      return value;
    default:
      return "queued";
  }
}

function refreshComposerAttachmentUi(sessionId = currentSessionId) {
  if (!sessionId || sessionId !== currentSessionId) {
    return;
  }
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  syncComposerPendingUi();
}

function getComposerAttachmentByLocalId(sessionId, localId) {
  if (!sessionId || typeof localId !== "string" || !localId) {
    return null;
  }
  return getComposerAttachmentsSnapshot(sessionId).find((attachment) => attachment?.localId === localId) || null;
}

function updateComposerAttachmentByLocalId(sessionId, localId, updater) {
  if (!sessionId || typeof localId !== "string" || !localId || typeof updater !== "function") {
    return null;
  }
  const attachments = getComposerAttachmentsSnapshot(sessionId);
  let nextAttachment = null;
  let changed = false;
  let found = false;
  const nextAttachments = attachments
    .map((attachment) => {
      if (attachment?.localId !== localId) {
        return attachment;
      }
      found = true;
      const updated = updater(attachment);
      nextAttachment = updated && typeof updated === "object" ? updated : null;
      if (updated !== attachment) {
        changed = true;
      }
      return updated;
    })
    .filter(Boolean);
  if (!found) {
    return null;
  }
  if (changed) {
    replaceComposerAttachmentsSnapshot(sessionId, nextAttachments);
    refreshComposerAttachmentUi(sessionId);
  }
  return nextAttachment;
}

function cancelComposerAttachmentUpload(sessionId, localId) {
  const key = buildComposerAttachmentUploadKey(sessionId, localId);
  const queuedIndex = composerAttachmentUploadQueue.findIndex((job) => job.key === key);
  if (queuedIndex >= 0) {
    const [job] = composerAttachmentUploadQueue.splice(queuedIndex, 1);
    composerAttachmentUploadPromises.delete(key);
    job.reject(createComposerAttachmentAbortError());
    return true;
  }
  const controller = composerAttachmentUploadControllers.get(key);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

async function uploadComposerAttachmentToAsset(sessionId, attachment, { signal } = {}) {
  const file = attachment?.file;
  if (!file || typeof file.arrayBuffer !== "function") {
    return attachment;
  }

  const intent = await fetchJsonOrRedirect("/api/assets/upload-intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      originalName: attachment?.originalName || file.name || "attachment",
      mimeType: attachment?.mimeType || file.type || "application/octet-stream",
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
    }),
  });

  const asset = intent?.asset && typeof intent.asset === "object"
    ? intent.asset
    : null;
  const upload = intent?.upload && typeof intent.upload === "object"
    ? intent.upload
    : null;
  if (!asset?.id || !upload?.url) {
    throw new Error("Upload intent is incomplete");
  }

  const uploadResponse = await (window.agentocFetch || fetch)(upload.url, {
    method: upload.method || "PUT",
    headers: upload.headers || {},
    body: file,
    ...(signal ? { signal } : {}),
  });
  if (!uploadResponse.ok) {
    throw new Error(`Attachment upload failed (${uploadResponse.status})`);
  }

  const finalized = await fetchJsonOrRedirect(`/api/assets/${encodeURIComponent(asset.id)}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
      etag: uploadResponse.headers.get("etag") || "",
    }),
  });

  const finalizedAsset = finalized?.asset && typeof finalized.asset === "object"
    ? finalized.asset
    : asset;
  return {
    assetId: finalizedAsset.id,
    ...(attachment?.localId ? { localId: attachment.localId } : {}),
    originalName: finalizedAsset.originalName || attachment?.originalName || file.name || "attachment",
    mimeType: finalizedAsset.mimeType || attachment?.mimeType || file.type || "application/octet-stream",
    ...(Number.isFinite(finalizedAsset?.sizeBytes) ? { sizeBytes: finalizedAsset.sizeBytes } : Number.isFinite(file.size) ? { sizeBytes: file.size } : {}),
    ...(finalizedAsset?.downloadUrl ? { downloadUrl: finalizedAsset.downloadUrl } : {}),
    ...(attachment?.renderAs === "file" ? { renderAs: "file" } : {}),
    ...(attachment?.objectUrl ? { objectUrl: attachment.objectUrl } : {}),
  };
}

async function runComposerAttachmentUpload(sessionId, localId) {
  const attachment = getComposerAttachmentByLocalId(sessionId, localId);
  if (!attachment) {
    return null;
  }
  if (attachment.assetId) {
    return attachment;
  }
  if (!attachment.file || typeof attachment.file.arrayBuffer !== "function") {
    throw new Error("Attachment file is unavailable");
  }

  updateComposerAttachmentByLocalId(sessionId, localId, (currentAttachment) => currentAttachment
    ? {
      ...currentAttachment,
      uploadState: "uploading",
      uploadError: "",
    }
    : currentAttachment);

  const key = buildComposerAttachmentUploadKey(sessionId, localId);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  if (controller) {
    composerAttachmentUploadControllers.set(key, controller);
  }

  try {
    const currentAttachment = getComposerAttachmentByLocalId(sessionId, localId);
    if (!currentAttachment) {
      throw createComposerAttachmentAbortError();
    }
    const uploadedAttachment = await uploadComposerAttachmentToAsset(sessionId, currentAttachment, {
      signal: controller?.signal,
    });
    return updateComposerAttachmentByLocalId(sessionId, localId, (nextAttachment) => nextAttachment
      ? {
        ...nextAttachment,
        ...uploadedAttachment,
        file: undefined,
        uploadState: "uploaded",
        uploadError: "",
      }
      : nextAttachment);
  } catch (error) {
    const latestAttachment = getComposerAttachmentByLocalId(sessionId, localId);
    if (latestAttachment) {
      updateComposerAttachmentByLocalId(sessionId, localId, (nextAttachment) => nextAttachment
        ? {
          ...nextAttachment,
          uploadState: error?.name === "AbortError"
            ? "queued"
            : "failed",
          uploadError: error?.name === "AbortError"
            ? nextAttachment?.uploadError || ""
            : (error?.message || "Attachment upload failed"),
        }
        : nextAttachment);
    }
    throw error;
  } finally {
    composerAttachmentUploadControllers.delete(key);
  }
}

function pumpComposerAttachmentUploads() {
  while (activeComposerAttachmentUploads < COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY && composerAttachmentUploadQueue.length > 0) {
    const job = composerAttachmentUploadQueue.shift();
    if (!job) {
      continue;
    }
    const attachment = getComposerAttachmentByLocalId(job.sessionId, job.localId);
    if (!attachment || attachment.assetId || !attachment.file) {
      composerAttachmentUploadPromises.delete(job.key);
      job.resolve(attachment || null);
      continue;
    }
    activeComposerAttachmentUploads += 1;
    void (async () => {
      try {
        job.resolve(await runComposerAttachmentUpload(job.sessionId, job.localId));
      } catch (error) {
        job.reject(error);
      } finally {
        composerAttachmentUploadPromises.delete(job.key);
        activeComposerAttachmentUploads = Math.max(0, activeComposerAttachmentUploads - 1);
        pumpComposerAttachmentUploads();
      }
    })();
  }
}

function scheduleComposerAttachmentUpload(sessionId, localId) {
  const key = buildComposerAttachmentUploadKey(sessionId, localId);
  const existingPromise = composerAttachmentUploadPromises.get(key);
  if (existingPromise) {
    return existingPromise;
  }
  const promise = new Promise((resolve, reject) => {
    composerAttachmentUploadQueue.push({
      sessionId,
      localId,
      key,
      resolve,
      reject,
    });
    pumpComposerAttachmentUploads();
  });
  composerAttachmentUploadPromises.set(key, promise);
  return promise;
}

function collectComposerAttachmentUploadPromises(sessionId, { localIds = [], includeFailed = false } = {}) {
  if (!sessionId || !shouldUseDirectComposerAssetUploads()) {
    return [];
  }
  const trackedIds = new Set(
    (Array.isArray(localIds) ? localIds : [])
      .filter((value) => typeof value === "string" && value),
  );
  const attachments = getComposerAttachmentsSnapshot(sessionId);
  const promises = [];
  for (const attachment of attachments) {
    if (!(attachment && typeof attachment === "object")) continue;
    if (!attachment.file || attachment.assetId) continue;
    const localId = typeof attachment.localId === "string" ? attachment.localId : "";
    if (!localId) continue;
    if (trackedIds.size > 0 && !trackedIds.has(localId)) continue;
    const uploadState = normalizeComposerAttachmentUploadState(attachment.uploadState);
    if (uploadState === "failed" && !includeFailed) continue;
    if (uploadState === "uploaded") continue;
    promises.push(scheduleComposerAttachmentUpload(sessionId, localId));
  }
  return promises;
}

async function ensureComposerAttachmentUploads(sessionId, options = {}) {
  const uploads = collectComposerAttachmentUploadPromises(sessionId, options);
  if (uploads.length === 0) {
    return [];
  }
  return Promise.all(uploads);
}

async function retryComposerAttachmentUpload(sessionId, localId) {
  const attachment = updateComposerAttachmentByLocalId(sessionId, localId, (currentAttachment) => currentAttachment
    ? {
      ...currentAttachment,
      uploadState: "queued",
      uploadError: "",
    }
    : currentAttachment);
  if (!attachment || !attachment.file) {
    throw new Error("Attachment file is unavailable");
  }
  return ensureComposerAttachmentUploads(sessionId, {
    localIds: [localId],
    includeFailed: true,
  });
}

async function prepareComposerAttachmentsForSend(sessionId, attachments) {
  if (!shouldUseDirectComposerAssetUploads()) {
    return attachments;
  }

  const trackedLocalIds = [];
  const trackedAttachmentPositions = [];
  const prepared = [];
  for (const attachment of attachments || []) {
    if (!(attachment && typeof attachment === "object")) continue;
    if (!attachment.file || typeof attachment.assetId === "string") {
      prepared.push(attachment);
      continue;
    }
    if (typeof attachment.localId === "string" && attachment.localId) {
      trackedLocalIds.push(attachment.localId);
      trackedAttachmentPositions.push({
        index: prepared.length,
        localId: attachment.localId,
      });
      prepared.push(null);
      continue;
    }
    prepared.push(await uploadComposerAttachmentToAsset(sessionId, attachment));
  }

  if (trackedLocalIds.length > 0) {
    await ensureComposerAttachmentUploads(sessionId, { localIds: trackedLocalIds });
    const attachmentsByLocalId = new Map(
      getComposerAttachmentsSnapshot(sessionId)
        .filter((attachment) => attachment?.localId)
        .map((attachment) => [attachment.localId, attachment]),
    );
    for (const attachment of attachments || []) {
      if (!(attachment && typeof attachment === "object")) continue;
      if (!attachment.file || typeof attachment.assetId === "string") {
        continue;
      }
      const localId = typeof attachment.localId === "string" ? attachment.localId : "";
      if (!localId) continue;
      const nextAttachment = attachmentsByLocalId.get(localId);
      if (!nextAttachment) {
        throw createComposerAttachmentAbortError();
      }
      if (!nextAttachment.assetId) {
        throw new Error(nextAttachment.uploadError || "Attachment upload did not finish");
      }
    }
    for (const trackedAttachment of trackedAttachmentPositions) {
      const nextAttachment = attachmentsByLocalId.get(trackedAttachment.localId);
      if (!nextAttachment?.assetId) {
        throw new Error(nextAttachment?.uploadError || "Attachment upload did not finish");
      }
      prepared[trackedAttachment.index] = nextAttachment;
    }
  }
  return prepared.filter(Boolean);
}

function hasPendingComposerSend() {
  return isComposerPendingBlocking(getComposerPendingSendSnapshot());
}

function isComposerPendingBlocking(pendingSend = getComposerPendingSendSnapshot()) {
  return !!pendingSend && pendingSend.stage !== "processing" && pendingSend.stage !== "checking";
}

function isComposerTransportPending(pendingSend = getComposerPendingSendSnapshot()) {
  return !!pendingSend && (pendingSend.stage === "uploading" || pendingSend.stage === "sending");
}

function isComposerPendingForSession(sessionId = currentSessionId, { includeProcessing = true } = {}) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!(pendingSend && sessionId && pendingSend.sessionId === sessionId)) {
    return false;
  }
  return includeProcessing ? true : isComposerPendingBlocking(pendingSend);
}

function isComposerPendingForCurrentSession() {
  return isComposerPendingForSession(currentSessionId);
}

function isComposerTransportPendingForCurrentSession(
  pendingSend = getComposerPendingSendSnapshot(),
) {
  return !!(
    pendingSend
    && currentSessionId
    && pendingSend.sessionId === currentSessionId
    && isComposerTransportPending(pendingSend)
  );
}

function isComposerBlockingForSession(sessionId = currentSessionId) {
  return isComposerPendingForSession(sessionId, { includeProcessing: false });
}

function isComposerEditorFocused() {
  const markdownEditorFocused = typeof window !== "undefined"
    && window.AgentoCMarkdownComposer?.isEditorFocused?.(msgInput) === true;
  return markdownEditorFocused
    || (typeof document !== "undefined" && document.activeElement === msgInput);
}

function blurComposerEditorForPendingSend() {
  const editable = window.AgentoCMarkdownComposer?.getEditable?.(msgInput)
    || window.AgentoCMarkdownComposer?.getEditor?.(msgInput);
  if (editable?.blur) editable.blur();
  if (typeof document !== "undefined" && document.activeElement === msgInput) {
    msgInput.blur?.();
  }
  document.body?.classList?.remove?.("composer-input-focused");
}

// Expansion is an interaction state, not a focus state. This mirrors the
// Android AgentComposer: once opened, the composer stays open while its own
// editor and controls are used; only an outside tap, send, or an explicit
// session reset closes an empty composer.
let composerExpandedByInteraction = false;
let composerCollapseLockSessionId = "";
let composerCollapseLockRequestId = "";
let composerPresentationInitialized = false;
let composerSizeAnimationCleanup = null;
const composerControlPresenceTimers = new WeakMap();
const COMPOSER_CONTROL_PRESENCE_DURATION = 280;
const composerPanelSelector = [
  ".composer-add-menu:not([hidden])",
  ".composer-add-panel:not([hidden])",
  ".composer-runtime-menu:not([hidden])",
  ".composer-runtime-speed-panel:not([hidden])",
  ".composer-permission-menu:not([hidden])",
].join(", ");
const composerPanelInteractionSelector = [
  "#imgBtn",
  "#composerRuntimeBtn",
  "#composerRuntimeSpeedBtn",
  "#composerPermissionBtn",
  "#composerControlsBtn",
  ".composer-add-menu",
  ".composer-add-panel",
  ".composer-runtime-menu",
  ".composer-runtime-speed-panel",
  ".composer-permission-menu",
].join(", ");

function armComposerCollapseLock(sessionId = currentSessionId, requestId = "") {
  composerCollapseLockSessionId = typeof sessionId === "string" ? sessionId : "";
  composerCollapseLockRequestId = typeof requestId === "string" ? requestId : "";
}

function releaseComposerCollapseLock(requestId = "") {
  if (requestId
    && composerCollapseLockRequestId
    && composerCollapseLockRequestId !== requestId) return;
  composerCollapseLockSessionId = "";
  composerCollapseLockRequestId = "";
}

function isComposerCollapseLockedForCurrentSession() {
  return !!(
    composerCollapseLockSessionId
    && currentSessionId
    && composerCollapseLockSessionId === currentSessionId
  );
}

function readComposerShellMotionSnapshot(wrapper) {
  if (!wrapper) return null;
  const rect = wrapper.getBoundingClientRect?.();
  const style = window.getComputedStyle?.(wrapper);
  const read = (property) => Number.parseFloat(style?.[property]);
  return {
    height: Math.max(0, Number(rect?.height) || 0),
    // Chromium computes logical margins correctly but does not interpolate
    // them consistently through Web Animations. The compact inset is
    // symmetric, so physical margins preserve the same RTL geometry.
    marginLeft: read("marginLeft"),
    marginRight: read("marginRight"),
    borderRadius: read("borderTopLeftRadius"),
  };
}

function composerMotionValue(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function createComposerSpringKeyframes(start, target, duration) {
  // This is the same critically-near spring family as Android's
  // animateContentSize(dampingRatio = .88, stiffness = 380). Give it to the
  // browser as one native timeline instead of mutating several layout
  // properties on every requestAnimationFrame. That keeps every visual frame
  // in one layout transaction and makes a reversed collapse the same curve.
  const stiffness = 380;
  const dampingRatio = 0.88;
  const naturalFrequency = Math.sqrt(stiffness);
  const dampedFrequency = naturalFrequency * Math.sqrt(1 - dampingRatio ** 2);
  const sampleCount = 24;
  const responseAt = (elapsedMs) => {
    const seconds = Math.max(0, Math.min(duration, elapsedMs)) / 1000;
    const envelope = Math.exp(-dampingRatio * naturalFrequency * seconds);
    const angle = dampedFrequency * seconds;
    return 1 - envelope * (
      Math.cos(angle)
      + (dampingRatio / Math.sqrt(1 - dampingRatio ** 2)) * Math.sin(angle)
    );
  };
  const settledResponse = responseAt(duration) || 1;
  const interpolate = (from, to, progress) => from + (to - from) * progress;

  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    const progress = Math.max(0, Math.min(1, responseAt(duration * offset) / settledResponse));
    return {
      offset,
      height: `${interpolate(start.height, target.height, progress)}px`,
      marginLeft: `${interpolate(start.marginLeft, target.marginLeft, progress)}px`,
      marginRight: `${interpolate(start.marginRight, target.marginRight, progress)}px`,
      borderRadius: `${interpolate(start.borderRadius, target.borderRadius, progress)}px`,
    };
  });
}

function animateComposerSize(motionStart = {}) {
  const wrapper = inputArea?.querySelector?.(".input-wrapper");
  if (!wrapper) return;
  composerSizeAnimationCleanup?.();
  composerSizeAnimationCleanup = null;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    wrapper.style.height = "";
    wrapper.style.marginLeft = "";
    wrapper.style.marginRight = "";
    wrapper.style.borderRadius = "";
    wrapper.classList.remove("composer-size-animating");
    return;
  }

  // The editor switches between its compact overlay and expanded flow layout
  // at the state boundary. Clip that one reflow, then let a single native
  // animation own every shell dimension. Do not animate child padding, editor
  // caps, or the action rail: those extra JS writes were the visible midpoint
  // hitch in the old implementation. Apply this before measuring the target:
  // otherwise input-row's legacy CSS padding transition reports an in-between
  // height and makes the shell jump when inline animation styles are cleared.
  wrapper.classList.add("composer-size-animating");
  const targetSnapshot = readComposerShellMotionSnapshot(wrapper);
  if (!targetSnapshot) {
    wrapper.classList.remove("composer-size-animating");
    return;
  }
  const startSnapshot = {
    height: composerMotionValue(motionStart.height, targetSnapshot.height),
    marginLeft: composerMotionValue(motionStart.marginLeft, targetSnapshot.marginLeft),
    marginRight: composerMotionValue(motionStart.marginRight, targetSnapshot.marginRight),
    borderRadius: composerMotionValue(motionStart.borderRadius, targetSnapshot.borderRadius),
  };
  const settleDuration = 280;
  wrapper.style.height = `${startSnapshot.height}px`;
  wrapper.style.marginLeft = `${startSnapshot.marginLeft}px`;
  wrapper.style.marginRight = `${startSnapshot.marginRight}px`;
  wrapper.style.borderRadius = `${startSnapshot.borderRadius}px`;

  if (typeof wrapper.animate !== "function") {
    wrapper.style.height = "";
    wrapper.style.marginLeft = "";
    wrapper.style.marginRight = "";
    wrapper.style.borderRadius = "";
    wrapper.classList.remove("composer-size-animating");
    return;
  }

  const animation = wrapper.animate(
    createComposerSpringKeyframes(startSnapshot, targetSnapshot, settleDuration),
    { duration: settleDuration, easing: "linear", fill: "both" },
  );
  let settled = false;
  const finish = ({ cancelled = false } = {}) => {
    if (settled) return;
    settled = true;
    animation.onfinish = null;
    if (!cancelled) {
      // Persist the exact final keyframe for this task turn, then reveal the
      // matching class-driven destination in the same paint transaction.
      animation.commitStyles?.();
    }
    animation.cancel();
    wrapper.style.height = "";
    wrapper.style.marginLeft = "";
    wrapper.style.marginRight = "";
    wrapper.style.borderRadius = "";
    wrapper.classList.remove("composer-size-animating");
    if (composerSizeAnimationCleanup === cancel) composerSizeAnimationCleanup = null;
  };
  const cancel = () => finish({ cancelled: true });
  composerSizeAnimationCleanup = cancel;
  animation.onfinish = () => finish();
}

// The composer has one interaction surface, but several asynchronous owners
// (the editor, run status, and the local send acknowledgement). Keep the
// visual state derived from those existing sources so a slow POST cannot show
// a misleading Send button in the gap before the run is accepted.
function syncComposerPresentation(pendingSend = getComposerPendingSendSnapshot()) {
  if (!inputArea || !sendBtn) return;
  const attachments = typeof getComposerAttachmentsSnapshot === "function"
    ? getComposerAttachmentsSnapshot(currentSessionId)
    : [];
  const hasDraft = !!String(msgInput?.value || "").trim();
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const editorFocused = isComposerEditorFocused();
  const pendingForCurrentSession = isComposerTransportPendingForCurrentSession(pendingSend);
  const collapseLocked = isComposerCollapseLockedForCurrentSession();
  const runActive = inputArea.classList.contains("run-active");
  const configOpen = inputArea.classList.contains("composer-config-open");
  const composerPanelOpen = typeof document !== "undefined"
    && !!document.querySelector?.(composerPanelSelector);
  if (pendingForCurrentSession) {
    // Sending is a closed transaction. The optimistic clear and the pending
    // transport state must not be followed by a focus/IME-driven re-open.
    composerExpandedByInteraction = false;
    if (editorFocused) blurComposerEditorForPendingSend();
  } else if (!collapseLocked && editorFocused) {
    composerExpandedByInteraction = true;
  }
  const expanded = !pendingForCurrentSession
    && !collapseLocked
    && (
      composerExpandedByInteraction
      || editorFocused
      || hasDraft
      || hasAttachments
      || configOpen
      || composerPanelOpen
    );
  // Apply the transport state before measuring the destination geometry. The
  // attachment strip is intentionally removed from the compact pending shell;
  // applying this after animateComposerSize() makes the strip inflate the
  // collapse target and leaves a tall capsule behind.
  inputArea.classList.toggle("composer-send-pending", pendingForCurrentSession);
  const wasExpanded = inputArea.classList.contains("composer-expanded");
  const composerWrapper = inputArea.querySelector?.(".input-wrapper");
  const motionStart = readComposerShellMotionSnapshot(composerWrapper);
  const showSend = !pendingForCurrentSession
    && hasDraftOrAttachments({ hasDraft, hasAttachments })
    && !sendBtn.disabled;

  inputArea.classList.toggle("composer-collapsed", !expanded);
  inputArea.classList.toggle("composer-expanded", expanded);
  syncComposerExpandedOnlyControls(
    expanded,
    { animate: composerPresentationInitialized && wasExpanded !== expanded },
  );
  if (composerPresentationInitialized && wasExpanded !== expanded) {
    animateComposerSize(motionStart);
  }
  composerPresentationInitialized = true;
  if (inputArea.dataset) {
    inputArea.dataset.composerState = pendingForCurrentSession
      ? "sending"
      : runActive
        ? "running"
        : expanded
          ? "expanded"
          : "collapsed";
  }

  sendBtn.classList.toggle("is-visible", showSend);
  sendBtn.setAttribute("aria-hidden", showSend ? "false" : "true");
  sendBtn.tabIndex = showSend ? 0 : -1;
  if (pendingForCurrentSession) sendBtn.setAttribute("aria-busy", "true");
  else sendBtn.removeAttribute("aria-busy");
}

function hasDraftOrAttachments({ hasDraft = false, hasAttachments = false } = {}) {
  return hasDraft || hasAttachments;
}

function composerControlMotionReduced() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function clearComposerControlPresenceTimer(control) {
  const timer = composerControlPresenceTimers.get(control);
  if (timer) window.clearTimeout(timer);
  composerControlPresenceTimers.delete(control);
}

function finishComposerControlPresence(control, expanded) {
  clearComposerControlPresenceTimer(control);
  control.classList.remove("composer-control-entering", "composer-control-exiting");
  control.hidden = !expanded;
  control.inert = !expanded;
  control.setAttribute("aria-hidden", expanded ? "false" : "true");
  control.dataset.composerControlPresence = expanded ? "expanded" : "collapsed";
}

function animateComposerControlPresence(control, expanded, animate) {
  if (!control) return;
  const targetState = expanded ? "expanded" : "collapsed";
  const currentState = control.dataset.composerControlPresence;
  const inFlightState = expanded ? "entering" : "exiting";
  if (currentState === targetState || currentState === inFlightState) {
    if (currentState === inFlightState) {
      // AnimatedVisibility keeps a node present while it is moving, but it
      // must not become a live target until the enter transition settles.
      control.inert = true;
      control.setAttribute("aria-hidden", "true");
    } else {
      control.inert = !expanded;
      control.setAttribute("aria-hidden", expanded ? "false" : "true");
    }
    return;
  }

  clearComposerControlPresenceTimer(control);
  control.hidden = false;
  control.inert = true;
  control.setAttribute("aria-hidden", "true");
  control.classList.remove("composer-control-entering", "composer-control-exiting");

  if (!animate || composerControlMotionReduced()) {
    finishComposerControlPresence(control, expanded);
    return;
  }

  control.dataset.composerControlPresence = expanded ? "entering" : "exiting";
  control.classList.add(expanded ? "composer-control-entering" : "composer-control-exiting");
  const timer = window.setTimeout(() => {
    // A reversed transition owns the node now; the stale timer must not
    // reopen or hide it after the user changes state mid-animation.
    if (control.dataset.composerControlPresence === (expanded ? "entering" : "exiting")) {
      finishComposerControlPresence(control, expanded);
    }
  }, COMPOSER_CONTROL_PRESENCE_DURATION);
  composerControlPresenceTimers.set(control, timer);
}

function syncComposerExpandedOnlyControls(expanded, { animate = false } = {}) {
  if (typeof document === "undefined") return;
  animateComposerControlPresence(
    document.getElementById("composerRuntimeControls"),
    expanded,
    animate,
  );
  animateComposerControlPresence(
    document.getElementById("composerExpandedLeftControls"),
    expanded,
    animate,
  );
}

function syncComposerSendButtonPendingState(pendingSend = getComposerPendingSendSnapshot()) {
  // No spinner on the send button while sending (user preference) — the
  // button stays in its normal state; only the a11y busy flag remains.
  const pendingForCurrentSession = !!(
    pendingSend
    && currentSessionId
    && pendingSend.sessionId === currentSessionId
    && isComposerTransportPending(pendingSend)
  );
  if (pendingForCurrentSession) {
    if (typeof sendBtn.setAttribute === "function") {
      sendBtn.setAttribute("aria-busy", "true");
    }
    syncComposerPresentation(pendingSend);
    return;
  }
  if (typeof sendBtn.removeAttribute === "function") {
    sendBtn.removeAttribute("aria-busy");
  }
  syncComposerPresentation(pendingSend);
}

// The send button stays hidden while the composer has no content (no text and
// no queued attachments); it returns as soon as the user types or attaches a
// file. Session-level enablement (no session / archived) is
// handled by updateStatus, which delegates here.
function syncComposerSendAvailability() {
  if (!sendBtn) return;
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) {
    sendBtn.disabled = true;
    return;
  }
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  const attachments = typeof getComposerAttachmentsSnapshot === "function"
    ? getComposerAttachmentsSnapshot(currentSessionId)
    : [];
  const hasContent = !!String(msgInput?.value || "").trim()
    || (Array.isArray(attachments) && attachments.length > 0);
  sendBtn.disabled = !currentSessionId || session?.archived === true || !hasContent;
  // While a session runs, the corner slot flips between Stop (empty composer)
  // and Send (staged follow-up): queued attachments or a non-empty draft swap
  // Send in without the input being focused — the file picker never focuses
  // the textarea, and auto-focusing would pop the mobile keyboard (user
  // decisions 2026-08-05/2026-08-06, restored from 5197dff).
  if (typeof inputArea?.classList?.toggle === "function") {
    inputArea.classList.toggle("has-attachments", Array.isArray(attachments) && attachments.length > 0);
    // Typed text alone is a staged follow-up that must stay sendable even
    // after the textarea loses focus; textarea focus with an empty composer
    // never reveals Send (user decision 2026-08-06).
    inputArea.classList.toggle("has-draft", !!String(msgInput?.value || "").trim());
    // Stop yields its corner slot to the staged follow-up: recompute Stop's
    // visibility/a11y whenever the content state flips mid-run (input events
    // do not re-enter updateStatus).
    if (typeof syncComposerStopButton === "function") {
      syncComposerStopButton();
    }
  }
  if (typeof syncComposerPresentation === "function") syncComposerPresentation();
}

function getComposerPendingBaselineEventSeq(sessionId = currentSessionId) {
  if (
    typeof renderedEventState === "object"
    && renderedEventState
    && renderedEventState.sessionId === sessionId
    && Number.isInteger(renderedEventState.latestSeq)
    && renderedEventState.latestSeq >= 0
  ) {
    return renderedEventState.latestSeq;
  }
  return 0;
}

function syncComposerPendingUi() {
  const pendingSend = getComposerPendingSendSnapshot();
  const blockingPendingForCurrentSession = isComposerBlockingForSession(currentSessionId);
  msgInput.readOnly = blockingPendingForCurrentSession;

  if (typeof syncComposerPendingTurnFeedback === "function") {
    syncComposerPendingTurnFeedback();
  }
  if (typeof updateStatus === "function" && typeof getCurrentSession === "function") {
    const connectionState = typeof ws !== "undefined"
      && typeof WebSocket !== "undefined"
      && ws
      && ws.readyState !== WebSocket.OPEN
      ? "disconnected"
      : "connected";
    updateStatus(connectionState, getCurrentSession());
  }
  syncComposerSendButtonPendingState(pendingSend);
  if (typeof syncComposerSendAvailability === "function") {
    syncComposerSendAvailability();
  }

  // Keep a busy-session follow-up visible from the first local send frame.
  // renderQueuedMessagePanel merges this pending request with the server
  // queue and later reconciles the same requestId in place when the ACK lands.
  // Idle sends still render their normal local echo and do not create a queue
  // surface.
  if (typeof renderQueuedMessagePanel === "function" && typeof getCurrentSession === "function") {
    renderQueuedMessagePanel(getCurrentSession());
  }

  if (composerPendingState) {
    composerPendingState.textContent = "";
    composerPendingState.classList.remove("visible");
  }
}

function clearComposerAcceptedSendArtifacts(completedSend) {
  if (!completedSend) return false;
  clearDraft(completedSend.sessionId);
  releaseImageObjectUrls(getComposerAttachmentsSnapshot(completedSend.sessionId));
  if (typeof clearComposerSessionState === "function") {
    clearComposerSessionState(completedSend.sessionId, {
      clearDraft: false,
      clearAttachments: true,
    });
  }
  if (currentSessionId === completedSend.sessionId) {
    // The textarea was already cleared optimistically at send time. Only
    // clear again if it still holds the sent text (or is already empty) —
    // never wipe a next-message draft the user started during the
    // round-trip.
    const sentText = typeof completedSend.text === "string"
      ? completedSend.text.trim()
      : "";
    const currentText = msgInput.value.trim();
    if (!currentText || (sentText && currentText === sentText)) {
      msgInput.value = "";
      autoResizeInput();
    }
    if (typeof renderImagePreviews === "function") {
      renderImagePreviews();
    }
  }
  return true;
}

function acknowledgeComposerPendingSend(requestId, options = {}) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (requestId && pendingSend.requestId !== requestId) return false;
  const nextStage = options?.nextStage === "checking" ? "checking" : "processing";
  if (pendingSend.stage === nextStage) {
    syncComposerPendingUi();
    return true;
  }

  clearComposerAcceptedSendArtifacts(pendingSend);
  if (typeof patchComposerPendingSendState === "function") {
    patchComposerPendingSendState({ stage: nextStage });
  }
  syncComposerPendingUi();
  return true;
}

function finalizeComposerPendingSend(requestId) {
  const completedSend = getComposerPendingSendSnapshot();
  if (!completedSend) return false;
  if (requestId && completedSend.requestId !== requestId) return false;

  // If a send finishes without its committed bubble ever rendering (e.g. the
  // queue flushed or a run finished while the events delta was missed), pull a
  // fresh events refresh once so the bubble appears without a manual reload.
  const requestKey = typeof completedSend.requestId === "string" ? completedSend.requestId : "";
  const committedRendered = requestKey
    && typeof findCommittedUserMessageNode === "function"
    && !!findCommittedUserMessageNode(requestKey);
  const echoStillPresent = requestKey
    && typeof findLocalEchoUserMessageNode === "function"
    && !!findLocalEchoUserMessageNode(requestKey);
  const needsCommitRefresh = !committedRendered
    && requestKey
    && !composerFlushRefreshRequestIds.has(requestKey);
  const retainedSend = getComposerRetainedSendSnapshot(requestKey);
  if (committedRendered) {
    clearComposerRetainedSend(requestKey);
  } else if (retainedSend?.localEcho !== false) {
    const ensureEcho = typeof ensureLocalEchoAwaitingCommit === "function"
      ? ensureLocalEchoAwaitingCommit
      : (typeof markLocalEchoAwaitingCommit === "function" ? markLocalEchoAwaitingCommit : null);
    if (ensureEcho) {
      ensureEcho(requestKey);
    } else if (echoStillPresent) {
      patchComposerRetainedSend(requestKey, { awaitingCommit: true, stage: "sent" });
    }
  }
  clearComposerAcceptedSendArtifacts(completedSend);
  clearComposerPendingSendSnapshot(requestId);
  syncComposerPendingUi();
  if (needsCommitRefresh) {
    composerFlushRefreshRequestIds.add(requestKey);
    if (typeof refreshCurrentSession === "function") {
      Promise.resolve(refreshCurrentSession()).catch(() => {});
    }
  }
  return true;
}

// One-shot guard against a missed events delta: finalizing a send whose
// committed bubble never rendered triggers exactly one refresh per requestId.
const composerFlushRefreshRequestIds = new Set();

function createEmptyComposerActivitySnapshot() {
  return {
    run: {
      state: "idle",
      phase: null,
      runId: null,
    },
    queue: {
      state: "idle",
      count: 0,
    },
    planning: {
      state: "idle",
      count: 0,
      requestId: null,
    },
  };
}

function getComposerSessionActivitySnapshot(session) {
  const raw = session?.activity || {};
  const queueCount = Number.isInteger(raw?.queue?.count) ? raw.queue.count : 0;
  return {
    run: {
      state: raw?.run?.state === "running" ? "running" : "idle",
      phase: typeof raw?.run?.phase === "string" ? raw.run.phase : null,
      runId: typeof raw?.run?.runId === "string" ? raw.run.runId : null,
    },
    queue: {
      state: raw?.queue?.state === "queued" && queueCount > 0 ? "queued" : "idle",
      count: queueCount,
    },
    planning: {
      state: raw?.planning?.state === "checking" ? "checking" : "idle",
      count: Number.isInteger(raw?.planning?.count) ? raw.planning.count : 0,
      requestId: typeof raw?.planning?.requestId === "string" ? raw.planning.requestId : null,
    },
  };
}

// A send into a busy session goes straight to the follow-up queue block, so
// the optimistic echo is skipped: no "sending" bubble flashes before the
// server ACKs the queue. Mirrors the server's queue condition (submitHttpMessage:
// active non-terminal run, pending compact, or non-empty follow-up queue) plus
// the planning-checking route that also parks the send.
function composerSendWillQueue(session) {
  if (!session) return false;
  const activity = session.activity || {};
  const runState = String(activity?.run?.state || "").toLowerCase();
  const runPhase = String(activity?.run?.phase || "").toLowerCase();
  const activeRun = !["", "idle", "completed", "failed", "cancelled"].includes(runState)
    || ["accepted", "running", "starting"].includes(runPhase);
  const queueCount = Number.isInteger(activity?.queue?.count) ? activity.queue.count : 0;
  return activeRun
    || queueCount > 0
    || activity?.planning?.state === "checking"
    || activity?.compact?.state === "pending";
}

function hasCanonicalComposerSendAcceptance(session) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (!session?.id || session.id !== pendingSend.sessionId) return false;

  const queuedMessages = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
  if (queuedMessages.some((item) => item?.requestId === pendingSend.requestId)) {
    return true;
  }

  const previousActivity = pendingSend.baselineActivity || createEmptyComposerActivitySnapshot();
  const nextActivity = getComposerSessionActivitySnapshot(session);

  if (
    nextActivity.planning.state === "checking"
    && (!nextActivity.planning.requestId || nextActivity.planning.requestId === pendingSend.requestId)
  ) {
    return true;
  }

  if (
    nextActivity.queue.state === "queued"
    && nextActivity.queue.count > (previousActivity.queue?.count || 0)
  ) {
    return true;
  }

  if (previousActivity.run.state !== "running") {
    if (nextActivity.run.state === "running") return true;
    if (nextActivity.run.phase === "accepted" || nextActivity.run.phase === "running") return true;
    if (nextActivity.run.runId && nextActivity.run.runId !== (previousActivity.run?.runId || null)) {
      return true;
    }
  }

  return false;
}

function isComposerPendingSessionStillActive(session, pendingSend) {
  if (!(pendingSend && session?.id && session.id === pendingSend.sessionId)) {
    return false;
  }

  const queuedMessages = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
  if (queuedMessages.some((item) => item?.requestId === pendingSend.requestId)) {
    return true;
  }

  const nextActivity = getComposerSessionActivitySnapshot(session);
  return (
    nextActivity.planning.state === "checking"
      && (!nextActivity.planning.requestId || nextActivity.planning.requestId === pendingSend.requestId)
  ) || nextActivity.queue.state === "queued"
    || nextActivity.run.state === "running"
    || nextActivity.run.phase === "accepted"
    || nextActivity.run.phase === "running";
}

function isComposerProcessingProgressEvent(event, pendingSend) {
  if (!(pendingSend && pendingSend.stage === "processing")) return false;
  const eventSeq = Number.isInteger(event?.seq) ? event.seq : 0;
  if (eventSeq <= (pendingSend.baselineEventSeq || 0)) return false;
  return !(event?.type === "message" && event.role === "user");
}

// Hard ceiling on how long a send may stay in the "checking" (confirming route)
// stage before the frontend gives up and clears the phantom pending state.
// Covers sends orphaned by a restart/gate or a session stuck planning, which
// otherwise hang the UI on "已发送，正在确认处理方式" with no message actually sent.
const ROUTE_CONFIRMATION_TIMEOUT_MS = 25000;

function reconcileComposerPendingSendWithSession(session) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (!session?.id || session.id !== pendingSend.sessionId) return false;
  const nextActivity = getComposerSessionActivitySnapshot(session);
  if (pendingSend.stage === "checking") {
    if (
      nextActivity.queue.state === "queued"
      || nextActivity.run.state === "running"
      || nextActivity.run.phase === "accepted"
      || nextActivity.run.phase === "running"
    ) {
      return acknowledgeComposerPendingSend(pendingSend.requestId, { nextStage: "processing" });
    }
    // Route-confirmation safety net: if a send has been stuck in "checking"
    // past the timeout (orphaned by a restart/gate, or a session stuck
    // planning), give up and clear the phantom pending state instead of
    // hanging on "已发送，正在确认处理方式" with no real send in flight.
    const routeStartedAtMs = Number.isInteger(pendingSend.startedAt)
      ? pendingSend.startedAt
      : Date.parse(pendingSend.startedAt) || 0;
    if (routeStartedAtMs > 0 && Date.now() - routeStartedAtMs > ROUTE_CONFIRMATION_TIMEOUT_MS) {
      return finalizeComposerPendingSend(pendingSend.requestId);
    }
    if (
      nextActivity.planning.state === "checking"
      && (!nextActivity.planning.requestId || nextActivity.planning.requestId === pendingSend.requestId)
    ) {
      syncComposerPendingUi();
      return false;
    }
    return finalizeComposerPendingSend(pendingSend.requestId);
  }
  if (pendingSend.stage === "processing") {
    if (isComposerPendingSessionStillActive(session, pendingSend)) {
      syncComposerPendingUi();
      return false;
    }
    return finalizeComposerPendingSend(pendingSend.requestId);
  }
  if (!hasCanonicalComposerSendAcceptance(session)) return false;
  return acknowledgeComposerPendingSend(pendingSend.requestId);
}

function reconcileComposerPendingSendWithEvent(event) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (!pendingSend) return false;
  if (pendingSend.stage === "processing") {
    if (!isComposerProcessingProgressEvent(event, pendingSend)) return false;
    return finalizeComposerPendingSend(pendingSend.requestId);
  }
  if (event?.type !== "message" || event.role !== "user") return false;
  if (!event.requestId || event.requestId !== pendingSend.requestId) return false;
  return acknowledgeComposerPendingSend(event.requestId);
}

function getDraftStorageKey(sessionId = currentSessionId) {
  if (!sessionId) return "";
  return `draft_${sessionId}`;
}

function readStoredDraft(sessionId = currentSessionId) {
  const key = getDraftStorageKey(sessionId);
  if (!key) return "";
  const text = localStorage.getItem(key) || "";
  // Clean up whitespace-only drafts created by older composer renders. They
  // are visual placeholders, not text the user should need to backspace.
  if (!text.trim()) {
    localStorage.removeItem(key);
    return "";
  }
  return text;
}

function writeStoredDraft(sessionId = currentSessionId, text = "") {
  if (scheduledDraftSaveTimer) {
    if (!sessionId || scheduledDraftSaveSessionId === sessionId) {
      clearScheduledDraftSaveTimer();
      scheduledDraftSaveSessionId = "";
      scheduledDraftSaveText = "";
    }
  }
  const key = getDraftStorageKey(sessionId);
  const normalizedText = String(text ?? "");
  const draftText = normalizedText.trim() ? normalizedText : "";
  syncComposerDraftState(sessionId, draftText);
  if (!key) return;
  if (draftText) {
    localStorage.setItem(key, draftText);
    return;
  }
  localStorage.removeItem(key);
}

function getComposerDraftText(sessionId = currentSessionId) {
  if (!sessionId) return "";
  if (isComposerBlockingForSession(sessionId)) {
    return getComposerPendingSendSnapshot()?.text || "";
  }
  return typeof getComposerDraftTextState === "function"
    ? getComposerDraftTextState(sessionId)
    : readStoredDraft(sessionId);
}

function resolveComposerRequestId(existingRequestId) {
  if (typeof existingRequestId === "string") {
    const normalizedRequestId = existingRequestId.trim();
    if (normalizedRequestId) {
      return normalizedRequestId;
    }
  }
  return createRequestId();
}

function sendMessage(existingRequestId) {
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) return;
  window.AgentoCMarkdownComposer?.flush?.(msgInput);
  const text = msgInput.value.trim();
  const currentSession = getCurrentSession();
  const queuedImages = getComposerAttachmentsSnapshot(currentSessionId);
  if (hasPendingComposerSend()) return;
  if ((!text && queuedImages.length === 0) || !currentSessionId || currentSession?.archived) return;

  // Android closes the empty shell after its send action. Keep that explicit
  // transition separate from editor focus so an accepted send does not leave
  // an empty expanded composer behind.
  composerExpandedByInteraction = false;

  // Edit-resend mode: the composer holds the edited version of an earlier
  // user message. Sending here REPLACES that message's run (fresh thread,
  // version-rail fold) instead of appending a new message — no local echo,
  // no queue, no draft side effects.
  const pendingEditResend = typeof getComposerPendingEditResend === "function"
    ? getComposerPendingEditResend()
    : null;
  if (pendingEditResend && pendingEditResend.sessionId === currentSessionId) {
    void submitEditResend(pendingEditResend, text, queuedImages);
    return;
  }

  const requestId = resolveComposerRequestId(existingRequestId);
  const sessionId = currentSessionId;
  // Keep the compact shell closed for the complete send transaction. A busy
  // follow-up can be acknowledged as queued/processing before the next
  // refresh or editor focus callback arrives; those callbacks must not reopen
  // the composer between the optimistic send and the user's next action.
  armComposerCollapseLock(sessionId, requestId);
  const sendInteractionMode = typeof isComposerPlanMode === "function" && isComposerPlanMode()
    ? "plan"
    : "agent";
  const sendPlanAction = typeof consumePendingComposerPlanAction === "function"
    ? consumePendingComposerPlanAction()
    : "";
  const sendPlanId = typeof consumePendingComposerPlanId === "function"
    ? consumePendingComposerPlanId()
    : "";

  // A new send supersedes any earlier failed local echo: its in-place
  // retry/discard actions are stale by now and would act on the user's NEW
  // draft. Drop those ghosts (the retry path reuses its own requestId, so it
  // is kept by removeStaleFailedEchoes).
  if (typeof removeStaleFailedEchoes === "function") {
    removeStaleFailedEchoes(requestId);
  }

  if (typeof setComposerPendingSendState === "function") {
    setComposerPendingSendState({
      sessionId,
      requestId,
      text,
      images: queuedImages,
      startedAt: new Date().toISOString(),
      baselineActivity: getComposerSessionActivitySnapshot(currentSession),
      baselineEventSeq: getComposerPendingBaselineEventSeq(sessionId),
      stage: "sending",
    });
  }
  clearDraft(sessionId);
  syncComposerPendingUi();
  // Clear the textarea at send time, not after the server ACK. A multi-line
  // draft collapses the composer right here, in the same synchronous block
  // as the local echo insert and the bottom pin below: the viewport grows
  // while the content lengthens in one unpainted layout pass, so the browser
  // paints once at the new bottom instead of twice (send + ACK) with a
  // visible jump between. restoreFailedSendState refills the text on error;
  // clearComposerAcceptedSendArtifacts only clears a still-untouched
  // composer on ACK, so a draft typed during the round-trip survives.
  msgInput.value = "";
  autoResizeInput();
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  // Optimistic local echo: the user's message appears in the canvas right
  // away with a pending status instead of waiting for the server round-trip.
  // syncComposerPendingTurnFeedback swaps it for the committed node when the
  // server echoes the message back; restoreFailedSendState removes it on error.
  // Busy sessions queue the send instead — the echo is skipped so the bubble
  // never flashes in "sending" before it lands in the queue block.
  const willQueueSend = typeof composerSendWillQueue === "function"
    && composerSendWillQueue(currentSession);
  if (!willQueueSend) {
    retainComposerSendUntilCommit({
      sessionId,
      requestId,
      text,
      images: queuedImages,
      baselineEventSeq: getComposerPendingBaselineEventSeq(sessionId),
      startedAt: new Date().toISOString(),
      stage: "sending",
      localEcho: true,
    });
  }
  if (!willQueueSend && typeof insertComposerLocalEcho === "function") {
    insertComposerLocalEcho({
      requestId,
      text,
      images: queuedImages,
      sessionId,
      baselineEventSeq: getComposerPendingBaselineEventSeq(sessionId),
    });
  }
  // Pin the viewport to the new bottom synchronously (no rAF hop): the echo
  // grew the content while the collapsed composer grew the viewport — both
  // settle in this same frame, so no paint ever shows the intermediate gap.
  // Sending is a fresh user intent: history-prepend restoration must not fight
  // the immediate bottom pin for the next few animation frames.
  if (
    typeof clearMessageViewportAnchorLock === "function"
    && typeof hasActiveMessageViewportAnchorLock === "function"
    && hasActiveMessageViewportAnchorLock()
  ) {
    clearMessageViewportAnchorLock();
  }
  if (willQueueSend && typeof scrollToBottom === "function") {
    scrollToBottom({ immediate: true });
  }

  void (async () => {
    let outboundText = text;
    let outboundImages = queuedImages;
    try {
      // A send carries its complete runtime selection below. Do not let an
      // unrelated, best-effort preferences PATCH delay this user intent: that
      // request may be queued behind slow storage or a transient network
      // round-trip, while the message is already self-contained and durable
      // on its own POST path.
      const sendTool = selectedTool;
      const sendModel = selectedModel;
      const sendReasoningKind = currentToolReasoningKind;
      const sendEffort = selectedEffort;
      const sendServiceTier = typeof selectedServiceTier === "string" ? selectedServiceTier : "standard";
      // Claude Code plan mode is an approval mode: the Plan agent must send
      // permissionMode 'plan' (the composer's stored default, e.g.
      // bypassPermissions, would silently run the turn outside plan mode and no
      // plan approval ever appears). Codex resolves plan mode via
      // interactionMode, so this only applies to the claude families.
      const sendPermissionMode = (sendInteractionMode === "plan"
        && (sendTool === "claude" || sendTool === "claude-bidi"))
        ? "plan"
        : selectedPermissionMode;
      const sendThinking = thinkingEnabled === true;

      if (queuedImages.length > 0) {
        if (typeof patchComposerPendingSendState === "function") {
          patchComposerPendingSendState({ stage: "uploading" });
        }
        patchComposerRetainedSend(requestId, { stage: "uploading" });
        syncComposerPendingUi();
        outboundImages = await prepareComposerAttachmentsForSend(sessionId, queuedImages);
        const pendingSend = getComposerPendingSendSnapshot();
        if (!(pendingSend && pendingSend.requestId === requestId)) return;
        replaceComposerAttachmentsSnapshot(sessionId, outboundImages);
        if (typeof patchComposerPendingSendState === "function") {
          patchComposerPendingSendState({
            images: outboundImages,
            stage: "sending",
          });
        }
        patchComposerRetainedSend(requestId, { images: outboundImages, stage: "sending" });
        syncComposerPendingUi();
        if (typeof renderImagePreviews === "function") {
          renderImagePreviews();
        }
      }

      const msg = {
        action: "send",
        sessionId,
        text: outboundText || "(attachment)",
      };
      msg.requestId = requestId;
      // Carry the active UI language so the server can localize session
      // artifacts (e.g. per-message system prompts) for this conversation.
      if (typeof window.AgentoCI18n?.getActiveUiLanguage === "function") {
        const activeUiLanguage = window.AgentoCI18n.getActiveUiLanguage();
        if (activeUiLanguage) msg.uiLanguage = activeUiLanguage;
      }
      if (!visitorMode) {
        if (sendModel) msg.model = sendModel;
        if ((sendTool === "codex" || sendTool === "codex-cli") && sendServiceTier) {
          msg.serviceTier = sendServiceTier;
        }
        if (sendReasoningKind === "enum") {
          if (sendEffort) msg.effort = sendEffort;
        } else if (sendReasoningKind === "toggle") {
          msg.thinking = sendThinking;
        }
        if (sendPermissionMode) msg.permissionMode = sendPermissionMode;
        msg.interactionMode = sendInteractionMode;
        if (sendPlanAction) msg.planAction = sendPlanAction;
        if (sendPlanId) msg.planId = sendPlanId;
        // Carry the composer agent-picker selection as a per-run override:
        // the next run uses this agent template without rebinding the session
        // (Plan mode is expressed via interactionMode, never as an agent id).
        const pickerAgentId = (typeof inlineAgentSelect !== "undefined"
          && inlineAgentSelect && !inlineAgentSelect.disabled
          && inlineAgentSelect.value && inlineAgentSelect.value !== "__plan")
          ? inlineAgentSelect.value
          : "";
        if (pickerAgentId) msg.agentId = pickerAgentId;
      }
      if (outboundImages.length > 0) {
        msg.images = outboundImages.map((img) => ({
          ...(img.file ? { file: img.file } : {}),
          ...(img.filename ? { filename: img.filename } : {}),
          ...(img.assetId ? { assetId: img.assetId } : {}),
          ...(img.originalName ? { originalName: img.originalName } : {}),
          ...(img.mimeType ? { mimeType: img.mimeType } : {}),
          ...(Number.isFinite(img?.sizeBytes) ? { sizeBytes: img.sizeBytes } : {}),
          ...(img?.renderAs === "file" ? { renderAs: "file" } : {}),
          ...(img.objectUrl ? { objectUrl: img.objectUrl } : {}),
        }));
      }
      if (outboundText.trim() && typeof window.adoptPendingGoalFromMessage === "function") {
        // Goal adoption is useful metadata, but it must not delay the user's
        // message POST. The message itself is already durable independently;
        // a failed background update can be retried from the Goal surface.
        void window.adoptPendingGoalFromMessage(sessionId, outboundText).catch((error) => {
          console.warn("[goal] Background adoption failed:", error?.message || error);
        });
      }
      const ok = await dispatchAction(msg);
      if (ok) return;
    } catch (error) {
      console.error("Composer send failed:", error?.message || error);
      outboundImages = getComposerAttachmentsSnapshot(sessionId);
    }

    const pendingSend = getComposerPendingSendSnapshot();
    const failedText = pendingSend?.requestId === requestId
      ? (pendingSend.text || outboundText || text)
      : (outboundText || text);
    restoreFailedSendState(sessionId, failedText, outboundImages, requestId);
    if (typeof showSystemToast === "function") {
      showSystemToast(t("compose.sendFailed"), "error");
    }
    if (typeof markComposerSendFailed === "function") {
      markComposerSendFailed(sessionId, requestId, {
        text: failedText,
        images: outboundImages,
      });
    }
    if (sendPlanAction && typeof setPendingComposerPlanAction === "function") {
      setPendingComposerPlanAction(sendPlanAction);
    }
    if (sendPlanId && typeof setPendingComposerPlanId === "function") {
      setPendingComposerPlanId(sendPlanId);
    }
  })();
}

// ---- Edit-resend (A1) ----

function getComposerEditResendCancelButtons() {
  if (typeof document === "undefined") return [];
  return [
    document.getElementById?.("composerEditCancelBtn"),
    document.getElementById?.("composerFullscreenEditCancelBtn"),
  ].filter(Boolean);
}

function cancelComposerEditResend() {
  if (typeof clearComposerPendingEditResend === "function") clearComposerPendingEditResend();
  syncComposerEditResendControls();
  if (typeof focusComposer === "function") focusComposer({ force: true });
}

function syncComposerEditResendButton(active) {
  const isActive = active === undefined
    ? !!(typeof getComposerPendingEditResend === "function"
      && getComposerPendingEditResend()?.sessionId === currentSessionId)
    : active === true;
  const updateTitle = isActive ? t("message.editResend.update") : t("action.send");
  const iconName = isActive ? "refresh" : "send";
  const buttons = [
    typeof sendBtn !== "undefined" ? sendBtn : null,
    typeof document !== "undefined" ? document.getElementById?.("composerFullscreenSendBtn") : null,
  ].filter(Boolean);
  for (const button of buttons) {
    button.classList?.toggle?.("is-edit-resend", isActive);
    button.setAttribute?.("data-icon", iconName);
    button.setAttribute?.("data-i18n-title", isActive ? "message.editResend.update" : "action.send");
    button.setAttribute?.("data-i18n-aria-label", isActive ? "message.editResend.update" : "action.send");
    button.setAttribute?.("title", updateTitle);
    button.setAttribute?.("aria-label", updateTitle);

    // The icon factory is already loaded for the static composer. Render the
    // changed icon directly because hydrate() only visits descendants, while
    // these buttons carry data-icon on the button itself.
    const renderer = typeof window !== "undefined" ? window.AgentoCIcons : null;
    if (renderer?.render && button.getAttribute?.("data-rendered-icon") !== iconName) {
      button.innerHTML = renderer.render(iconName);
      button.setAttribute?.("data-rendered-icon", iconName);
    }
  }

  const cancelTitle = t("message.editResend.cancelAria");
  const renderer = typeof window !== "undefined" ? window.AgentoCIcons : null;
  for (const button of getComposerEditResendCancelButtons()) {
    button.classList?.toggle?.("is-visible", isActive);
    button.setAttribute?.("data-icon", "close");
    button.setAttribute?.("data-i18n-title", "message.editResend.cancelAria");
    button.setAttribute?.("data-i18n-aria-label", "message.editResend.cancelAria");
    button.setAttribute?.("title", cancelTitle);
    button.setAttribute?.("aria-label", cancelTitle);
    if (isActive) {
      button.removeAttribute?.("aria-hidden");
      button.setAttribute?.("tabindex", "0");
    } else {
      button.setAttribute?.("aria-hidden", "true");
      button.setAttribute?.("tabindex", "-1");
    }
    if (renderer?.render && button.getAttribute?.("data-rendered-icon") !== "close") {
      button.innerHTML = renderer.render("close");
      button.setAttribute?.("data-rendered-icon", "close");
    }
  }
}

// Edit mode is per-session: its adjacent cancel/update controls hide when the
// user switches away from the session being edited, and return when they come
// back.
function syncComposerEditResendControls() {
  if (typeof document === "undefined") return;
  const wrapper = document.querySelector?.(".input-wrapper");
  if (!wrapper) return;
  const pending = typeof getComposerPendingEditResend === "function"
    ? getComposerPendingEditResend()
    : null;
  const active = pending && pending.sessionId === currentSessionId ? pending : null;
  wrapper.classList?.toggle?.("is-edit-resend", !!active);
  syncComposerEditResendButton(!!active);
}

// The reply being replaced may have run machine operations; re-running them
// on edit needs the same explicit consent as regenerate.
function parentReplyHasToolMarkers(requestId) {
  if (!requestId || typeof messagesInner === "undefined" || !messagesInner) return false;
  const nodes = Array.from(messagesInner.querySelectorAll?.(".msg-assistant[data-request-id]") || []);
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i]?.dataset?.requestId !== requestId) continue;
    if (nodes[i]?.classList?.contains?.("is-live")) continue;
    return typeof assistantReplyHasToolMarkers === "function"
      && assistantReplyHasToolMarkers(nodes[i]);
  }
  return false;
}

async function submitEditResend(pendingEditResend, text, queuedImages) {
  const sessionId = pendingEditResend.sessionId;
  const requestId = pendingEditResend.requestId;
  if (typeof sessionStatus !== "undefined" && sessionStatus === "running") {
    if (typeof showSystemToast === "function") {
      showSystemToast(t("message.regenerate.busy"), "info");
    }
    return;
  }
  try {
    if (parentReplyHasToolMarkers(requestId)) {
      const confirmed = typeof window.confirm === "function"
        && window.confirm(t("message.editResend.confirm"));
      if (!confirmed) return;
    }
    if (typeof setComposerPendingSendState === "function") {
      setComposerPendingSendState({
        sessionId,
        requestId,
        text,
        images: queuedImages,
        startedAt: new Date().toISOString(),
        stage: "sending",
      });
    }
    if (typeof syncComposerPendingUi === "function") syncComposerPendingUi();
    let outboundImages = queuedImages;
    if (queuedImages.length > 0 && typeof prepareComposerAttachmentsForSend === "function") {
      if (typeof patchComposerPendingSendState === "function") {
        patchComposerPendingSendState({ stage: "uploading" });
      }
      if (typeof syncComposerPendingUi === "function") syncComposerPendingUi();
      outboundImages = await prepareComposerAttachmentsForSend(sessionId, queuedImages);
    }
    const body = {
      requestId,
      prompt: text,
      ...(outboundImages.length > 0
        ? {
            attachments: outboundImages.map((img) => ({
              ...(img.filename ? { filename: img.filename } : {}),
              ...(img.assetId ? { assetId: img.assetId } : {}),
              ...(img.originalName ? { originalName: img.originalName } : {}),
              ...(img.mimeType ? { mimeType: img.mimeType } : {}),
              ...(Number.isFinite(img?.sizeBytes) ? { sizeBytes: img.sizeBytes } : {}),
              ...(img?.renderAs === "file" ? { renderAs: "file" } : {}),
            })),
          }
        : {}),
    };
    // Cross-agent resend: carry the composer's current runtime selection
    // (agent picker, tool, model, effort/thinking) as a per-run override, so
    // an edit can re-run under a different agent or model than the original.
    if (typeof visitorMode === "undefined" || !visitorMode) {
      if (typeof selectedTool !== "undefined" && selectedTool) body.tool = selectedTool;
      if (typeof selectedModel !== "undefined" && selectedModel) body.model = selectedModel;
      if ((selectedTool === "codex" || selectedTool === "codex-cli")
        && typeof selectedServiceTier !== "undefined" && selectedServiceTier) {
        body.serviceTier = selectedServiceTier;
      }
      if (typeof currentToolReasoningKind !== "undefined" && currentToolReasoningKind === "enum") {
        if (typeof selectedEffort !== "undefined" && selectedEffort) body.effort = selectedEffort;
      } else if (typeof thinkingEnabled !== "undefined") {
        body.thinking = thinkingEnabled === true;
      }
      const pickerAgentId = (typeof inlineAgentSelect !== "undefined"
        && inlineAgentSelect && !inlineAgentSelect.disabled
        && inlineAgentSelect.value && inlineAgentSelect.value !== "__plan")
        ? inlineAgentSelect.value
        : "";
      if (pickerAgentId) body.agentId = pickerAgentId;
    }
    if (typeof window.AgentoCI18n?.getActiveUiLanguage === "function") {
      const activeUiLanguage = window.AgentoCI18n.getActiveUiLanguage();
      if (activeUiLanguage) body.uiLanguage = activeUiLanguage;
    }
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/resend-edited`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      revalidate: false,
    });
    if (data?.error) throw new Error(data.error);
    // Optimistic bubble patch — the run_regenerate event re-applies it
    // idempotently when it arrives (and again on any later reload).
    if (typeof applyEditedUserMessageContent === "function") {
      applyEditedUserMessageContent(requestId, text, outboundImages);
    }
    if (typeof clearComposerPendingEditResend === "function") clearComposerPendingEditResend();
    syncComposerEditResendControls();
    if (typeof clearDraft === "function") clearDraft(sessionId);
    if (typeof replaceComposerAttachmentsSnapshot === "function") {
      replaceComposerAttachmentsSnapshot(sessionId, []);
    }
    if (typeof renderImagePreviews === "function") renderImagePreviews();
    msgInput.value = "";
    if (typeof autoResizeInput === "function") autoResizeInput();
    if (typeof scrollToBottom === "function") scrollToBottom({});
  } catch (error) {
    console.warn("[edit-resend] Failed:", error?.message || error);
    if (typeof showSystemToast === "function") {
      showSystemToast(t("message.editResend.failed"), "error");
    }
    // Keep the pending edit + composer content so the user can fix and retry.
  } finally {
    if (typeof clearComposerPendingSendState === "function") clearComposerPendingSendState(requestId);
    if (typeof syncComposerPendingUi === "function") syncComposerPendingUi();
  }
}

cancelBtn.addEventListener("click", () => {
  window.AgentoCHaptics?.danger?.();
  dispatchAction({ action: "cancel" });
});

for (const button of getComposerEditResendCancelButtons()) {
  button.addEventListener("click", cancelComposerEditResend);
}

compactBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "compact" });
});

dropToolsBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "drop_tools" });
});

sendBtn.addEventListener("click", () => sendMessage());
function shouldSubmitComposerOnEnter(event) {
  const mobileViewport = window.matchMedia?.("(max-width: 767px)")?.matches === true;
  return event?.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && !mobileViewport;
}

function handleComposerKeydown(e) {
  if (shouldSubmitComposerOnEnter(e)) {
    e.preventDefault();
    sendMessage();
  }
}
msgInput.addEventListener("keydown", handleComposerKeydown);
window.AgentoCMarkdownComposer?.getEditor?.(msgInput)?.addEventListener("keydown", handleComposerKeydown);

// ---- Composer height ----
// Empty composer sits at a single line (user decision: no manual height
// resize anymore); typing auto-grows from there to the cap.
const INPUT_MIN_LINES = 1;
// Desktop/tablet cap from chat-responsive.css (min-width: 768px);
// mobile uses INPUT_AUTO_MAX_LINES_MOBILE instead.
const INPUT_AUTO_MAX_LINES = 8;
// On mobile, auto-grow stops at 5 lines and the
// full-screen composer (composer-fullscreen.js) takes over. Must stay
// aligned with chat-responsive.css `.input-row textarea` max-height.
const INPUT_AUTO_MAX_LINES_MOBILE = 5;
// Breathing room at the auto-grow cap (all breakpoints): Chromium rounds
// textarea scrollHeight down, which would clip the last line's descenders,
// and a bare cap leaves the final line flush against the box edge.
const INPUT_AUTO_MAX_LINES_MOBILE_PAD = 8;

function getInputLineHeight() {
  const editor = window.AgentoCMarkdownComposer?.getEditable?.(msgInput)
    || window.AgentoCMarkdownComposer?.getEditor?.(msgInput)
    || msgInput;
  return parseFloat(getComputedStyle(editor).lineHeight) || 24;
}

function getAutoInputMinH() {
  return getInputLineHeight() * INPUT_MIN_LINES;
}

function getAutoInputMaxH() {
  const mobile = typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 767px)").matches;
  return getInputLineHeight() * (mobile ? INPUT_AUTO_MAX_LINES_MOBILE : INPUT_AUTO_MAX_LINES)
    + INPUT_AUTO_MAX_LINES_MOBILE_PAD;
}

function clampInputHeight(height) {
  const minH = getAutoInputMinH();
  const maxH = Math.max(minH, getAutoInputMaxH());
  return Math.min(Math.max(height, minH), maxH);
}

function autoResizeInput() {
  // Re-evaluate the expand affordance first so its visibility and the
  // textarea height stay in sync for the measurement below.
  window.AgentoCComposerFullscreen?.sync?.();
  const editor = window.AgentoCMarkdownComposer?.getEditable?.(msgInput)
    || window.AgentoCMarkdownComposer?.getEditor?.(msgInput)
    || msgInput;
  // Vditor's editable `pre` is intentionally overflow-visible. The composer
  // shell is the actual scroll owner, so capture it before changing the
  // editable height; Chromium can clamp an ancestor while the content box is
  // temporarily measured at its natural height.
  const scrollContainer = window.AgentoCMarkdownComposer?.getEditor?.(msgInput)
    || editor;
  const previousScrollTop = Number(scrollContainer.scrollTop) || 0;
  const previousMaxScrollTop = Math.max(
    0,
    (Number(scrollContainer.scrollHeight) || 0) - (Number(scrollContainer.clientHeight) || 0),
  );
  // A document can cross the height cap because of soft wrapping while its
  // previous layout still had no scroll range. That does not mean the caret
  // was at the end; preserve the top and let the caret visibility pass move it
  // only when the active line actually needs it.
  const wasAtScrollEnd = previousMaxScrollTop > 0
    && previousMaxScrollTop - previousScrollTop <= 2;
  editor.style.height = "auto";
  const scrollH = editor.scrollHeight;
  const maxH = getAutoInputMaxH();
  // At the cap, use the full capped height instead of the rounded-down
  // scrollHeight: Chromium reports scrollHeight a fraction of a line
  // shorter than the real content, which would clip the last glyphs and
  // leave the final line flush against the box edge.
  const newH = scrollH >= maxH - INPUT_AUTO_MAX_LINES_MOBILE_PAD - 1
    ? maxH
    : clampInputHeight(scrollH);
  // Keep the editable document at its natural height. The adapter stamps the
  // capped height on the shell and leaves the inner document tall enough for
  // the shell's single scroll range.
  editor.style.height = "auto";
  if (editor === msgInput) editor.style.height = newH + "px";
  window.AgentoCMarkdownComposer?.setHeight?.(msgInput, newH);
  const nextMaxScrollTop = Math.max(
    0,
    (Number(scrollContainer.scrollHeight) || 0) - (Number(scrollContainer.clientHeight) || 0),
  );
  scrollContainer.scrollTop = wasAtScrollEnd
    ? nextMaxScrollTop
    : Math.min(previousScrollTop, nextMaxScrollTop);
}

function syncInputHeightForLayout() {
  autoResizeInput();
}

if (window.AgentoCLayout?.subscribe) {
  window.AgentoCLayout.subscribe(() => {
    syncInputHeightForLayout();
  });
} else {
  window.addEventListener("resize", syncInputHeightForLayout);
  window.visualViewport?.addEventListener("resize", syncInputHeightForLayout);
}

// ---- Draft persistence ----
let scheduledDraftSaveTimer = 0;
let scheduledDraftSaveSessionId = "";
let scheduledDraftSaveText = "";

function clearScheduledDraftSaveTimer() {
  if (!scheduledDraftSaveTimer) return;
  const clear = typeof window !== "undefined" && typeof window.clearTimeout === "function"
    ? window.clearTimeout.bind(window)
    : typeof clearTimeout === "function"
      ? clearTimeout
      : null;
  clear?.(scheduledDraftSaveTimer);
  scheduledDraftSaveTimer = 0;
}

function scheduleTimeout(callback, delayMs) {
  const schedule = typeof window !== "undefined" && typeof window.setTimeout === "function"
    ? window.setTimeout.bind(window)
    : typeof setTimeout === "function"
      ? setTimeout
      : null;
  return schedule ? schedule(callback, delayMs) : 0;
}

function saveDraft() {
  if (!currentSessionId || isComposerBlockingForSession(currentSessionId)) return;
  writeStoredDraft(currentSessionId, msgInput.value);
}

function scheduleDraftSave() {
  const sessionId = currentSessionId;
  if (!sessionId || isComposerBlockingForSession(sessionId)) return;
  if (scheduledDraftSaveTimer && scheduledDraftSaveSessionId !== sessionId) {
    // A quick session switch can happen before the debounce window closes.
    // Persist the previous session before replacing the pending slot so its
    // draft cannot be lost when the next session receives input.
    flushScheduledDraftSave();
  } else {
    clearScheduledDraftSaveTimer();
  }
  scheduledDraftSaveSessionId = sessionId;
  scheduledDraftSaveText = msgInput.value;
  // Keep the in-memory composer projection current for send/session logic;
  // defer only the synchronous localStorage write.
  syncComposerDraftState(sessionId, scheduledDraftSaveText);
  scheduledDraftSaveTimer = scheduleTimeout(() => {
    const pendingSessionId = scheduledDraftSaveSessionId;
    const pendingText = scheduledDraftSaveText;
    scheduledDraftSaveTimer = 0;
    scheduledDraftSaveSessionId = "";
    scheduledDraftSaveText = "";
    if (pendingSessionId) writeStoredDraft(pendingSessionId, pendingText);
  }, 240);
  if (!scheduledDraftSaveTimer) {
    const pendingText = scheduledDraftSaveText;
    scheduledDraftSaveSessionId = "";
    scheduledDraftSaveText = "";
    writeStoredDraft(sessionId, pendingText);
  }
}

function flushScheduledDraftSave() {
  clearScheduledDraftSaveTimer();
  const pendingSessionId = scheduledDraftSaveSessionId;
  const pendingText = scheduledDraftSaveText;
  scheduledDraftSaveSessionId = "";
  scheduledDraftSaveText = "";
  if (pendingSessionId) writeStoredDraft(pendingSessionId, pendingText);
}

function flushComposerStateForPageLifecycle() {
  window.AgentoCMarkdownComposer?.flush?.(msgInput);
  flushScheduledDraftSave();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushComposerStateForPageLifecycle);
  window.addEventListener("beforeunload", flushComposerStateForPageLifecycle);
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushComposerStateForPageLifecycle();
  });
}

function restoreDraft() {
  // A session switch starts a fresh interaction surface. Draft content or an
  // open picker may expand it again through the derived presentation state.
  if (composerCollapseLockSessionId !== currentSessionId) {
    releaseComposerCollapseLock();
  }
  composerExpandedByInteraction = false;
  if (typeof setComposerActiveSession === "function") {
    setComposerActiveSession(currentSessionId);
  }
  syncComposerDraftState(currentSessionId, readStoredDraft(currentSessionId));
  msgInput.value = getComposerDraftText(currentSessionId);
  autoResizeInput();
  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }
  syncComposerPendingUi();
}
function clearDraft(sessionId = currentSessionId) {
  writeStoredDraft(sessionId, "");
}

// Composer focus means the textarea is focused — nothing else. Clicking the
// + button, model selector, or send button keeps their own focus visuals and
// must not light up the whole composer ring (user decision 2026-08-05).
// The CSS contract lives on body.composer-input-focused (chat-input.css /
// chat-glass.css) instead of :focus-within so sibling controls never match.
function syncComposerInputFocus() {
  if (typeof document === "undefined" || !document.body) return;
  const pendingForCurrentSession = typeof isComposerTransportPendingForCurrentSession === "function"
    && isComposerTransportPendingForCurrentSession();
  const collapseLocked = typeof isComposerCollapseLockedForCurrentSession === "function"
    && isComposerCollapseLockedForCurrentSession();
  const markdownEditorFocused = typeof window !== "undefined"
    && window.AgentoCMarkdownComposer?.isEditorFocused?.(msgInput) === true;
  if (!pendingForCurrentSession && !collapseLocked && (markdownEditorFocused || document.activeElement === msgInput)) {
    composerExpandedByInteraction = true;
  }
  document.body.classList.toggle(
    "composer-input-focused",
    !pendingForCurrentSession
      && !collapseLocked
      && (markdownEditorFocused || document.activeElement === msgInput),
  );
  if (typeof syncComposerPresentation === "function") syncComposerPresentation();
}
if (typeof msgInput?.addEventListener === "function") {
  msgInput.addEventListener("focus", syncComposerInputFocus);
  msgInput.addEventListener("blur", syncComposerInputFocus);
}
// In the compact state the visible editor is only one line tall, while the
// action row owns the lower part of the capsule. Make the whole empty input
// surface an affordance for opening the composer, but leave every explicit
// control (plus, runtime/model, send, and menu items) to its own handler.
const composerInputArea = typeof inputArea !== "undefined"
  ? inputArea
  : document.getElementById("inputArea");
function isVisibleComposerControl(control) {
  if (!control || control.hidden) return false;
  let node = control;
  while (node) {
    if (node.hidden) return false;
    const style = typeof window !== "undefined" && window.getComputedStyle
      ? window.getComputedStyle(node)
      : null;
    if (style?.display === "none"
      || style?.visibility === "hidden"
      || style?.pointerEvents === "none") return false;
    if (node === composerInputArea) break;
    node = node.parentElement;
  }
  return true;
}
function focusComposerFromShell(event) {
  const target = event?.target;
  if (!target?.closest) return;
  if (!composerInputArea?.classList?.contains("composer-collapsed")) return;
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) return;
  if (typeof isComposerTransportPendingForCurrentSession === "function"
    && isComposerTransportPendingForCurrentSession()) return;
  const explicitControl = target.closest(
    "button, a, input, textarea, select, summary, [role=\"button\"], [contenteditable=\"true\"], "
      + ".composer-add-menu, .composer-add-panel, .composer-runtime-menu, .composer-permission-menu"
  );
  // Hidden runtime controls can still be the closest DOM ancestor when the
  // pointer lands in the right action-row hit area. Only a genuinely visible
  // control owns the tap; every other point in the compact capsule expands it.
  if (isVisibleComposerControl(explicitControl)) return;

  const editable = window.AgentoCMarkdownComposer?.getEditable?.(msgInput)
    || window.AgentoCMarkdownComposer?.getEditor?.(msgInput);
  const blocked = !editable
    || editable.getAttribute?.("contenteditable") === "false"
    || editable.closest?.(".is-disabled");
  if (blocked) {
    releaseComposerCollapseLock();
    if (typeof focusComposer === "function") focusComposer({ force: true });
    return;
  }

  releaseComposerCollapseLock();
  composerExpandedByInteraction = true;
  event.preventDefault();
  try {
    editable.focus({ preventScroll: true });
  } catch {
    editable.focus();
  }
  // A tap on the capsule chrome has no caret coordinate; put the insertion
  // point at the end just as Android does when opening its compact composer.
  try {
    const selection = window.getSelection?.();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // Focus is still useful if the browser does not expose a selection API.
  }
}
function preserveComposerExpansionForPanel(event) {
  const target = event?.target;
  if (!target?.closest) return;
  const panelControl = target.closest(composerPanelInteractionSelector);
  if (!isVisibleComposerControl(panelControl)) return;
  // pointerdown runs before the editor blur that the control causes. Lock the
  // interaction state here so opening a portaled menu cannot be preceded by a
  // stale blur-driven collapse.
  releaseComposerCollapseLock();
  composerExpandedByInteraction = true;
  if (typeof syncComposerPresentation === "function") syncComposerPresentation();
}
if (composerInputArea?.addEventListener) {
  composerInputArea.addEventListener("pointerdown", focusComposerFromShell);
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  function collapseComposerFromOutside(event) {
    const target = event?.target;
    if (!composerInputArea?.classList?.contains("composer-expanded") || !target?.closest) return;
    if (target.closest(
      ".input-area, .composer-add-menu, .composer-add-panel, .composer-runtime-menu, "
        + ".composer-permission-menu, .composer-config-backdrop, .composer-fullscreen"
    )) return;
    composerExpandedByInteraction = false;
    const editable = window.AgentoCMarkdownComposer?.getEditable?.(msgInput)
      || window.AgentoCMarkdownComposer?.getEditor?.(msgInput);
    editable?.blur?.();
    if (document.activeElement === msgInput) msgInput.blur?.();
    syncComposerInputFocus();
  }
  document.addEventListener("focusin", syncComposerInputFocus);
  // This listener is capture-phase because add/runtime panels may be portaled
  // out of .input-area to document.body for viewport-safe positioning.
  document.addEventListener("pointerdown", preserveComposerExpansionForPanel, true);
  document.addEventListener("click", collapseComposerFromOutside);
  document.addEventListener("focusout", () => {
    window.setTimeout(syncComposerInputFocus, 0);
  });
}

let composerInputEffectFrame = 0;

function scheduleComposerInputEffects() {
  if (composerInputEffectFrame) return;
  const run = () => {
    composerInputEffectFrame = 0;
    autoResizeInput();
    syncComposerSendAvailability();
    syncComposerInputFocus();
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    composerInputEffectFrame = window.requestAnimationFrame(run);
  } else if (typeof requestAnimationFrame === "function") {
    composerInputEffectFrame = requestAnimationFrame(run);
  } else if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    composerInputEffectFrame = window.setTimeout(run, 0);
  } else {
    run();
  }
}

msgInput.addEventListener("input", () => {
  if (typeof isComposerTransportPendingForCurrentSession !== "function"
    || !isComposerTransportPendingForCurrentSession()) {
    // An input event is an explicit new composer interaction. It is the
    // deliberate way out of the post-send collapse lock; refresh/focus/ACK
    // callbacks never release it on their own.
    releaseComposerCollapseLock();
  }
  scheduleDraftSave();
  scheduleComposerInputEffects();
});
// Set initial height
requestAnimationFrame(() => {
  autoResizeInput();
  syncComposerPresentation();
});

function releaseImageObjectUrls(images = []) {
  for (const image of images) {
    if (image?.objectUrl) {
      URL.revokeObjectURL(image.objectUrl);
    }
  }
}

function restoreFailedSendState(sessionId, text, images, requestId = "", forceRefill = false) {
  const pendingSend = getComposerPendingSendSnapshot();
  if (pendingSend && (!requestId || pendingSend.requestId === requestId)) {
    clearComposerPendingSendSnapshot(requestId);
  }
  if (requestId) {
    clearComposerRetainedSend(requestId);
  }
  if (typeof removeAssistantPendingNode === "function") {
    removeAssistantPendingNode({ immediate: true });
  }
  releaseComposerCollapseLock(requestId);
  writeStoredDraft(sessionId, text || "");
  replaceComposerAttachmentsSnapshot(sessionId, images);
  syncComposerPendingUi();
  if (sessionId !== currentSessionId) {
    return;
  }

  // forceRefill is used by in-place retry/edit: the composer is restored to
  // the ORIGINAL failed message even if the user typed something else since
  // the failure — the recovery action must act on the failed message, not on
  // whatever happens to be in the input now.
  if ((forceRefill || !msgInput.value.trim()) && text) {
    msgInput.value = text;
    autoResizeInput();
    saveDraft();
  }

  if (typeof renderImagePreviews === "function") {
    renderImagePreviews();
  }

  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: true });
  } else {
    msgInput.focus();
  }
}

// ---- Sidebar tabs ----
let activeTab = normalizeSidebarTab(
  (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "") ||
    pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "agents" | "settings" | "model-providers" | "harnesses" | "account-policy"

if (typeof setChatActiveTab === "function") {
  setChatActiveTab(activeTab, {
    normalizeTab: normalizeSidebarTab,
  });
  activeTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : activeTab;
} else if (typeof dispatchChatStore === "function") {
  dispatchChatStore({
    type: "set-active-tab",
    value: activeTab,
    normalizeTab: normalizeSidebarTab,
  });
}

function restartSidebarSurfaceAnimation(el) {
  if (!el?.classList?.add || !el.classList?.remove) return;
  el.classList.remove("sidebar-surface-enter");
  // Force style recalc so repeated tab visits replay the same entry motion.
  void el.offsetWidth;
  el.classList.add("sidebar-surface-enter");
}

function syncSidebarTabChrome(tab) {
  const normalizedTab = normalizeSidebarTab(tab);
  const resolvedSidebar = typeof sidebar !== "undefined" ? sidebar : null;
  const resolvedSidebarOverlay = typeof sidebarOverlay !== "undefined" ? sidebarOverlay : null;
  if (resolvedSidebar?.dataset) {
    resolvedSidebar.dataset.activeTab = normalizedTab;
  }
  if (resolvedSidebarOverlay?.dataset) {
    resolvedSidebarOverlay.dataset.activeTab = normalizedTab;
  }
  if (typeof syncSidebarShellState === "function") {
    syncSidebarShellState(normalizedTab);
  }
}

function switchTab(tab, { syncState = true, animate = true } = {}) {
  const resolvedTabSessions = typeof tabSessions !== "undefined" ? tabSessions : null;
  const resolvedTabAgents = typeof tabAgents !== "undefined" ? tabAgents : null;
  const resolvedSessionList = typeof sessionList !== "undefined" ? sessionList : null;
  const resolvedSidebarSearch = typeof sidebarSearch !== "undefined" ? sidebarSearch : null;
  const resolvedAgentsPanel = typeof agentsPanel !== "undefined" ? agentsPanel : null;
  const resolvedSettingsPanel = typeof settingsPanel !== "undefined" ? settingsPanel : null;
  const resolvedModelProvidersPanel = typeof modelProvidersPanel !== "undefined" ? modelProvidersPanel : null;
  const resolvedHarnessesPanel = typeof harnessesPanel !== "undefined" ? harnessesPanel : null;
  const resolvedAccountPolicyPanel = document.getElementById("accountPolicyPanel");
  const resolvedSortSessionListBtn = typeof sortSessionListBtn !== "undefined" ? sortSessionListBtn : null;
  const resolvedNewSessionBtn = typeof newSessionBtn !== "undefined" ? newSessionBtn : null;
  const nextTab = normalizeSidebarTab(tab);
  if (typeof setChatActiveTab === "function") {
    setChatActiveTab(nextTab, {
      normalizeTab: normalizeSidebarTab,
    });
    activeTab = typeof getActiveSidebarTabValue === "function"
      ? getActiveSidebarTabValue()
      : nextTab;
  } else {
    activeTab = nextTab;
    if (typeof dispatchChatStore === "function") {
      dispatchChatStore({
        type: "set-active-tab",
        value: activeTab,
        normalizeTab: normalizeSidebarTab,
      });
    }
  }
  const showingSessions = activeTab === "sessions";
  const showingAgents = activeTab === "agents";
  const showingSettings = activeTab === "settings";
  const showingModelProviders = activeTab === "model-providers";
  const showingHarnesses = activeTab === "harnesses";
  const showingAccountPolicy = activeTab === "account-policy";
  syncSidebarTabChrome(activeTab);
  if (resolvedTabSessions) {
    resolvedTabSessions.classList.toggle("active", activeTab === "sessions");
  }
  if (resolvedTabAgents) {
    resolvedTabAgents.classList.toggle("active", activeTab === "agents");
  }
  if (resolvedSessionList) resolvedSessionList.style.display = showingSessions ? "" : "none";
  if (resolvedSidebarSearch) resolvedSidebarSearch.style.display = showingSessions ? "" : "none";
  if (resolvedAgentsPanel) resolvedAgentsPanel.classList.toggle("visible", showingAgents);
  if (resolvedSettingsPanel) resolvedSettingsPanel.classList.toggle("visible", showingSettings);
  if (resolvedModelProvidersPanel) {
    resolvedModelProvidersPanel.classList.toggle("visible", showingModelProviders);
    resolvedModelProvidersPanel.hidden = !showingModelProviders;
  }
  if (resolvedHarnessesPanel) {
    resolvedHarnessesPanel.classList.toggle("visible", showingHarnesses);
    resolvedHarnessesPanel.hidden = !showingHarnesses;
  }
  if (resolvedAccountPolicyPanel) {
    resolvedAccountPolicyPanel.classList.toggle("visible", showingAccountPolicy);
    resolvedAccountPolicyPanel.hidden = !showingAccountPolicy;
  }
  if (resolvedSortSessionListBtn) resolvedSortSessionListBtn.classList.toggle("hidden", !showingSessions);
  if (resolvedNewSessionBtn) resolvedNewSessionBtn.classList.toggle("hidden", !showingSessions);
  if (animate && showingSessions) {
    restartSidebarSurfaceAnimation(resolvedSidebarSearch);
    restartSidebarSurfaceAnimation(resolvedSessionList);
  }
  if (syncState) {
    syncBrowserState();
  }
}

if (typeof tabSessions !== "undefined" && tabSessions) {
  tabSessions.addEventListener("click", () => switchTab("sessions"));
}
if (typeof tabAgents !== "undefined" && tabAgents) {
  tabAgents.addEventListener("click", () => switchTab("agents"));
}

switchTab(activeTab, { syncState: false });

// ---- Message rendering ----
function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

// ---- Typewriter streaming state ----
let streamingMessageEl = null;
let streamingTextContent = "";
let streamingPendingTokens = [];
let streamingAnimFrame = null;
let streamingFinalizeCallback = null;
let streamingLastRenderAt = 0;
let streamingMarkdownRenderWarned = false;
let streamingMarkdownMode = false;
let streamingBlockStableEnd = 0;
let streamingBlockPrefixNode = null;
let streamingBlockSuffixNode = null;
let streamingPlainFrontier = null;
let streamingRevealProgress = 0;
let streamingLastPumpAt = 0;
let streamingRateTokensPerSec = 0;
let streamingArrivalRateTokensPerSec = 0;
let streamingArrivedSinceLastPump = 0;
let streamingPreviewTruncated = false;
// Adaptive reveal pacing. The typewriter spends a wall-clock budget per frame
// instead of a fixed glyph count, and its rate tracks the measured provider
// throughput: a slow stream keeps the readable per-frame floor, while a burst
// or backlog accelerates along a bounded ramp (never an instant jump) so it
// drains within a bounded window instead of typing long after the run ended.
const STREAM_FLOOR_TOKENS_PER_FRAME = 1;
// A backlog is allowed to catch up, but never as a large visible jump. The
// cap is deliberately small: a display frame should feel like a continuous
// stream, not like a provider flush being painted in batches.
const STREAM_MAX_VISIBLE_TOKENS_PER_FRAME = 6;
const STREAM_CATCH_UP_DRAIN_SECONDS = 1.2;
const STREAM_MAX_RATE_TOKENS_PER_SEC = 360;
const STREAM_RATE_RISE_TAU_MS = 220;
const STREAM_RATE_FALL_TAU_MS = 480;
const STREAM_MAX_FRAME_DELTA_MS = 120;
const STREAM_ARRIVAL_TAU_MS = 450;
const STREAM_MARKDOWN_RENDER_INTERVAL_MS = 33;
const STREAMING_STICKY_BOTTOM_THRESHOLD_PX = 32;
const EVENT_RENDER_STICKY_BOTTOM_THRESHOLD_PX = 120;
// Streaming attach/detach hysteresis for the transcript viewport. Attach is
// deliberately generous because touch flings and momentum scrolls almost
// never land exactly on the bottom edge; between the two thresholds the
// previous decision stands so a jittering position cannot flap the flag.
const STREAMING_ATTACH_BOTTOM_DISTANCE_PX = 96;
const STREAMING_DETACH_BOTTOM_DISTANCE_PX = EVENT_RENDER_STICKY_BOTTOM_THRESHOLD_PX;
const SCROLL_GUARD_EPSILON_PX = 2;
const SCROLL_TO_BOTTOM_ANIMATION_MIN_MS = 180;
const SCROLL_TO_BOTTOM_ANIMATION_MAX_MS = 320;
// A live response is a preview until the authoritative timeline event lands.
// Keep both tokenization and DOM/Markdown work bounded for pathological
// provider output; the final message still renders from the durable payload.
const STREAM_MAX_PENDING_TOKENS = 50_000;
const STREAM_MAX_INPUT_CHARS_PER_APPEND = 128_000;
const STREAM_MAX_VISIBLE_CHARS = 512_000;
// A complete assistant message can arrive in one WS/HTTP event after a
// provider-side flush. Live text, whether it arrived as a provider delta or a
// complete message, must pass through the same presentation queue. This is
// deliberately a frontend effect; history replays never opt into it, and
// reduced-motion users keep the instant render.

// Typewriter pacing is display-grapheme based. ChatGPT-style synthetic streams
// reveal one visible character at a time, including CJK and emoji clusters, so
// a server-flushed paragraph never pops in as a whole. The latest visible
// grapheme is marked as a quiet tail until the following grapheme arrives.
const STREAM_MARKDOWN_TRIGGER_RE = /(?:`|\*\*|__|~~|!\[|]\(|\||^#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*>\s?|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$|<[a-z/][^>]*>)/mi;

function hasMarkdownSignificantSyntax(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return STREAM_MARKDOWN_TRIGGER_RE.test(text);
}

function tokenizeStreamingText(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return [];
  let tokens = [];
  try {
    if (typeof Intl?.Segmenter === "function") {
      tokens = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), ({ segment }) => segment)
        .filter(Boolean);
    }
  } catch { /* Fall through to the portable tokenizer. */ }
  if (tokens.length === 0) {
    tokens = Array.from(text);
  }
  return tokens;
}

function takeStreamingTokens(tokensLimit) {
  return streamingPendingTokens.splice(0, Math.max(1, tokensLimit)).join("");
}

function appendStreamingVisibleText(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return;
  const remaining = Math.max(0, STREAM_MAX_VISIBLE_CHARS - streamingTextContent.length);
  if (remaining <= 0) {
    streamingPreviewTruncated = true;
    return;
  }
  if (text.length > remaining) streamingPreviewTruncated = true;
  streamingTextContent += text.slice(0, remaining);
}

function enqueueStreamingTokens(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return 0;
  const remaining = Math.max(0, STREAM_MAX_PENDING_TOKENS - streamingPendingTokens.length);
  if (remaining <= 0) {
    streamingPreviewTruncated = true;
    return 0;
  }
  // Avoid allocating a full grapheme array for a giant provider flush when
  // the preview queue can only retain a bounded prefix anyway.
  const source = text.length > STREAM_MAX_INPUT_CHARS_PER_APPEND
    ? text.slice(0, STREAM_MAX_INPUT_CHARS_PER_APPEND)
    : text;
  if (source.length < text.length) streamingPreviewTruncated = true;
  const tokens = tokenizeStreamingText(source);
  const retained = tokens.length > remaining ? tokens.slice(0, remaining) : tokens;
  if (retained.length < tokens.length) streamingPreviewTruncated = true;
  streamingPendingTokens.push(...retained);
  return retained.length;
}

function setStreamingPendingText(value) {
  streamingPendingTokens = [];
  enqueueStreamingTokens(value);
}

function streamingPreviewText() {
  const text = formatDecodedDisplayText(streamingTextContent);
  return streamingPreviewTruncated
    ? `${text}\n\n[…实时预览已截断，最终消息将补全…]`
    : text;
}

function resetStreamingPacingState() {
  streamingRevealProgress = 0;
  streamingLastPumpAt = 0;
  streamingRateTokensPerSec = 0;
  streamingArrivalRateTokensPerSec = 0;
  streamingArrivedSinceLastPump = 0;
  // Deliberately does NOT touch streamingUserScrollDetached: this runs at
  // every inter-chunk drain (pump early-return) and on presentation cancel
  // from timeline rebuilds, so clearing user scroll intent here would
  // silently re-attach mid-turn and kill the dock anchor / bottom follow for
  // the rest of the turn. The flag is cleared only at real turn boundaries:
  // a new streaming bubble (getOrCreateStreamingMessage), a transcript reset
  // (clearMessages), the FAB click, or a near-bottom scroll (attach).
  if (_scrollToBottomFabEl?.classList) {
    _scrollToBottomFabEl.classList.remove("is-streaming-unread");
  }
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function getMessagesBottomDistance() {
  if (!messagesEl) return Number.POSITIVE_INFINITY;
  const scrollHeight = Number(messagesEl.scrollHeight) || 0;
  const scrollTop = Number(messagesEl.scrollTop) || 0;
  const clientHeight = Number(messagesEl.clientHeight) || 0;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

let _scrollToBottomAnimation = null;

function cancelScrollToBottomAnimation() {
  const animation = _scrollToBottomAnimation;
  if (!animation) return false;
  if (animation.frame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(animation.frame);
  }
  _scrollToBottomAnimation = null;
  return true;
}

function prefersReducedScrollMotion() {
  try {
    return typeof window?.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function animateMessagesToBottom({ sessionId = currentSessionId } = {}) {
  if (!messagesEl || currentSessionId !== sessionId) return false;
  cancelScrollToBottomAnimation();

  const startTop = Number(messagesEl.scrollTop) || 0;
  const targetTop = Math.max(
    0,
    (Number(messagesEl.scrollHeight) || 0) - (Number(messagesEl.clientHeight) || 0),
  );
  const distance = targetTop - startTop;
  if (distance <= SCROLL_GUARD_EPSILON_PX || prefersReducedScrollMotion()) {
    if (typeof markMessageViewportProgrammaticScroll === "function") {
      markMessageViewportProgrammaticScroll();
    }
    messagesEl.scrollTop = targetTop;
    if (typeof syncMessageViewportStabilitySnapshot === "function") {
      syncMessageViewportStabilitySnapshot();
    }
    return false;
  }

  const duration = Math.min(
    SCROLL_TO_BOTTOM_ANIMATION_MAX_MS,
    Math.max(SCROLL_TO_BOTTOM_ANIMATION_MIN_MS, 160 + distance * 0.08),
  );
  const animation = {
    sessionId,
    startTop,
    targetTop,
    duration,
    startedAt: nowMs(),
    frame: 0,
  };
  _scrollToBottomAnimation = animation;

  const step = (frameTime) => {
    if (_scrollToBottomAnimation !== animation) return;
    if (currentSessionId !== sessionId) {
      _scrollToBottomAnimation = null;
      return;
    }
    const timestamp = Number.isFinite(frameTime) ? frameTime : nowMs();
    const progress = Math.min(1, Math.max(0, (timestamp - animation.startedAt) / animation.duration));
    // Cubic ease-out: quick response at the thumb, then a quiet arrival at
    // the latest message without a bounce or an overshoot.
    const eased = 1 - ((1 - progress) ** 3);
    if (typeof markMessageViewportProgrammaticScroll === "function") {
      markMessageViewportProgrammaticScroll();
    }
    messagesEl.scrollTop = animation.startTop + (animation.targetTop - animation.startTop) * eased;
    if (typeof syncMessageViewportStabilitySnapshot === "function") {
      syncMessageViewportStabilitySnapshot();
    }
    if (progress >= 1) {
      messagesEl.scrollTop = animation.targetTop;
      _scrollToBottomAnimation = null;
      animation.frame = 0;
      if (typeof syncMessageViewportStabilitySnapshot === "function") {
        syncMessageViewportStabilitySnapshot();
      }
      return;
    }
    animation.frame = requestAnimationFrame(step);
  };

  animation.frame = requestAnimationFrame(step);
  return true;
}

function shouldAutoScrollMessages(thresholdPx = EVENT_RENDER_STICKY_BOTTOM_THRESHOLD_PX) {
  return getMessagesBottomDistance() < thresholdPx;
}

// Block-level incremental streaming: the accumulated markdown is split at
// blank-line boundaries (never inside an open code fence); completed blocks
// are rendered once into a stable prefix, and only the trailing incomplete
// block is re-parsed per frame. Math ($) and plan tags fall back to the full
// per-frame render to stay correct.
function computeStreamingBlockSplit(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const lines = text.split("\n");
  let inFence = false;
  let fenceMarker = "";
  let stableEnd = 0;
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextOffset = offset + line.length + 1;
    const trimmed = line.trim();
    if (!inFence) {
      const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
      if (fenceMatch) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (trimmed === "") {
        stableEnd = nextOffset;
      }
    } else if (
      trimmed.length >= fenceMarker.length
      && trimmed.startsWith(fenceMarker[0])
      && trimmed.replace(/[`~]/g, "").length === 0
    ) {
      inFence = false;
    }
    offset = nextOffset;
  }
  return Math.min(stableEnd, text.length);
}

function canUseStreamingBlockRender(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  // Math spans blocks and plan tags are rendered whole-document — keep the
  // full per-frame render for those so nothing breaks mid-stream.
  if (text.includes("$")) return false;
  if (/<proposed_plan\b/i.test(text)) return false;
  return true;
}

function renderCompletedStreamingBlocks(prefixNode, blockText) {
  if (!prefixNode || typeof blockText !== "string" || !blockText.trim()) return;
  const segment = document.createElement("div");
  segment.className = "streaming-block-segment";
  if (typeof renderMarkdownFragmentIntoNode === "function"
    && renderMarkdownFragmentIntoNode(segment, blockText, { deferEnhance: true })) {
    prefixNode.appendChild(segment);
    return;
  }
  segment.textContent = blockText;
  prefixNode.appendChild(segment);
}

function renderStreamingBlocks(body, text) {
  if (!body) return false;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  if (typeof renderMarkdownFragmentIntoNode !== "function") return false;
  if (!streamingBlockPrefixNode || streamingBlockPrefixNode.parentNode !== body) {
    // First block render takes over the body: drop any content rendered by
    // the pre-block full path so prefix + suffix are the only children.
    streamingBlockPrefixNode = document.createElement("div");
    streamingBlockPrefixNode.className = "streaming-blocks-prefix";
    body.textContent = "";
    streamingPlainFrontier = null;
    body.appendChild(streamingBlockPrefixNode);
  }
  if (!streamingBlockSuffixNode || streamingBlockSuffixNode.parentNode !== body) {
    streamingBlockSuffixNode = document.createElement("div");
    streamingBlockSuffixNode.className = "streaming-blocks-suffix";
    body.appendChild(streamingBlockSuffixNode);
  }
  const stableEnd = computeStreamingBlockSplit(text);
  if (stableEnd > streamingBlockStableEnd) {
    renderCompletedStreamingBlocks(streamingBlockPrefixNode, text.slice(streamingBlockStableEnd, stableEnd));
    streamingBlockStableEnd = stableEnd;
  }
  const suffix = text.slice(stableEnd);
  if (suffix) {
    renderMarkdownFragmentIntoNode(streamingBlockSuffixNode, suffix, { deferEnhance: true });
  } else {
    streamingBlockSuffixNode.textContent = "";
  }
  return true;
}

function getStreamingCaretAnchor(body) {
  try {
    let node = (streamingBlockSuffixNode && streamingBlockSuffixNode.parentNode === body)
      ? streamingBlockSuffixNode
      : body;
    for (let depth = 0; depth < 6; depth += 1) {
      const children = Array.from(node.children || []);
      const last = children[children.length - 1];
      if (!last || typeof last.tagName !== "string") return node;
      const tag = last.tagName.toUpperCase();
      if (tag === "P" || tag === "LI" || tag === "BLOCKQUOTE") return last;
      if (tag === "PRE") {
        const code = last.querySelector?.("code") || last;
        return code;
      }
      if (
        tag === "UL" || tag === "OL" || tag === "TABLE" || tag === "TBODY"
        || tag === "THEAD" || tag === "TR" || tag === "TD" || tag === "TH"
        || tag === "DIV" || tag === "SPAN" || tag === "CODE"
      ) {
        node = last;
        continue;
      }
      return node;
    }
  } catch { /* fall through to body */ }
  return body;
}

function ensureStreamingCaret(body) {
  if (!body) return;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return;
  try {
    const anchor = getStreamingCaretAnchor(body);
    const siblings = anchor === body ? body.children : anchor.children;
    const lastChild = siblings ? siblings[siblings.length - 1] : null;
    if (lastChild && typeof lastChild.className === "string" && lastChild.className.includes("streaming-caret")) {
      return;
    }
    const caret = document.createElement("span");
    caret.className = "streaming-caret";
    caret.setAttribute?.("aria-hidden", "true");
    anchor.appendChild(caret);
  } catch { /* caret is progressive enhancement */ }
}

function settlePlainStreamingFrontier(span) {
  if (!span?.parentNode) return;
  try {
    const text = document.createTextNode(span.textContent || "");
    span.parentNode.insertBefore(text, span);
    span.remove();
  } catch { /* progressive enhancement; the span can remain in place */ }
}

// Before Markdown syntax appears, the body is a text node plus the caret.
// Appending the newly revealed graphemes preserves the existing text layout
// instead of replacing body.textContent (and invalidating the whole line box)
// once per animation frame. Markdown promotion still owns the fallback path.
function appendPlainStreamingText(body, value) {
  if (!body || !value) return false;
  if (typeof document === "undefined" || typeof document.createTextNode !== "function") return false;
  try {
    const caret = body.querySelector?.(".streaming-caret") || null;
    // Keep one persistent frontier for the entire plain-text phase. Creating a
    // span and a timer on every display frame caused needless DOM churn and
    // short-lived allocations during long answers. Markdown promotion clears
    // this node in one operation.
    let frontier = streamingPlainFrontier;
    if (!frontier || frontier.parentNode !== body) {
      frontier = document.createElement("span");
      frontier.className = "streaming-text-frontier";
      if (caret) body.insertBefore(frontier, caret);
      else body.appendChild(frontier);
      streamingPlainFrontier = frontier;
    }
    frontier.appendChild(document.createTextNode(value));
    ensureStreamingCaret(body);
    return true;
  } catch { /* fall back to the full renderer */ }
  return false;
}

// Timeline owns the message root, so it cannot use the legacy standalone
// streaming bubble. Apply the same visible frontier treatment to a keyed
// live row: the row stays in place and the caret follows the rendered
// markdown instead of creating another message. The frontier itself is
// expressed by the caret's pulse, not by re-styling the latest grapheme —
// wrapping and unwrapping a text range every frame costs a layout pass per
// token and reads as flicker on long messages.
function decorateStreamingMessageNode(node) {
  if (!node) return false;
  const body = node.querySelector?.(".msg-assistant-body");
  if (!body) return false;
  node.classList?.add("streaming");
  ensureStreamingCaret(body);
  return true;
}

function renderStreamingBody(body, { force = false, full = false } = {}) {
  if (!body) return false;
  const visibleStreamingText = streamingPreviewText();
  const currentTime = nowMs();
  if (!force && streamingLastRenderAt && currentTime - streamingLastRenderAt < STREAM_MARKDOWN_RENDER_INTERVAL_MS) {
    return false;
  }
  streamingLastRenderAt = currentTime;
  if (!full && streamingMarkdownMode && canUseStreamingBlockRender(visibleStreamingText)) {
    try {
      if (renderStreamingBlocks(body, visibleStreamingText)) {
        ensureStreamingCaret(body);
        return true;
      }
    } catch (error) {
      if (!streamingMarkdownRenderWarned) {
        console.warn("[streaming] Failed to render markdown blocks incrementally:", error.message);
        streamingMarkdownRenderWarned = true;
      }
    }
  }
  // A full render replaces the body's children, so block-incremental state
  // must reset here or the next block frame would rebuild empty prefix/suffix
  // nodes against a stale stable-end index.
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  streamingPlainFrontier = null;
  if (typeof renderMarkdownIntoNode === "function") {
    try {
      renderMarkdownIntoNode(body, visibleStreamingText, { deferEnhance: true });
      ensureStreamingCaret(body);
      return true;
    } catch (error) {
      if (!streamingMarkdownRenderWarned) {
        console.warn("[streaming] Failed to render markdown incrementally:", error.message);
        streamingMarkdownRenderWarned = true;
      }
    }
  }
  body.textContent = visibleStreamingText;
  ensureStreamingCaret(body);
  return true;
}

function getOrCreateStreamingMessage() {
  if (streamingMessageEl && streamingMessageEl.parentNode === messagesInner) {
    return streamingMessageEl;
  }
  if (inThinkingBlock) finalizeThinkingBlock();
  if (typeof removeAssistantPendingNode === "function") {
    removeAssistantPendingNode({ immediate: true });
  }
  const div = document.createElement("div");
  div.className = "msg-assistant md-content streaming";
  const body = document.createElement("div");
  body.className = "msg-assistant-body";
  div.appendChild(body);
  const spacer = typeof document !== "undefined" ? document.getElementById("turnViewportSpacer") : null;
  if (spacer && spacer.parentNode === messagesInner) {
    messagesInner.insertBefore(div, spacer);
  } else {
    messagesInner.appendChild(div);
  }
  streamingMessageEl = div;
  streamingTextContent = "";
  streamingPendingTokens = [];
  streamingPreviewTruncated = false;
  streamingFinalizeCallback = null;
  streamingLastRenderAt = 0;
  streamingMarkdownRenderWarned = false;
  streamingMarkdownMode = false;
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  streamingPlainFrontier = null;
  // A freshly created streaming bubble is a turn boundary: the previous
  // turn's scroll-detach intent must not leak into the new docked turn.
  streamingUserScrollDetached = false;
  syncScrollToBottomFab();
  resetStreamingPacingState();
  return div;
}

function pumpStreamingAnimation() {
  streamingAnimFrame = null;
  if (!streamingMessageEl || streamingPendingTokens.length === 0) {
    resetStreamingPacingState();
    // Animation complete — if a finalize callback is waiting, run it now
    if (streamingFinalizeCallback) {
      const cb = streamingFinalizeCallback;
      streamingFinalizeCallback = null;
      cb();
    }
    return;
  }
  const body = streamingMessageEl.querySelector(".msg-assistant-body");
  if (!body) return;
  const minScrollTop = Number(messagesEl.scrollTop) || 0;
  const shouldScroll = !streamingUserScrollDetached
    && shouldAutoScrollMessages(STREAMING_STICKY_BOTTOM_THRESHOLD_PX);

  // Reveal budget on the wall clock. The rate tracks the measured arrival
  // throughput and accelerates along a bounded ramp when a backlog builds up,
  // so a provider flush catches up within ~STREAM_CATCH_UP_DRAIN_SECONDS
  // instead of typing long after the run finished. The exponential blends
  // keep rate changes gradual: no burst at the start, no hard stop at the end.
  const reducedMotion = prefersReducedScrollMotion();
  const frameAt = nowMs();
  const elapsedMs = streamingLastPumpAt
    ? Math.min(STREAM_MAX_FRAME_DELTA_MS, Math.max(0, frameAt - streamingLastPumpAt))
    : 0;
  streamingLastPumpAt = frameAt;
  if (!reducedMotion && elapsedMs > 0) {
    if (streamingArrivedSinceLastPump > 0) {
      const sample = Math.min(
        STREAM_MAX_RATE_TOKENS_PER_SEC,
        (streamingArrivedSinceLastPump / elapsedMs) * 1000,
      );
      const arrivalBlend = 1 - Math.exp(-elapsedMs / STREAM_ARRIVAL_TAU_MS);
      streamingArrivalRateTokensPerSec
        += (sample - streamingArrivalRateTokensPerSec) * arrivalBlend;
    }
    const maxAllowedRate = streamingPendingTokens.length > 40
      ? Math.min(720, STREAM_MAX_RATE_TOKENS_PER_SEC * 2)
      : STREAM_MAX_RATE_TOKENS_PER_SEC;
    const targetRate = Math.min(
      maxAllowedRate,
      Math.max(streamingArrivalRateTokensPerSec * 1.08, streamingPendingTokens.length / STREAM_CATCH_UP_DRAIN_SECONDS),
    );
    const rateTau = targetRate >= streamingRateTokensPerSec
      ? STREAM_RATE_RISE_TAU_MS
      : STREAM_RATE_FALL_TAU_MS;
    const rateBlend = 1 - Math.exp(-elapsedMs / rateTau);
    streamingRateTokensPerSec += (targetRate - streamingRateTokensPerSec) * rateBlend;
    streamingRevealProgress += (streamingRateTokensPerSec * elapsedMs) / 1000;
  }
  streamingArrivedSinceLastPump = 0;

  const backlog = streamingPendingTokens.length;
  const dynamicMaxTokensPerFrame = backlog > 40
    ? Math.min(24, Math.max(STREAM_MAX_VISIBLE_TOKENS_PER_FRAME, Math.floor(backlog / 8)))
    : STREAM_MAX_VISIBLE_TOKENS_PER_FRAME;
  const revealCount = reducedMotion
    ? backlog
    : Math.min(
      backlog,
      dynamicMaxTokensPerFrame,
      Math.max(STREAM_FLOOR_TOKENS_PER_FRAME, Math.floor(streamingRevealProgress)),
    );
  streamingRevealProgress = Math.max(0, streamingRevealProgress - revealCount);
  const revealedText = takeStreamingTokens(revealCount);
  appendStreamingVisibleText(revealedText);
  if (!streamingMarkdownMode && hasMarkdownSignificantSyntax(streamingTextContent)) {
    streamingMarkdownMode = true;
  }
  // Markdown re-renders are the expensive part of streaming: relayout the
  // markdown at most ~30fps (time-gated, so high-refresh displays do not do
  // double work) while plain text still renders every frame via the fast
  // path. The final frame always renders so nothing is left behind.
  const drainComplete = streamingPendingTokens.length === 0;
  const shouldRenderMarkdownFrame =
    !streamingMarkdownMode
    || drainComplete
    || !streamingLastRenderAt
    || frameAt - streamingLastRenderAt >= STREAM_MARKDOWN_RENDER_INTERVAL_MS;
  if (!streamingMarkdownMode) {
    const renderStartedAt = nowMs();
    if (!appendPlainStreamingText(body, revealedText)) {
      renderStreamingBody(body, { force: true, full: true });
    }
    if (typeof recordStreamingRenderMetric === "function") {
      recordStreamingRenderMetric({
        renderMs: Math.max(0, nowMs() - renderStartedAt),
        mode: "plain-append",
        textLen: streamingTextContent.length,
      });
    }
  } else if (shouldRenderMarkdownFrame) {
    // A drain frame (backlog emptied, possibly between chunks) must not wipe
    // the block-incremental DOM; the block renderer already reflects the full
    // text. Only non-block streams fall back to the full render on drain.
    const blockEligible = streamingMarkdownMode && canUseStreamingBlockRender(streamingTextContent);
    const renderStartedAt = nowMs();
    renderStreamingBody(body, { force: true, full: drainComplete && !blockEligible });
    // Per-frame markdown render timing: the performance closure for the
    // block-level incremental / render-throttling work. Cross-file call is
    // guarded — realtime-render.js may evaluate before session-http.js, and
    // metrics must never throw inside an animation frame. Frames that do not
    // render (shouldRenderMarkdownFrame false) cost nothing here.
    if (typeof recordStreamingRenderMetric === "function") {
      recordStreamingRenderMetric({
        renderMs: Math.max(0, nowMs() - renderStartedAt),
        mode: blockEligible ? "block" : "full",
        textLen: streamingTextContent.length,
      });
    }
  }
  let spacerResult = null;
  if (typeof syncTurnViewportSpacerOnGrowth === "function") {
    spacerResult = syncTurnViewportSpacerOnGrowth();
  }
  // We are already inside an animation frame here: a deferred scrollToBottom
  // would land one frame late and, worse, sit behind the next pump frame's
  // render (double rAF chain), amplifying the visible stream hitch.
  // If the turn is still within the screen height and docked to the top,
  // syncTurnViewportSpacerOnGrowth manages the docked scroll position.
  // Once the output fills and exceeds the screen height, auto-scroll takes over
  // to push history upwards so the newest streaming tokens remain visible.
  if (shouldScroll && (!spacerResult || spacerResult.filledScreen)) {
    scrollToBottom({ minScrollTop, immediate: true });
  }
  if (streamingPendingTokens.length > 0) {
    streamingAnimFrame = requestAnimationFrame(pumpStreamingAnimation);
  } else {
    // Animation complete — if a finalize callback is waiting, run it now
    if (streamingFinalizeCallback) {
      const cb = streamingFinalizeCallback;
      streamingFinalizeCallback = null;
      cb();
    }
  }
}

function enqueueAssistantText(text) {
  const value = typeof text === "string" ? text : "";
  if (!value) return false;
  getOrCreateStreamingMessage();
  enqueueStreamingTokens(value);
  streamingArrivedSinceLastPump += value.length;
  if (emptyState.parentNode === messagesInner) emptyState.remove();
  if (!streamingAnimFrame) {
    streamingAnimFrame = requestAnimationFrame(pumpStreamingAnimation);
  }
  return true;
}

// Keep the provider-facing name for existing callers while routing every text
// source through the one presentation gate above.
function appendTextDelta(text) {
  return enqueueAssistantText(text);
}

function prefersReducedMotionForSyntheticStream() {
  return typeof window?.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function shouldSyntheticStreamAssistantMessage(evt, enabled = false) {
  if (!enabled || !evt || evt.type !== "message" || evt.role !== "assistant") return false;
  if (streamingMessageEl && streamingMessageEl.parentNode === messagesInner) return false;
  if (prefersReducedMotionForSyntheticStream()) return false;
  const text = typeof evt.content === "string" ? evt.content : "";
  return text.trim().length > 0;
}

function queueSyntheticAssistantMessage(evt) {
  const text = typeof evt?.content === "string" ? evt.content : "";
  if (!enqueueAssistantText(text)) return false;
  finalizeStreamingMessage((streamingNode) => {
    const shouldStickToBottom = shouldAutoScrollMessages(STREAMING_STICKY_BOTTOM_THRESHOLD_PX);
    const settledNode = typeof renderMessageIntoStreamingNode === "function"
      ? renderMessageIntoStreamingNode(streamingNode, evt)
      : null;
    if (!settledNode) renderMessage(evt);
    if (shouldStickToBottom) {
      scrollToBottom({ minScrollTop: messagesEl.scrollTop });
    }
    if (typeof movePlanProgressCardToEnd === "function") {
      movePlanProgressCardToEnd(messagesInner, evt?.runId);
    }
  }, { preserveNode: true });
  return true;
}

// Timeline owns transcript identity. This adapter lets it animate a complete
// real-time message inside an already-keyed root instead of mounting the old
// standalone streaming bubble. Completion is handed back to Timeline so it
// can restore the final message visual without losing data-timeline-* attrs.
function startSyntheticAssistantMessageInNode(node, evt, { onComplete } = {}) {
  const text = typeof evt?.content === "string" ? evt.content : "";
  if (!node || node.parentNode !== messagesInner || !text.trim()) return false;
  if (prefersReducedMotionForSyntheticStream()) return false;
  if (streamingMessageEl && streamingMessageEl.parentNode === messagesInner) return false;

  const body = node.querySelector?.(".msg-assistant-body") || document.createElement("div");
  body.className = "msg-assistant-body";
  body.replaceChildren();
  node.replaceChildren(body);
  node.classList?.add("streaming");
  streamingMessageEl = node;
  streamingTextContent = "";
  streamingPendingTokens = [];
  streamingPreviewTruncated = false;
  enqueueStreamingTokens(text);
  streamingFinalizeCallback = () => {
    const completedNode = _doFinalizeStreamingMessage({ removeNode: false });
    onComplete?.(completedNode);
  };
  streamingLastRenderAt = 0;
  streamingMarkdownRenderWarned = false;
  streamingMarkdownMode = false;
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  streamingPlainFrontier = null;
  resetStreamingPacingState();
  if (!streamingAnimFrame) streamingAnimFrame = requestAnimationFrame(pumpStreamingAnimation);
  return true;
}

function finishSyntheticAssistantMessage() {
  if (!streamingMessageEl) return false;
  if (streamingAnimFrame) {
    cancelAnimationFrame(streamingAnimFrame);
    streamingAnimFrame = null;
  }
  if (streamingPendingTokens.length > 0) {
    const body = streamingMessageEl.querySelector(".msg-assistant-body");
    appendStreamingVisibleText(streamingPendingTokens.join(""));
    streamingPendingTokens = [];
    if (body) renderStreamingBody(body, { force: true, full: true });
  }
  const callback = streamingFinalizeCallback;
  streamingFinalizeCallback = null;
  callback?.();
  return true;
}

window.RagentStreamingPresentation = Object.freeze({
  startSyntheticAssistantMessageInNode,
  finishSyntheticAssistantMessage,
  decorateStreamingMessageNode,
  cancel: flushStreamingAnimation,
  settleTerminal: settleStreamingPresentationForTerminal,
  isScrollDetached: () => streamingUserScrollDetached,
  setScrollDetached: (val) => { streamingUserScrollDetached = Boolean(val); },
});

// A run may terminate before its authoritative final assistant event reaches
// the browser. Detach the presentation queue in that case, remove the caret,
// and leave the partial text readable instead of leaving an eternal streaming
// indicator or reusing the old node for the next run. Synthetic complete
// messages still finish through their normal keyed-node hand-off.
function settleStreamingPresentationForTerminal(state = "completed") {
  if (!streamingMessageEl || streamingMessageEl.parentNode !== messagesInner) return false;
  if (streamingFinalizeCallback) {
    finishSyntheticAssistantMessage();
    return true;
  }
  const node = streamingMessageEl;
  if (streamingAnimFrame) {
    cancelAnimationFrame(streamingAnimFrame);
    streamingAnimFrame = null;
  }
  if (streamingPendingTokens.length > 0) {
    const body = node.querySelector?.(".msg-assistant-body");
    appendStreamingVisibleText(streamingPendingTokens.join(""));
    streamingPendingTokens = [];
    if (body) renderStreamingBody(body, { force: true, full: true });
  }
  node.querySelector?.(".streaming-caret")?.remove?.();
  node.classList?.remove("streaming");
  node.classList?.add("run-terminal-settle");
  node.dataset.runTerminalState = String(state || "completed");
  streamingMessageEl = null;
  streamingTextContent = "";
  streamingPendingTokens = [];
  streamingPreviewTruncated = false;
  streamingFinalizeCallback = null;
  streamingLastRenderAt = 0;
  streamingMarkdownRenderWarned = false;
  streamingMarkdownMode = false;
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  streamingPlainFrontier = null;
  resetStreamingPacingState();
  return true;
}

function flushStreamingAnimation() {
  if (streamingAnimFrame) {
    cancelAnimationFrame(streamingAnimFrame);
    streamingAnimFrame = null;
  }
  if (streamingPendingTokens.length > 0 && streamingMessageEl) {
    const body = streamingMessageEl.querySelector(".msg-assistant-body");
    if (body) {
      appendStreamingVisibleText(streamingPendingTokens.join(""));
      renderStreamingBody(body, { force: true });
    }
    streamingPendingTokens = [];
    resetStreamingPacingState();
  }
  streamingFinalizeCallback = null;
}

function finalizeStreamingMessage(callback, { preserveNode = false } = {}) {
  const finish = () => {
    const finalizedNode = _doFinalizeStreamingMessage({ removeNode: !preserveNode });
    if (callback) callback(finalizedNode);
  };
  // If animation is still running, queue the finalize for when it finishes
  if (streamingPendingTokens.length > 0 && streamingAnimFrame) {
    streamingFinalizeCallback = finish;
    return;
  }
  flushStreamingAnimation();
  finish();
}

function _doFinalizeStreamingMessage({ removeNode = true } = {}) {
  if (!streamingMessageEl || streamingMessageEl.parentNode !== messagesInner) {
    streamingMessageEl = null;
    streamingTextContent = "";
    streamingPendingTokens = [];
    streamingPreviewTruncated = false;
    streamingAnimFrame = null;
    streamingFinalizeCallback = null;
    streamingLastRenderAt = 0;
    streamingMarkdownRenderWarned = false;
    streamingMarkdownMode = false;
    streamingPlainFrontier = null;
    resetStreamingPacingState();
    return null;
  }
  const finalizedNode = streamingMessageEl;
  if (removeNode) finalizedNode.remove();
  streamingMessageEl = null;
  streamingTextContent = "";
  streamingPendingTokens = [];
  streamingPreviewTruncated = false;
  streamingAnimFrame = null;
  streamingFinalizeCallback = null;
  streamingLastRenderAt = 0;
  streamingMarkdownRenderWarned = false;
  streamingMarkdownMode = false;
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  streamingPlainFrontier = null;
  resetStreamingPacingState();
  return finalizedNode;
}

let preservedComposerEchoes = [];
let sessionContentTransitionTimeout = null;
let sessionContentTransitionReleaseFrame = null;

function cancelSessionContentTransitionRelease() {
  if (sessionContentTransitionReleaseFrame == null) return;
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(sessionContentTransitionReleaseFrame);
  }
  sessionContentTransitionReleaseFrame = null;
}

function setSessionContentTransition(active, { settle = false } = {}) {
  if (sessionContentTransitionTimeout) {
    if (typeof clearTimeout === "function") {
      clearTimeout(sessionContentTransitionTimeout);
    }
    sessionContentTransitionTimeout = null;
  }
  cancelSessionContentTransitionRelease();
  if (!messagesInner) return;
  if (active) {
    messagesInner.classList?.add("is-session-transitioning");
    messagesInner.setAttribute?.("aria-busy", "true");
    if (typeof setTimeout === "function") {
      sessionContentTransitionTimeout = setTimeout(() => {
        sessionContentTransitionTimeout = null;
        if (messagesInner?.classList?.contains("is-session-transitioning")) {
          messagesInner.classList.remove("is-session-transitioning");
          messagesInner.removeAttribute?.("aria-busy");
        }
      }, 3500);
    }
  } else {
    messagesInner.removeAttribute?.("aria-busy");
    const wasActive = messagesInner.classList?.contains?.("is-session-transitioning") === true;
    if (settle && wasActive && typeof requestAnimationFrame === "function") {
      // Release the single composited crossfade after the replacement DOM has
      // had one paint opportunity. Removing the state in the same task as the
      // timeline commit made the old and new opacity states collapse into one
      // abrupt frame on slower phones.
      const release = () => {
        sessionContentTransitionReleaseFrame = requestAnimationFrame(() => {
          sessionContentTransitionReleaseFrame = null;
          if (messagesInner) {
            messagesInner.classList?.remove("is-session-transitioning");
            messagesInner.classList?.add("is-session-swap-in");
            setTimeout(() => {
              messagesInner?.classList?.remove("is-session-swap-in");
            }, 260);
          }
        });
      };
      sessionContentTransitionReleaseFrame = requestAnimationFrame(release);
      return;
    }
    messagesInner.classList?.remove("is-session-transitioning");
  }
}

function finishSessionContentTransition(sessionId = null) {
  if (
    sessionId
    && typeof currentSessionId === "string"
    && currentSessionId !== sessionId
  ) return false;
  setSessionContentTransition(false, { settle: true });
  return true;
}

if (typeof window !== "undefined") {
  window.setSessionContentTransition = setSessionContentTransition;
  window.finishSessionContentTransition = finishSessionContentTransition;
}

function collectComposerEchoesForRefresh() {
  if (!messagesInner || typeof currentSessionId !== "string" || !currentSessionId) return [];
  const pendingSend = typeof getComposerPendingSendSnapshot === "function"
    ? getComposerPendingSendSnapshot()
    : null;
  const retainedRequestIds = new Set();
  if (typeof getComposerRetainedSendsState === "function") {
    for (const retainedSend of getComposerRetainedSendsState(currentSessionId)) {
      if (retainedSend?.localEcho !== false && retainedSend.requestId) {
        retainedRequestIds.add(retainedSend.requestId);
      }
    }
  }
  return Array.from(messagesInner.querySelectorAll(".msg-user-local-echo[data-request-id]"))
    .filter((node) => {
      if (node.dataset?.sessionId && node.dataset.sessionId !== currentSessionId) return false;
      if (!node.dataset?.sendBaselineSeq) {
        const baselineSeq = typeof renderedEventState === "object"
          && renderedEventState
          && Number.isInteger(renderedEventState.latestSeq)
          && renderedEventState.latestSeq >= 0
          ? renderedEventState.latestSeq
          : 0;
        node.dataset.sendBaselineSeq = String(baselineSeq);
      }
      const requestId = node.dataset?.requestId || "";
      return node.dataset?.sendAwaitingCommit === "true"
        || retainedRequestIds.has(requestId)
        || (pendingSend?.sessionId === currentSessionId && pendingSend?.requestId === requestId);
    });
}

// A foreground refresh can race the user-message event by a few milliseconds.
// Keep the visible local echo across that reset; the canonical event will
// remove it in the same render frame. A still-uncommitted echo is reinserted at
// its send-time sequence boundary so a live assistant overlay cannot appear
// before the user bubble.
function placePreservedComposerEchoesInTimelineOrder() {
  if (!messagesInner) return false;
  let placed = false;
  const echoes = Array.from(messagesInner.querySelectorAll(".msg-user-local-echo[data-request-id]"));
  for (const node of echoes) {
    if (node.dataset?.sessionId && node.dataset.sessionId !== currentSessionId) continue;
    const baselineSeq = Number(node.dataset?.sendBaselineSeq);
    // A 0/absent baseline means the send raced the session load, so the
    // cursor says nothing about where the message belongs. Moving it to the
    // first rendered row would hoist the user's bubble above the whole
    // history; bottom is where they typed it and the canonical event takes
    // over from there.
    const anchored = Number.isFinite(baselineSeq) && baselineSeq > 0;
    const boundary = anchored ? baselineSeq : 0;
    const following = anchored
      ? Array.from(messagesInner.children).find((candidate) => {
        if (candidate === node || candidate.classList?.contains("msg-user-local-echo")) return false;
        const startSeq = Number(candidate.dataset?.timelineStartSeq);
        return Number.isFinite(startSeq) && startSeq > boundary;
      })
      : null;
    if (following) {
      if (node.nextElementSibling !== following) {
        messagesInner.insertBefore(node, following);
        placed = true;
      }
    } else if (node !== messagesInner.lastElementChild) {
      messagesInner.appendChild(node);
      placed = true;
    }
  }
  return placed;
}

function restorePreservedComposerEchoesAfterRender() {
  if (!messagesInner) return false;
  let restored = false;
  for (const node of preservedComposerEchoes) {
    if (!node || node.parentNode === messagesInner || !node.dataset?.requestId) continue;
    if (node.dataset?.sessionId && node.dataset.sessionId !== currentSessionId) continue;
    messagesInner.appendChild(node);
    restored = true;
  }
  preservedComposerEchoes = [];
  if (typeof restoreComposerRetainedEchoesForCurrentSession === "function") {
    restored = restoreComposerRetainedEchoesForCurrentSession() || restored;
  }
  restored = placePreservedComposerEchoesInTimelineOrder() || restored;
  if (!restored) return false;
  if (emptyState?.parentNode === messagesInner) emptyState.remove();
  const homeWorkspace = document.getElementById("homeWorkspace");
  if (homeWorkspace?.parentNode === messagesInner) homeWorkspace.remove();
  syncScrollToBottomFab();
  return true;
}

function clearMessages({ preserveRunningBlockExpanded = false, preserveContent = false } = {}) {
  if (typeof clearSessionLoadError === "function") clearSessionLoadError();
  if (typeof removeAssistantPendingNode === "function") {
    removeAssistantPendingNode({ immediate: true });
  }
  if (typeof removeTurnViewportSpacer === "function") {
    removeTurnViewportSpacer({ immediate: true });
  }
  preservedComposerEchoes = collectComposerEchoesForRefresh();
  const nextRunningBlockExpanded = typeof preserveRunningBlockExpanded === "boolean"
    ? preserveRunningBlockExpanded
    : null;
  if (typeof resetMessageViewportStabilityForRender === "function") {
    resetMessageViewportStabilityForRender();
  }
  if (preserveContent) {
    // Keep the previous session visible until the first durable page for the
    // new session is ready. TimelineRuntime removes the old keyed roots and
    // commits the new roots in the same task, so the browser never paints an
    // intermediate empty transcript.
    setSessionContentTransition(true);
  } else {
    messagesInner.innerHTML = "";
    // Keep the node attached while the history is replayed so a matching
    // canonical user event can atomically replace it instead of creating a
    // duplicate. Remaining echoes are moved to the tail after replay.
    if (preservedComposerEchoes.length > 0) {
      messagesInner.append(...preservedComposerEchoes);
    }
    setSessionContentTransition(false);
  }
  // A session switch wipes the transcript without a scroll event: keep the
  // scroll-to-latest FAB in sync (hidden while the transcript is empty).
  syncScrollToBottomFab();
  resetRenderedEventState();
  if (!preserveContent) {
    window.RagentTimelineRuntime?.reset?.(typeof currentSessionId === "string" ? currentSessionId : "");
  }
  if (typeof nextRunningBlockExpanded === "boolean") {
    renderedEventState.runningBlockExpanded = nextRunningBlockExpanded;
  }
  // Reset thinking block state
  inThinkingBlock = false;
  currentThinkingBlock = null;
  // Reset streaming state
  if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
  streamingMessageEl = null;
  streamingTextContent = "";
  streamingPendingTokens = [];
  streamingPreviewTruncated = false;
  streamingAnimFrame = null;
  streamingFinalizeCallback = null;
  streamingLastRenderAt = 0;
  streamingMarkdownRenderWarned = false;
  streamingMarkdownMode = false;
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  streamingPlainFrontier = null;
  resetStreamingPacingState();
  // Transcript reset (session switch / refresh) is a turn boundary: drop any
  // scroll-detach intent from the replaced transcript.
  streamingUserScrollDetached = false;
}

let homeWorkspaceNode = null;

function getHomeWorkspaceNode() {
  if (!homeWorkspaceNode) {
    homeWorkspaceNode = document.getElementById("homeWorkspace");
  }
  return homeWorkspaceNode;
}

function syncEmptyStateUi() {
  const noAttachedSession = !currentSessionId && !hasAttachedSession && !visitorMode && !shareSnapshotMode;
  const homeWorkspace = getHomeWorkspaceNode();
  if (emptyState) {
    emptyState.hidden = noAttachedSession && !!homeWorkspace;
    emptyState.classList.toggle("empty-state--workspace-empty", noAttachedSession);
  }
  if (homeWorkspace) {
    homeWorkspace.hidden = !noAttachedSession;
  }
  const actions = document.getElementById("emptyStateActions");
  if (actions) {
    actions.hidden = !noAttachedSession;
  }
  if (inputArea) {
    inputArea.hidden = noAttachedSession;
  }
}

function showEmpty() {
  if (typeof clearSessionLoadError === "function") clearSessionLoadError();
  const homeWorkspace = getHomeWorkspaceNode();
  messagesInner.innerHTML = "";
  // An attached session can legitimately have no visible rows (new session,
  // control-only history, or a filtered projection). Resetting the runtime to
  // the empty session here makes that successful state look unrendered and
  // forces the next refresh to start over. Only the true no-session home state
  // should reset the projector identity.
  if (!currentSessionId) window.RagentTimelineRuntime?.reset?.("");
  // A refresh can temporarily have no projected timeline rows while a
  // session is still attached (for example when leaving and re-entering a
  // recently opened session). The home workspace is only valid for the true
  // no-session state; mounting it here would make syncEmptyStateUi hide the
  // only child and leave the transcript visually blank.
  const shouldShowHome = !currentSessionId
    && !hasAttachedSession
    && !visitorMode
    && !shareSnapshotMode
    && !!homeWorkspace;
  messagesInner.appendChild(shouldShowHome ? homeWorkspace : emptyState);
  if (shouldShowHome && typeof showHomeWorkspace === "function") {
    showHomeWorkspace();
  }
  syncEmptyStateUi();
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(null);
  }
  inThinkingBlock = false;
  currentThinkingBlock = null;
  if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
  streamingMessageEl = null;
  streamingTextContent = "";
  streamingPendingTokens = [];
  streamingPreviewTruncated = false;
  streamingAnimFrame = null;
  streamingFinalizeCallback = null;
  streamingLastRenderAt = 0;
  streamingMarkdownRenderWarned = false;
  streamingMarkdownMode = false;
  streamingBlockStableEnd = 0;
  streamingBlockPrefixNode = null;
  streamingBlockSuffixNode = null;
  if (typeof syncSessionTemplateControls === "function") {
    syncSessionTemplateControls();
  }
  syncForkButton();
  syncShareButton();
}

function scrollToBottom({
  minScrollTop = null,
  sessionId = currentSessionId,
  immediate = false,
  animate = false,
} = {}) {
  if (animate && !immediate) {
    cancelScrollToBottomAnimation();
    requestAnimationFrame(() => {
      if (currentSessionId !== sessionId) return;
      animateMessagesToBottom({ sessionId });
    });
    return;
  }
  cancelScrollToBottomAnimation();
  // `immediate` skips the rAF hop for callers that already run inside an
  // animation frame (streaming pump) or that must pair the pin with other
  // layout writes in the same synchronous block (send-time flush), so the
  // browser paints once at the new bottom instead of snapping a frame late.
  const scroll = () => {
    if (currentSessionId !== sessionId) return;
    // The scroll event fired by this write must not look like user intent —
    // otherwise the pin's own event would bump the user generation and
    // invalidate a pending semantic restore.
    if (typeof markMessageViewportProgrammaticScroll === "function") {
      markMessageViewportProgrammaticScroll();
    }
    const currentScrollTop = Number(messagesEl.scrollTop) || 0;
    if (
      Number.isFinite(minScrollTop)
      && currentScrollTop + SCROLL_GUARD_EPSILON_PX < minScrollTop
    ) {
      return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (typeof syncMessageViewportStabilitySnapshot === "function") {
      syncMessageViewportStabilitySnapshot();
    }
  };
  if (immediate) {
    scroll();
    return;
  }
  requestAnimationFrame(scroll);
}

// ---- Scroll-to-latest floating button ----
// Self-contained: its own passive scroll listener toggles visibility from the
// same bottom-distance signal the event-refresh stickiness uses. It appears
// only when the reader has scrolled away from the bottom of a non-empty
// transcript; clicking returns to the latest content.
const SCROLL_TO_BOTTOM_FAB_THRESHOLD_PX = EVENT_RENDER_STICKY_BOTTOM_THRESHOLD_PX;
let _scrollToBottomFabEl = null;
let _scrollToBottomFabReady = false;
let streamingUserScrollDetached = false;
if (typeof window !== "undefined") {
  window.isStreamingUserScrollDetached = () => streamingUserScrollDetached;
  window.setStreamingUserScrollDetached = (val) => { streamingUserScrollDetached = Boolean(val); };
}

function syncScrollToBottomFab() {
  const fab = _scrollToBottomFabEl;
  if (!fab || !messagesEl) return;
  const hasMessages =
    !!messagesInner &&
    messagesInner.children.length > 0 &&
    (typeof emptyState === "undefined" || !emptyState || emptyState.parentNode !== messagesInner);
  const awayFromBottom = getMessagesBottomDistance() >= SCROLL_TO_BOTTOM_FAB_THRESHOLD_PX;
  const isStreaming = !!streamingMessageEl || (Array.isArray(streamingPendingTokens) && streamingPendingTokens.length > 0);
  const shouldBeVisible = hasMessages && (awayFromBottom || (isStreaming && streamingUserScrollDetached));
  fab.classList.toggle("visible", shouldBeVisible);
  fab.classList.toggle("is-streaming-unread", isStreaming && streamingUserScrollDetached);
}

function handleStreamingScrollIntent(event) {
  const isStreaming = !!streamingMessageEl || (Array.isArray(streamingPendingTokens) && streamingPendingTokens.length > 0);
  if (!isStreaming) return;
  if (event?.type === "wheel") {
    if (event.deltaY < 0) {
      streamingUserScrollDetached = true;
      syncScrollToBottomFab();
    }
  } else if (event?.type === "touchmove") {
    if (getMessagesBottomDistance() > 16) {
      streamingUserScrollDetached = true;
      syncScrollToBottomFab();
    }
  }
}

function handleMessagesViewportScroll() {
  const dist = getMessagesBottomDistance();
  if (dist <= STREAMING_ATTACH_BOTTOM_DISTANCE_PX) {
    if (streamingUserScrollDetached) {
      streamingUserScrollDetached = false;
      // Re-engaging mid-turn must restore the dock immediately: in dock mode
      // this snaps back to the top anchor (user bubble at the top margin), in
      // filled mode it snaps onto the growing tail. Waiting for the next
      // growth frame would leave the view parked up to the attach threshold
      // away from where the turn lives, looking like a dead viewport.
      const isStreaming = !!streamingMessageEl || (Array.isArray(streamingPendingTokens) && streamingPendingTokens.length > 0);
      if (isStreaming && typeof syncTurnViewportSpacerOnGrowth === "function") {
        syncTurnViewportSpacerOnGrowth();
      }
    }
  } else if (dist > STREAMING_DETACH_BOTTOM_DISTANCE_PX) {
    const isStreaming = !!streamingMessageEl || (Array.isArray(streamingPendingTokens) && streamingPendingTokens.length > 0);
    if (isStreaming) {
      const isProg = typeof isMessageViewportProgrammaticScroll === "function"
        ? isMessageViewportProgrammaticScroll()
        : false;
      if (!isProg) {
        streamingUserScrollDetached = true;
      }
    }
  }
  syncScrollToBottomFab();
}

function setupScrollToBottomFab() {
  if (_scrollToBottomFabReady) return;
  if (typeof messagesEl === "undefined" || !messagesEl) return;
  const fab = document.getElementById("scrollToBottomFab");
  if (!fab) return;
  _scrollToBottomFabEl = fab;
  _scrollToBottomFabReady = true;
  fab.addEventListener("click", () => {
    streamingUserScrollDetached = false;
    scrollToBottom({ animate: true });
    // Hide immediately; the scroll listener keeps it hidden while at the bottom.
    fab.classList.remove("visible", "is-streaming-unread");
  });
  for (const eventName of ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"]) {
    messagesEl.addEventListener(eventName, cancelScrollToBottomAnimation, { passive: true });
  }
  messagesEl.addEventListener("wheel", handleStreamingScrollIntent, { passive: true });
  messagesEl.addEventListener("touchmove", handleStreamingScrollIntent, { passive: true });
  messagesEl.addEventListener("scroll", handleMessagesViewportScroll, { passive: true });
  syncScrollToBottomFab();
}

setupScrollToBottomFab();

function scrollNodeToTop(node, { margin = 10, sessionId = currentSessionId } = {}) {
  if (!node) return;
  requestAnimationFrame(() => {
    if (currentSessionId !== sessionId || node.isConnected === false) return;
    const containerRect = messagesEl.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nextTop =
      messagesEl.scrollTop + (nodeRect.top - containerRect.top) - margin;
    messagesEl.scrollTop = Math.max(0, nextTop);
    if (typeof syncMessageViewportStabilitySnapshot === "function") {
      syncMessageViewportStabilitySnapshot();
    }
  });
}

function parseMessageTimestamp(stamp) {
  if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
  if (typeof stamp === "string" && stamp.trim()) {
    const parsed = new Date(stamp).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function appendMessageTimestamp(container, stamp, extraClass = "") {
  const parsed = parseMessageTimestamp(stamp);
  if (!parsed) return;
  const time = document.createElement("div");
  time.className = `msg-timestamp${extraClass ? ` ${extraClass}` : ""}`;
  time.textContent = messageTimeFormatter.format(parsed);
  time.title = new Date(parsed).toLocaleString();
  container.appendChild(time);
}

function queueHydrateLazyNodes(root) {
  if (!root) return;
  setTimeout(() => {
    hydrateLazyNodes(root).catch(() => {});
  }, 0);
}

function shouldSkipMobileHistoryPrependEvent(evt, historyPrepend = false) {
  if (!historyPrepend || typeof shouldCompactMobileThinking !== "function") return false;
  if (!shouldCompactMobileThinking()) return false;
  return [
    "collapsed_block",
    "thinking_block",
    "operation",
    "tool_use",
    "tool_result",
    "file_change",
    "reasoning",
  ].includes(evt?.type);
}

function markHistoryEntryNodes(previousChildren = [], { index = 0 } = {}) {
  if (!messagesInner) return;
  const previousSet = new Set(Array.isArray(previousChildren) ? previousChildren : []);
  const newNodes = Array.from(messagesInner.children || []).filter((node) => (
    node !== emptyState && !previousSet.has(node)
  ));
  if (newNodes.length === 0) return;
  const baseDelay = Math.min(180, Math.max(0, Number(index) || 0) * 18);
  newNodes.forEach((node, offset) => {
    const delay = Math.min(180, baseDelay + offset * 18);
    node.classList?.add("history-entry-node");
    node.style?.setProperty?.("--history-entry-delay", `${delay}ms`);
  });
}

// A1 regenerate (branch + fold): move every sibling rendered after the parent
// user message (up to the next user message) into a collapsible version rail.
// Repeated regenerations keep stacking into the same rail, so v1/v2/v3 all
// stay auditable under the original request.
function findVersionRailForUserNode(userNode, parentRequestId = "") {
  const container = userNode?.parentNode;
  if (!userNode || !container) return null;
  if (userNode.nextElementSibling?.classList?.contains?.("msg-version-rail")) {
    return userNode.nextElementSibling;
  }
  const normalizedParentId = typeof parentRequestId === "string" ? parentRequestId.trim() : "";
  if (normalizedParentId && typeof container.querySelectorAll === "function") {
    const rails = Array.from(container.querySelectorAll(".msg-version-rail"));
    const byParent = rails.find((rail) => rail?.dataset?.parentRequestId === normalizedParentId);
    if (byParent) return byParent;
  }
  return null;
}

function reconcileVersionRailForUserNode(userNode, nodesToFold = [], {
  parentRequestId = "",
  append = false,
} = {}) {
  const container = userNode?.parentNode;
  if (!userNode || !container) return null;
  const resolvedParentId = typeof parentRequestId === "string" && parentRequestId.trim()
    ? parentRequestId.trim()
    : (userNode.dataset?.requestId || "");
  const foldList = Array.isArray(nodesToFold) ? nodesToFold.filter(Boolean) : [];
  let rail = findVersionRailForUserNode(userNode, resolvedParentId);

  if (foldList.length === 0) {
    if (!append && rail) {
      rail.remove?.();
      if (typeof syncRegenerateActions === "function") {
        syncRegenerateActions();
      }
      return null;
    }
    if (!rail) return null;
  }

  if (!rail) {
    rail = document.createElement("div");
    rail.className = "msg-version-rail";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "msg-version-rail__toggle";
    toggle.setAttribute("aria-expanded", "false");
    const iconHtml = typeof renderRealtimeIcon === "function"
      ? renderRealtimeIcon("refresh", "msg-version-rail__icon")
      : "";
    toggle.innerHTML = `${iconHtml}<span class="msg-version-rail__label"></span>`;
    const body = document.createElement("div");
    body.className = "msg-version-rail__body";
    toggle.addEventListener("click", () => {
      const expanded = rail.classList.toggle("is-expanded");
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
    rail.appendChild(toggle);
    rail.appendChild(body);
    userNode.after(rail);
  } else if (userNode.nextElementSibling !== rail && typeof userNode.after === "function") {
    userNode.after(rail);
  }

  if (resolvedParentId && rail.dataset) {
    rail.dataset.parentRequestId = resolvedParentId;
  }
  const body = rail.querySelector(".msg-version-rail__body");
  if (!body) return rail;

  let totalCount;
  if (append) {
    const previousCount = Number(rail.dataset.foldedCount) || 0;
    for (const child of foldList) {
      body.appendChild(child);
    }
    totalCount = previousCount + foldList.length;
  } else {
    const wanted = new Set(foldList);
    for (const existingChild of Array.from(body.children || [])) {
      if (!wanted.has(existingChild)) {
        existingChild.remove?.();
      }
    }
    let cursor = body.firstElementChild || null;
    for (const child of foldList) {
      if (child === cursor) {
        cursor = child.nextElementSibling || null;
        continue;
      }
      if (typeof body.insertBefore === "function") {
        body.insertBefore(child, cursor);
        cursor = child.nextElementSibling || null;
      } else {
        body.appendChild(child);
      }
    }
    totalCount = foldList.length;
  }

  rail.dataset.foldedCount = String(totalCount);
  const label = rail.querySelector(".msg-version-rail__label");
  if (label) {
    label.textContent = totalCount > 1
      ? `${t("message.versionRail.folded")} · ${totalCount}`
      : t("message.versionRail.folded");
  }
  if (typeof syncRegenerateActions === "function") {
    syncRegenerateActions();
  }
  return rail;
}

function foldAssistantRepliesIntoVersionRail(parentRequestId) {
  if (!messagesInner || !parentRequestId) return null;
  const userNode = Array.from(messagesInner.querySelectorAll(".msg-user[data-request-id]"))
    .find((node) => node.dataset.requestId === parentRequestId) || null;
  if (!userNode || userNode.parentNode !== messagesInner) return null;

  const rail = findVersionRailForUserNode(userNode, parentRequestId);
  const toFold = [];
  let node = userNode.nextElementSibling;
  while (node && node !== emptyState && !node.classList?.contains("msg-user")) {
    if (node.classList?.contains("msg-version-rail")) {
      node = node.nextElementSibling;
      continue;
    }
    toFold.push(node);
    node = node.nextElementSibling;
  }
  if (toFold.length === 0 && !rail) return null;
  return reconcileVersionRailForUserNode(userNode, toFold, { parentRequestId, append: true });
}

function renderEvent(
  evt,
  autoScroll,
  {
    historyPrepend = false,
    approvalRequestLiveId,
    syntheticStream = false,
    historyEntryIndex = null,
    preserveTimelinePosition = false,
  } = {},
) {
  let rendered = false;
  const viewportChildrenBefore = Array.from(messagesInner?.children || []);
  const minScrollTop = Number(messagesEl.scrollTop) || 0;
  const shouldScroll =
    autoScroll && shouldAutoScrollMessages(EVENT_RENDER_STICKY_BOTTOM_THRESHOLD_PX);

  if (shouldSkipMobileHistoryPrependEvent(evt, historyPrepend)) {
    return;
  }

  if (!historyPrepend) {
    if (
      evt?.type === "text_delta"
      || (evt?.type === "message" && evt?.role === "assistant")
      || evt?.type === "attachment_delivery"
      || evt?.type === "plan"
    ) {
      window.RagentRunActivity?.noteFormalOutput?.(evt);
    } else {
      window.RagentRunActivity?.applyEvent?.(evt);
    }
  }

  switch (evt.type) {
    case "text_delta":
      rendered = true;
      enqueueAssistantText(evt.text || "");
      break;
    case "message":
    case "attachment_delivery":
      if (historyPrepend) {
        renderMessageInto(messagesInner, evt, {
          finalizeActiveThinkingBlock: false,
          mergeAssistantRunMessages: false,
          preservePosition: preserveTimelinePosition,
        });
        rendered = true;
        break;
      }
      if (
        shouldSyntheticStreamAssistantMessage(evt, syntheticStream)
        && !findAssistantRunMergeNode(messagesInner, getAssistantRunMergeKeyForRender(evt))
      ) {
        rendered = queueSyntheticAssistantMessage(evt);
        break;
      }
      // Finalize any streaming placeholder before rendering the complete message.
      // If typewriter animation is still running, queue the render until it finishes
      // so the user sees the full typewriter effect before the markdown replacement.
      if (evt.role === "assistant") {
        finalizeStreamingMessage((streamingNode) => {
          const shouldStickToBottom = shouldAutoScrollMessages(STREAMING_STICKY_BOTTOM_THRESHOLD_PX);
          const settledNode = typeof renderMessageIntoStreamingNode === "function"
            ? renderMessageIntoStreamingNode(streamingNode, evt)
            : null;
          if (!settledNode) {
            renderMessageInto(messagesInner, evt, {
              finalizeActiveThinkingBlock: true,
              preservePosition: preserveTimelinePosition,
            });
          }
          if (shouldStickToBottom) {
            scrollToBottom({ minScrollTop: messagesEl.scrollTop });
          }
          if (typeof movePlanProgressCardToEnd === "function") {
            movePlanProgressCardToEnd(messagesInner, evt?.runId);
          }
        }, { preserveNode: true });
      } else {
        finalizeStreamingMessage();
        renderMessage(evt);
      }
      rendered = true;
      break;
    case "run_regenerate":
      rendered = true;
      if (typeof foldAssistantRepliesIntoVersionRail === "function") {
        foldAssistantRepliesIntoVersionRail(evt?.parentRequestId || "");
      }
      // Edit-resend markers carry the edited prompt: patch the user bubble so
      // the visible message text matches the version that was actually
      // re-answered (the original text stays in the event log).
      if (evt?.editResend === true && typeof applyEditedUserMessageContent === "function") {
        applyEditedUserMessageContent(
          evt?.parentRequestId || "",
          typeof evt?.prompt === "string" ? evt.prompt : "",
          Array.isArray(evt?.images) ? evt.images : [],
        );
      }
      break;
    case "collapsed_block":
      rendered = true;
      renderCollapsedBlock(evt);
      break;
    case "thinking_block":
      rendered = true;
      renderThinkingBlockEvent(evt);
      break;
    case "operation":
      rendered = true;
      renderOperation(evt);
      break;
    case "plan":
      rendered = true;
      renderPlanEvent(evt);
      // Codex proposals (plan events awaiting a decision) feed the Decision
      // Sheet like a plan-kind approval request: awaiting_decision pops it,
      // executing/revising/terminal states dismiss it. Progress plans
      // (planIntent "progress" / agent interaction mode) are execution
      // tracking, not proposals, so they never touch the store. History
      // replays never touch the store; full-sync page renders gate on
      // approvalRequestLiveId (same semantics as approval_request below).
      if (!historyPrepend && !isCodexProgressPlanEvent(evt)) {
        const planApprovalId = planApprovalIdForPlanEvent(evt);
        if (planApprovalId) {
          if (
            String(evt?.state || "").trim().toLowerCase() === "awaiting_decision"
            && (
              approvalRequestLiveId == null
              || planApprovalId === approvalRequestLiveId
            )
          ) {
            const sheetEvent = buildPlanApprovalRequestEvent(evt);
            if (sheetEvent) window.RagentDecisions?.noteRequest(sheetEvent);
          } else if (isPlanSheetDismissState(evt)) {
            window.RagentDecisions?.noteResponse({ approvalId: planApprovalId });
          }
        }
      }
      break;
    case "approval_request":
      // Plan-kind requests (Claude Code ExitPlanMode) keep an in-stream plan
      // card in the conversation (codex-proposal style) besides the sheet;
      // other kinds are sheet-only. Cards persist across history replays, but
      // their approve/deny actions stay inert unless this is the live pending
      // approval (same gate as the store feed below).
      // History replays must not re-open the sheet for approvals that are no
      // longer live. historyPrepend (scroll-up pagination) renders past records;
      // full-sync page renders gate on options.approvalRequestLiveId, which is
      // null on live paths (WS/delta), "" when the session has no live approval,
      // or the approvalId of the newest unresolved request of a running session.
      rendered = true;
      if (String(evt?.kind || "").trim().toLowerCase() === "plan") {
        renderPlanApprovalCard(evt, {
          livePrompt: !historyPrepend
            && (
              approvalRequestLiveId == null
              || String(evt?.approvalId || "") === approvalRequestLiveId
            ),
        });
      }
      if (
        !historyPrepend
        && (
          approvalRequestLiveId == null
          || String(evt?.approvalId || "") === approvalRequestLiveId
        )
      ) {
        window.RagentDecisions?.noteRequest(evt);
      }
      break;
    case "approval_response":
      rendered = true;
      renderApprovalResponse(evt);
      // The in-stream plan card (plan-kind requests) reflects the outcome.
      updatePlanApprovalCardOnResponse(evt);
      // A historical response (scroll-up replay) is an audit record — rendering
      // the summary line is enough; it must not clear a currently pending sheet.
      if (!historyPrepend) window.RagentDecisions?.noteResponse(evt);
      break;
    case "privileged_batch_request":
      // Danger-tier ops surface as one batch approval (other/delete groups).
      // The sheet renders it; history replays and full-sync page renders must
      // not re-open a surface for a batch that is no longer live.
      rendered = true;
      if (
        !historyPrepend
        && (
          approvalRequestLiveId == null
          || String(evt?.batchId || "") === approvalRequestLiveId
        )
      ) {
        window.RagentDecisions?.notePrivilegedBatch(evt);
      }
      break;
    case "privileged_batch_response":
      // One category group resolved — advance the pending batch surface.
      // Historical responses are audit records only (same gate as
      // approval_response above).
      rendered = true;
      if (!historyPrepend) window.RagentDecisions?.notePrivilegedBatchResponse(evt);
      break;
    case "approved_action_batch_request":
      rendered = true;
      if (
        !historyPrepend
        && (
          approvalRequestLiveId == null
          || String(evt?.batchId || "") === approvalRequestLiveId
        )
      ) {
        window.RagentDecisions?.noteApprovedAction?.(evt);
      }
      break;
    case "approved_action_state":
      rendered = true;
      if (!historyPrepend) window.RagentDecisions?.noteApprovedActionState?.(evt);
      break;
    case "approved_action_batch_response":
      rendered = true;
      if (!historyPrepend) window.RagentDecisions?.noteApprovedActionResolution?.(evt);
      break;
    case "tool_use":
      rendered = true;
      renderToolUse(evt);
      break;
    case "tool_result":
      rendered = true;
      renderToolResult(evt);
      break;
    case "file_change":
      rendered = true;
      renderFileChange(evt);
      break;
    case "reasoning":
      rendered = true;
      renderReasoning(evt);
      break;
    case "status":
      rendered = true;
      // A terminal status (cancelled / error) means the run is over — drop any
      // leftover approval or batch sheet immediately so stale cards never
      // linger on the composer. The server also emits per-approval cancelled
      // responses at finalize; this is the belt-and-braces path for clients
      // that race the run's end (e.g. events dropped by a reconnect).
      {
        const statusText = String(evt?.content || "").trim().toLowerCase();
        const terminalStatus = statusText === "cancelled" || statusText.startsWith("error:");
        const statusRunId = String(evt?.runId || "").trim();
        const pendingApproval = window.RagentDecisions?.getPending?.();
        const pendingBatch = window.RagentDecisions?.getPendingBatch?.();
        const pendingAction = window.RagentDecisions?.getPendingAction?.();
        const pendingDecisions = [pendingApproval, pendingBatch, pendingAction].filter(Boolean);
        const pendingRunIds = pendingDecisions
          .map((decision) => decision?.runId)
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        // A durable page can contain terminal status records from older runs.
        // Do not let one of those records clear a live approval belonging to a
        // different run. The timeline runtime applies the same guard for its
        // primary path; keep this legacy renderer safe for direct harness use.
        const protectsLiveApproval = Boolean(
          pendingDecisions.length > 0
          && (
            !statusRunId
            || pendingRunIds.length === 0
            || !pendingRunIds.includes(statusRunId)
          ),
        );
        if (terminalStatus && !protectsLiveApproval) {
          window.RagentDecisions?.reset?.();
        }
      }
      renderStatusMsg(evt);
      break;
    case "context_barrier":
      rendered = true;
      renderContextBarrier(evt);
      break;
    case "context_operation":
      rendered = true;
      renderContextOperation(evt);
      break;
    case "usage":
      rendered = true;
      renderUsage(evt);
      break;
  }

  if (!rendered) return;

  if (typeof annotateRenderedEventViewportNodes === "function") {
    annotateRenderedEventViewportNodes(evt, viewportChildrenBefore);
  }
  if (Number.isInteger(historyEntryIndex)) {
    markHistoryEntryNodes(viewportChildrenBefore, { index: historyEntryIndex });
  }

  if (typeof movePlanProgressCardToEnd === "function") {
    movePlanProgressCardToEnd(messagesInner, evt?.runId);
  }

  if (emptyState.parentNode === messagesInner) emptyState.remove();
  if (typeof syncComposerPendingTurnFeedback === "function") {
    syncComposerPendingTurnFeedback();
  }

  if (shouldScroll) {
    scrollToBottom({
      minScrollTop,
      animate: evt?.type === "attachment_delivery",
    });
  }
}

function applyFinishedTurnCollapseState() {
  if (typeof compactMobileThinkingTimeline === "function") {
    compactMobileThinkingTimeline();
  }
  if (typeof syncTurnViewportSpacerOnGrowth === "function") {
    syncTurnViewportSpacerOnGrowth();
  }
  let latestTurnStart = null;
  for (const node of messagesInner.children) {
    if (node === emptyState) continue;
    if (node.classList?.contains("msg-user")) {
      latestTurnStart = node;
    }
  }

  return latestTurnStart;
}

function shouldFocusLatestTurnStart(node) {
  return !!node && sessionStatus !== "running" && !inThinkingBlock;
}

// ---- Thinking block helpers ----
function openThinkingBlock() {
  const block = document.createElement("div");
  block.className = "thinking-block collapsed running";

  const header = document.createElement("div");
  header.className = "thinking-header";
  header.innerHTML = `${renderRealtimeIcon("gear", "thinking-icon")}
    <span class="thinking-label">${t("thinking.active")}</span>
    <span class="thinking-chevron">${renderRealtimeIcon("chevron-down")}</span>`;

  const body = document.createElement("div");
  body.className = "thinking-body";

  header.addEventListener("click", async () => {
    block.classList.toggle("collapsed");
    if (!block.classList.contains("collapsed")) {
      await hydrateLazyNodes(block);
    }
  });

  block.appendChild(header);
  block.appendChild(body);
  if (typeof removeAssistantPendingNode === "function") {
    removeAssistantPendingNode({ immediate: true });
  }
  const spacer = typeof document !== "undefined" ? document.getElementById("turnViewportSpacer") : null;
  if (spacer && spacer.parentNode === messagesInner) {
    messagesInner.insertBefore(block, spacer);
  } else {
    messagesInner.appendChild(block);
  }

  currentThinkingBlock = {
    el: block,
    header,
    body,
    label: header.querySelector(".thinking-label"),
    tools: new Set(),
  };
  inThinkingBlock = true;
}

function formatToolList(names, max) {
  if (names.length <= max) return names.join(", ");
  return names.slice(0, max).join(", ") + ` +${names.length - max}`;
}

function finalizeThinkingBlock() {
  if (!currentThinkingBlock) return;
  const { label, tools } = currentThinkingBlock;
  if (typeof clearThinkingHeaderEditingState === "function") {
    clearThinkingHeaderEditingState(currentThinkingBlock.el || currentThinkingBlock.block);
  }
  const toolList = [...tools];
  if (toolList.length > 0) {
    label.textContent = t("thinking.usedTools", { tools: formatToolList(toolList, 3) });
  } else {
    label.textContent = t("thinking.done");
  }
  inThinkingBlock = false;
  currentThinkingBlock = null;
}

async function copyText(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function setCopyButtonState(button, copied) {
  const icon = copied
    ? renderRealtimeIcon("check")
    : renderRealtimeIcon("copy");
  button.innerHTML = icon;
  button.classList.toggle("copied", copied);
  button.title = copied ? t("action.copied") : t("copy.code");
  button.setAttribute("aria-label", copied ? t("action.copied") : t("copy.code"));
}

function codeBlockLanguageLabel(code) {
  const languageClass = Array.from(code?.classList || [])
    .find((name) => /^(?:language|lang)-/i.test(name));
  const raw = languageClass
    ? languageClass.replace(/^(?:language|lang)-/i, "")
    : "";
  if (window.RagentMarkdownEnhancements?.codeLanguageLabel) {
    return window.RagentMarkdownEnhancements.codeLanguageLabel(raw);
  }
  const normalized = raw.trim().toLowerCase();
  const aliases = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    ps: "powershell",
    ps1: "powershell",
    psm1: "powershell",
    pwsh: "powershell",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yml: "yaml",
    md: "markdown",
    html: "markup",
    htm: "markup",
    xml: "markup",
  };
  const canonical = aliases[normalized] || normalized;
  const labels = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    python: "Python",
    powershell: "PowerShell",
    shell: "Shell",
    yaml: "YAML",
    markdown: "Markdown",
    markup: "HTML",
    css: "CSS",
    sql: "SQL",
    json: "JSON",
    kotlin: "Kotlin",
    java: "Java",
    diff: "Diff",
    patch: "Patch",
    text: "Plain text",
    plaintext: "Plain text",
    plain: "Plain text",
  };
  return labels[canonical] || canonical || "Plain text";
}

function createCodeBlockHeader(code) {
  const label = codeBlockLanguageLabel(code);
  const header = document.createElement("div");
  header.className = "code-block-header";
  header.setAttribute("role", "group");
  header.setAttribute("aria-label", `${label} code block`);

  const language = document.createElement("span");
  language.className = "code-block-language";
  language.dataset.language = label;

  const icon = document.createElement("span");
  icon.className = "code-block-language-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "</>";
  language.appendChild(icon);

  const text = document.createElement("span");
  text.className = "code-block-language-name";
  text.textContent = label;
  language.appendChild(text);
  header.appendChild(language);
  return header;
}

// Copy handling is delegated: one document-level click listener serves every
// .code-copy-btn, so settle re-enhancement (innerHTML rebuilds) never tears
// down and re-creates per-button listeners. The registration guard makes the
// delegation idempotent across repeated enhanceCodeBlocks calls. Reset timers
// live in a per-button WeakMap so a destroyed button node is collected with
// its pending timer handle.
let codeCopyDelegationRegistered = false;
const codeCopyResetTimers = new WeakMap();
const CODE_COPY_RESET_MS = 1600;

function registerCodeCopyDelegation() {
  if (codeCopyDelegationRegistered) return;
  codeCopyDelegationRegistered = true;
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".code-copy-btn");
    if (!button) return;
    const wrapper = button.closest(".code-block-wrap");
    if (!wrapper) return;
    const code = wrapper.querySelector("pre > code");
    if (!code) return;
    handleCodeCopyClick(button, code.textContent || "");
  });
}

async function handleCodeCopyClick(button, text) {
  try {
    await copyText(text);
    setCopyButtonState(button, true);
    window.clearTimeout(codeCopyResetTimers.get(button));
    codeCopyResetTimers.set(
      button,
      window.setTimeout(() => {
        codeCopyResetTimers.delete(button);
        setCopyButtonState(button, false);
      }, CODE_COPY_RESET_MS),
    );
  } catch (err) {
    console.warn("[copy] Failed to copy code block:", err.message);
  }
}

function enhanceCodeBlocks(root) {
  registerCodeCopyDelegation();
  const blocks = root.querySelectorAll("pre > code");
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    let wrapper = pre.parentElement?.classList.contains("code-block-wrap")
      ? pre.parentElement
      : null;
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "code-block-wrap";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
    }

    let header = wrapper.querySelector(":scope > .code-block-header");
    if (!header) {
      header = createCodeBlockHeader(code);
      wrapper.insertBefore(header, pre);
    }
    if (!wrapper.querySelector(":scope > .code-block-header > .code-copy-btn")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-btn";
      setCopyButtonState(button, false);
      header.appendChild(button);
    }
    wrapper.dataset.codeLanguage = codeBlockLanguageLabel(code);
  }
}

function enhanceTables(root) {
  const tables = root.querySelectorAll("table");
  for (const table of tables) {
    if (!table.parentElement || table.parentElement.classList.contains("md-table-wrap")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "md-table-wrap";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
}

function getThinkingBody() {
  if (!inThinkingBlock) openThinkingBlock();
  return currentThinkingBlock.body;
}

function eventCacheScope() {
  const authEpoch = typeof window !== "undefined"
    && typeof window.ragentAuthEpoch === "string"
    && window.ragentAuthEpoch
    ? window.ragentAuthEpoch
    : "anonymous";
  const targetId = typeof window !== "undefined"
    ? (window.RagentTargetRuntime?.getActiveTarget?.()?.targetId || "local")
    : "local";
  return `${authEpoch}:${targetId}`;
}

function eventBlockCacheKey(sessionId, startSeq, endSeq) {
  return `${eventCacheScope()}:${sessionId}:${startSeq}-${endSeq}`;
}

// bootstrap.js owns the bounded caches in the normal chat shell. Keep the
// renderer independently loadable for partial embeds/tests and script-load
// races: a missing bootstrap binding must degrade to a local cache, not throw
// from clearMessages() before the first transcript render.
const fallbackEventBlockCache = new Map();
const fallbackEventBodyCache = new Map();
const fallbackEventBlockRequests = new Map();
const fallbackEventBodyRequests = new Map();

function resolveEventCache(name, fallback) {
  try {
    if (name === "eventBlockCache" && typeof eventBlockCache !== "undefined") return eventBlockCache;
    if (name === "eventBodyCache" && typeof eventBodyCache !== "undefined") return eventBodyCache;
    if (name === "eventBlockRequests" && typeof eventBlockRequests !== "undefined") return eventBlockRequests;
    if (name === "eventBodyRequests" && typeof eventBodyRequests !== "undefined") return eventBodyRequests;
  } catch (_) {}
  return fallback;
}

function clearEventCacheEntries(cache, prefix) {
  if (typeof cache.deleteMatching === "function") {
    cache.deleteMatching((key) => String(key).startsWith(prefix));
    return;
  }
  for (const key of cache.keys()) {
    if (String(key).startsWith(prefix)) cache.delete(key);
  }
}

function clearSessionEventCaches(sessionId) {
  cancelSessionEventBodyFetches(sessionId);
  const caches = [
    resolveEventCache("eventBlockCache", fallbackEventBlockCache),
    resolveEventCache("eventBodyCache", fallbackEventBodyCache),
    resolveEventCache("eventBlockRequests", fallbackEventBlockRequests),
    resolveEventCache("eventBodyRequests", fallbackEventBodyRequests),
  ];
  // A principal/target transition invalidates every immutable response and
  // every in-flight promise.  Keeping a promise from the previous transport
  // would otherwise repopulate a fresh cache after the transition completes.
  if (!sessionId) {
    for (const cache of caches) cache?.clear?.();
    return;
  }
  const scopedPrefix = `${eventCacheScope()}:${String(sessionId)}:`;
  const legacyPrefix = `${String(sessionId)}:`;
  for (const cache of caches) {
    clearEventCacheEntries(cache, scopedPrefix);
    // Keep partial embeds and old pages safe while they migrate to scoped
    // keys; those caches do not include the auth epoch yet.
    clearEventCacheEntries(cache, legacyPrefix);
  }
}

// Event bodies are immutable by sequence and are useful on session re-entry;
// operation blocks, however, may carry a later state/revision after a live
// update. Normal navigation only invalidates the block side so it keeps the
// cheap immutable body cache without rendering stale operation details.
function clearSessionEventBlockCaches(sessionId) {
  const caches = [
    resolveEventCache("eventBlockCache", fallbackEventBlockCache),
    resolveEventCache("eventBlockRequests", fallbackEventBlockRequests),
  ];
  if (!sessionId) {
    for (const cache of caches) cache?.clear?.();
    return;
  }
  const scopedPrefix = `${eventCacheScope()}:${String(sessionId)}:`;
  const legacyPrefix = `${String(sessionId)}:`;
  for (const cache of caches) {
    clearEventCacheEntries(cache, scopedPrefix);
    clearEventCacheEntries(cache, legacyPrefix);
  }
}

if (typeof window !== "undefined") {
  window.ragentClearSessionEventCaches = clearSessionEventCaches;
  window.ragentClearSessionEventBlockCaches = clearSessionEventBlockCaches;
  // A session change normally keeps immutable body data cached, but its lazy
  // hydration work is no longer useful.  Expose cancellation separately from
  // cache invalidation so returning to a long session remains fast.
  window.ragentCancelSessionEventBodyFetches = cancelSessionEventBodyFetches;
}

async function fetchEventBlock(sessionId, startSeq, endSeq) {
  const blockCache = resolveEventCache("eventBlockCache", fallbackEventBlockCache);
  const blockRequests = resolveEventCache("eventBlockRequests", fallbackEventBlockRequests);
  const key = eventBlockCacheKey(sessionId, startSeq, endSeq);
  if (blockCache.has(key)) return blockCache.get(key);
  if (blockRequests.has(key)) return blockRequests.get(key);
  if ((typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) && typeof getShareSnapshotEventBlock === "function") {
    const localBlock = getShareSnapshotEventBlock(startSeq, endSeq);
    if (localBlock) {
      blockCache.set(key, localBlock);
      return localBlock;
    }
  }
  const request = fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/blocks/${startSeq}-${endSeq}`,
  )
    .then((data) => {
      blockCache.set(key, data);
      blockRequests.delete(key);
      return data;
    })
    .catch((error) => {
      blockRequests.delete(key);
      throw error;
    });
  blockRequests.set(key, request);
  return request;
}

function eventBodyCacheKey(sessionId, seq) {
  return `${eventCacheScope()}:${sessionId}:${seq}`;
}

const EVENT_BODY_FETCH_CONCURRENCY = 6;
const eventBodyQueue = [];
let activeEventBodyFetches = 0;
const eventBodyGenerations = new Map();
const eventBodyControllers = new Map();

function abortEventBodyError() {
  const error = new Error("Event body request was superseded");
  error.name = "AbortError";
  return error;
}

function eventBodyGeneration(sessionId) {
  return eventBodyGenerations.get(String(sessionId || "")) || 0;
}

function isCurrentEventBodyRequest(sessionId, generation) {
  return eventBodyGeneration(sessionId) === generation;
}

function cancelSessionEventBodyFetches(sessionId) {
  const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
  const matches = (value) => !normalized || value === normalized;
  if (!normalized) {
    for (const key of eventBodyGenerations.keys()) {
      eventBodyGenerations.set(key, eventBodyGeneration(key) + 1);
    }
  } else {
    eventBodyGenerations.set(normalized, eventBodyGeneration(normalized) + 1);
  }

  // Drop queued work immediately instead of making a newly selected session
  // wait behind bodies that cannot ever be painted.
  for (let index = eventBodyQueue.length - 1; index >= 0; index -= 1) {
    const job = eventBodyQueue[index];
    if (!job || !matches(job.sessionId)) continue;
    eventBodyQueue.splice(index, 1);
    job.cancelled = true;
    job.reject(abortEventBodyError());
  }
  for (const [key, entry] of eventBodyControllers) {
    if (!matches(entry.sessionId)) continue;
    eventBodyControllers.delete(key);
    entry.controller.abort();
  }
}

function pumpEventBodyQueue() {
  while (activeEventBodyFetches < EVENT_BODY_FETCH_CONCURRENCY && eventBodyQueue.length > 0) {
    const next = eventBodyQueue.shift();
    if (!next) break;
    if (next.cancelled || !isCurrentEventBodyRequest(next.sessionId, next.generation)) {
      next.reject(abortEventBodyError());
      continue;
    }
    activeEventBodyFetches += 1;
    Promise.resolve()
      .then(next.run)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeEventBodyFetches = Math.max(0, activeEventBodyFetches - 1);
        pumpEventBodyQueue();
      });
  }
}

function scheduleEventBodyFetch(sessionId, generation, run) {
  return new Promise((resolve, reject) => {
    eventBodyQueue.push({ sessionId, generation, run, resolve, reject, cancelled: false });
    pumpEventBodyQueue();
  });
}

async function fetchEventBody(sessionId, seq) {
  const bodyCache = resolveEventCache("eventBodyCache", fallbackEventBodyCache);
  const bodyRequests = resolveEventCache("eventBodyRequests", fallbackEventBodyRequests);
  const key = eventBodyCacheKey(sessionId, seq);
  if (bodyCache.has(key)) return bodyCache.get(key);
  if (bodyRequests.has(key)) return bodyRequests.get(key);
  const generation = eventBodyGeneration(sessionId);
  const controller = new AbortController();
  eventBodyControllers.set(key, { sessionId, generation, controller });
  let request;
  request = scheduleEventBodyFetch(sessionId, generation, async () => {
    if (!isCurrentEventBodyRequest(sessionId, generation)) throw abortEventBodyError();
    const data = await fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}/events/${seq}/body`,
      { signal: controller.signal },
    );
    if (!isCurrentEventBodyRequest(sessionId, generation)) throw abortEventBodyError();
    return data;
  })
    .then((data) => {
      if (!isCurrentEventBodyRequest(sessionId, generation)) throw abortEventBodyError();
      const body = data.body || null;
      bodyCache.set(key, body);
      return body;
    })
    .catch((error) => {
      throw error;
    })
    .finally(() => {
      if (bodyRequests.get(key) === request) bodyRequests.delete(key);
      const active = eventBodyControllers.get(key);
      if (active?.controller === controller) eventBodyControllers.delete(key);
    });
  bodyRequests.set(key, request);
  return request;
}

function applyLazyBodyToNode(node, body) {
  if (!node) return;
  const renderMode = node.dataset.bodyRender || "text";
  const value = formatDecodedDisplayText(body?.value || node.dataset.preview || "");
  if (renderMode === "markdown" && typeof renderMarkdownIntoNode === "function") {
    renderMarkdownIntoNode(node, value);
    return;
  }
  node.textContent = value;
}

function cleanBase64TextForDisplay(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function stripHiddenDisplayBlocks(text) {
  let visible = String(text || "")
    .replace(/<private>[\s\S]*?<\/private>/gi, "")
    .replace(/<hide>[\s\S]*?<\/hide>/gi, "")
    .replace(/<ragent-(organization-proposal|collaboration-plan|result-packet|session-labels)\b[^>]*>[\s\S]*?(?:<\/ragent-(?:organization-proposal|collaboration-plan|result-packet|session-labels)>|$)/gi, "")
    .replace(/<\/ragent-(?:organization-proposal|collaboration-plan|result-packet|session-labels)>/gi, "");
  const markers = [
    "<ragent-organization-proposal>",
    "<ragent-collaboration-plan>",
    "<ragent-result-packet>",
    "<ragent-session-labels>",
  ];
  const lower = visible.toLowerCase();
  let suffixLength = 0;
  for (const marker of markers) {
    const normalized = marker.toLowerCase();
    const max = Math.min(normalized.length - 1, lower.length);
    for (let length = max; length > suffixLength; length -= 1) {
      if (lower.endsWith(normalized.slice(0, length))) {
        suffixLength = length;
        break;
      }
    }
  }
  if (suffixLength > 0) visible = visible.slice(0, -suffixLength);
  return visible.trim();
}

function looksLikeReadableDisplayText(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return false;
  if (value.includes("\uFFFD")) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

function tryDecodeUtf8Base64Text(text) {
  const normalized = cleanBase64TextForDisplay(text);
  if (
    normalized.length < 16 ||
    normalized.length % 4 !== 0 ||
    !/[+/=]/.test(normalized) ||
    /[^A-Za-z0-9+/=]/.test(normalized)
  ) {
    return "";
  }

  try {
    const binary = window.atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder("utf-8").decode(bytes);
    return looksLikeReadableDisplayText(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function formatDecodedDisplayText(text) {
  const source = stripHiddenDisplayBlocks(typeof text === "string" ? text : "");
  const marker = "Original email:";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return source;

  const prefix = source.slice(0, markerIndex + marker.length);
  const encodedTail = source.slice(markerIndex + marker.length).replace(/^\s+/, "");
  const decodedTail = tryDecodeUtf8Base64Text(encodedTail);
  if (!decodedTail) return source;
  return `${prefix}\n${decodedTail}`;
}

async function hydrateLazyNode(node) {
  const sessionId = currentSessionId;
  const seq = parseInt(node?.dataset?.eventSeq || "", 10);
  if (!sessionId || !seq || node.dataset.bodyPending !== "true") return;
  try {
    const body = await fetchEventBody(sessionId, seq);
    // A body response is optional decoration.  Never let a late response for
    // a previously attached session mutate a recycled/detached transcript
    // node after a fast sidebar switch.
    if (
      currentSessionId !== sessionId
      || node.dataset.bodyPending !== "true"
      || node.isConnected === false
    ) return;
    applyLazyBodyToNode(node, body);
    node.dataset.bodyPending = "false";
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.warn("[event-body] Failed to load body:", error.message);
  }
}

async function hydrateLazyNodes(root) {
  const sessionId = currentSessionId;
  const nodes = root?.querySelectorAll?.('[data-body-pending="true"]') || [];
  // Keep the DOM hydration work bounded as well as the underlying fetches.
  // A large history page can contain thousands of deferred bodies; creating a
  // Promise for every node at once adds avoidable memory pressure and queues
  // work faster than the user can observe it. Process small batches while the
  // fetch layer still provides cross-root dedupe and its global concurrency
  // limit.
  for (let offset = 0; offset < nodes.length; offset += EVENT_BODY_FETCH_CONCURRENCY) {
    if (currentSessionId !== sessionId) return;
    const batch = [];
    for (
      let index = offset;
      index < Math.min(nodes.length, offset + EVENT_BODY_FETCH_CONCURRENCY);
      index += 1
    ) {
      batch.push(hydrateLazyNode(nodes[index]));
    }
    await Promise.all(batch);
  }
}

// ---------------------------------------------------------------------------
// Plan proposal <-> Decision Sheet bridge.
//
// Codex proposals are plan events (state awaiting_decision). Live ones feed
// the Decision Sheet like a plan-kind approval_request, so both providers get
// the same popup + in-stream card pair. Progress plans are execution tracking
// and must never bridge to the sheet. History replays never touch the store.
// ---------------------------------------------------------------------------
const PLAN_SHEET_STALE_STATES = Object.freeze(
  new Set(["drafting", "executing", "revising", "completed", "failed", "superseded", "cancelled"]),
);

// Progress plans are read-only execution tracking, not proposals awaiting a
// decision. This mirrors ui.js isPlanProgressEvent for the live render path.
function isCodexProgressPlanEvent(evt) {
  const planIntent = String(evt?.planIntent || "").trim().toLowerCase();
  if (planIntent) return planIntent === "progress";
  return String(evt?.interactionMode || "").trim().toLowerCase() === "agent";
}

// A plan event's sheet identity: "plan:<planId>" (distinct from provider
// approval ids like "claude:<requestId>", so both namespaces coexist).
function planApprovalIdForPlanEvent(evt) {
  const planId = typeof evt?.planId === "string" ? evt.planId.trim() : "";
  return planId ? `plan:${planId}` : "";
}

function planEventItemsToMarkdown(evt) {
  const items = Array.isArray(evt?.items) ? evt.items : [];
  return items
    .map((item) => {
      const text = typeof item === "string"
        ? item.trim()
        : String(item?.text || item?.step || item?.title || "").trim();
      return text ? `- ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Shape the store expects for a plan proposal: an approval_request-like event
// so the Decision Sheet renders it with the shared plan renderer.
function buildPlanApprovalRequestEvent(evt) {
  const approvalId = planApprovalIdForPlanEvent(evt);
  if (!approvalId) return null;
  const title = typeof evt?.title === "string" ? evt.title.trim() : "";
  const bodyMarkdown = typeof evt?.bodyMarkdown === "string" ? evt.bodyMarkdown.trim() : "";
  const runId = typeof evt?.runId === "string" ? evt.runId.trim() : "";
  const reason = bodyMarkdown || planEventItemsToMarkdown(evt);
  return {
    type: "approval_request",
    approvalId,
    kind: "plan",
    status: "pending",
    ...(title ? { title } : {}),
    ...(reason ? { reason } : {}),
    ...(runId ? { runId } : {}),
    planEventRef: { planId: String(evt.planId).trim() },
  };
}

// States that mean "the proposal is no longer awaiting a decision": the sheet
// must dismiss (executing/revising after an action, terminal after the run).
function isPlanSheetDismissState(evt) {
  return PLAN_SHEET_STALE_STATES.has(String(evt?.state || "").trim().toLowerCase());
}

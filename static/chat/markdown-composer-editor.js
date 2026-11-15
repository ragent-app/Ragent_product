// Ragent adapter for the vendored Vditor Markdown editor.
//
// Vditor owns the editable Markdown surface, selection/IME handling, paste,
// and undo/redo. Ragent keeps the existing hidden textarea as the integration
// value so the send, draft, session, and attachment paths remain unchanged.
(function initMarkdownComposerEditor() {
  "use strict";

  const VALUE_DESCRIPTOR = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  const mounted = new WeakMap();
  const LONG_PASTE_FAST_PATH_THRESHOLD = 8 * 1024;
  const MOBILE_LONG_PASTE_FAST_PATH_THRESHOLD = 4 * 1024;
  const scriptUrl = document.currentScript?.src || "";
  const assetBase = new URL("vendor/vditor", scriptUrl || document.baseURI).toString().replace(/\/$/, "");
  const workerUrl = new URL("markdown-composer-worker.js", scriptUrl || document.baseURI).toString();
  let markdownWorker = null;
  let markdownWorkerRequestId = 0;
  const markdownWorkerRequests = new Map();

  function getMarkdownWorker() {
    if (markdownWorker || typeof window.Worker !== "function") return markdownWorker;
    try {
      markdownWorker = new window.Worker(workerUrl);
      markdownWorker.onmessage = (event) => {
        const request = markdownWorkerRequests.get(event?.data?.id);
        if (!request) return;
        markdownWorkerRequests.delete(event.data.id);
        if (event.data.error) request.reject(new Error(event.data.error));
        else request.resolve(event.data.html);
      };
      markdownWorker.onerror = (error) => {
        for (const request of markdownWorkerRequests.values()) {
          request.reject(error instanceof Error ? error : new Error("Markdown worker failed"));
        }
        markdownWorkerRequests.clear();
        markdownWorker.terminate();
        markdownWorker = null;
      };
    } catch {
      markdownWorker = null;
    }
    return markdownWorker;
  }

  function renderMarkdownInWorker(text) {
    const worker = getMarkdownWorker();
    if (!worker) return null;
    const id = ++markdownWorkerRequestId;
    return new Promise((resolve, reject) => {
      markdownWorkerRequests.set(id, { resolve, reject });
      worker.postMessage({ id, text });
    });
  }

  function warmMarkdownWorkerWhenIdle() {
    if (markdownWorker || typeof window.Worker !== "function") return;
    const warm = () => { getMarkdownWorker(); };
    // Loading Lute into a Worker is deliberately not part of the paste event:
    // on an uncached mobile connection that startup cost is otherwise visible
    // as a long delay before the first pasted character appears.
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(warm, { timeout: 1500 });
    } else if (typeof window.setTimeout === "function") {
      window.setTimeout(warm, 300);
    }
  }

  function longPasteFastPathThreshold() {
    const narrowViewport = Number(window.innerWidth) > 0 && window.innerWidth <= 768;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches === true;
    return narrowViewport || coarsePointer
      ? MOBILE_LONG_PASTE_FAST_PATH_THRESHOLD
      : LONG_PASTE_FAST_PATH_THRESHOLD;
  }

  function isDarkTheme() {
    const root = document.documentElement;
    const body = document.body;
    return root?.dataset?.theme === "dark"
      || body?.dataset?.theme === "dark"
      || root?.classList?.contains("dark")
      || body?.classList?.contains("dark")
      || (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true
        && root?.dataset?.theme !== "light");
  }

  function contentThemeForEditorTheme(theme) {
    return theme === "dark" ? "dark" : "light";
  }

  function nativeValue(textarea) {
    return VALUE_DESCRIPTOR?.get?.call(textarea) || "";
  }

  function writeNativeValue(textarea, value) {
    VALUE_DESCRIPTOR?.set?.call(textarea, String(value ?? ""));
  }

  function editorValueMatchesExpected(actual, expected) {
    const actualValue = String(actual ?? "");
    const expectedValue = String(expected ?? "");
    // Vditor serializes its empty WYSIWYG paragraph as a trailing newline,
    // while the integration textarea uses the canonical empty string.
    return actualValue === expectedValue
      || (expectedValue === "" && actualValue.trim() === "");
  }

  function editableElement(vditor) {
    return vditor?.vditor?.wysiwyg?.element || null;
  }

  function editorScrollContainer(instance) {
    const editable = editableElement(instance?.vditor);
    let element = editable;
    while (element && element !== document.body && element !== document.documentElement) {
      const overflowY = window.getComputedStyle(element).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return element;
      }
      element = element.parentElement;
    }
    return instance?.editor || null;
  }

  function selectionRect(editable) {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || !selection.anchorNode) return null;
    if (!editable.contains(selection.anchorNode)) return null;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect?.();
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    const rects = range.getClientRects?.();
    return rects && rects.length > 0 ? rects[rects.length - 1] : null;
  }

  // Contenteditable normally asks the browser to reveal the caret, but that
  // native behavior can run before Vditor and auto-resize finish changing the
  // editor's height. Re-check the caret after layout and keep one line of
  // breathing room so the line being edited never sits against the clip edge.
  function ensureCaretVisible(instance) {
    if (!instance?.ready) return;
    const editable = editableElement(instance.vditor);
    if (!editable) return;
    const activeElement = document.activeElement;
    if (activeElement !== editable && !editable.contains(activeElement)) return;

    const container = editorScrollContainer(instance);
    const caret = selectionRect(editable);
    if (!container || !caret) return;

    const containerRect = container.getBoundingClientRect();
    const style = window.getComputedStyle(editable);
    const lineHeight = Number.parseFloat(style.lineHeight)
      || Number.parseFloat(window.getComputedStyle(container).lineHeight)
      || 24;
    const margin = Math.min(lineHeight, Math.max(4, container.clientHeight / 3));
    const visibleTop = containerRect.top + margin;
    const visibleBottom = containerRect.bottom - margin;
    let nextScrollTop = container.scrollTop;
    if (caret.top < visibleTop) {
      nextScrollTop -= visibleTop - caret.top;
    } else if (caret.bottom > visibleBottom) {
      nextScrollTop += caret.bottom - visibleBottom;
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(Math.max(nextScrollTop, 0), maxScrollTop);
  }

  function scheduleCaretVisibilitySync(instance) {
    if (!instance?.ready || instance.visibilityFrame) return;
    const run = () => {
      instance.visibilityFrame = 0;
      ensureCaretVisible(instance);
    };
    if (typeof window.requestAnimationFrame === "function") {
      instance.visibilityFrame = window.requestAnimationFrame(run);
    } else {
      instance.visibilityFrame = window.setTimeout(run, 0);
    }
  }

  // Vditor's contenteditable surface can expose an extra editing line through
  // an overflow-visible WYSIWYG parent. The main composer owns the growth cap;
  // keep the shell capped while the two inner layout boxes retain the full
  // natural document height so the shell remains the only scroll owner.
  function syncEditorShellHeight(instance, explicitHeight) {
    if (!instance?.editor?.classList?.contains("composer-markdown-editor")) return;
    const editable = editableElement(instance.vditor);
    if (!editable) return;
    const naturalHeight = editable.getBoundingClientRect().height;
    let height = Number.isFinite(explicitHeight)
      ? explicitHeight
      : naturalHeight;
    // The shell height must stay inside the composer's own growth cap: the
    // root is the single scroll container, and stamping an uncapped document
    // height onto it would overflow its CSS max-height and fight the
    // auto-resize clamp in compose.js.
    const shellMaxHeight = Number.parseFloat(window.getComputedStyle(instance.editor).maxHeight);
    if (Number.isFinite(shellMaxHeight) && shellMaxHeight > 0) {
      height = Math.min(height, shellMaxHeight);
    }
    if (!Number.isFinite(height) || height <= 0) return;
    const documentHeight = Number.isFinite(naturalHeight) && naturalHeight > 0
      ? naturalHeight
      : height;

    const previousScrollTop = Number(instance.editor.scrollTop) || 0;
    const previousMaxScrollTop = Math.max(
      0,
      (Number(instance.editor.scrollHeight) || 0) - (Number(instance.editor.clientHeight) || 0),
    );
    // A newly overflowing document starts with no previous scroll range. It is
    // not evidence that the user was at the end: treating it as the end would
    // move a first-line caret down by one viewport as soon as soft wrapping
    // crosses the composer cap.
    const wasAtScrollEnd = previousMaxScrollTop > 0
      && previousMaxScrollTop - previousScrollTop <= 2;

    const content = instance.editor.querySelector(":scope > .vditor-content");
    const wysiwyg = content?.querySelector(":scope > .vditor-wysiwyg");
    if (instance.editor) instance.editor.style.height = `${height}px`;
    if (content) {
      content.style.height = `${documentHeight}px`;
      if (content.scrollTop !== 0) content.scrollTop = 0;
      if (content.scrollLeft !== 0) content.scrollLeft = 0;
    }
    if (wysiwyg) {
      wysiwyg.style.height = `${documentHeight}px`;
      // The shell root is the sole scroll owner for the composer. The WYSIWYG
      // wrapper must remain overflow:visible and un-scrolled so continuous
      // typing that soft wraps to the next line without an explicit newline
      // never scrolls this inner box or clips/swallows the first line.
      wysiwyg.style.overflow = "visible";
      if (wysiwyg.scrollTop !== 0) wysiwyg.scrollTop = 0;
      if (wysiwyg.scrollLeft !== 0) wysiwyg.scrollLeft = 0;
    }
    if (editable) {
      if (editable.scrollTop !== 0) editable.scrollTop = 0;
      if (editable.scrollLeft !== 0) editable.scrollLeft = 0;
    }

    const nextMaxScrollTop = Math.max(
      0,
      (Number(instance.editor.scrollHeight) || 0) - (Number(instance.editor.clientHeight) || 0),
    );
    instance.editor.scrollTop = wasAtScrollEnd
      ? nextMaxScrollTop
      : Math.min(previousScrollTop, nextMaxScrollTop);
  }

  function scheduleEditorShellHeightSync(instance) {
    if (!instance?.ready || instance.shellHeightFrame) return;
    const run = () => {
      instance.shellHeightFrame = 0;
      syncEditorShellHeight(instance);
    };
    const raf = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : null;
    if (raf) {
      instance.shellHeightFrame = raf(run);
      return;
    }
    const timeout = typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : typeof setTimeout === "function"
        ? setTimeout
        : null;
    if (timeout) instance.shellHeightFrame = timeout(run, 0);
    else Promise.resolve().then(run);
  }

  function syncDisabledState(instance) {
    const { textarea, editor, vditor } = instance;
    const blocked = Boolean(textarea.disabled || textarea.readOnly);
    editor.classList.toggle("is-disabled", blocked);
    editor.setAttribute("aria-disabled", blocked ? "true" : "false");
    editor.dataset.placeholder = textarea.placeholder || "";
    editor.setAttribute("aria-label", textarea.placeholder || "Message");

    const editable = editableElement(vditor);
    if (editable) {
      editable.setAttribute("aria-label", textarea.placeholder || "Message");
      editable.setAttribute("aria-disabled", blocked ? "true" : "false");
    }
    if (!vditor || !instance.ready || blocked === instance.blocked) return;
    instance.blocked = blocked;
    if (blocked) vditor.disabled();
    else vditor.enable();
  }

  function collapseSelectionToEnd(instance) {
    const target = editableElement(instance.vditor);
    if (!target) return;
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertTextAtSelection(editable, text) {
    if (!editable) return false;
    if (typeof document.execCommand === "function"
      && document.execCommand("insertText", false, text)) {
      return true;
    }
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || !editable.contains(selection.anchorNode)) {
      return false;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editable.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }));
    return true;
  }

  function insertMarkdownAtSelection(instance, text) {
    const vditor = instance?.vditor;
    const editable = editableElement(vditor);
    if (!vditor || !editable) return false;

    // Vditor's public Markdown insertion path parses the pasted source once
    // and inserts the rendered fragment. Using execCommand here makes the
    // editor process the same large document again from its input handler.
    if (typeof vditor.insertMD === "function") {
      const currentValue = nativeValue(instance.textarea);
      instance.synchronizing = true;
      try {
        if (!currentValue.trim()) {
          vditor.setValue(text, false);
          collapseSelectionToEnd(instance);
        } else {
          vditor.insertMD(text);
        }
      } finally {
        instance.synchronizing = false;
      }
      return true;
    }
    return insertTextAtSelection(editable, text);
  }

  function pendingLargePasteStillMatches(instance, pending) {
    if (!pending || instance?.pendingLargePaste !== pending) return false;
    const expectedValue = pending.previewApplied ? pending.text : pending.initialValue;
    return nativeValue(instance.textarea) === expectedValue;
  }

  function finishPendingLargePaste(instance) {
    instance.pendingLargePaste = null;
    const editable = editableElement(instance.vditor);
    editable?.setAttribute(
      "contenteditable",
      instance.textarea.disabled || instance.textarea.readOnly ? "false" : "true",
    );
    instance.editor.classList.remove("is-pasting");
    instance.editor.removeAttribute("aria-busy");
    return editable;
  }

  function showPlainTextLargePastePreview(instance, pending) {
    if (!pending?.wasEmpty || pending.previewApplied) return false;
    const editable = editableElement(instance.vditor);
    if (!editable) return false;

    // A full Markdown document can take seconds to convert on a phone. Put a
    // single raw text node on screen now, then replace it with the worker's
    // rendered HTML later. This avoids the expensive synchronous HTML parser
    // while still making the pasted content and send action available at once.
    instance.synchronizing = true;
    try {
      editable.textContent = pending.text;
      collapseSelectionToEnd(instance);
    } finally {
      instance.synchronizing = false;
    }
    pending.previewApplied = true;
    instance.pendingValue = pending.text;
    writeNativeValue(instance.textarea, pending.text);
    instance.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    scheduleEditorShellHeightSync(instance);
    scheduleCaretVisibilitySync(instance);
    return true;
  }

  function runPendingLargePaste(instance, syncFromEditor, forceSync = false) {
    const pending = instance?.pendingLargePaste;
    if (!pending || !instance.ready) return false;
    if (!pendingLargePasteStillMatches(instance, pending)) {
      finishPendingLargePaste(instance);
      return false;
    }
    const editable = finishPendingLargePaste(instance);
    if (!editable) return false;
    if (!insertMarkdownAtSelection(instance, pending.text)) return false;

    // An empty composer has no selection ambiguity: keep the known source
    // value and avoid a second full WYSIWYG-to-Markdown serialization pass.
    if (pending.wasEmpty) {
      instance.pendingValue = pending.text;
      writeNativeValue(instance.textarea, pending.text);
      instance.textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    // Existing drafts need Vditor to serialize the insertion point back into
    // Markdown. Let the rendered fragment paint before doing that work.
    if (forceSync) syncFromEditor?.();
    else {
      window.setTimeout(() => {
        if (!instance.ready || instance.pendingLargePaste) return;
        syncFromEditor?.();
      }, 0);
    }
    return true;
  }

  function schedulePendingLargePaste(instance, text, syncFromEditor) {
    const editable = editableElement(instance?.vditor);
    if (!instance || !editable) return false;
    const initialValue = nativeValue(instance.textarea);
    const pending = instance.pendingLargePaste;
    if (pending && pending.initialValue === initialValue && pending.text === text) return true;
    instance.pendingLargePaste = {
      text,
      initialValue,
      wasEmpty: !initialValue.trim(),
      previewApplied: false,
    };
    instance.editor.classList.add("is-pasting");
    instance.editor.setAttribute("aria-busy", "true");
    editable.setAttribute("contenteditable", "false");
    showPlainTextLargePastePreview(instance, instance.pendingLargePaste);

    const run = () => {
      // Give the browser a paint opportunity before starting conversion.
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => {
          const pending = instance.pendingLargePaste;
          if (pending && scheduleWorkerRenderedPaste(instance, pending, syncFromEditor)) return;
          runPendingLargePaste(instance, syncFromEditor);
        });
      } else {
        window.setTimeout(() => {
          const pending = instance.pendingLargePaste;
          if (pending && scheduleWorkerRenderedPaste(instance, pending, syncFromEditor)) return;
          runPendingLargePaste(instance, syncFromEditor);
        }, 0);
      }
    };
    run();
    return true;
  }

  function insertRenderedMarkdownAtSelection(instance, html) {
    const vditor = instance?.vditor;
    const editable = editableElement(vditor);
    const selection = window.getSelection?.();
    if (!vditor || !editable || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editable.contains(range.commonAncestorContainer)) return false;

    // Remove the selected source before asking Vditor to insert the already
    // rendered fragment. Vditor's insertValue() collapses the range itself,
    // so deleting first preserves normal paste replacement semantics.
    if (!range.collapsed) range.deleteContents();
    instance.synchronizing = true;
    try {
      if (typeof vditor.insertValue === "function") {
        vditor.insertValue(html, true);
        return true;
      }

      const template = document.createElement("template");
      template.innerHTML = html;
      const fragment = template.content;
      range.insertNode(fragment);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } finally {
      instance.synchronizing = false;
    }
  }

  function applyWorkerRenderedPaste(instance, pending, html, syncFromEditor) {
    if (!instance?.ready || !pendingLargePasteStillMatches(instance, pending)) {
      if (instance?.pendingLargePaste === pending) finishPendingLargePaste(instance);
      return false;
    }
    const editable = finishPendingLargePaste(instance);
    if (!editable) return false;
    if (pending.wasEmpty) {
      instance.synchronizing = true;
      try {
        editable.innerHTML = html;
        collapseSelectionToEnd(instance);
      } finally {
        instance.synchronizing = false;
      }
    } else if (!insertRenderedMarkdownAtSelection(instance, html)) {
      // The selection may have disappeared while the worker was running.
      // Fall back to Vditor's source insertion path rather than dropping the
      // clipboard payload.
      instance.pendingLargePaste = pending;
      runPendingLargePaste(instance, syncFromEditor, false);
      return false;
    }

    if (pending.wasEmpty) {
      instance.pendingValue = pending.text;
      writeNativeValue(instance.textarea, pending.text);
      instance.textarea.dispatchEvent(new Event("input", { bubbles: true }));
      scheduleEditorShellHeightSync(instance);
      scheduleCaretVisibilitySync(instance);
      return true;
    }

    // Existing drafts need one full-document serialization after the rendered
    // fragment has painted. The worker removed the expensive Markdown parse
    // from the input event's critical path.
    if (syncFromEditor) {
      window.setTimeout(() => {
        if (!instance.ready || instance.pendingLargePaste) return;
        syncFromEditor();
      }, 0);
    }
    scheduleEditorShellHeightSync(instance);
    scheduleCaretVisibilitySync(instance);
    return true;
  }

  function scheduleWorkerRenderedPaste(instance, pending, syncFromEditor) {
    const promise = renderMarkdownInWorker(pending.text);
    if (!promise) return false;
    promise.then((html) => {
      applyWorkerRenderedPaste(instance, pending, html, syncFromEditor);
    }).catch(() => {
      if (instance.pendingLargePaste !== pending) return;
      runPendingLargePaste(instance, syncFromEditor, false);
    });
    return true;
  }

  function mount(textarea, editor) {
    if (!textarea || !editor || mounted.has(textarea) || !VALUE_DESCRIPTOR) return null;

    const nativeFocus = textarea.focus.bind(textarea);
    const nativeBlur = textarea.blur.bind(textarea);
    const nativeSetSelectionRange = textarea.setSelectionRange.bind(textarea);
    const instance = {
      textarea,
      editor,
      vditor: null,
      ready: false,
      blocked: null,
      composing: false,
      synchronizing: false,
      visibilityFrame: 0,
      markdownSyncFrame: 0,
      pendingMarkdownValue: null,
      resizeObserver: null,
      pendingValue: nativeValue(textarea),
      // An external value assignment (send clear, draft restore, or session
      // switch) must win over callbacks that were queued for the previous
      // Vditor document. Keep the target as a barrier until the editor really
      // moves away from it through a new user edit.
      externalValueBarrier: null,
      theme: isDarkTheme() ? "dark" : "classic",
    };
    instance.contentTheme = contentThemeForEditorTheme(instance.theme);
    mounted.set(textarea, instance);
    editor.dataset.ragentEditor = "vditor";

    function syncMarkdown(markdown) {
      const value = String(markdown ?? "");
      if (instance.synchronizing) return;

      const barrier = instance.externalValueBarrier;
      if (barrier !== null) {
        const currentEditorValue = instance.vditor?.getValue?.();
        if (editorValueMatchesExpected(currentEditorValue, barrier) && value !== barrier) {
          // The editor already reflects the newer external value. This is a
          // delayed callback from the document that was just replaced.
          return;
        }
        if (!editorValueMatchesExpected(currentEditorValue, barrier)) {
          // The user edited after the external assignment, so the new editor
          // value is authoritative again.
          instance.externalValueBarrier = null;
        }
      }
      if (value === nativeValue(textarea)) return;
      instance.pendingValue = value;
      writeNativeValue(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function clearPendingMarkdownSync() {
      if (instance.markdownSyncFrame) {
        if (typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(instance.markdownSyncFrame);
        } else {
          window.clearTimeout(instance.markdownSyncFrame);
        }
        instance.markdownSyncFrame = 0;
      }
      instance.pendingMarkdownValue = null;
    }

    function scheduleMarkdownSync(markdown) {
      if (instance.synchronizing) return;
      instance.pendingMarkdownValue = String(markdown ?? "");
      if (instance.markdownSyncFrame) return;
      const run = () => {
        const pendingMarkdown = instance.pendingMarkdownValue;
        instance.markdownSyncFrame = 0;
        instance.pendingMarkdownValue = null;
        if (pendingMarkdown !== null) syncMarkdown(pendingMarkdown);
      };
      if (typeof window.requestAnimationFrame === "function") {
        instance.markdownSyncFrame = window.requestAnimationFrame(run);
      } else {
        instance.markdownSyncFrame = window.setTimeout(run, 0);
      }
    }

    function flushMarkdownSync() {
      if (instance.pendingMarkdownValue === null) return false;
      const pendingMarkdown = instance.pendingMarkdownValue;
      clearPendingMarkdownSync();
      syncMarkdown(pendingMarkdown);
      return true;
    }

    function syncFromEditor() {
      if (!instance.ready || instance.synchronizing || !instance.vditor) return;
      clearPendingMarkdownSync();
      const value = instance.vditor.getValue();
      const before = nativeValue(textarea);
      syncMarkdown(value);
      // Vditor may keep trailing empty paragraphs out of the serialized
      // Markdown source even though the visible document became taller.
      // Notify the composer anyway so its height/layout pass still runs.
      if (value === before) textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function handleEditorKeydown(event) {
      if (event?.key !== "Enter"
        || !event.shiftKey
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      insertTextAtSelection(editableElement(instance.vditor), "\n");
    }

    function handleLongPlainTextPaste(event) {
      const clipboardData = event?.clipboardData;
      if (!clipboardData) return;
      const hasFiles = Array.from(clipboardData.items || []).some((item) => item?.kind === "file");
      if (hasFiles) return;
      const text = clipboardData.getData("text/plain");
      if (text.length < longPasteFastPathThreshold()) return;
      // Prefer the Markdown source even when mobile clipboard providers also
      // expose a large HTML representation. Vditor's clipboard sanitizer and
      // HTML parser otherwise block the main thread and then serialize the
      // resulting DOM back to Markdown a second time.
      event.preventDefault();
      event.stopPropagation();
      schedulePendingLargePaste(instance, text, syncFromEditor);
    }

    function handleLongPasteBeforeInput(event) {
      if (event?.inputType !== "insertFromPaste") return;
      const transfer = event.dataTransfer;
      const hasFiles = Array.from(transfer?.items || []).some((item) => item?.kind === "file");
      if (hasFiles) return;
      // WebKit has shipped beforeinput paste events where dataTransfer is
      // absent but data contains the plain-text payload. Keep both forms on
      // the same deferred path so the page does not wait for a re-entry to
      // reconcile the source textarea with the rendered editor.
      const text = transfer?.getData?.("text/plain") || String(event.data || "");
      if (text.length < longPasteFastPathThreshold()) return;

      // Some mobile browsers expose the clipboard through beforeinput and do
      // not deliver a useful paste event to the contenteditable surface. Take
      // the same deferred path there; a following paste event is deduplicated
      // by schedulePendingLargePaste while this request is pending.
      event.preventDefault();
      event.stopPropagation();
      schedulePendingLargePaste(instance, text, syncFromEditor);
    }

    function handleNativeInput(event) {
      if (event?.isComposing || event?.inputType === "insertCompositionText") {
        instance.composing = true;
        return;
      }
      instance.composing = false;
      // Vditor's `input(value)` callback is the single source of truth for
      // Markdown synchronization. Calling getValue() here as well performs a
      // second full-document serialization on every keystroke, which is
      // especially expensive on mobile CPUs.
      scheduleEditorShellHeightSync(instance);
      scheduleCaretVisibilitySync(instance);
    }

    function handleCompositionStart() {
      instance.composing = true;
    }

    function handleCompositionEnd() {
      instance.composing = false;
      queueMicrotask(syncFromEditor);
      scheduleCaretVisibilitySync(instance);
    }

    function handleSelectionChange() {
      const editable = editableElement(instance.vditor);
      const selection = window.getSelection?.();
      if (editable && selection?.anchorNode && editable.contains(selection.anchorNode)) {
        scheduleCaretVisibilitySync(instance);
      }
    }

    function applyExternalValue(value) {
      const nextValue = String(value ?? "");
      clearPendingMarkdownSync();
      instance.pendingValue = nextValue;
      instance.externalValueBarrier = nextValue;
      if (!instance.vditor || !instance.ready || instance.synchronizing) return;

      const pendingPaste = instance.pendingLargePaste;
      if (pendingPaste?.previewApplied) {
        // The source textarea already holds this exact raw preview. In
        // particular, avoid calling getValue() here: serializing a very large
        // temporary document while Send clears the composer would recreate the
        // very main-thread stall this fast path removes.
        if (nextValue === pendingPaste.text) return;
        finishPendingLargePaste(instance);
        instance.synchronizing = true;
        try {
          instance.vditor.setValue(nextValue, false);
        } finally {
          instance.synchronizing = false;
        }
        syncEditorShellHeight(instance);
        scheduleCaretVisibilitySync(instance);
        return;
      }
      if (editorValueMatchesExpected(instance.vditor.getValue(), nextValue)) return;
      instance.synchronizing = true;
      try {
        instance.vditor.setValue(nextValue, false);
      } finally {
        instance.synchronizing = false;
      }
      syncEditorShellHeight(instance);
      scheduleCaretVisibilitySync(instance);
    }

    instance.vditor = new window.Vditor(editor, {
      value: instance.pendingValue,
      mode: "wysiwyg",
      theme: instance.theme,
      lang: "zh_CN",
      cdn: assetBase,
      _lutePath: `${assetBase}/dist/js/lute/lute.min.js`,
      height: "auto",
      minHeight: 0,
      toolbar: [],
      cache: { enable: false },
      resize: { enable: false },
      counter: { enable: false },
      placeholder: textarea.placeholder || "",
      link: { isOpen: false },
      upload: {},
      preview: {
        theme: {
          current: instance.contentTheme,
          path: `${assetBase}/dist/css/content-theme`,
        },
        markdown: {
          sanitize: true,
          paragraphBeginningSpace: false,
          autoSpace: false,
        },
      },
      after() {
        instance.ready = true;
        instance.blocked = null;
        const editable = editableElement(instance.vditor);
        const content = instance.editor.querySelector(":scope > .vditor-content");
        const wysiwyg = content?.querySelector(":scope > .vditor-wysiwyg");
        const preventInnerScroll = (el) => {
          if (!el) return;
          el.addEventListener("scroll", () => {
            if (el.scrollTop !== 0) el.scrollTop = 0;
            if (el.scrollLeft !== 0) el.scrollLeft = 0;
          }, { passive: true });
        };
        if (editable) {
          preventInnerScroll(editable);
          editable.addEventListener("input", handleNativeInput);
          editable.addEventListener("compositionstart", handleCompositionStart);
          editable.addEventListener("compositionend", handleCompositionEnd);
          editable.addEventListener("keydown", handleEditorKeydown, true);
          editable.addEventListener("beforeinput", handleLongPasteBeforeInput, true);
          editable.addEventListener("paste", handleLongPlainTextPaste, true);
        }
        preventInnerScroll(wysiwyg);
        preventInnerScroll(content);
        applyExternalValue(instance.pendingValue);
        syncEditorShellHeight(instance);
        syncDisabledState(instance);
        if (typeof window.ResizeObserver === "function" && editable) {
          instance.resizeObserver = new window.ResizeObserver(() => {
            // A viewport or composer-width change can create new soft-wrapped
            // lines without an input event. Re-measure the natural document
            // and re-check the caret after the browser commits that layout.
            scheduleEditorShellHeightSync(instance);
            scheduleCaretVisibilitySync(instance);
          });
          instance.resizeObserver.observe(editable);
        }
        document.addEventListener("selectionchange", handleSelectionChange);
        warmMarkdownWorkerWhenIdle();
        editor.dispatchEvent(new CustomEvent("ragent-markdown-editor-ready", { bubbles: true }));
      },
      input(value) {
        if (!instance.composing) scheduleMarkdownSync(value);
        scheduleEditorShellHeightSync(instance);
        scheduleCaretVisibilitySync(instance);
      },
      focus() {
        editor.classList.add("is-focused");
        // Keep the existing composer focus contract alive for code that still
        // listens to the hidden textarea's focus/blur events.
        textarea.dispatchEvent(new Event("focus"));
        scheduleCaretVisibilitySync(instance);
      },
      blur() {
        editor.classList.remove("is-focused");
        textarea.dispatchEvent(new Event("blur"));
      },
    });

    Object.defineProperty(textarea, "value", {
      configurable: true,
      get() {
        return nativeValue(textarea);
      },
      set(value) {
        const nextValue = String(value ?? "");
        writeNativeValue(textarea, nextValue);
        applyExternalValue(nextValue);
      },
    });

    textarea.focus = (...args) => {
      if (textarea.disabled || textarea.readOnly) return nativeFocus(...args);
      if (instance.vditor?.focus) instance.vditor.focus();
      else nativeFocus(...args);
    };
    textarea.blur = () => {
      if (instance.vditor?.blur) instance.vditor.blur();
      else nativeBlur();
    };
    textarea.setSelectionRange = (start, end = start, direction) => {
      nativeSetSelectionRange(start, end, direction);
      if (start === end && start >= nativeValue(textarea).length) collapseSelectionToEnd(instance);
    };

    const themeObserver = new MutationObserver(() => {
      const nextTheme = isDarkTheme() ? "dark" : "classic";
      if (!instance.ready || nextTheme === instance.theme) return;
      instance.theme = nextTheme;
      instance.contentTheme = contentThemeForEditorTheme(nextTheme);
      instance.vditor.setTheme(nextTheme, instance.contentTheme);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });

    const attributeObserver = new MutationObserver(() => syncDisabledState(instance));
    attributeObserver.observe(textarea, { attributes: true, attributeFilter: ["disabled", "readonly", "placeholder"] });
    syncDisabledState(instance);

    instance.destroy = () => {
      themeObserver.disconnect();
      attributeObserver.disconnect();
      instance.resizeObserver?.disconnect?.();
      instance.resizeObserver = null;
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (instance.visibilityFrame) {
        if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(instance.visibilityFrame);
        else window.clearTimeout(instance.visibilityFrame);
        instance.visibilityFrame = 0;
      }
      if (instance.shellHeightFrame) {
        if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(instance.shellHeightFrame);
        else window.clearTimeout(instance.shellHeightFrame);
        instance.shellHeightFrame = 0;
      }
      clearPendingMarkdownSync();
      const editable = editableElement(instance.vditor);
      instance.pendingLargePaste = null;
      if (editable) {
        editable.removeEventListener("input", handleNativeInput);
        editable.removeEventListener("compositionstart", handleCompositionStart);
        editable.removeEventListener("compositionend", handleCompositionEnd);
        editable.removeEventListener("keydown", handleEditorKeydown, true);
        editable.removeEventListener("beforeinput", handleLongPasteBeforeInput, true);
        editable.removeEventListener("paste", handleLongPlainTextPaste, true);
      }
      instance.vditor?.destroy?.();
      mounted.delete(textarea);
    };
    instance.flush = () => {
      // The raw preview has already synchronized the source textarea, so an
      // immediate Send must not turn a responsive paste back into a synchronous
      // full-document Markdown conversion.
      if (instance.pendingLargePaste?.previewApplied) return true;
      const didSyncMarkdown = flushMarkdownSync();
      return runPendingLargePaste(instance, syncFromEditor, true) || didSyncMarkdown;
    };
    instance.refresh = () => applyExternalValue(nativeValue(textarea));
    instance.setHeight = (height) => {
      syncEditorShellHeight(instance, height);
      scheduleCaretVisibilitySync(instance);
    };
    instance.isFocused = () => editor.contains(document.activeElement) || document.activeElement === editor;
    return instance;
  }

  function mountComposer(textarea, editor) {
    if (!window.Vditor) {
      console.error("[markdown-composer] Vditor runtime is unavailable");
      return null;
    }
    return mounted.get(textarea) || mount(textarea, editor);
  }

  window.RagentMarkdownComposer = Object.freeze({
    mount: mountComposer,
    getEditor: (textarea) => mounted.get(textarea)?.editor || null,
    getEditable: (textarea) => editableElement(mounted.get(textarea)?.vditor),
    getVditor: (textarea) => mounted.get(textarea)?.vditor || null,
    flush: (textarea) => mounted.get(textarea)?.flush?.() === true,
    isEditorFocused: (textarea) => mounted.get(textarea)?.isFocused() === true,
    refresh: (textarea) => mounted.get(textarea)?.refresh?.(),
    setHeight: (textarea, height) => mounted.get(textarea)?.setHeight?.(height),
  });

  mountComposer(
    document.getElementById("msgInput"),
    document.getElementById("composerEditor"),
  );
})();

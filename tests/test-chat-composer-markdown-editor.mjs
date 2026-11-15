#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const visualOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || "").trim();
if (visualOutputDir) await mkdir(visualOutputDir, { recursive: true });
const [baseCss, inputCss, responsiveCss, glassCss, fontFile, vditorJs, vditorCss, luteJs, iconsJs, localeJs, lightTheme, darkTheme, adapterJs, workerSource, fullscreenJs, sidebarUiSource, composeSource] = await Promise.all([
  readFile(join(repoRoot, "static/chat/chat-base.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-input.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-responsive.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/chat-glass.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/fonts/InterVariable-latin.woff2")),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/index.min.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/index.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/js/lute/lute.min.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/js/icons/ant.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/js/i18n/zh_CN.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/css/content-theme/light.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/vendor/vditor/dist/css/content-theme/dark.css"), "utf8"),
  readFile(join(repoRoot, "static/chat/markdown-composer-editor.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/markdown-composer-worker.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/composer-fullscreen.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/sidebar-ui.js"), "utf8"),
  readFile(join(repoRoot, "static/chat/compose.js"), "utf8"),
]);

// ---- Attachment routing wiring (static) ----
// Vditor's paste/drop handlers live on the editable surface and call
// stopPropagation() before bubble-phase listeners can see file transfers, so
// the attachment routing must be bound in the capture phase on each editor
// shell (main composer and full-screen composer alike).
assert.match(
  sidebarUiSource,
  /composerShell\.addEventListener\("paste", handleComposerPaste, true\);/,
  "file pastes must be intercepted in the capture phase before Vditor's own paste handler",
);
assert.match(
  sidebarUiSource,
  /composerShell\.addEventListener\("drop", \(event\) => \{\s*void handleComposerFileDrop\(event\);\s*\}, true\);/,
  "file drops must be intercepted in the capture phase before Vditor's own drop handler",
);
assert.match(
  sidebarUiSource,
  /for \(const composerShellId of \["composerEditor", "composerFullscreenEditor"\]\)/,
  "both the main and the full-screen editor shells must route file transfers",
);
assert.match(
  sidebarUiSource,
  /if \(attachmentFiles\.length > 0\) \{\s*\n\s*\/\/ Also keep the event away from the Markdown editor's own paste handler:[\s\S]*?e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);\s*\n\s*addAttachmentFiles\(attachmentFiles\);/,
  "an intercepted paste must be kept away from Vditor's inline base64 embed fallback",
);
assert.match(
  composeSource,
  /window\.RagentMarkdownComposer\?\.flush\?\.\(msgInput\);/,
  "sending immediately after a large paste must flush the pending editor update",
);
assert.match(
  adapterJs,
  /theme:\s*\{\s*current:\s*instance\.contentTheme,\s*path:\s*`\$\{assetBase\}\/dist\/css\/content-theme`,\s*\}/,
  "the editor must initialize Vditor with the content theme that matches the shell theme",
);
assert.match(
  adapterJs,
  /instance\.vditor\.setTheme\(nextTheme, instance\.contentTheme\);/,
  "theme changes must update Vditor's content theme as well as its editor chrome",
);

const assets = new Map([
  ["/fonts/InterVariable-latin.woff2", ["font/woff2", fontFile]],
  ["/chat/vendor/vditor/dist/index.min.js", ["text/javascript", vditorJs]],
  ["/chat/vendor/vditor/dist/index.css", ["text/css", vditorCss]],
  ["/chat/vendor/vditor/dist/js/lute/lute.min.js", ["text/javascript", luteJs]],
  ["/chat/vendor/vditor/dist/js/icons/ant.js", ["text/javascript", iconsJs]],
  ["/chat/vendor/vditor/dist/js/i18n/zh_CN.js", ["text/javascript", localeJs]],
  ["/chat/vendor/vditor/dist/css/content-theme/light.css", ["text/css", lightTheme]],
  ["/chat/vendor/vditor/dist/css/content-theme/dark.css", ["text/css", darkTheme]],
  ["/chat/markdown-composer-editor.js", ["text/javascript", adapterJs]],
  ["/chat/markdown-composer-worker.js", ["text/javascript", workerSource]],
  ["/chat/composer-fullscreen.js", ["text/javascript", fullscreenJs]],
]);
const requests = [];
const failedResponses = [];
const html = `<!doctype html>
<html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/chat/vendor/vditor/dist/index.css">
  <style>
    body { margin: 20px; font-family: system-ui, sans-serif; }
    .input-area { width: 330px; }
    .input-stack, .input-wrapper { width: 100%; }
    .input-row { width: 100%; }
    #messagesFixture { width: 330px; height: 120px; overflow-y: auto; }
    ${baseCss}
    ${inputCss}
    ${responsiveCss}
    ${glassCss}
  </style>
</head><body>
    <div class="messages" id="messagesFixture"><div style="height: 900px"></div></div>
    <div class="input-area" id="inputArea">
      <div class="input-stack">
        <div class="input-wrapper">
          <div class="input-row">
            <div class="composer-markdown-editor" id="composerEditor" contenteditable="false" role="textbox" aria-multiline="true" data-placeholder="Message"></div>
            <textarea id="msgInput" placeholder="Message" aria-hidden="true" tabindex="-1" disabled></textarea>
          </div>
          <div class="input-actions-row"><button id="sendBtn" type="button">Send</button></div>
        </div>
      </div>
    </div>
  </div>
  <div id="composerFullscreen" hidden>
    <div id="composerFullscreenEditor" class="composer-fullscreen-markdown-editor" contenteditable="false" role="textbox" aria-multiline="true" data-placeholder="Message"></div>
    <textarea id="composerFullscreenInput" placeholder="Message"></textarea>
    <button id="composerExpandBtn" type="button">Expand</button>
    <button id="composerFullscreenSendBtn" type="button">Send full-screen</button>
    <button id="composerFullscreenCloseBtn" type="button">Close</button>
  </div>
  <script src="/chat/vendor/vditor/dist/index.min.js"></script>
  <script src="/chat/markdown-composer-editor.js"></script>
  <script src="/chat/composer-fullscreen.js"></script>
</body></html>`;

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/test.html") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
    return;
  }
  const asset = assets.get(path);
  if (!asset) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  response.setHeader("Content-Type", asset[0]);
  response.end(asset[1]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "log" && message.text().startsWith("soft-wrap-reflow-state")) {
    console.log(message.text());
  }
});
page.on("request", (request) => requests.push(request.url()));
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
});

async function waitForValue(predicate, description) {
  await page.waitForFunction(predicate, undefined, { timeout: 5000 }).catch((error) => {
    throw new Error(`Timed out waiting for ${description}: ${error.message}`);
  });
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/test.html`);
  await waitForValue(
    () => Boolean(window.RagentMarkdownComposer?.getVditor?.(document.getElementById("msgInput"))?.vditor?.wysiwyg?.element),
    "Vditor WYSIWYG mount",
  );
  await waitForValue(
    () => Boolean(window.RagentMarkdownComposer?.getVditor?.(document.getElementById("composerFullscreenInput"))?.vditor?.wysiwyg?.element),
    "full-screen Vditor WYSIWYG mount",
  );

  const mounted = await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const editor = document.getElementById("composerEditor");
    const instance = window.RagentMarkdownComposer.getVditor(textarea);
    textarea.disabled = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      rootHasVditorClass: editor.classList.contains("vditor"),
      editableTag: instance.vditor.wysiwyg.element.tagName,
      editable: instance.vditor.wysiwyg.element.getAttribute("contenteditable"),
      hasOldProjection: Boolean(editor.querySelector(".composer-md-source")),
    };
  });
  assert.deepEqual(mounted, {
    rootHasVditorClass: true,
    editableTag: "PRE",
    editable: "true",
    hasOldProjection: false,
  }, "the composer must be the open-source Vditor surface, not the retired local projection");

  const shellStyles = await page.locator("#composerEditor .vditor-wysiwyg > pre").evaluate((node) => ({
    padding: getComputedStyle(node).padding,
    overflowX: getComputedStyle(node).overflowX,
    overflowY: getComputedStyle(node).overflowY,
    maxHeight: getComputedStyle(node).maxHeight,
    wysiwygOverflowY: getComputedStyle(node.parentElement).overflowY,
    rootOverflowY: getComputedStyle(node.closest(".composer-markdown-editor")).overflowY,
    rootBorder: getComputedStyle(node.parentElement.parentElement.parentElement).border,
  }));
  assert.equal(shellStyles.padding, "0px", "Vditor's default editor padding must not change the Ragent composer shell");
  // Single scroll container: the shell root owns the growth cap and the
  // scrollbar; the editable document must never open a second nested track.
  // Both axes must be visible because Vditor's generic
  // `.vditor-reset { overflow: auto }` would otherwise pair with a
  // single-axis override and recompute back to auto.
  assert.equal(shellStyles.overflowX, "visible");
  assert.equal(shellStyles.overflowY, "visible");
  assert.equal(shellStyles.maxHeight, "none");
  assert.equal(shellStyles.wysiwygOverflowY, "visible", "the WYSIWYG wrapper must not clip the final document line");
  assert.equal(shellStyles.rootOverflowY, "auto");
  assert.match(shellStyles.rootBorder, /0px/, "Vditor's default border must not remain around the shell");

  const editor = page.locator("#composerEditor .vditor-wysiwyg > pre");
  const emptyEditorState = await editor.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(node).lineHeight),
    rootHeight: node.closest(".composer-markdown-editor")?.clientHeight,
  }));
  assert.ok(
    emptyEditorState.rootHeight >= emptyEditorState.lineHeight - 1
      && emptyEditorState.rootHeight <= emptyEditorState.lineHeight + 2,
    `empty composer should reserve one line (${emptyEditorState.rootHeight}px vs ${emptyEditorState.lineHeight}px)`,
  );
  await editor.click();
  await page.keyboard.type("first");
  await waitForValue(
    () => document.getElementById("msgInput").value.includes("first"),
    "immediate hidden textarea synchronization",
  );
  assert.equal(await page.locator("#msgInput").inputValue(), "first\n", "Vditor's documented block serializer newline should be the sent value");

  const messageRailState = await page.evaluate(() => {
    const messages = document.getElementById("messagesFixture");
    document.body.classList.add("composer-input-focused");
    const style = getComputedStyle(messages);
    const before = messages.scrollTop;
    messages.scrollTop = 120;
    return {
      scrollbarWidth: style.scrollbarWidth,
      webkitScrollbarDisplay: getComputedStyle(messages, "::-webkit-scrollbar").display,
      scrollRange: messages.scrollHeight - messages.clientHeight,
      canStillScroll: messages.scrollTop > before,
    };
  });
  assert.equal(messageRailState.scrollbarWidth, "none", "the background message rail must be visually hidden while composing");
  assert.equal(messageRailState.webkitScrollbarDisplay, "none", "the background message rail must not paint a second WebKit track while composing");
  assert.ok(messageRailState.scrollRange > 0 && messageRailState.canStillScroll, "hiding the background rail must not disable message scrolling");

  await page.evaluate(() => {
    document.getElementById("msgInput").value = "## Delivery plan\n\n**Important**: verify `healthz` and ~~obsolete~~.";
  });
  await page.locator("#composerEditor h2").waitFor();
  assert.equal(await page.locator("#composerEditor strong").textContent(), "Important");
  assert.equal((await page.locator("#composerEditor code").textContent()).replace(/\u200b/g, ""), "healthz");
  assert.equal((await page.locator("#composerEditor del, #composerEditor s").textContent()).replace(/\u200b/g, ""), "obsolete");
  assert.equal(await page.locator("#msgInput").inputValue(), "## Delivery plan\n\n**Important**: verify `healthz` and ~~obsolete~~.");
  assert.equal((await editor.textContent()).includes("**Important**"), false, "visible WYSIWYG text must not expose bold delimiters");
  assert.equal((await editor.textContent()).includes("~~obsolete~~"), false, "visible WYSIWYG text must not expose strike delimiters");

  await page.evaluate(() => {
    document.getElementById("msgInput").value = "hello";
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const paragraph = document.querySelector("#composerEditor .vditor-wysiwyg p");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new DataTransfer();
    data.setData("text/plain", " PASTE");
    document.querySelector("#composerEditor .vditor-wysiwyg > pre").dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await waitForValue(() => document.getElementById("msgInput").value.includes("PASTE"), "Vditor paste synchronization");
  assert.equal(await page.locator("#msgInput").inputValue(), "helloPASTE\n", "Vditor should own plain-text paste normalization and source serialization");

  // Image pastes must become attachments, never inline base64 embeds.
  // Vditor's own paste handler runs on the editable surface, calls
  // stopPropagation() first, and — with no upload backend configured —
  // inserts the pasted image as a base64 <img> in the draft. Ragent routes
  // file transfers in the capture phase on each editor shell, which runs
  // before Vditor's listeners. First prove the vendor fallback still exists
  // (the failure mode being defended against), then prove capture wins.
  const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMDEgAQBGKQEDyR3jigAAAABJRU5ErkJggg==";
  const pasteImage = () => page.evaluate((dataUrl) => {
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    document.querySelector("#composerEditor .vditor-wysiwyg > pre").dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, pngDataUrl);

  await page.evaluate(() => { document.getElementById("msgInput").value = "before image"; });
  await page.waitForTimeout(100);
  await pasteImage();
  await page.waitForTimeout(200);
  const fallbackState = await page.evaluate(() => ({
    value: document.getElementById("msgInput").value,
    imgs: document.querySelectorAll("#composerEditor img, #composerFullscreenEditor img").length,
  }));
  assert.ok(
    fallbackState.value.includes("![shot.png](data:image/png;base64,") || fallbackState.imgs > 0,
    "expected Vditor's unconfigured-upload fallback to inline-embed pasted images (the failure mode capture-phase routing defends against)",
  );

  await page.evaluate(() => { document.getElementById("msgInput").value = ""; });
  await page.waitForTimeout(100);
  // Mirror sidebar-ui.js: capture-phase paste routing on both editor shells.
  await page.evaluate(() => {
    window.__pastedFiles = [];
    window.__routeComposerPasteFiles = (event) => {
      const files = Array.from(event.clipboardData?.items || [])
        .map((item) => typeof item.getAsFile === "function" ? item.getAsFile() : null)
        .filter(Boolean);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      window.__pastedFiles.push(...files.map((file) => file.name));
    };
    for (const shellId of ["composerEditor", "composerFullscreenEditor"]) {
      document.getElementById(shellId)?.addEventListener("paste", window.__routeComposerPasteFiles, true);
    }
  });
  await pasteImage();
  await page.waitForTimeout(200);
  const routedState = await page.evaluate(() => ({
    files: window.__pastedFiles,
    value: document.getElementById("msgInput").value,
    imgs: document.querySelectorAll("#composerEditor img, #composerFullscreenEditor img").length,
  }));
  assert.deepEqual(routedState.files, ["shot.png"], "a pasted image must reach the attachment routing");
  assert.equal(routedState.imgs, 0, "a pasted image must not be inserted into either editor");
  assert.equal(
    routedState.value.includes("data:image"),
    false,
    "a pasted image must never be serialized into the draft as base64 Markdown",
  );

  // Plain text must still flow through to Vditor when the capture routing is
  // installed (non-file transfers are ignored by the routing).
  await page.evaluate(() => { window.__pastedFiles = []; });
  await page.evaluate(() => { document.getElementById("msgInput").value = "plain text"; });
  await page.locator("#composerEditor .vditor-wysiwyg p").waitFor();
  await page.evaluate(() => {
    const paragraph = document.querySelector("#composerEditor .vditor-wysiwyg p");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new DataTransfer();
    data.setData("text/plain", "MORE");
    document.querySelector("#composerEditor .vditor-wysiwyg > pre").dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await waitForValue(() => document.getElementById("msgInput").value.includes("MORE"), "text paste with capture routing installed");
  assert.equal(await page.evaluate(() => window.__pastedFiles.length), 0, "plain-text pastes must not be routed as attachments");
  await page.evaluate(() => { document.getElementById("msgInput").value = ""; });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    document.getElementById("msgInput").value = "undo";
  });
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await waitForValue(() => document.getElementById("msgInput").value.includes("undo!"), "typed undo fixture");
  await page.waitForTimeout(1000);
  await page.keyboard.press("Control+Z");
  await waitForValue(() => !document.getElementById("msgInput").value.includes("undo!"), "Vditor undo");
  await page.keyboard.press("Control+Y");
  await waitForValue(() => document.getElementById("msgInput").value.includes("undo!"), "Vditor redo");

  await page.evaluate(() => {
    document.getElementById("msgInput").value = "Send **this**";
    window.sentValue = null;
    document.getElementById("sendBtn").onclick = () => { window.sentValue = document.getElementById("msgInput").value; };
  });
  await page.locator("#sendBtn").click();
  assert.equal(await page.evaluate(() => window.sentValue), "Send **this**", "the existing send path must receive Markdown source, not editor HTML");

  // External clears (send, session switch, or recovery) must form a barrier
  // against a callback that was queued by the previous editor value. A stale
  // Vditor callback must never refill the hidden textarea after the send path
  // has already cleared it.
  await page.evaluate(() => {
    const textarea = document.getElementById("msgInput");
    const instance = window.RagentMarkdownComposer.getVditor(textarea);
    textarea.value = "stale **send**";
    const staleInput = instance.vditor.options.input;
    textarea.value = "";
    window.setTimeout(() => staleInput("stale **send**"), 0);
  });
  await page.waitForTimeout(80);
  assert.equal(await page.locator("#msgInput").inputValue(), "", "a stale editor callback must not restore a sent draft");
  assert.equal(await editor.textContent(), "", "the visible editor must stay empty after the stale callback");

  await page.evaluate(() => {
    document.getElementById("msgInput").value = "Full-screen **bold**";
    window.RagentComposerFullscreen.open();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#composerFullscreenEditor strong").textContent(), "bold");
  assert.equal(await page.locator("#composerFullscreenInput").inputValue(), "Full-screen **bold**");
  const fullscreenShellStyles = await page.locator("#composerFullscreenEditor .vditor-wysiwyg > pre").evaluate((node) => ({
    padding: getComputedStyle(node).padding,
    overflowX: getComputedStyle(node).overflowX,
    overflowY: getComputedStyle(node).overflowY,
    maxHeight: getComputedStyle(node).maxHeight,
    rootOverflowY: getComputedStyle(node.closest(".composer-fullscreen-markdown-editor")).overflowY,
    rootBorder: getComputedStyle(node.parentElement.parentElement.parentElement).border,
    toolbarDisplay: getComputedStyle(node.closest(".vditor")?.querySelector(".vditor-toolbar")).display,
  }));
  assert.equal(fullscreenShellStyles.padding, "0px", "full-screen Vditor must use the Ragent editor shell padding");
  assert.equal(fullscreenShellStyles.overflowX, "visible", "full-screen editable content must not scroll horizontally on its own");
  assert.equal(fullscreenShellStyles.overflowY, "visible", "full-screen editable content must not open a second vertical track");
  assert.equal(fullscreenShellStyles.maxHeight, "none", "full-screen editable content must grow into the shell scroll range");
  assert.equal(fullscreenShellStyles.rootOverflowY, "auto", "the full-screen shell must own the vertical scroll");
  assert.match(fullscreenShellStyles.rootBorder, /0px/, "full-screen Vditor must not retain its default border");
  assert.equal(fullscreenShellStyles.toolbarDisplay, "none", "full-screen Vditor must not expose its own toolbar");
  await page.evaluate(() => window.RagentComposerFullscreen.close());
  assert.equal(await page.locator("#msgInput").inputValue(), "Full-screen **bold**", "closing full-screen editing must return Markdown to the main composer");

  const disabled = await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    textarea.disabled = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return editable.getAttribute("contenteditable");
  });
  assert.equal(disabled, "false", "disabled state must reach Vditor's editable surface");
  await page.evaluate(() => { document.getElementById("msgInput").disabled = false; });

  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.waitForFunction(() => document.getElementById("vditorContentTheme")?.href.endsWith("/dark.css"));
  await page.waitForTimeout(260);
  const darkThemeState = await page.evaluate(() => ({
    editorClass: document.getElementById("composerEditor")?.className || "",
    contentThemeHref: document.getElementById("vditorContentTheme")?.getAttribute("href") || "",
  }));
  assert.match(darkThemeState.editorClass, /\bvditor--dark\b/, "dark mode must update Vditor's editor chrome");
  assert.match(darkThemeState.contentThemeHref, /\/dark\.css$/, "dark mode must load Vditor's dark content theme");
  if (visualOutputDir) await page.screenshot({ path: join(visualOutputDir, "composer-dark-390.png"), fullPage: false });

  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.waitForFunction(() => document.getElementById("vditorContentTheme")?.href.endsWith("/light.css"));
  await page.waitForTimeout(260);
  const lightThemeState = await page.evaluate(() => ({
    editorClass: document.getElementById("composerEditor")?.className || "",
    contentThemeHref: document.getElementById("vditorContentTheme")?.getAttribute("href") || "",
  }));
  assert.equal(lightThemeState.editorClass.includes("vditor--dark"), false, "light mode must remove Vditor's dark editor chrome");
  assert.match(lightThemeState.contentThemeHref, /\/light\.css$/, "light mode must restore Vditor's light content theme");
  if (visualOutputDir) await page.screenshot({ path: join(visualOutputDir, "composer-light-390.png"), fullPage: false });

  await page.evaluate(() => {
    document.getElementById("msgInput").value = "one line";
  });
  await page.waitForTimeout(100);
  const shortState = await editor.evaluate((node) => {
    const root = node.closest(".composer-markdown-editor");
    return {
      rootHeight: root?.clientHeight,
      rootScrollHeight: root?.scrollHeight,
      rootScrollTop: root?.scrollTop,
    };
  });
  assert.equal(
    shortState.rootScrollHeight,
    shortState.rootHeight,
    "a one-line Markdown draft must not expose a premature composer scroll range",
  );
  assert.equal(shortState.rootScrollTop, 0, "a short Markdown draft must start at the top of the composer");

  await page.evaluate(() => {
    document.getElementById("msgInput").value = Array.from({ length: 30 }, (_, index) => `- item ${index + 1}`).join("\n");
  });
  const longState = await editor.evaluate((node) => {
    const root = node.closest(".composer-markdown-editor");
    const scrollAncestors = [];
    let ancestor = node;
    while (ancestor && ancestor !== document.body) {
      const style = getComputedStyle(ancestor);
      if (["auto", "scroll", "overlay"].includes(style.overflowY)) {
        scrollAncestors.push({
          id: ancestor.id,
          className: ancestor.className,
          overflowY: style.overflowY,
          scrollHeight: ancestor.scrollHeight,
          clientHeight: ancestor.clientHeight,
        });
      }
      ancestor = ancestor.parentElement;
    }
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowX: getComputedStyle(node).overflowX,
      overflowY: getComputedStyle(node).overflowY,
      rootHeight: root?.clientHeight,
      rootScrollHeight: root?.scrollHeight,
      rootOverflowY: root ? getComputedStyle(root).overflowY : null,
      rootMaxHeight: root ? parseFloat(getComputedStyle(root).maxHeight) : null,
      scrollAncestors,
    };
  });
  // Single scroll container past the cap: the editable document stays
  // unscrollable and the shell root clips and scrolls the whole document.
  assert.equal(longState.overflowX, "visible", "the editable document must not scroll horizontally on its own");
  assert.equal(longState.overflowY, "visible", "the editable document must not open a second vertical track past the cap");
  assert.equal(longState.rootOverflowY, "auto", "the shell root is the composer's scroll container");
  assert.ok(longState.rootScrollHeight > longState.rootHeight, "long Markdown must remain scrollable inside the composer cap");
  assert.ok(
    longState.rootScrollHeight >= longState.scrollHeight - 2,
    "the root scroll region must expose the whole editable document",
  );
  assert.ok(
    Math.abs(longState.rootScrollHeight - longState.scrollHeight) <= 2,
    "the composer must not add an empty trailing scroll range below long Markdown",
  );
  assert.deepEqual(
    longState.scrollAncestors.map(({ id }) => id),
    ["composerEditor"],
    "the editable document must have exactly one scroll owner inside the composer",
  );
  assert.ok(
    longState.rootHeight <= (longState.rootMaxHeight || Infinity) + 0.5,
    "the shell must never be stamped taller than its own growth cap",
  );

  // The adapter's shell sync must clamp externally requested heights to the
  // cap so a stale or natural document height cannot overflow the shell.
  await page.evaluate(() => {
    window.RagentMarkdownComposer.setHeight(document.getElementById("msgInput"), 10000);
  });
  const clampedState = await editor.evaluate((node) => {
    const root = node.closest(".composer-markdown-editor");
    return {
      inlineHeight: parseFloat(root.style.height),
      maxHeight: parseFloat(getComputedStyle(root).maxHeight),
    };
  });
  assert.ok(
    clampedState.inlineHeight <= clampedState.maxHeight + 0.5,
    `the shell sync must clamp to the composer cap (${clampedState.inlineHeight}px vs ${clampedState.maxHeight}px)`,
  );

  await page.evaluate(() => { document.getElementById("msgInput").value = ""; });
  await page.waitForTimeout(100);
  const clearedState = await editor.evaluate((node) => ({
    clientHeight: node.clientHeight,
    lineHeight: parseFloat(getComputedStyle(node).lineHeight),
    rootHeight: node.closest(".composer-markdown-editor")?.clientHeight,
  }));
  assert.ok(
    clearedState.rootHeight >= clearedState.lineHeight - 1
      && clearedState.rootHeight <= clearedState.lineHeight + 2,
    `clearing the draft should restore one line (${clearedState.rootHeight}px vs ${clearedState.lineHeight}px)`,
  );

  // A contenteditable can leave the caret below the clipped portion when its
  // height and Markdown layout change in the same frame. Selection changes
  // must recover the single composer scroll container in either direction.
  const caretVisibility = await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const instance = window.RagentMarkdownComposer.getVditor(textarea);
    const editable = instance.vditor.wysiwyg.element;
    const root = document.getElementById("composerEditor");
    textarea.value = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    await new Promise((resolve) => setTimeout(resolve, 120));
    editable.focus();
    const selectOffset = (offset) => {
      const paragraph = editable.querySelector("p") || editable;
      const textNode = paragraph.firstChild || paragraph;
      const range = document.createRange();
      range.setStart(textNode, Math.min(offset, textNode.textContent?.length || 0));
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    };
    selectOffset(0);
    root.scrollTop = root.scrollHeight;
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const topScrollTop = root.scrollTop;

    const paragraphs = Array.from(editable.querySelectorAll("p"));
    const lastParagraph = paragraphs[paragraphs.length - 1] || editable;
    const lastTextNode = lastParagraph.firstChild || lastParagraph;
    const endRange = document.createRange();
    endRange.selectNodeContents(lastTextNode);
    endRange.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(endRange);
    root.scrollTop = 0;
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      topScrollTop,
      bottomScrollTop: root.scrollTop,
      maxScrollTop: root.scrollHeight - root.clientHeight,
    };
  });
  assert.ok(
    caretVisibility.topScrollTop < caretVisibility.maxScrollTop - 1,
    "moving the caret to the first line should reveal the top of the document",
  );
  assert.ok(
    caretVisibility.bottomScrollTop > 0
      && caretVisibility.bottomScrollTop <= caretVisibility.maxScrollTop + 1,
    "moving the caret to the last line should reveal it inside the composer scroll range",
  );

  await page.evaluate(() => {
    const root = document.getElementById("composerEditor");
    root.scrollTop = root.scrollHeight;
  });
  const scrollBeforeTypingAtEnd = await page.locator("#composerEditor").evaluate((node) => node.scrollTop);
  await page.keyboard.type(" tail");
  await page.waitForTimeout(100);
  const scrollAfterTypingAtEnd = await page.locator("#composerEditor").evaluate((node) => node.scrollTop);
  assert.ok(
    scrollAfterTypingAtEnd >= scrollBeforeTypingAtEnd - 2,
    `typing at the composer scroll end must not jump to the top (${scrollBeforeTypingAtEnd} -> ${scrollAfterTypingAtEnd})`,
  );

  await page.setViewportSize({ width: 1200, height: 844 });
  await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    textarea.value = "";
    await new Promise((resolve) => setTimeout(resolve, 100));
    editable.focus();
  });
  const emptyComposerHeight = await editor.evaluate((node) => ({
    height: node.closest(".composer-markdown-editor")?.clientHeight || 0,
    lineHeight: parseFloat(getComputedStyle(node).lineHeight),
  }));
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.waitForTimeout(120);
  const emptyLineState = await page.evaluate(() => ({
    paragraphCount: document.querySelectorAll("#composerEditor .vditor-wysiwyg p").length,
    rootHeight: document.getElementById("composerEditor").clientHeight,
  }));
  assert.ok(
    emptyLineState.paragraphCount >= 4,
    "Shift+Enter should preserve line breaks even when the draft contains no text",
  );
  assert.ok(
    emptyLineState.rootHeight >= emptyComposerHeight.height + emptyComposerHeight.lineHeight * 2 - 2,
    "blank-only line breaks should still grow the composer",
  );

  await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    textarea.value = "alpha";
    await new Promise((resolve) => setTimeout(resolve, 100));
    const paragraph = editable.querySelector("p") || editable;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
  });
  const initialComposerHeight = await editor.evaluate((node) => ({
    height: node.closest(".composer-markdown-editor")?.clientHeight || 0,
    lineHeight: parseFloat(getComputedStyle(node).lineHeight),
  }));
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.waitForTimeout(120);
  const blankLineState = await page.evaluate(() => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    const root = document.getElementById("composerEditor");
    return {
      value: textarea.value,
      paragraphCount: editable.querySelectorAll("p").length,
      rootHeight: root.clientHeight,
    };
  });
  assert.ok(
    blankLineState.paragraphCount >= 4,
    "Shift+Enter should create visible empty paragraphs instead of being swallowed",
  );
  assert.ok(
    blankLineState.rootHeight >= initialComposerHeight.height + initialComposerHeight.lineHeight * 2 - 2,
    `empty line breaks should grow the composer (${blankLineState.rootHeight}px vs ${initialComposerHeight.height}px)`,
  );

  await page.keyboard.type("beta");
  await waitForValue(
    () => document.getElementById("msgInput").value.includes("beta"),
    "text typed after Shift+Enter",
  );
  const shiftEnterValue = await page.locator("#msgInput").inputValue();
  assert.ok(
    shiftEnterValue.indexOf("alpha") < shiftEnterValue.indexOf("beta")
      && shiftEnterValue.slice(shiftEnterValue.indexOf("alpha"), shiftEnterValue.indexOf("beta")).includes("\n"),
    "desktop Shift+Enter should preserve a Markdown line break before subsequent text",
  );

  await page.evaluate(() => {
    const textarea = document.getElementById("msgInput");
    window.__singleInputEventCount = 0;
    window.__singleInputEventListener = () => { window.__singleInputEventCount += 1; };
    textarea.addEventListener("input", window.__singleInputEventListener);
  });
  await page.locator("#composerEditor").focus();
  await page.keyboard.type("input-event-marker");
  await waitForValue(
    () => document.getElementById("msgInput").value.includes("input-event-marker"),
    "single editor edit",
  );
  const singleInputEventCount = await page.evaluate(() => {
    const textarea = document.getElementById("msgInput");
    textarea.removeEventListener("input", window.__singleInputEventListener);
    return window.__singleInputEventCount;
  });
  assert.equal(
    singleInputEventCount,
    1,
    "a single editor edit should synchronize the hidden textarea once",
  );

  const longPasteText = [
    "**paste-fast-path-marker**",
    ...Array.from({ length: 700 }, (_, index) => `line ${index + 1} with enough Markdown text to exceed the fast-path threshold`),
  ].join("\n");
  await page.evaluate(() => {
    document.getElementById("msgInput").value = "";
  });
  await page.waitForTimeout(100);
  await page.evaluate((text) => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    const paragraph = editable.querySelector("p") || editable;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    window.__longPasteDispatchResult = editable.dispatchEvent(event);
    window.__longPasteImmediateState = {
      previewText: editable.textContent,
      sourceValue: textarea.value,
      busy: editable.closest(".composer-markdown-editor")?.getAttribute("aria-busy"),
      editable: editable.getAttribute("contenteditable"),
    };
  }, longPasteText);
  const longPasteImmediateState = await page.evaluate(() => window.__longPasteImmediateState);
  assert.match(
    longPasteImmediateState.previewText,
    /paste-fast-path-marker/,
    "large mobile pastes should show their source text before background Markdown rendering finishes",
  );
  assert.match(
    longPasteImmediateState.sourceValue,
    /paste-fast-path-marker/,
    "large mobile pastes should make their source value available immediately",
  );
  assert.equal(longPasteImmediateState.busy, "true", "the raw paste preview should remain marked busy until Markdown formatting is ready");
  assert.equal(longPasteImmediateState.editable, "false", "the raw paste preview should not accept edits while its Markdown replacement is pending");
  await waitForValue(
    () => document.querySelector("#composerEditor strong")?.textContent.includes("paste-fast-path-marker")
      && !document.getElementById("composerEditor").hasAttribute("aria-busy"),
    "long plain-text paste Markdown rendering",
  );
  assert.equal(
    await page.evaluate(() => window.__longPasteDispatchResult),
    false,
    "long plain-text paste should be handled by the editor fast path",
  );
  assert.ok(
    await page.locator("#composerEditor strong").filter({ hasText: "paste-fast-path-marker" }).count(),
    "long Markdown paste should still render Markdown emphasis",
  );
  assert.equal(
    await page.evaluate(() => window.RagentMarkdownComposer
      .getVditor(document.getElementById("msgInput"))
      .getValue()
      .includes("paste-fast-path-marker")),
    true,
    "worker-rendered Markdown must also be visible to Vditor's live document",
  );
  assert.ok(
    requests.includes(`${new URL(page.url()).origin}/chat/markdown-composer-worker.js`),
    "large Markdown paste should load the off-main-thread renderer",
  );

  // Send clears the textarea as soon as it accepts the draft. If that happens
  // while a raw large-paste preview is still awaiting Worker output, clearing
  // must not call getValue() and serialize the temporary full document on the
  // main thread.
  const pendingPasteClearState = await page.evaluate((text) => {
    const textarea = document.getElementById("msgInput");
    const editor = window.RagentMarkdownComposer.getVditor(textarea);
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    textarea.value = "";
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    editable.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
    const originalGetValue = editor.getValue.bind(editor);
    let getValueCalls = 0;
    editor.getValue = () => {
      getValueCalls += 1;
      return originalGetValue();
    };
    const startedAt = performance.now();
    try {
      textarea.value = "";
    } finally {
      editor.getValue = originalGetValue;
    }
    return {
      elapsedMs: performance.now() - startedAt,
      getValueCalls,
      sourceValue: textarea.value,
      previewText: editable.textContent,
      busy: editable.closest(".composer-markdown-editor")?.getAttribute("aria-busy"),
      editable: editable.getAttribute("contenteditable"),
    };
  }, longPasteText);
  assert.equal(pendingPasteClearState.getValueCalls, 0, "clearing a raw large-paste preview must not serialize the preview document");
  assert.ok(pendingPasteClearState.elapsedMs < 500, `clearing a raw large-paste preview should return promptly (${pendingPasteClearState.elapsedMs}ms)`);
  assert.equal(pendingPasteClearState.sourceValue, "", "clearing a raw large-paste preview should immediately clear the textarea");
  assert.doesNotMatch(pendingPasteClearState.previewText, /paste-fast-path-marker/, "clearing a raw large-paste preview should remove its temporary source text");
  assert.equal(pendingPasteClearState.busy, null, "clearing a raw large-paste preview should cancel its pending busy state");
  assert.equal(pendingPasteClearState.editable, "true", "clearing a raw large-paste preview should restore editing");

  // Mobile clipboard providers often include both Markdown source and a rich
  // HTML rendition. Large source pastes must stay on the Markdown fast path;
  // otherwise Vditor's async HTML sanitizer keeps the page busy after the
  // paste event has already returned.
  await page.evaluate(() => {
    document.getElementById("msgInput").value = "";
  });
  await page.waitForTimeout(100);
  const longRichPasteDispatchMs = await page.evaluate((text) => {
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    const paragraph = editable.querySelector("p") || editable;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    data.setData("text/html", `<p>${text.replaceAll("\\n", "<br>")}</p>`);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    const startedAt = performance.now();
    editable.dispatchEvent(event);
    return performance.now() - startedAt;
  }, longPasteText);
  assert.ok(longRichPasteDispatchMs < 500, `large rich clipboard paste should return promptly (${longRichPasteDispatchMs}ms)`);
  await waitForValue(
    () => document.querySelector("#composerEditor strong")?.textContent.includes("paste-fast-path-marker")
      && !document.getElementById("composerEditor").hasAttribute("aria-busy"),
    "long rich-clipboard Markdown rendering",
  );
  assert.ok(
    await page.locator("#composerEditor strong").filter({ hasText: "paste-fast-path-marker" }).count(),
    "large rich-clipboard Markdown paste should render Markdown emphasis",
  );

  const existingDraftPasteText = [
    "**existing-draft-paste-marker**",
    ...Array.from({ length: 260 }, (_, index) => `inserted line ${index + 1} with Markdown content and enough payload`),
  ].join("\n");
  await page.evaluate(() => {
    document.getElementById("msgInput").value = "prefix";
  });
  await page.waitForTimeout(100);
  const flushResult = await page.evaluate((text) => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    const paragraphs = editable.querySelectorAll("p");
    const paragraph = paragraphs[paragraphs.length - 1] || editable;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    data.setData("text/html", `<p>${text.replaceAll("\n", "<br>")}</p>`);
    editable.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
    return window.RagentMarkdownComposer.flush(textarea);
  }, existingDraftPasteText);
  assert.equal(flushResult, true, "a pending large paste should flush synchronously for an immediate send");
  await waitForValue(
    () => document.getElementById("msgInput").value.includes("existing-draft-paste-marker"),
    "large Markdown paste into an existing draft",
  );
  assert.match(
    await page.locator("#msgInput").inputValue(),
    /^prefix[\s\S]*existing-draft-paste-marker/,
    "flushing a large paste must preserve the existing draft before the insertion",
  );
  assert.ok(
    await page.locator("#composerEditor strong").filter({ hasText: "existing-draft-paste-marker" }).count(),
    "large Markdown paste into an existing draft should render Markdown emphasis",
  );

  // Existing drafts used to bypass the worker and call Vditor.insertMD(),
  // which parses the complete pasted Markdown on the UI thread. Keep this
  // asynchronous case separate from the send-time flush above: an immediate
  // send intentionally takes the synchronous, correctness-first fallback.
  const workerExistingDraftPasteText = [
    "**worker-existing-draft-marker**",
    // This is deliberately between the 4 KiB mobile and 8 KiB desktop
    // thresholds, proving that mobile gets the lower Worker cutoff.
    ...Array.from({ length: 70 }, (_, index) => `worker inserted line ${index + 1} with Markdown content and enough payload`),
  ].join("\n");
  await page.evaluate(() => {
    const textarea = document.getElementById("msgInput");
    const editor = window.RagentMarkdownComposer.getVditor(textarea);
    textarea.value = "worker prefix";
    window.__originalInsertMd = editor.insertMD.bind(editor);
    window.__insertMdCalledForWorkerPaste = false;
    editor.insertMD = () => {
      window.__insertMdCalledForWorkerPaste = true;
      throw new Error("existing-draft worker paste should not parse Markdown on the UI thread");
    };
  });
  await page.waitForTimeout(100);
  await page.evaluate((text) => {
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    const paragraph = editable.querySelector("p") || editable;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    editable.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, workerExistingDraftPasteText);
  await waitForValue(
    () => document.getElementById("msgInput").value.includes("worker-existing-draft-marker"),
    "worker-rendered large paste into an existing draft",
  );
  const workerExistingDraftPasteState = await page.evaluate(() => {
    const textarea = document.getElementById("msgInput");
    const editor = window.RagentMarkdownComposer.getVditor(textarea);
    editor.insertMD = window.__originalInsertMd;
    delete window.__originalInsertMd;
    return {
      value: textarea.value,
      insertMdCalled: window.__insertMdCalledForWorkerPaste,
    };
  });
  assert.equal(
    workerExistingDraftPasteState.insertMdCalled,
    false,
    "large pastes into existing drafts should use the worker-rendered insertion path",
  );
  assert.match(
    workerExistingDraftPasteState.value,
    /^worker prefix[\s\S]*worker-existing-draft-marker/,
    "worker insertion must retain the existing draft before the pasted Markdown",
  );
  assert.ok(
    await page.locator("#composerEditor strong").filter({ hasText: "worker-existing-draft-marker" }).count(),
    "worker-rendered pastes into existing drafts should preserve Markdown formatting",
  );

  // A soft-wrapped document can create its first scroll range without a
  // newline input event. Keep a first-line caret at the top while the shell
  // crosses the mobile growth cap.
  const softWrapState = await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const root = document.getElementById("composerEditor");
    const editable = root.querySelector(".vditor-wysiwyg > pre");
    textarea.value = "soft wrap ".repeat(120);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const firstParagraph = editable.querySelector("p") || editable;
    const firstText = firstParagraph.firstChild || firstParagraph;
    editable.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    root.scrollTop = root.scrollHeight;
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      scrollTop: root.scrollTop,
      maxScrollTop: root.scrollHeight - root.clientHeight,
      firstLineTop: editable.getBoundingClientRect().top,
      rootTop: root.getBoundingClientRect().top,
    };
  });
  assert.ok(softWrapState.maxScrollTop > 0, "soft-wrapped text must create a composer scroll range");
  assert.ok(softWrapState.scrollTop <= 1, `soft-wrap layout must keep the first line visible (${JSON.stringify(softWrapState)})`);
  assert.ok(softWrapState.firstLineTop >= softWrapState.rootTop - 1, "the first soft-wrapped line must not be clipped above the shell");

  const softWrapReflowState = await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const row = document.querySelector(".input-row");
    const root = document.getElementById("composerEditor");
    const editable = root.querySelector(".vditor-wysiwyg > pre");
    row.style.width = "900px";
    textarea.value = "soft width ".repeat(30);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const paragraph = editable.querySelector("p") || editable;
    const textNode = paragraph.firstChild || paragraph;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editable.focus();
    root.scrollTop = 0;
    row.style.width = "230px";
    await new Promise((resolve) => setTimeout(resolve, 160));
    const state = {
      scrollTop: root.scrollTop,
      maxScrollTop: root.scrollHeight - root.clientHeight,
      firstLineTop: editable.getBoundingClientRect().top,
      rootTop: root.getBoundingClientRect().top,
      rootHeight: root.clientHeight,
      rootScrollHeight: root.scrollHeight,
      editableHeight: editable.getBoundingClientRect().height,
      editableScrollHeight: editable.scrollHeight,
      lastContentBottom: editable.lastElementChild?.getBoundingClientRect().bottom || 0,
      rootBottom: root.getBoundingClientRect().bottom,
      rootMaxHeight: getComputedStyle(root).maxHeight,
      rootStyleHeight: root.style.height,
    };
    console.log("soft-wrap-reflow-state", JSON.stringify({
      state,
      layers: Array.from(root.querySelectorAll(".vditor, .vditor-content, .vditor-wysiwyg, pre")).map((node) => ({
        tag: node.tagName,
        className: node.className,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        overflowY: getComputedStyle(node).overflowY,
        padding: getComputedStyle(node).padding,
        boxSizing: getComputedStyle(node).boxSizing,
        position: getComputedStyle(node).position,
        rect: node.getBoundingClientRect().toJSON(),
      })),
      wysiwygChildren: Array.from(root.querySelector(".vditor-wysiwyg")?.children || []).map((node) => ({
        tag: node.tagName,
        className: node.className,
        text: node.textContent.slice(0, 30),
        rect: node.getBoundingClientRect().toJSON(),
        computedHeight: getComputedStyle(node).height,
        margin: getComputedStyle(node).margin,
      })),
      ancestors: (() => {
        const values = [];
        let node = root;
        while (node && node !== document.body) {
          values.push({
            tag: node.tagName,
            id: node.id,
            className: node.className,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: getComputedStyle(node).overflowY,
            rect: node.getBoundingClientRect().toJSON(),
          });
          node = node.parentElement;
        }
        return values;
      })(),
    }));
    row.style.width = "330px";
    return state;
  });
  assert.ok(softWrapReflowState.maxScrollTop > 0, "width reflow must create a composer scroll range");
  assert.ok(
    softWrapReflowState.scrollTop <= 1,
    `width reflow must keep a first-line caret at the top (${JSON.stringify(softWrapReflowState)})`,
  );
  assert.ok(
    softWrapReflowState.firstLineTop >= softWrapReflowState.rootTop - 1,
    "width reflow must not clip the first soft-wrapped line",
  );
  assert.ok(
    softWrapReflowState.rootScrollHeight >= softWrapReflowState.editableHeight - 2,
    `width reflow must expose the complete naturally wrapped document (${JSON.stringify(softWrapReflowState)})`,
  );
  assert.ok(
    softWrapReflowState.lastContentBottom <= softWrapReflowState.rootTop
      + softWrapReflowState.rootScrollHeight + 2,
    `width reflow must keep the last content inside the shell scroll range (${JSON.stringify(softWrapReflowState)})`,
  );

  const tailVisibility = await page.evaluate(async () => {
    const root = document.getElementById("composerEditor");
    const editable = root.querySelector(".vditor-wysiwyg > pre");
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let lastText = null;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent) lastText = walker.currentNode;
    }
    if (lastText) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(lastText, lastText.textContent.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    // The editor's Compose-style caret synchronizer may otherwise move the
    // shell back to the active (first-line) caret while this geometry probe
    // settles. The visibility check concerns the document tail, independent
    // of focus state.
    editable.blur();
    root.scrollTop = root.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const range = document.createRange();
    const end = lastText?.textContent?.length || 0;
    if (lastText && end > 0) {
      range.setStart(lastText, Math.max(0, end - 1));
      range.setEnd(lastText, end);
    } else {
      range.selectNodeContents(editable);
      range.collapse(false);
    }
    const lastCharacter = range.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return {
      scrollTop: root.scrollTop,
      maxScrollTop: root.scrollHeight - root.clientHeight,
      lastCharacterTop: lastCharacter.top,
      lastCharacterBottom: lastCharacter.bottom,
      rootTop: rootRect.top,
      rootBottom: rootRect.bottom,
      wysiwygOverflowY: getComputedStyle(editable.parentElement).overflowY,
    };
  });
  assert.ok(
    tailVisibility.scrollTop >= tailVisibility.maxScrollTop - 1,
    `scrolling to the end must reach the shell's final scroll position (${JSON.stringify(tailVisibility)})`,
  );
  assert.ok(
    tailVisibility.lastCharacterTop >= tailVisibility.rootTop - 1
      && tailVisibility.lastCharacterBottom <= tailVisibility.rootBottom + 1,
    `the final character must remain inside the visible composer viewport (${JSON.stringify(tailVisibility)})`,
  );
  assert.equal(
    tailVisibility.wysiwygOverflowY,
    "visible",
    "the final character must not be clipped by the WYSIWYG wrapper",
  );

  // Mobile input implementations may report a large clipboard payload through
  // beforeinput without a usable paste event. It must use the same worker path
  // and render Markdown without requiring a page re-entry.
  await page.evaluate((text) => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    textarea.value = "";
    editable.focus();
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
      data: text,
    });
    editable.dispatchEvent(event);
  }, longPasteText);
  await waitForValue(
    () => document.querySelector("#composerEditor strong")?.textContent.includes("paste-fast-path-marker")
      && !document.getElementById("composerEditor").hasAttribute("aria-busy"),
    "mobile beforeinput large-paste Markdown rendering",
  );
  assert.ok(
    await page.locator("#composerEditor strong").filter({ hasText: "paste-fast-path-marker" }).count(),
    "mobile beforeinput large Markdown paste should render emphasis",
  );

  // Soft-wrapping without Enter: typing continuous text exceeding one line width
  // must grow the composer shell without scrolling the inner WYSIWYG element or
  // clipping/swallowing the first line.
  await page.evaluate(async () => {
    const textarea = document.getElementById("msgInput");
    const editable = document.querySelector("#composerEditor .vditor-wysiwyg > pre");
    textarea.value = "";
    window.RagentMarkdownComposer.refresh(textarea);
    await new Promise((resolve) => setTimeout(resolve, 80));
    editable.focus();
  });
  const continuousText = "这是一段非常长的测试文本用来测试当内容超过一行长度并且无回车软换行时第一行不会被吞掉";
  for (let i = 0; i < continuousText.length; i++) {
    await page.keyboard.type(continuousText[i]);
    if (i === 15 || i === 30 || i === continuousText.length - 1) {
      await page.waitForTimeout(40);
      const wrapCheck = await page.evaluate(() => {
        const root = document.getElementById("composerEditor");
        const wysiwyg = root.querySelector(".vditor-wysiwyg");
        const editable = root.querySelector(".vditor-wysiwyg > pre");
        const paragraph = editable.querySelector("p") || editable;
        const rootRect = root.getBoundingClientRect();
        const pRect = paragraph.getBoundingClientRect();
        return {
          rootTop: rootRect.top,
          pTop: pRect.top,
          rootHeight: root.clientHeight,
          rootScrollTop: root.scrollTop,
          wysiwygScrollTop: wysiwyg.scrollTop,
          diffTop: pRect.top - rootRect.top,
        };
      });
      assert.ok(
        wrapCheck.wysiwygScrollTop === 0,
        `inner WYSIWYG element must never scroll (${JSON.stringify(wrapCheck)})`,
      );
      assert.ok(
        wrapCheck.pTop >= wrapCheck.rootTop - 1,
        `first line must remain visible and not be clipped/swallowed above the shell (${JSON.stringify(wrapCheck)})`,
      );
    }
  }

  assert.equal(requests.some((url) => url.includes("cdn.jsdelivr.net") || url.includes("unpkg.com")), false, "Vditor must use only local vendored runtime assets");
  assert.equal(requests.some((url) => url.includes("/upload")), false, "the embedded editor must not issue upload requests");
  assert.deepEqual(failedResponses, [], "all Vditor runtime and theme assets must be available locally");
  console.log("test-chat-composer-markdown-editor: ok");
} finally {
  await context.close();
  await browser.close();
  server.close();
}

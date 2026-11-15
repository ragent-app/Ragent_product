#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const focusSource = await readFile(join(repoRoot, "static/chat/focus-scope.js"), "utf8");
const runSheetSource = await readFile(join(repoRoot, "static/chat/run-sheet.js"), "utf8");

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; min-height: 100vh; }
    .outside-area { width: 100%; height: 200px; background: #eee; }
  </style></head><body>
    <div class="outside-area" id="outsideArea">Outside Area</div>
    <div class="run-sheet-backdrop" id="runSheetBackdrop"></div>
    <div class="run-sheet" id="runSheet" role="dialog" aria-modal="true" aria-labelledby="runSheetTitle" aria-hidden="true" inert>
      <div class="run-sheet__handle-zone" id="runSheetHandleZone">
        <div class="run-sheet__handle"></div>
      </div>
      <div class="run-sheet__header">
        <h2 class="run-sheet__title" id="runSheetTitle">Run Sheet</h2>
        <button class="run-sheet__close" id="runSheetClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="run-sheet__content" id="runSheetContent"></div>
    </div>
    <button id="runSheetBtn" type="button">Open Run Sheet</button>
  </body></html>`);

  await page.addScriptTag({ content: focusSource });
  await page.addScriptTag({
    content: `
      window.tr = (key) => key;
      window.ragentFetch = async (url) => ({
        ok: true,
        text: async () => "# Sample Markdown Document\\n\\nContent here.",
        json: async () => ({
          status: "completed",
          session: { id: "test-session" },
          changedFiles: [],
          artifactFiles: [
            { id: "art-1", name: "notes.md", url: "/mock/notes.md", isMarkdown: true }
          ]
        }),
      });
      window.fetch = window.ragentFetch;
      window.RagentSessionStateModel = {
        getSessionVisualStatus: () => ({ kind: "completed", label: "Completed" })
      };
      window.currentSessionId = "test-session";
    `,
  });
  await page.addScriptTag({ content: runSheetSource });

  const testResult = await page.evaluate(async () => {
    const sheet = document.getElementById("runSheet");
    const backdrop = document.getElementById("runSheetBackdrop");
    const outside = document.getElementById("outsideArea");

    // 1. Open the Run Sheet
    window.openRunSheet();
    await new Promise((r) => setTimeout(r, 100));

    const step1SheetOpen = sheet.classList.contains("run-sheet--open");
    const step1SheetInert = sheet.hasAttribute("inert");

    // Check that markdown button rendered
    const mdButton = sheet.querySelector('[data-action="open-markdown"]');
    if (!mdButton) {
      return {
        error: "Markdown button not rendered in sheet",
        html: sheet.innerHTML,
      };
    }

    // 2. Click the markdown file button
    mdButton.click();
    await new Promise((r) => setTimeout(r, 100));

    const reader = document.getElementById("runSheetMarkdownPreview");
    const step2ReaderExists = Boolean(reader);
    const step2ReaderHidden = reader ? reader.hidden : true;
    const step2SheetStillOpen = sheet.classList.contains("run-sheet--open");
    const step2SheetInert = sheet.hasAttribute("inert");

    // 3. Click inside the Run Sheet (not outside)
    sheet.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));

    const step3SheetOpenAfterInsideClick = sheet.classList.contains("run-sheet--open");
    const step3ReaderOpenAfterInsideClick = reader && !reader.hidden;

    // 4. Click inside the Reader drawer
    if (reader) {
      reader.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 50));

    const step4SheetOpenAfterReaderClick = sheet.classList.contains("run-sheet--open");
    const step4ReaderOpenAfterReaderClick = reader && !reader.hidden;

    // 4b. Close reader using the reader close button, verify sheet stays open!
    const readerCloseBtn = reader?.querySelector("[data-run-sheet-reader-close]");
    if (readerCloseBtn) {
      readerCloseBtn.click();
      await new Promise((r) => setTimeout(r, 260));
    }
    const step4bReaderClosed = reader ? reader.hidden : true;
    const step4bSheetStillOpen = sheet.classList.contains("run-sheet--open");

    // Reopen reader for step 5
    mdButton.click();
    await new Promise((r) => setTimeout(r, 100));

    // 5. Click outside both (on outside area)
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 260));

    const step5SheetClosedAfterOutsideClick = !sheet.classList.contains("run-sheet--open");
    const step5ReaderClosedAfterOutsideClick = reader && reader.hidden;

    return {
      step1SheetOpen,
      step1SheetInert,
      step2ReaderExists,
      step2ReaderHidden,
      step2SheetStillOpen,
      step2SheetInert,
      step3SheetOpenAfterInsideClick,
      step3ReaderOpenAfterInsideClick,
      step4SheetOpenAfterReaderClick,
      step4ReaderOpenAfterReaderClick,
      step4bReaderClosed,
      step4bSheetStillOpen,
      step5SheetClosedAfterOutsideClick,
      step5ReaderClosedAfterOutsideClick,
    };
  });

  assert.equal(testResult.error, undefined, JSON.stringify(testResult));
  assert.equal(testResult.step1SheetOpen, true, "Run Sheet should be open at step 1");
  assert.equal(testResult.step1SheetInert, false, "Run Sheet should not be inert when open");
  assert.equal(testResult.step2ReaderExists, true, "Reader element should exist");
  assert.equal(testResult.step2ReaderHidden, false, "Reader should be visible after clicking markdown file");
  assert.equal(testResult.step2SheetStillOpen, true, "Run Sheet should REMAIN OPEN after clicking markdown file");
  assert.equal(testResult.step2SheetInert, false, "Run Sheet should NOT BE INERT after reader opens");
  assert.equal(testResult.step3SheetOpenAfterInsideClick, true, "Run Sheet must not close when clicked inside sheet");
  assert.equal(testResult.step3ReaderOpenAfterInsideClick, true, "Reader must not close when clicked inside sheet");
  assert.equal(testResult.step4SheetOpenAfterReaderClick, true, "Run Sheet must not close when clicked inside reader");
  assert.equal(testResult.step4ReaderOpenAfterReaderClick, true, "Reader must not close when clicked inside reader");
  assert.equal(testResult.step4bReaderClosed, true, "Reader must close after clicking reader close button");
  assert.equal(testResult.step4bSheetStillOpen, true, "Run Sheet must REMAIN OPEN after reader close button clicked");
  assert.equal(testResult.step5SheetClosedAfterOutsideClick, true, "Run Sheet must close when clicked outside");
  assert.equal(testResult.step5ReaderClosedAfterOutsideClick, true, "Reader must close when clicked outside");

  console.log("test-chat-run-sheet-click-boundary: ok");
} finally {
  await browser.close();
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const focusSource = await readFile(join(repoRoot, "static/chat/focus-scope.js"), "utf8");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <main id="app"><button id="trigger">Open</button><button id="background">Background</button></main>
    <section id="panel" role="dialog" aria-hidden="true" hidden>
      <button id="first">First</button><button id="second">Second</button>
      <section id="reader" role="dialog" aria-hidden="true" hidden>
        <button id="readerClose">Reader close</button><button id="readerAction">Reader action</button>
      </section>
    </section>
  </body></html>`);
  await page.addScriptTag({ content: focusSource });

  const result = await page.evaluate(() => {
    const trigger = document.getElementById("trigger");
    const panel = document.getElementById("panel");
    const reader = document.getElementById("reader");
    const app = document.getElementById("app");
    trigger.focus();
    panel.hidden = false;
    const parentEscapes = [];
    const deactivateParent = window.RagentFocusScope.activate(panel, {
      containmentRoot: document.body,
      initialFocus: document.getElementById("first"),
      restoreFocus: trigger,
      modal: true,
      onEscape: () => parentEscapes.push("parent"),
    });
    const parentOpened = {
      active: document.activeElement.id,
      appInert: app.hasAttribute("inert"),
      appAriaHidden: app.getAttribute("aria-hidden"),
      modal: panel.getAttribute("aria-modal"),
    };
    const press = (key, shiftKey = false) => document.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }));
    press("Tab");
    const afterTab = document.activeElement.id;
    press("Tab");
    const afterWrap = document.activeElement.id;
    press("Tab", true);
    const afterReverse = document.activeElement.id;

    reader.hidden = false;
    const readerEscapes = [];
    const deactivateReader = window.RagentFocusScope.activate(reader, {
      containmentRoot: panel,
      initialFocus: document.getElementById("readerClose"),
      restoreFocus: document.getElementById("second"),
      modal: true,
      onEscape: () => readerEscapes.push("reader"),
    });
    const nestedOpened = document.activeElement.id;
    press("Tab");
    const nestedTab = document.activeElement.id;
    press("Escape");
    const afterNestedEscape = { readerEscapes, parentEscapes };
    deactivateReader();
    const afterReaderClose = document.activeElement.id;
    deactivateParent();
    return {
      parentOpened,
      afterTab,
      afterWrap,
      afterReverse,
      nestedOpened,
      nestedTab,
      afterNestedEscape,
      afterReaderClose,
      restored: {
        appInert: app.hasAttribute("inert"),
        appAriaHidden: app.getAttribute("aria-hidden"),
        panelModal: panel.getAttribute("aria-modal"),
        focus: document.activeElement.id,
      },
    };
  });

  assert.deepEqual(result.parentOpened, {
    active: "first",
    appInert: true,
    appAriaHidden: "true",
    modal: "true",
  });
  assert.equal(result.afterTab, "second");
  assert.equal(result.afterWrap, "first");
  assert.equal(result.afterReverse, "second");
  assert.equal(result.nestedOpened, "readerClose");
  assert.equal(result.nestedTab, "readerAction");
  assert.deepEqual(result.afterNestedEscape, { readerEscapes: ["reader"], parentEscapes: [] });
  assert.equal(result.afterReaderClose, "second");
  assert.deepEqual(result.restored, {
    appInert: false,
    appAriaHidden: null,
    panelModal: null,
    focus: "trigger",
  });
  console.log("test-chat-focus-scope: ok");
} finally {
  await browser.close();
}

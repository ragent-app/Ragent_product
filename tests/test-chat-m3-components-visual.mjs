#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || join(repoRoot, "artifacts", "chat-m3-components");
await mkdir(outputDir, { recursive: true });

const css = await Promise.all([
  "static/chat/chat-base.css",
  "static/chat/chat-input.css",
  "static/chat/chat-responsive.css",
  "static/chat/chat-glass.css",
  "static/chat/chat-messages.css",
  "static/chat/chat-m3-tokens.css",
  "static/chat/chat-m3-components.css",
].map((file) => readFile(join(repoRoot, file), "utf8")));

const fixture = `<!doctype html><html><head><style>${css.join("\n")}
html,body{margin:0;min-height:100%;}body{background:var(--sys-surface);}
.fixture-header-icon{display:block;width:16px;height:16px;border:2px solid currentColor;border-radius:5px;}
.input-area{position:relative;display:block;padding:12px;}
.input-stack{position:relative;}
.input-wrapper{display:block;}
.composer-add-panel{position:relative;display:block;max-height:none;}
.plan-card{margin:12px;}
</style></head><body>
<div class="app-shell"><main>
  <div class="header" aria-label="Chat header">
    <button class="header-btn header-btn--sessions" type="button" aria-label="Sessions"><span class="fixture-header-icon" aria-hidden="true"></span></button>
    <button class="header-btn header-btn--home" type="button" style="display:flex" aria-label="Home"><span class="fixture-header-icon" aria-hidden="true"></span></button>
    <button class="header-more-btn" type="button" style="display:flex" aria-label="More"><span class="fixture-header-icon" aria-hidden="true"></span></button>
  </div>
  <nav class="sidebar-projects-view" aria-label="Sessions">
    <button class="sidebar-project-head" type="button">L1 project</button>
    <button class="session-item" type="button">L2 session</button>
  </nav>
  <section class="home-workspace" hidden aria-label="Home"></section>
  <section class="input-area"><div class="input-stack"><div class="input-wrapper">
    <div class="input-row"><textarea aria-label="Message" placeholder="Message"></textarea></div>
    <div class="input-actions-row"><div class="input-actions-group input-actions-group--add"><button class="composer-action-btn" type="button">+</button></div><div class="input-actions-group right"><button class="send-btn" type="button">Send</button></div></div>
  </div><div class="composer-add-panel"><button class="composer-add-menu-item" type="button">Agent</button><button class="composer-add-menu-item active" type="button">Connector</button></div></div></section>
  <article class="plan-card"><div class="plan-card__title">Review the generated plan</div><div class="plan-card__actions"><button class="plan-card__action" data-plan-action="execute">Execute</button><button class="plan-card__action" data-plan-action="deny">Dismiss</button></div></article>
  <section class="runtime-approval-card__prompt"><div class="runtime-approval-card__option is-selected">Use staging</div><div class="runtime-approval-card__option">Use production</div></section>
</main></div></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await page.emulateMedia({ colorScheme: theme });
      await page.setContent(fixture, { waitUntil: "load" });
      await page.evaluate((selectedTheme) => { document.documentElement.dataset.theme = selectedTheme; }, theme);
      const metrics = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return {
            background: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            radius: style.borderRadius,
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        };
        return {
          input: read(".input-wrapper"),
          panel: read(".composer-add-panel"),
          plan: read(".plan-card"),
          primary: read("[data-plan-action=execute]"),
          selected: read(".runtime-approval-card__option.is-selected"),
          header: read(".header"),
          headerButton: read(".header-btn--sessions"),
          sessionRow: read(".session-item"),
          headerBeforeBlur: getComputedStyle(document.querySelector(".header"), "::before").backdropFilter,
          headerPointerEvents: getComputedStyle(document.querySelector(".header")).pointerEvents,
          homeHeader: (() => {
            const home = document.querySelector(".home-workspace");
            home.hidden = false;
            const header = document.querySelector(".header");
            const result = {
              blur: getComputedStyle(header, "::before").backdropFilter,
              backgroundImage: getComputedStyle(header).backgroundImage,
            };
            home.hidden = true;
            return result;
          })(),
        };
      });
      assert.notEqual(metrics.input.background, "rgba(0, 0, 0, 0)", `${theme}-${width}: input should have a computed surface`);
      assert.equal(metrics.input.radius, width <= 767 ? "20px" : "16px", `${theme}-${width}: composer keeps the online surface radius`);
      assert.equal(metrics.panel.backgroundImage, "none", `${theme}-${width}: add panel does not use a decorative gradient`);
      assert.ok(metrics.primary.width >= 80 && metrics.primary.height >= 40, `${theme}-${width}: primary plan action remains usable`);
      assert.ok(metrics.selected.background !== metrics.plan.background, `${theme}-${width}: selected state has a distinct container`);
      const expectedHeaderRadius = width <= 767 ? 40 * 0.5 : 34 * 0.5;
      assert.ok(Math.abs(parseFloat(metrics.headerButton.radius) - expectedHeaderRadius) < 0.5, `${theme}-${width}: header buttons should use the height-proportional radius`);
      assert.ok(Math.abs(parseFloat(metrics.sessionRow.radius) - (52 * 0.5)) < 0.5, `${theme}-${width}: L2 session rows should own the capsule ratio`);
      assert.ok(Math.abs(parseFloat(metrics.primary.radius) - (52 * 0.5)) < 0.5, `${theme}-${width}: decision buttons should use the same capsule ratio`);
      assert.match(metrics.headerBeforeBlur, /blur\(10px\)/, `${theme}-${width}: chat header should reuse the online blur fade`);
      assert.equal(metrics.homeHeader.blur, "none", `${theme}-${width}: home header should not use the chat blur fade`);
      assert.equal(metrics.homeHeader.backgroundImage, "none", `${theme}-${width}: home header should not paint a blur gradient`);
      assert.equal(metrics.headerPointerEvents, "none", `${theme}-${width}: empty header surface should not block the transcript`);
      await page.screenshot({ path: join(outputDir, `${theme}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`test-chat-m3-components-visual: ok (${outputDir})`);

#!/usr/bin/env node
// Focused Goal M3 visual fixture. This intentionally does not boot the full chat
// app: it renders the real Goal/Material CSS against the complete chip + sheet
// structure so compact and expanded geometry can be reviewed deterministically.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const repoRoot = process.cwd();
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR
  || "/var/lib/ragent/workspace/visual-ui-reviews/chat-goal-m3";
await mkdir(outputDir, { recursive: true });

const css = await Promise.all([
  "chat-base.css",
  "chat-input.css",
  "chat-responsive.css",
  "chat-goal-ui.css",
  "chat-m3-tokens.css",
  "chat-m3-components.css",
].map((file) => readFile(join(repoRoot, "static/chat", file), "utf8")));

const markup = `
  <div class="app-shell">
    <header class="header">
      <button class="header-btn" type="button" aria-label="Sessions">☰</button>
      <button class="header-btn" type="button" aria-label="Home">⌂</button>
      <div class="header-title-block">
        <h1>Ragent Chat</h1>
        <button class="goal-chip" type="button" data-state="active" data-tone="working" aria-label="Session goal">
          <span class="goal-chip-dot" data-tone="working" aria-hidden="true"></span>
          <span class="goal-chip-text">Prepare the weekly operations summary</span>
          <span class="goal-chip-usage">4.2k/10k · 42%</span>
          <span class="goal-chip-chase">Auto-continuing</span>
        </button>
      </div>
      <button class="header-more-btn" type="button" aria-label="More">⋯</button>
    </header>
  </div>
  <main class="goal-visual-backdrop">
    <div class="goal-visual-copy"><strong>Current work</strong><span>Conversation content stays behind the focused editor.</span></div>
  </main>
  <div class="modal-backdrop is-open" id="goalSheet">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="goalSheetTitle" aria-describedby="goalSheetLead">
      <div class="goal-sheet-handle" aria-hidden="true"></div>
      <div class="modal-header">
        <h2 class="modal-title" id="goalSheetTitle">Session goal</h2>
        <button class="modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <p class="modal-lead" id="goalSheetLead">Keep the agent focused on one outcome. Add an optional token budget to keep the work bounded across turns.</p>
        <div class="goal-status-display" data-tone="working">Working</div>
        <div class="provider-helper-field">
          <label for="goalObjectiveInput">Objective</label>
          <textarea id="goalObjectiveInput" rows="3">Prepare the weekly operations summary and highlight decisions that need owner review.</textarea>
        </div>
        <div class="provider-helper-grid">
          <div class="provider-helper-field">
            <label for="goalTokenBudgetInput">Token budget (optional)</label>
            <input id="goalTokenBudgetInput" type="number" value="10000">
          </div>
        </div>
        <label class="goal-toggle">
          <input type="checkbox" checked>
          <span>Goal is active for the next turn</span>
        </label>
        <div class="goal-chase-row">
          <div class="goal-chase-copy">
            <strong>Continue automatically</strong>
            <span>Start another turn when the current turn ends, until the goal is complete.</span>
          </div>
          <div class="goal-chase-actions">
            <span class="goal-chase-status" data-tone="working">Auto-continuing</span>
            <button class="modal-btn" type="button">Pause auto-continue</button>
          </div>
        </div>
      </div>
      <div class="goal-sheet-footer">
        <button class="modal-btn" type="button">Clear goal</button>
        <button class="modal-btn primary" type="button">Save goal</button>
      </div>
    </section>
  </div>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height, label] of [[390, 844, "mobile"], [1440, 900, "desktop"]]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
      await page.setContent(`<!doctype html><html><head><style>${css.join("\n")}</style><style>
        html, body { margin: 0; min-height: 100%; }
        .goal-visual-backdrop { min-height: 900px; padding: 120px 24px; background: var(--sys-surface); color: var(--sys-on-surface); }
        .goal-visual-copy { display: grid; gap: 8px; max-width: 520px; color: var(--sys-on-surface-variant); }
        .goal-visual-copy strong { color: var(--sys-on-surface); }
      </style></head><body>${markup}</body></html>`);
      await page.waitForTimeout(320);

      const state = await page.evaluate(() => {
        const modal = document.querySelector("#goalSheet .modal");
        const chip = document.querySelector(".goal-chip");
        const modalStyle = getComputedStyle(modal);
        const chipStyle = getComputedStyle(chip);
        return {
          bodyWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          modalWidth: modal.getBoundingClientRect().width,
          modalRadius: [modalStyle.borderTopLeftRadius, modalStyle.borderTopRightRadius, modalStyle.borderBottomRightRadius, modalStyle.borderBottomLeftRadius],
          modalBackground: modalStyle.backgroundColor,
          modalFilter: modalStyle.backdropFilter,
          chipBackground: chipStyle.backgroundColor,
          chipBorder: chipStyle.borderTopWidth,
          chipTextWidth: document.querySelector(".goal-chip-text").getBoundingClientRect().width,
          chaseActionsRect: document.querySelector(".goal-chase-actions").getBoundingClientRect().toJSON(),
        };
      });
      assert.ok(state.bodyWidth <= state.viewport + 1, `${theme} ${label}: Goal surface overflows horizontally`);
      assert.equal(state.modalFilter, "none", `${theme} ${label}: Goal editor should not retain glass blur`);
      assert.equal(state.chipBorder, "0px", `${theme} ${label}: Goal chip should be borderless`);
      assert.ok(state.chipTextWidth > 0, `${theme} ${label}: Goal chip text should remain visible`);
      if (label === "mobile") {
        assert.equal(state.modalWidth, width, `${theme} mobile: bottom sheet should span the viewport`);
        assert.deepEqual(state.modalRadius.slice(0, 2), ["28px", "28px"], `${theme} mobile: sheet top corners should use M3 extra-large shape`);
        assert.deepEqual(state.modalRadius.slice(2), ["0px", "0px"], `${theme} mobile: sheet should meet the bottom edge`);
        assert.ok(state.chaseActionsRect.bottom < height, `${theme} mobile: auto-continue action should remain reachable above the footer`);
      } else {
        assert.deepEqual(state.modalRadius, ["28px", "28px", "28px", "28px"], `${theme} desktop: dialog should use M3 extra-large shape on all corners`);
      }
      await page.screenshot({ path: join(outputDir, `goal-m3-${theme}-${label}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`test-chat-goal-ui-visual: ok (${outputDir})`);

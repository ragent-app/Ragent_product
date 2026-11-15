#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const motionSource = await readFile(join(repoRoot, "static/chat/motion.js"), "utf8");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body><div id=target hidden></div></body></html>");
  await page.evaluate(() => {
    const frames = new Map();
    let nextFrameId = 0;
    const cancelled = [];
    window.requestAnimationFrame = (callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      cancelled.push(id);
      frames.delete(id);
    };
    window.__flushFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(Date.now()));
    };
    window.__cancelledFrames = cancelled;
    let changeListener = null;
    const query = {
      matches: false,
      addEventListener(type, listener) {
        if (type === "change") changeListener = listener;
      },
      dispatch(matches) {
        this.matches = matches;
        changeListener?.({ matches });
      },
    };
    window.matchMedia = () => query;
    window.__motionQuery = query;
  });
  await page.addScriptTag({ content: motionSource });

  const result = await page.evaluate(async () => {
    const target = document.getElementById("target");
    let opened = 0;
    let closed = 0;
    window.RagentMotion.setPresence(target, true, { onAfterOpen: () => { opened += 1; } });
    window.RagentMotion.setPresence(target, false, { onAfterClose: () => { closed += 1; } });
    window.RagentMotion.setPresence(target, true, { onAfterOpen: () => { opened += 1; } });
    window.__flushFrames();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const openedState = {
      hidden: target.hidden,
      open: target.classList.contains("is-open"),
      closing: target.classList.contains("is-closing"),
      opened,
      closed,
    };

    window.RagentMotion.setPresence(target, false, { duration: 80, onAfterClose: () => { closed += 1; } });
    window.RagentMotion.setPresence(target, true, { onAfterOpen: () => { opened += 1; } });
    window.__flushFrames();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const staleTimerState = {
      hidden: target.hidden,
      open: target.classList.contains("is-open"),
      closing: target.classList.contains("is-closing"),
      opened,
      closed,
      cancelledFrames: window.__cancelledFrames.length,
    };

    window.RagentMotion.setPresence(target, false, { duration: 500, onAfterClose: () => { closed += 1; } });
    window.__motionQuery.dispatch(true);
    const reducedState = {
      hidden: target.hidden,
      open: target.classList.contains("is-open"),
      closing: target.classList.contains("is-closing"),
      opened,
      closed,
    };
    return { openedState, staleTimerState, reducedState };
  });

  assert.deepEqual(result.openedState, {
    hidden: false,
    open: true,
    closing: false,
    opened: 1,
    closed: 0,
  });
  assert.equal(result.staleTimerState.hidden, false, "an old close timer must not hide a later open");
  assert.equal(result.staleTimerState.open, true);
  assert.equal(result.staleTimerState.closing, false);
  assert.equal(result.staleTimerState.closed, 0, "cancelled close must not call its callback");
  assert.ok(result.staleTimerState.cancelledFrames >= 1, "a new request must cancel the old rAF");
  assert.deepEqual(result.reducedState, {
    hidden: true,
    open: false,
    closing: false,
    opened: 1,
    closed: 1,
  });
  console.log("test-chat-motion-presence-race: ok");
} finally {
  await browser.close();
}

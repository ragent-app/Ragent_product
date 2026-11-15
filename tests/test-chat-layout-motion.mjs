#!/usr/bin/env node
// Layout motion contract: dynamic session surfaces may move because another
// surface grows or collapses, but the transition must stay compositor-backed,
// interruptible, and disappear under prefers-reduced-motion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const motionSource = readFileSync(new URL("../static/chat/motion.js", import.meta.url), "utf8");

async function makePage(reducedMotion = "no-preference") {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.emulateMedia({ reducedMotion });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; }
      .chat-area { height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; overflow: hidden; }
      .messages { min-height: 0; overflow: auto; padding: 0 12px 20px; }
      .messages-inner { display: flex; flex-direction: column; gap: 8px; }
      .msg-user { height: 42px; background: #ddd; }
      .input-area { position: relative; }
      .input-stack { display: flex; flex-direction: column; }
      .input-wrapper { height: 72px; background: #eee; }
    </style>
    <main class="chat-area">
      <div class="messages"><div class="messages-inner"><div class="msg-user"></div></div></div>
      <div class="input-area"><div class="input-stack"><div class="input-wrapper"></div></div></div>
    </main>
    <script>${motionSource.replace(/<\/script/gi, "<\\/script")}</script>
  `);
  await page.evaluate(() => window.RagentMotion.observeLayout(document.querySelector(".chat-area")));
  return { browser, page };
}

{
  const { browser, page } = await makePage();
  // Seed the initial ResizeObserver measurement before changing the composer.
  // The observer callback is asynchronous in Chromium and may otherwise see
  // only the final geometry, making this contract timing-dependent.
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    document.querySelector(".input-wrapper").style.height = "148px";
  });
  await page.waitForFunction(
    () => document.querySelector(".input-area")?.getAnimations?.().length > 0,
    null,
    { timeout: 1000 },
  );
  const metrics = await page.evaluate(() => {
    const inputArea = document.querySelector(".input-area");
    const animations = inputArea.getAnimations();
    return {
      animationCount: animations.length,
      translateKeyframes: animations[0]?.effect?.getKeyframes?.().map((frame) => frame.translate || "") || [],
      duration: animations[0]?.effect?.getComputedTiming?.().duration || 0,
    };
  });
  assert.ok(metrics.animationCount > 0, "composer height growth should animate the displaced input area");
  assert.ok(metrics.translateKeyframes.some((value) => String(value).includes("px")), "layout motion should use compositor translate keyframes");
  assert.equal(metrics.duration, 300, "layout motion should use the gentle layout token");

  await page.evaluate(() => {
    const inner = document.querySelector(".messages-inner");
    const message = document.createElement("div");
    message.className = "msg-user";
    inner.appendChild(message);
  });
  await page.waitForTimeout(45);
  const contentAnimations = await page.evaluate(() => [
    ...document.querySelectorAll(".messages-inner > *"),
  ].reduce((count, element) => count + element.getAnimations().length, 0));
  assert.equal(contentAnimations, 0, "message and home content changes must not trigger page-level layout motion");
  await browser.close();
}

{
  const { browser, page } = await makePage("reduce");
  await page.evaluate(() => {
    document.querySelector(".input-wrapper").style.height = "148px";
  });
  await page.waitForTimeout(45);
  const animationCount = await page.evaluate(() => document.querySelector(".input-area").getAnimations().length);
  assert.equal(animationCount, 0, "reduced motion should apply the final layout without a spatial animation");
  await browser.close();
}

{
  const { browser, page } = await makePage();
  await page.waitForTimeout(100);
  // Shift chat-area horizontally as happens when sidebar collapses or expands
  await page.evaluate(() => {
    const chatArea = document.querySelector(".chat-area");
    chatArea.style.marginLeft = "280px";
    chatArea.style.width = "calc(100% - 280px)";
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const chatArea = document.querySelector(".chat-area");
    chatArea.style.marginLeft = "0px";
    chatArea.style.width = "100%";
  });
  await page.waitForTimeout(100);
  const messageAnimations = await page.evaluate(() => {
    const messages = document.querySelector(".messages");
    return messages?.getAnimations?.()?.map((anim) => {
      const frames = anim.effect?.getKeyframes?.() || [];
      return frames.map((f) => f.translate || "");
    }) || [];
  });
  const hasHorizontalTranslate = messageAnimations.some((animFrames) =>
    animFrames.some((frame) => {
      const match = String(frame).match(/^([^\s]+)\s+([^\s]+)$/);
      if (!match) return false;
      return match[1] !== "0" && match[1] !== "0px";
    }),
  );
  assert.equal(hasHorizontalTranslate, false, "horizontal layout changes must not cause horizontal translation on messages");
  await browser.close();
}

console.log("test-chat-layout-motion: ok");


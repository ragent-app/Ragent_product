#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const repoRoot = process.cwd();
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || "/var/lib/ragent/workspace/visual-ui-reviews/instance-admin-m3";
await mkdir(outputDir, { recursive: true });

const [m3Pages, template] = await Promise.all([
  readFile(join(repoRoot, "static/m3-pages.css"), "utf8"),
  readFile(join(repoRoot, "templates/instance-admin.html"), "utf8"),
]);
const inlineCss = [...template.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");

const body = `
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar"><div class="topbar-inner">
    <div class="brand-block"><p class="eyebrow">user workbench</p><div class="brand-row"><h1>Ragent Admin</h1><span class="cache-pill">Ready</span></div></div>
    <div class="topbar-tools"><nav class="view-nav" aria-label="Admin views">
      <a class="view-link is-active" href="#pending">待处理 <span class="nav-count">3</span></a>
      <a class="view-link" href="#users">用户 <span class="nav-count">12</span></a>
      <a class="view-link" href="#instances">实例 <span class="nav-count">8</span></a>
    </nav><div class="top-actions"><button class="btn btn-primary">创建实例</button><button class="btn">刷新</button><button class="btn btn-subtle">退出</button></div></div>
  </div></header>
  <main class="shell" id="content">
    <section class="panel page-panel"><div class="page-head"><div><p class="eyebrow">workbench</p><h2 class="section-title">待处理工作</h2><p class="section-copy">查看需要关注的用户、实例和运行状态。</p></div><div class="inline-meta">刚刚更新</div></div><div class="metric-grid">
      <div class="metric-card" data-tone="accent"><strong>12</strong><span class="metric-label">活跃用户</span><span class="metric-note">本周新增 3 个</span></div>
      <div class="metric-card" data-tone="ok"><strong>8</strong><span class="metric-label">可用实例</span><span class="metric-note">运行稳定</span></div>
      <div class="metric-card" data-tone="danger"><strong>2</strong><span class="metric-label">需要处理</span><span class="metric-note">等待管理员决策</span></div>
    </div></section>
    <section class="panel control-panel"><div class="control-row"><label class="search-field"><span>搜索</span><input type="search" placeholder="搜索用户、来源或实例"></label><div class="chip-row"><button class="chip is-active">全部</button><button class="chip">待处理</button><button class="chip">可用</button></div></div></section>
    <section class="view-stack"><section class="panel section-panel"><div class="section-panel-head"><div><h3>需要关注的实例</h3><p class="section-panel-copy">最近状态变化和需要确认的操作。</p></div><span class="section-count"><strong>3</strong> 项</span></div><div class="list-stack">
      <details class="row-card" open><summary class="row-summary"><div class="row-main"><strong class="row-title">north-star</strong><span class="row-sub">owner@example.com</span></div><span class="tag" data-tone="ok">运行中</span></summary><div class="detail-body"><div class="detail-grid"><article class="detail-card"><h4>运行状态</h4><p>当前连接正常，最近一次心跳 2 分钟前。</p></article><article class="detail-card"><h4>下一步</h4><p>继续观察，不需要立即操作。</p></article></div><div class="detail-actions"><button class="action-btn" data-tone="primary">查看实例</button><button class="action-btn" data-tone="danger">删除</button></div></div></details>
    </div></section></section>
  </main>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height, label] of [[390, 844, "mobile"], [1440, 900, "desktop"]]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
      await page.setContent(`<!doctype html><html><head><style>${m3Pages}</style><style>${inlineCss}</style></head><body>${body}</body></html>`, { waitUntil: "load" });
      const state = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        viewport: innerWidth,
        topbarFilter: getComputedStyle(document.querySelector(".topbar")).backdropFilter,
        cardFilter: getComputedStyle(document.querySelector(".metric-card")).backdropFilter,
      }));
      assert.ok(state.bodyWidth <= state.viewport + 1, `${theme} ${label} overflows horizontally`);
      assert.equal(state.topbarFilter, "none", `${theme} ${label} retains topbar glass`);
      assert.equal(state.cardFilter, "none", `${theme} ${label} retains card glass`);
      await page.screenshot({ path: join(outputDir, `instance-admin-${theme}-${label}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`test-instance-admin-m3-visual: ok (${outputDir})`);

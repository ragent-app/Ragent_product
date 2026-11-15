#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const artifactDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || join(tmpdir(), 'ragent-visual-review');
mkdirSync(artifactDir, { recursive: true });

const cssFiles = [
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-decision-sheet.css',
  'static/chat/chat-attention-popup.css',
  'static/chat/chat-input.css',
  'static/chat/chat-sidebar.css',
  'static/chat/cross-device-panel.css',
  'static/chat/chat-goal-ui.css',
  'static/chat/workspace-file-reader.css',
  'static/chat/right-sidebar.css',
  'static/chat/chat-workbench.css',
  'static/chat/custom-select.css',
  'static/chat/custom-select-2.css',
  'static/chat/chat-home.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-operational-surfaces.css',
  'static/chat/chat-material-finish.css',
];
const styles = cssFiles.map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');
const loginHtml = readFileSync(join(repoRoot, 'templates/login.html'), 'utf8');

function renderFixtureHtml(theme = 'light') {
  return `<!doctype html>
  <html data-theme="${theme}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px 20px;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: ${theme === 'dark' ? '#0f1011' : '#f4f5f8'};
        color: ${theme === 'dark' ? '#e5e7eb' : '#1f2937'};
      }
      ${styles}
      .fixture-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 36px;
        max-width: 800px;
        margin: 0 auto;
      }
      .fixture-section-header {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: ${theme === 'dark' ? '#9ca3af' : '#6b7280'};
        margin-bottom: 12px;
      }
    </style>
  </head>
  <body>
    <div class="fixture-grid">
      <!-- 1. 跨设备配对中心 -->
      <div id="section-cross-device">
        <div class="fixture-section-header">1. 跨设备中心 (Zero Borders, 16px 外壳, 胶囊按钮, 单层贯通设备列表)</div>
        <div class="cross-device-sheet" style="position: static; transform: none; width: 100%; max-width: 520px; margin: 0 auto; display: block;">
          <div class="cross-device-header">
            <div class="cross-device-header-lead">
              <span class="cross-device-title">跨设备互联中心</span>
              <span class="cross-device-sub">扫码与远程中继协同</span>
            </div>
            <button class="cross-device-close" type="button" aria-label="Close" data-icon="close"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
          <div class="cross-device-tabs">
            <button class="cross-device-tab active" type="button">已连接设备</button>
            <button class="cross-device-tab" type="button">扫码配对</button>
            <button class="cross-device-tab" type="button">中继节点</button>
          </div>
          <div class="cross-device-body" style="padding: 16px;">
            <div class="cross-device-card">
              <div class="cross-device-device-row is-connected" style="display: flex; justify-content: space-between; align-items: center; padding: 12px;">
                <div>
                  <div style="font-weight: 600; font-size: 14px;">XiaoMi 14 Pro (Android Client)</div>
                  <div style="font-size: 11px; color: #888;">WebRTC P2P 直连 · 活跃中</div>
                </div>
                <button class="cross-device-action" type="button">断开</button>
              </div>
              <div class="cross-device-device-row" style="display: flex; justify-content: space-between; align-items: center; padding: 12px;">
                <div>
                  <div style="font-weight: 600; font-size: 14px;">MacBook Pro M3 (Validation Peer)</div>
                  <div style="font-size: 11px; color: #888;">Cloudflare TURN · 备用中</div>
                </div>
                <button class="cross-device-action secondary" type="button">配置</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 设置中心卡片与胶囊下拉/按钮 -->
      <div id="section-settings">
        <div class="fixture-section-header">2. 设置中心卡片组 (16px 圆角, 9999px 药丸按钮与下拉触发器, 舒适内部留白)</div>
        <div class="settings-group" style="max-width: 520px; margin: 0 auto;">
          <div class="settings-group-card" style="padding: 20px 22px; display: flex; flex-direction: column; gap: 16px;">
            <div>
              <div class="settings-group-title" style="font-size: 14px; font-weight: 700; color: var(--text); margin-bottom: 4px;">AI 模型提供商</div>
              <div class="settings-group-description" style="font-size: 12px; color: var(--text-secondary); margin: 0;">配置会话调用的默认引擎与认证凭据</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 16px; margin-top: 4px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <div style="font-weight: 600; font-size: 13px;">默认代码模型</div>
                  <div style="font-size: 11px; color: #888; margin-top: 2px;">当前选择 Claude 3.7 Sonnet (Hybrid)</div>
                </div>
                <div class="custom-select-wrap cs-settings-row">
                  <button class="cs-trigger" type="button">Claude 3.7</button>
                </div>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <div style="font-weight: 600; font-size: 13px;">API 凭据配置</div>
                  <div style="font-size: 11px; color: #888; margin-top: 2px;">已安全保存在本地 Keyring 密库</div>
                </div>
                <button class="settings-row-button" type="button">修改密钥</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. 工作台审查器 (Workbench Inspector) -->
      <div id="section-workbench">
        <div class="fixture-section-header">3. 工作台审查器 (Zero Borders, 胶囊 Tab 切换, 平滑指标与结果卡片)</div>
        <div class="workbench-inspector" style="position: static !important; transform: none !important; opacity: 1 !important; display: flex !important; width: 100%; max-width: 520px; margin: 0 auto; border-left: 0; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border-radius: 16px;">
          <div class="workbench-inspector-header">
            <div class="workbench-inspector-title-block">
              <div class="workbench-inspector-eyebrow">Workspace Session</div>
              <h2>前端标准容器改造计划</h2>
            </div>
            <button class="workbench-inspector-close" type="button" aria-label="Close" data-icon="close"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
          <div class="workbench-inspector-tabs">
            <button class="workbench-inspector-tab active" type="button">产物综述</button>
            <button class="workbench-inspector-tab" type="button">执行活动</button>
            <button class="workbench-inspector-tab" type="button">上下文</button>
          </div>
          <div class="workbench-inspector-body" style="padding: 14px; display: flex; flex-direction: column; gap: 14px;">
            <div class="workbench-outcome-card">
              <div class="workbench-outcome-title">跨端视觉设计规范达成</div>
              <div class="workbench-outcome-summary">已完成侧边栏、设置卡片、跨设备面板与对话弹窗的 OneUI 实体质感对齐。</div>
              <div class="workbench-outcome-metrics">
                <div class="workbench-outcome-metric">
                  <div class="workbench-outcome-metric-value">0</div>
                  <div class="workbench-outcome-metric-label">硬边框残留</div>
                </div>
                <div class="workbench-outcome-metric">
                  <div class="workbench-outcome-metric-value">16px</div>
                  <div class="workbench-outcome-metric-label">标准容器圆角</div>
                </div>
                <div class="workbench-outcome-metric">
                  <div class="workbench-outcome-metric-value">100%</div>
                  <div class="workbench-outcome-metric-label">胶囊药丸率</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. 右侧栏组织审查器与大按钮 -->
      <div id="section-right-sidebar">
        <div class="fixture-section-header">4. 右侧栏组织审查器与大卡片按钮 (单层指标网格, 无 1px 细线, 胶囊刷新)</div>
        <div style="display: flex; flex-direction: column; gap: 16px; max-width: 520px; margin: 0 auto;">
          <button class="right-sidebar-big-button" type="button">
            <div class="right-sidebar-big-button-icon"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg></div>
            <div class="right-sidebar-big-button-main">
              <div class="right-sidebar-big-button-title">自动化协同总览</div>
              <div class="right-sidebar-big-button-subtitle">查看所有根会话与派生会话的编排拓扑与实时健康度</div>
            </div>
            <div class="right-sidebar-big-button-chevron"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></div>
          </button>

          <div class="organization-inspector" style="background: var(--bg); border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); padding: 14px;">
            <div class="organization-inspector-header">
              <div class="organization-inspector-title-block">
                <div class="organization-inspector-eyebrow">Root Session Status</div>
                <h3>主流程自动化编排</h3>
              </div>
              <button class="organization-inspector-refresh" type="button" aria-label="Refresh" data-icon="refresh"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.3 5.6L21 8"/><path d="M21 3v5h-5"/></svg></button>
            </div>
            <div class="organization-summary" style="padding: 10px 0;">
              <div class="organization-summary-item">
                <span>总节点</span>
                <strong>12</strong>
              </div>
              <div class="organization-summary-item">
                <span>已完成</span>
                <strong>10</strong>
              </div>
              <div class="organization-summary-item">
                <span>阻断</span>
                <strong>0</strong>
              </div>
              <div class="organization-summary-item">
                <span>耗时</span>
                <strong>2.4m</strong>
              </div>
            </div>
            <div class="organization-phase-list">
              <div class="organization-phase-row" data-state="completed">
                <span>Phase 1: 视觉设计系统审计</span>
                <b>PASS</b>
              </div>
              <div class="organization-phase-row" data-state="completed">
                <span>Phase 2: 容器与组件无缝收敛</span>
                <b>ACTIVE</b>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. 工作区文件阅读器 -->
      <div id="section-file-reader">
        <div class="fixture-section-header">5. 文件阅读器 (Zero Borders, 16px 容器, 9999px 胶囊工具按钮)</div>
        <div class="workspace-file-reader" style="position: static !important; transform: none !important; opacity: 1 !important; display: flex !important; width: 100%; max-width: 560px; margin: 0 auto; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.07); background: var(--bg);">
          <div class="workspace-file-reader-header" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;">
            <div class="workspace-file-reader-title-group">
              <span class="workspace-file-reader-title" style="font-weight: 700; font-size: 14px;">AGENTS.md</span>
              <span class="workspace-file-reader-path" style="font-size: 11px; color: #888;">/home/example/project/AGENTS.md</span>
            </div>
            <div class="workspace-file-reader-actions" style="display: flex; gap: 8px;">
              <button class="workspace-file-reader-refresh" type="button" aria-label="Refresh" data-icon="refresh"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.3 5.6L21 8"/><path d="M21 3v5h-5"/></svg></button>
              <button class="workspace-file-reader-close" type="button" aria-label="Close" data-icon="close"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </div>
          </div>
          <div class="workspace-file-reader-search" style="padding: 8px 16px;">
            <input class="workspace-file-reader-search-input" placeholder="在文件中搜索…" style="width: 100%;">
          </div>
          <div class="workspace-file-reader-content" style="padding: 16px; font-family: monospace; font-size: 12px; line-height: 1.6;">
            # AGENTS.md — Ragent Project Context<br>
            All platform assumptions, packaging, capability boundaries, and adapter gating treat Windows and Android as first-class surfaces.
          </div>
        </div>
      </div>

      <!-- 6. 目标专注模式抽屉 -->
      <div id="section-goal-sheet">
        <div class="fixture-section-header">6. 目标专注抽屉 (平滑微加深一体底, 无独立圆角小盒子拼贴)</div>
        <div id="goalSheet" class="goal-sheet is-open" style="position: static; transform: none; width: 100%; max-width: 520px; margin: 0 auto; display: block;">
          <div class="modal" style="width: 100%; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.07);">
            <div class="goal-sheet-header" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 16px;">
              <span style="font-weight: 700; font-size: 15px;">目标模式状态</span>
              <button class="modal-close" type="button" aria-label="Close" data-icon="close"><svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </div>
            <div class="goal-sheet-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
              <div class="goal-status-display" style="padding: 12px 14px; border-radius: 12px;">
                <span class="goal-status-badge">进行中</span>
                <span style="font-size: 13px; margin-left: 8px;">完成跨端组件无边框标准对齐</span>
              </div>
              <div class="goal-toggle" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-radius: 12px;">
                <span style="font-size: 13px;">自动推进下一阶段任务</span>
                <input type="checkbox" checked style="accent-color: var(--notice);">
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body>
  </html>`;
}

const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 2800 } });
    await page.emulateMedia({ colorScheme: theme });
    await page.setContent(renderFixtureHtml(theme), { waitUntil: 'load' });

    // Assert computed styles for zero borders and standard radii
    const checks = await page.evaluate(() => {
      const crossDeviceSheet = document.querySelector('.cross-device-sheet');
      const crossDeviceAction = document.querySelector('.cross-device-action');
      const settingsGroupCard = document.querySelector('.settings-group-card');
      const settingsRowBtn = document.querySelector('.settings-row-button');
      const csTrigger = document.querySelector('.cs-trigger');
      const workbenchTab = document.querySelector('.workbench-inspector-tab.active');
      const outcomeMetric = document.querySelector('.workbench-outcome-metric');
      const bigButton = document.querySelector('.right-sidebar-big-button');
      const orgItem = document.querySelector('.organization-summary-item');
      const orgRefresh = document.querySelector('.organization-inspector-refresh');
      const fileReader = document.querySelector('.workspace-file-reader');
      const fileReaderBtn = document.querySelector('.workspace-file-reader-refresh');
      const fileReaderInput = document.querySelector('.workspace-file-reader-search-input');
      const goalSheetModal = document.querySelector('#goalSheet .modal');

      return {
        crossDeviceSheetBorder: getComputedStyle(crossDeviceSheet).borderWidth,
        crossDeviceSheetRadius: getComputedStyle(crossDeviceSheet).borderRadius,
        crossDeviceActionRadius: getComputedStyle(crossDeviceAction).borderRadius,
        settingsGroupCardRadius: getComputedStyle(settingsGroupCard).borderRadius,
        settingsGroupCardBorder: getComputedStyle(settingsGroupCard).borderWidth,
        settingsRowBtnRadius: getComputedStyle(settingsRowBtn).borderRadius,
        csTriggerRadius: getComputedStyle(csTrigger).borderRadius,
        csTriggerBorder: getComputedStyle(csTrigger).borderWidth,
        workbenchTabRadius: getComputedStyle(workbenchTab).borderRadius,
        outcomeMetricBorder: getComputedStyle(outcomeMetric).borderWidth,
        outcomeMetricRadius: getComputedStyle(outcomeMetric).borderRadius,
        bigButtonBorder: getComputedStyle(bigButton).borderWidth,
        bigButtonRadius: getComputedStyle(bigButton).borderRadius,
        orgItemBorder: getComputedStyle(orgItem).borderWidth,
        orgRefreshRadius: getComputedStyle(orgRefresh).borderRadius,
        fileReaderBorder: getComputedStyle(fileReader).borderWidth,
        fileReaderRadius: getComputedStyle(fileReader).borderRadius,
        fileReaderBtnRadius: getComputedStyle(fileReaderBtn).borderRadius,
        fileReaderInputBorder: getComputedStyle(fileReaderInput).borderWidth,
        fileReaderInputRadius: getComputedStyle(fileReaderInput).borderRadius,
        goalSheetBorder: getComputedStyle(goalSheetModal).borderWidth,
        goalSheetRadius: getComputedStyle(goalSheetModal).borderRadius,
      };
    });

    assert.equal(checks.crossDeviceSheetBorder, '0px', `${theme}: cross-device sheet must have 0px border`);
    assert.equal(checks.crossDeviceSheetRadius, '16px', `${theme}: cross-device sheet must have 16px radius`);
    assert.ok(parseInt(checks.crossDeviceActionRadius, 10) >= 900, `${theme}: cross-device action must be a capsule pill`);
    assert.equal(checks.settingsGroupCardRadius, '16px', `${theme}: settings-group-card must have 16px radius`);
    assert.equal(checks.settingsGroupCardBorder, '0px', `${theme}: settings-group-card must have 0px border`);
    assert.ok(parseInt(checks.settingsRowBtnRadius, 10) >= 900, `${theme}: settings-row-button must be a capsule pill`);
    assert.ok(parseInt(checks.csTriggerRadius, 10) >= 900, `${theme}: cs-trigger must be a capsule pill`);
    assert.equal(checks.csTriggerBorder, '0px', `${theme}: cs-trigger must have 0px border`);
    assert.ok(parseInt(checks.workbenchTabRadius, 10) >= 900, `${theme}: workbench tab must be a capsule pill`);
    assert.equal(checks.outcomeMetricBorder, '0px', `${theme}: outcome metric must have 0px border`);
    assert.equal(checks.outcomeMetricRadius, '12px', `${theme}: outcome metric must have 12px radius`);
    assert.equal(checks.bigButtonBorder, '0px', `${theme}: big button must have 0px border`);
    assert.equal(checks.bigButtonRadius, '16px', `${theme}: big button must have 16px radius`);
    assert.equal(checks.orgItemBorder, '0px', `${theme}: organization summary item must have 0px border`);
    assert.ok(parseInt(checks.orgRefreshRadius, 10) >= 900, `${theme}: organization refresh must be a capsule pill`);
    assert.equal(checks.fileReaderBorder, '0px', `${theme}: file reader must have 0px border`);
    assert.equal(checks.fileReaderRadius, '16px', `${theme}: file reader must have 16px radius`);
    assert.ok(parseInt(checks.fileReaderBtnRadius, 10) >= 900, `${theme}: file reader btn must be a capsule pill`);
    assert.equal(checks.fileReaderInputBorder, '0px', `${theme}: file reader search input must have 0px border`);
    assert.ok(parseInt(checks.fileReaderInputRadius, 10) >= 900, `${theme}: file reader input must be a capsule pill`);
    assert.equal(checks.goalSheetBorder, '0px', `${theme}: goal sheet must have 0px border`);
    assert.equal(checks.goalSheetRadius, '16px', `${theme}: goal sheet must have 16px radius`);

    // Capture overall suite screenshot
    const suiteScreenshot = join(artifactDir, `standard_containers_suite_${theme}.png`);
    await page.screenshot({ path: suiteScreenshot, fullPage: true });
    console.log(`Saved screenshot: ${suiteScreenshot}`);

    // Capture individual section screenshots for walkthrough gallery
    const sections = [
      { id: 'section-cross-device', name: `cross_device_panel_${theme}.png` },
      { id: 'section-settings', name: `settings_panel_${theme}.png` },
      { id: 'section-workbench', name: `workbench_inspector_${theme}.png` },
      { id: 'section-right-sidebar', name: `right_sidebar_inspector_${theme}.png` },
      { id: 'section-file-reader', name: `workspace_file_reader_${theme}.png` },
      { id: 'section-goal-sheet', name: `goal_sheet_drawer_${theme}.png` },
    ];

    for (const sec of sections) {
      const el = page.locator(`#${sec.id}`);
      const secPath = join(artifactDir, sec.name);
      await el.screenshot({ path: secPath });
      console.log(`Saved screenshot: ${secPath}`);
    }

    await page.close();
  }

  // Also verify login page in light and dark
  for (const theme of ['light', 'dark']) {
    const loginPage = await browser.newPage({ viewport: { width: 440, height: 750 } });
    await loginPage.emulateMedia({ colorScheme: theme });
    await loginPage.setContent(loginHtml, { waitUntil: 'load' });
    const loginChecks = await loginPage.evaluate(() => {
      const card = document.querySelector('.card');
      const btn = document.querySelector('.btn');
      const input = document.querySelector('input[type=password]');
      return {
        cardBorder: getComputedStyle(card).borderWidth,
        cardRadius: getComputedStyle(card).borderRadius,
        btnRadius: getComputedStyle(btn).borderRadius,
        inputRadius: getComputedStyle(input).borderRadius,
        inputBorder: getComputedStyle(input).borderWidth,
      };
    });

    assert.equal(loginChecks.cardBorder, '0px', `${theme}: login card must have 0px border`);
    assert.equal(loginChecks.cardRadius, '20px', `${theme}: login card must have 20px radius`);
    assert.ok(parseInt(loginChecks.btnRadius, 10) >= 900, `${theme}: login button must be a capsule pill`);
    assert.ok(parseInt(loginChecks.inputRadius, 10) >= 900, `${theme}: login input must be a capsule pill`);
    assert.equal(loginChecks.inputBorder, '0px', `${theme}: login input must have 0px border`);

    const loginScreenshotPath = join(artifactDir, `standard_login_page_${theme}.png`);
    await loginPage.screenshot({ path: loginScreenshotPath, fullPage: true });
    console.log(`Saved screenshot: ${loginScreenshotPath}`);
    await loginPage.close();
  }

  console.log('ALL STANDARD CONTAINERS & CONTROLS FULLY VERIFIED!');
} finally {
  await browser.close();
}

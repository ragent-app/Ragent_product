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
  'static/chat/chat-sidebar.css',
  'static/chat/chat-messages.css',
  'static/chat/right-sidebar.css',
  'static/chat/workspace-file-reader.css',
  'static/chat/chat-input.css',
  'static/chat/chat-run-sheet.css',
  'static/chat/chat-responsive.css',
  'static/chat/custom-select.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-goal-ui.css',
  'static/chat/chat-sheet-actions.css',
  'static/chat/chat-sidebar-motion.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-operational-surfaces.css',
  'static/chat/chat-material-finish.css',
];
const styles = cssFiles.map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');
const iconsJs = readFileSync(join(repoRoot, 'static/chat/icons.js'), 'utf8');

function renderL1Html(theme = 'light') {
  return `<!doctype html>
  <html data-theme="${theme}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: ${theme === 'dark' ? '#0f1011' : '#f4f5f8'};
        color: ${theme === 'dark' ? '#e5e7eb' : '#1f2937'};
        display: flex;
        align-items: center;
        justify-content: center;
      }
      ${styles}
      /* Ensure sidebar is displayed statically inside container for clean screenshot */
      .sidebar-capture-wrap {
        width: 320px;
        height: 740px;
        border-radius: 20px;
        overflow: hidden;
        position: relative;
        background: var(--bg-secondary);
        box-shadow: 0 16px 48px rgba(0,0,0,0.18);
      }
      .sidebar-capture-wrap .sidebar {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        transform: none;
        transition: none;
      }
    </style>
  </head>
  <body>
    <div class="sidebar-capture-wrap" id="capture-wrap">
      <aside class="sidebar" id="sidebar">
        <!-- App Bar -->
        <div class="sidebar-app-bar" id="sidebarAppBar">
          <div class="sidebar-brand">Ragent</div>
          <div class="sidebar-app-bar-actions">
            <button class="sidebar-icon-btn" id="sidebarSearchBtn" type="button" title="Search" data-icon="search"></button>
            <button class="sidebar-icon-btn" id="closeSidebar" type="button" title="Close" data-icon="close"></button>
          </div>
        </div>

        <!-- Device Bar (L1 only) -->
        <div class="sidebar-device-bar" id="sidebarDeviceBar">
          <button class="sidebar-device-name-btn" id="sidebarDeviceNameBtn" type="button" title="Switch device">
            <span class="sidebar-device-name-icon" data-icon="monitor" aria-hidden="true"></span>
            <span class="sidebar-device-name-text">ragent-dev (Linux Host)</span>
            <span class="sidebar-device-name-chevron" data-icon="chevron-down" aria-hidden="true"></span>
          </button>
          <button class="sidebar-device-add-btn" id="sidebarDeviceAddBtn" type="button" title="Add device" data-icon="monitor-plus"></button>
        </div>

        <!-- Workspace Nav -->
        <nav class="sidebar-primary-nav" id="sidebarPrimaryNav">
          <div class="sidebar-workspace" id="workspacePicker">
            <button class="sidebar-workspace-summary sidebar-primary-action" id="workspaceSummaryButton" type="button">
              <span class="sidebar-workspace-summary-icon" data-icon="folder-solid" aria-hidden="true"></span>
              <span class="sidebar-workspace-summary-text" id="workspaceSummaryText">Workspace: /home/example/project</span>
              <span class="sidebar-primary-action-chevron" data-icon="chevron-down" aria-hidden="true"></span>
            </button>
            <button class="sidebar-project-create-btn" id="projectCreateButton" type="button" title="Create project" data-icon="folder-plus"></button>
          </div>
        </nav>

        <!-- L1 Projects View -->
        <div class="sidebar-session-surface" id="sidebarSessionSurface">
          <div class="sidebar-projects-view" id="projectsView">
            <!-- Project 1 -->
            <div class="sidebar-project-group">
              <div class="sidebar-project-head-row">
                <button type="button" class="sidebar-project-head is-open" data-running="true">
                  <span class="sidebar-project-head-icon" data-icon="folder-solid"></span>
                  <span class="sidebar-project-head-name">Ragent Core</span>
                  <span class="sidebar-project-head-pin" data-icon="pinned" title="Pinned"></span>
                  <span class="sidebar-project-head-count">4</span>
                  <span class="sidebar-project-head-chevron" data-icon="chevron-right"></span>
                </button>
              </div>
              <div class="sidebar-project-preview">
                <div class="session-item active">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">重构左侧栏标准容器风格</span>
                    </div>
                    <span class="session-item-status session-item-status--running" aria-hidden="true"></span>
                    <span class="session-item-time">14:52</span>
                  </button>
                </div>
                <div class="session-item">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">跨设备直连配对与中继优化</span>
                    </div>
                    <span class="session-item-status session-item-status--unread" aria-hidden="true"></span>
                    <span class="session-item-time">13:20</span>
                  </button>
                </div>
                <div class="session-item">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">Windows A0 自动化诊断</span>
                    </div>
                    <span class="session-item-time">昨天</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- Project 2 -->
            <div class="sidebar-project-group">
              <div class="sidebar-project-head-row">
                <button type="button" class="sidebar-project-head">
                  <span class="sidebar-project-head-icon" data-icon="folder-solid"></span>
                  <span class="sidebar-project-head-name">Android Client</span>
                  <span class="sidebar-project-head-count">2</span>
                  <span class="sidebar-project-head-chevron" data-icon="chevron-right"></span>
                </button>
              </div>
              <div class="sidebar-project-preview">
                <div class="session-item">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">Compose UI 视觉回归测试</span>
                    </div>
                    <span class="session-item-time">09-02</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom Actions Bar -->
        <div class="sidebar-bottom-frost" aria-hidden="true"></div>
        <div class="sidebar-bottom-actions" id="sidebarBottomActions">
          <button class="new-session-btn sidebar-new-chat-btn" id="newSessionBtn" type="button">
            <span class="sidebar-new-chat-icon" data-icon="folder-plus" aria-hidden="true"></span>
            <span>新建项目</span>
          </button>
          <button class="sidebar-filter-btn" id="sidebarFilterBtn" type="button" title="Settings" data-icon="gear-solid"></button>
          <button class="sidebar-account-btn" id="sidebarAccountBtn" type="button" title="Account">
            <span class="sidebar-account-avatar">A</span>
            <span class="sidebar-account-indicator" aria-hidden="true"></span>
          </button>
        </div>
      </aside>
    </div>

    <script>
      ${iconsJs}
      window.RagentIcons.hydrate(document);
    </script>
  </body>
  </html>`;
}

function renderL2Html(theme = 'light') {
  return `<!doctype html>
  <html data-theme="${theme}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: ${theme === 'dark' ? '#0f1011' : '#f4f5f8'};
        color: ${theme === 'dark' ? '#e5e7eb' : '#1f2937'};
        display: flex;
        align-items: center;
        justify-content: center;
      }
      ${styles}
      .sidebar-capture-wrap {
        width: 320px;
        height: 740px;
        border-radius: 20px;
        overflow: hidden;
        position: relative;
        background: var(--bg-secondary);
        box-shadow: 0 16px 48px rgba(0,0,0,0.18);
      }
      .sidebar-capture-wrap .sidebar {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        transform: none;
        transition: none;
      }
    </style>
  </head>
  <body>
    <div class="sidebar-capture-wrap" id="capture-wrap">
      <aside class="sidebar" id="sidebar">
        <!-- App Bar -->
        <div class="sidebar-app-bar" id="sidebarAppBar">
          <div class="sidebar-brand">Ragent</div>
          <div class="sidebar-app-bar-actions">
            <button class="sidebar-icon-btn" id="sidebarSearchBtn" type="button" title="Search" data-icon="search"></button>
            <button class="sidebar-icon-btn" id="closeSidebar" type="button" title="Close" data-icon="close"></button>
          </div>
        </div>

        <!-- L2 Project Header -->
        <div class="sidebar-project-header" id="sidebarProjectHeader">
          <button class="sidebar-icon-btn" id="sidebarProjectBackBtn" type="button" title="Back to projects" data-icon="chevron-left"></button>
          <span class="sidebar-project-header-icon" data-icon="folder-solid" aria-hidden="true"></span>
          <span class="sidebar-project-header-title" id="sidebarProjectTitle">Ragent Core</span>
          <button class="sidebar-icon-btn sidebar-project-settings-btn" id="sidebarProjectSettingsBtn" type="button" title="Project settings" data-icon="gear"></button>
        </div>

        <!-- L2 Sessions List -->
        <div class="sidebar-session-surface" id="sidebarSessionSurface">
          <div class="sidebar-list" id="sessionList">
            <div class="folder-group unified-sessions">
              <div class="folder-group-header sidebar-session-section-header">运行中</div>
              <div class="folder-group-items">
                <div class="session-item active">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">重构左侧栏标准容器风格</span>
                    </div>
                    <span class="session-item-status session-item-status--running" aria-hidden="true"></span>
                    <span class="session-item-time">14:52</span>
                  </button>
                </div>
              </div>

              <div class="folder-group-header sidebar-session-section-header">最近会话</div>
              <div class="folder-group-items">
                <div class="session-item">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">跨设备直连配对与中继优化</span>
                    </div>
                    <span class="session-item-status session-item-status--unread" aria-hidden="true"></span>
                    <span class="session-item-time">13:20</span>
                  </button>
                </div>
                <div class="session-item">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">Windows A0 自动化诊断</span>
                    </div>
                    <span class="session-item-time">昨天</span>
                  </button>
                </div>
                <div class="session-item">
                  <button type="button" class="session-item-main">
                    <div class="session-item-info">
                      <span class="session-item-name">Native Provider 凭据同步</span>
                    </div>
                    <span class="session-item-status session-item-status--needs-action" aria-hidden="true"></span>
                    <span class="session-item-time">09-02</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom Actions Bar -->
        <div class="sidebar-bottom-frost" aria-hidden="true"></div>
        <div class="sidebar-bottom-actions" id="sidebarBottomActions">
          <button class="new-session-btn sidebar-new-chat-btn" id="newSessionBtn" type="button">
            <span class="sidebar-new-chat-icon" data-icon="new-chat" aria-hidden="true"></span>
            <span>新对话</span>
          </button>
          <button class="sidebar-agent-btn" id="sidebarAgentBtn" type="button" title="Agents">
            <span class="sidebar-agent-icon" data-icon="sparkle-solid" aria-hidden="true"></span>
          </button>
          <button class="sidebar-filter-btn" id="sidebarFilterBtn" type="button" title="Settings" data-icon="gear-solid"></button>
          <button class="sidebar-account-btn" id="sidebarAccountBtn" type="button" title="Account">
            <span class="sidebar-account-avatar">A</span>
            <span class="sidebar-account-indicator" aria-hidden="true"></span>
          </button>
        </div>
      </aside>
    </div>

    <script>
      ${iconsJs}
      window.RagentIcons.hydrate(document);
    </script>
  </body>
  </html>`;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const renders = [
      { name: 'sidebar_l1_projects_light_current.png', html: renderL1Html('light'), theme: 'light' },
      { name: 'sidebar_l1_projects_dark_current.png', html: renderL1Html('dark'), theme: 'dark' },
      { name: 'sidebar_l2_sessions_light_current.png', html: renderL2Html('light'), theme: 'light' },
      { name: 'sidebar_l2_sessions_dark_current.png', html: renderL2Html('dark'), theme: 'dark' },
    ];

    for (const item of renders) {
      const page = await browser.newPage({ viewport: { width: 600, height: 900 } });
      await page.emulateMedia({ colorScheme: item.theme });
      await page.setContent(item.html, { waitUntil: 'load' });
      if (item.name.includes('l2')) {
        const rules = await page.evaluate(() => {
          const el = document.querySelector('.folder-group-header');
          const matched = [];
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) {
                if (rule.selectorText && el.matches(rule.selectorText)) {
                  if (rule.style.display) {
                    matched.push({ sel: rule.selectorText, display: rule.style.display });
                  }
                }
              }
            } catch (e) {}
          }
          return matched;
        });
        console.log('rules setting display:', rules);
      }
      const target = page.locator('#capture-wrap');
      const outPath = join(artifactDir, item.name);
      await target.screenshot({ path: outPath });
      console.log(`Saved: ${item.name}`);
      await page.close();
    }
    console.log('Visual test capture complete.');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

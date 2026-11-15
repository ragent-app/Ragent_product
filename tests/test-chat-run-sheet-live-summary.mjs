#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const runSheetSource = readFileSync(join(repoRoot, 'static/chat/run-sheet.js'), 'utf8');
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8');
const runSheetCss = readFileSync(join(repoRoot, 'static/chat/chat-run-sheet.css'), 'utf8');
const liveStatusSource = readFileSync(join(repoRoot, 'static/chat/live-status-ui.js'), 'utf8');
const runActivitySource = readFileSync(join(repoRoot, 'static/chat/run-activity-ui.js'), 'utf8');

const renderNowStart = runSheetSource.indexOf('function renderNow(model)');
const renderPlanStart = runSheetSource.indexOf('function renderPlan(model)');
assert.ok(renderNowStart >= 0 && renderPlanStart > renderNowStart);
const renderNowSource = runSheetSource.slice(renderNowStart, renderPlanStart);

assert.match(
  renderNowSource,
  /RagentRunActivity\?\.getPresentation\?\.\(\)\?\.text/,
  'Run Sheet current status should consume the canonical live summary',
);
assert.doesNotMatch(
  renderNowSource,
  /getLivePresentation/,
  'Run Sheet should keep showing the current action instead of the Live Bar progress override',
);
assert.match(
  renderNowSource,
  /isCurrentAttachedSession\(model\.session\) && isRunningSession\(model\.session\)/,
  'Run Sheet should not let stale Live Bar text make a completed session look running',
);
assert.doesNotMatch(
  renderNowSource,
  /sortedActivity\(model\)\[0\]/,
  'Run Sheet must not infer current work from the latest historical activity item',
);
assert.match(
  runSheetSource,
  /RagentRunActivity\?\.subscribe/,
  'an open Run Sheet should subscribe to summary updates',
);
assert.match(
  runSheetSource,
  /function resolveRunSheetTargetSession\(\)/,
  'Run Sheet should resolve its own target session',
);
assert.match(
  runSheetSource,
  /\.filter\(isRunningSession\)/,
  'Run Sheet should prefer currently running sessions',
);
assert.match(
  runSheetSource,
  /sessionSortTime\(b\) - sessionSortTime\(a\)/,
  'Run Sheet should fall back to the latest session by activity time',
);
assert.match(
  runSheetSource,
  /fetchRunSheetModel\(target,\s*\{\s*forceFresh\s*\}\)/,
  'Run Sheet should fetch its dedicated projection without an inspector dependency',
);
assert.match(
  runSheetSource,
  /function scheduleContentRefresh/,
  'Run Sheet should expose a scheduleContentRefresh entry point for open and background refreshes',
);
assert.match(
  runSheetSource,
  /scheduleContentRefresh\(\{ forceFresh: true, delay: 0 \}\)/,
  'Run Sheet should refresh its target model when the sheet is opened',
);
assert.match(
  runSheetSource,
  /renderResolvedContent\(\);\s*scheduleContentRefresh\(\{ forceFresh: true, delay: 0 \}\);/,
  'Opening the Run Sheet should paint the warm cached model before asking for a fresh update',
);
assert.match(runSheetSource, /const modelCache = new Map\(\)/, 'Run Sheet should keep a per-session projection cache');
assert.match(runSheetSource, /function adoptCachedModel\(sessionId\)/, 'Run Sheet should adopt cached content immediately when the target session changes');
assert.match(runSheetSource, /nextSessionId !== previousSessionId[\s\S]*?scheduleContentRefresh\(\{ forceFresh: true, delay: 0 \}\)/, 'session changes should trigger an immediate closed-state preload');
assert.match(runSheetSource, /if \(!state\.open && !forceFresh\)/, 'explicit session preloads should bypass the background refresh throttle');

const refreshContentStart = runSheetSource.indexOf('async function refreshContent');
const openMarkdownButtonStart = runSheetSource.indexOf('function openMarkdownFromButton');
assert.ok(refreshContentStart >= 0 && openMarkdownButtonStart > refreshContentStart);
const refreshContentSource = runSheetSource.slice(refreshContentStart, openMarkdownButtonStart);
assert.doesNotMatch(
  refreshContentSource,
  /if \(!state\.open\) return null;/,
  'Run Sheet refresh should run in the background while the sheet is closed to keep the cached model warm',
);
assert.match(
  refreshContentSource,
  /refreshInFlight/,
  'Run Sheet should coalesce overlapping model refreshes to reduce update delay and fetch pressure',
);
assert.match(
  runSheetSource,
  /function scheduleBackgroundPoll/,
  'Run Sheet should keep its polling entry point for open and closed refreshes',
);
assert.match(
  runSheetSource,
  /function scheduleContentRefresh[\s\S]*?refreshTimer = setTimeout/,
  'Run Sheet should schedule refreshes even while closed, so background update hooks keep the model warm',
);
assert.doesNotMatch(
  runSheetSource,
  /clearRefreshTimers/,
  'Run Sheet must not drop refresh requests while the sheet is closed',
);
assert.match(
  runSheetSource,
  /BACKGROUND_MIN_INTERVAL_MS/,
  'Run Sheet should cap the background refresh cadence while closed so streaming activity does not hammer the projection endpoint',
);
assert.match(
  runSheetSource,
  /function close\(\)[\s\S]*?scheduleBackgroundPoll\(\)/,
  'Closing the Run Sheet should keep the background poll armed so the next open paints warm data',
);
assert.match(
  runSheetSource,
  /api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/run-sheet/,
  'Run Sheet should call the lightweight run-sheet endpoint directly',
);
assert.doesNotMatch(
  runSheetSource,
  /RagentWorkbench|fetchAllSessionEvents/,
  'Run Sheet must not retain the desktop audit model or raw all-events dependency',
);

const renderPlanSourceStart = runSheetSource.indexOf('function renderPlan(model)');
const renderMarkdownStart = runSheetSource.indexOf('function renderMarkdownFiles(model)');
assert.ok(renderPlanSourceStart >= 0 && renderMarkdownStart > renderPlanSourceStart);
const renderPlanSource = runSheetSource.slice(renderPlanSourceStart, renderMarkdownStart);
assert.match(
  renderPlanSource,
  /selectProgressPlan\(model\)/,
  'Run Sheet plan card should use the scoped progress-plan selector',
);
assert.match(
  renderPlanSource,
  /renderPlanDetails\(items,\s*currentText\)/,
  'Run Sheet progress card should expand from the current progress line',
);
assert.match(
  renderPlanSource,
  /run-sheet__section run-sheet__section--plan/,
  'Run Sheet plan should remain the compact-mode progress surface',
);
assert.match(
  runSheetSource,
  /run-sheet__section run-sheet__section--files/,
  'Run Sheet changed files should be identifiable as expanded-mode detail',
);
assert.match(
  renderPlanSource,
  /run-sheet__progress-fill[^>]*style="--run-sheet-progress:\$\{ratio \/ 100\}"/,
  'Run Sheet progress should pass a normalized transform scale instead of an animated layout width',
);
assert.match(
  runSheetSource,
  /planItemText\(current\)/,
  'Run Sheet plan card should render item text/title/step, not only title',
);
assert.match(
  runSheetSource,
  /<summary class="run-sheet__plan-current">/,
  'Run Sheet should make the current progress line the expandable control',
);
assert.doesNotMatch(
  runSheetSource,
  /run-sheet__plan-summary/,
  'Run Sheet should not render a separate progress details header',
);
assert.match(
  runActivitySource,
  /text:\s*summary/,
  'Live Bar progress should show only the fraction and current step',
);
assert.doesNotMatch(
  runActivitySource,
  /text:\s*`\$\{tr\("plan\.progress\.label"\)\}/,
  'Live Bar progress should not prefix the label text',
);
assert.match(
  runSheetSource,
  /function activeRunningRunId\(model\)/,
  'Run Sheet should only anchor the plan to session activity while a run is actually running',
);
assert.match(
  runSheetSource,
  /activity\?\.run\?\.state !== "running"/,
  'Run Sheet should not treat an idle session runId as the active running run',
);
assert.match(
  runSheetSource,
  /function latestEventRunId\(model\)/,
  'Run Sheet should fall back to the latest event run id when no run is currently active',
);
assert.match(
  runSheetSource,
  /function latestPlanRunId\(plans\)/,
  'Run Sheet should use the latest run-scoped plan only as a legacy fallback when event run ids are unavailable',
);
assert.match(
  runSheetSource,
  /findLatestPlanForRun\(plans, activeRunId\)/,
  'Run Sheet should select the current run progress card when a running run id is available',
);
assert.doesNotMatch(
  runSheetSource,
  /findLatestPlanForRun\(plans, activeRunId\)\s*\|\|\s*plans\[0\]/,
  'Run Sheet must not fall back to an older completed plan when the active run has no plan yet',
);

const renderStreamStart = runSheetSource.indexOf('function renderStream(model)');
const renderResolvedStart = runSheetSource.indexOf('function renderResolvedContent()');
assert.ok(renderStreamStart >= 0 && renderResolvedStart > renderStreamStart);
const renderStreamSource = runSheetSource.slice(renderStreamStart, renderResolvedStart);
assert.match(
  renderStreamSource,
  /\[renderNow\(model\), renderPlan\(model\), renderMarkdownFiles\(model\), renderFiles\(model\)\]/,
  'Markdown files should render above changed files in the Run Sheet',
);
assert.match(
  runSheetSource,
  /function scopedMarkdownArtifacts\(model\)/,
  'Run Sheet Markdown files should be scoped before rendering',
);
assert.match(
  runSheetSource,
  /artifactSessionId\(artifact\)[\s\S]*?sessionId === targetSessionId/,
  'Run Sheet Markdown files should stay inside the resolved target session',
);
assert.match(
  runSheetSource,
  /const artifacts = scopedMarkdownArtifacts\(model\)/,
  'Run Sheet should render the scoped Markdown artifact list used by the current target session',
);
assert.match(
  runSheetSource,
  /data-markdown-artifact-session-id=/,
  'Run Sheet Markdown buttons should carry the artifact session id for click-time validation',
);
assert.match(
  runSheetSource,
  /artifactSession && targetSession && artifactSession !== targetSession/,
  'Run Sheet Markdown click handling should reject stale cross-session buttons',
);
assert.doesNotMatch(
  runSheetSource,
  /markdownRunIdForModel|data-markdown-artifact-run-id|targetRun && artifactRun/,
  'Run Sheet Markdown files should match the audit changes list for the target session, not be cropped to one run',
);
assert.doesNotMatch(
  runSheetSource,
  /function renderActivity|function renderFooter|data-action="open-audit"|runSheet\.recentActivity|runSheet\.openAudit/,
  'Run Sheet should not render the old recent activity section or full audit button',
);
assert.doesNotMatch(
  runSheetCss,
  /run-sheet__activity|run-sheet__footer|run-sheet__link/,
  'Run Sheet stylesheet should not keep dead recent activity/footer selectors',
);
assert.match(
  runSheetCss,
  /\.run-sheet__plan-details\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/,
  'Run Sheet expanded progress should be a borderless continuation of the plan card',
);
assert.match(
  runSheetCss,
  /\.run-sheet__progress-fill\s*\{[\s\S]*?transform:\s*scaleX\(var\(--run-sheet-progress,\s*0\)\)[\s\S]*?transition:\s*transform\b/,
  'Run Sheet progress should animate on the compositor-friendly transform property',
);
assert.match(
  runSheetCss,
  /\.run-sheet--compact \.run-sheet__section--markdown,[\s\S]*?\.run-sheet--compact \.run-sheet__section--files\s*\{[\s\S]*?display:\s*none;/,
  'Run Sheet compact mode should keep the sheet focused on now + progress instead of listing every detail',
);
assert.match(
  runSheetCss,
  /\.run-sheet__plan-chevron[\s\S]*?\.run-sheet__plan-chevron-expanded \{\s*display:\s*none;\s*\}/,
  'Run Sheet current progress line should expose a chevron affordance',
);
assert.match(
  runSheetCss,
  /\.run-sheet__plan-details\[open\] \.run-sheet__plan-chevron-collapsed \{\s*display:\s*none;\s*\}/,
  'the chevron should point right when collapsed and down when expanded',
);
assert.doesNotMatch(
  runSheetCss,
  /\.run-sheet__plan-summary/,
  'Run Sheet stylesheet should not keep the separate progress details header',
);

assert.match(
  runSheetSource,
  /function openMarkdownPreview/,
  'Run Sheet should open Markdown in its own synchronized preview layer',
);
assert.match(
  runSheetSource,
  /reader\.className = "run-sheet__reader"/,
  'Run Sheet should inject a reader inside the sheet instead of relying on a separate full-screen overlay',
);
assert.match(
  runSheetSource,
  /data-run-sheet-handle-zone/,
  'Run Sheet reader should expose the same drag handle contract as the base sheet',
);
assert.match(
  runSheetSource,
  /addEventListener\("pointerdown", handleDragStart\)/,
  'Run Sheet drag handle should use pointer events for touch-friendly resizing',
);
assert.match(
  runSheetSource,
  /setPointerCapture\(state\.dragPointerId\)/,
  'Run Sheet drag should keep tracking the finger after the handle is grabbed',
);
assert.match(
  runSheetSource,
  /Math\.abs\(deltaY\) > 3/,
  'Run Sheet drag should start after a small movement threshold',
);
assert.match(runSheetSource, /run-sheet--opening/, 'Run Sheet should expose an explicit opening motion state');
assert.match(runSheetSource, /run-sheet--closing/, 'Run Sheet should expose an explicit closing motion state');
assert.match(
  runSheetSource,
  /handleDocumentPointerDown[\s\S]*?dom\.sheet\.contains\(event\.target\)[\s\S]*?close\(\)/,
  'Run Sheet should close when a captured pointer lands outside the sheet',
);
assert.match(
  runSheetCss,
  /\.run-sheet__handle-zone\s*\{[\s\S]*?min-height:\s*36px;[\s\S]*?touch-action:\s*none;[\s\S]*?user-select:\s*none;/,
  'Run Sheet handle should expose a generous touch target',
);
assert.match(runSheetCss, /@keyframes run-sheet-present[\s\S]*?translate3d\(-50%, -18px, 0\) scale\(0\.92\)[\s\S]*?translate3d\(-50%, 0, 0\) scale\(1\)/, 'Run Sheet should expand downwards from top Live Bar when opening');
assert.match(runSheetCss, /@keyframes run-sheet-dismiss[\s\S]*?translate3d\(-50%, 0, 0\) scale\(1\)[\s\S]*?translate3d\(-50%, -14px, 0\) scale\(0\.94\)/, 'Run Sheet should collapse upward towards top Live Bar when closing');
assert.match(runSheetCss, /prefers-reduced-motion:\s*reduce[\s\S]*?run-sheet--closing/, 'Run Sheet motion should honor reduced-motion');
assert.match(
  runSheetCss,
  /\.run-sheet__reader\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?bottom:\s*0;/,
  'Markdown preview should be an independent bottom drawer decoupled from Run Sheet',
);
assert.match(
  runSheetCss,
  /@keyframes run-sheet-reader-present[\s\S]*?translate3d\(0, 100%, 0\)[\s\S]*?translate3d\(0, 0, 0\)/,
  'Markdown preview should animate upward from bottom when opening',
);
assert.match(
  runSheetCss,
  /@keyframes run-sheet-reader-dismiss[\s\S]*?translate3d\(0, 0, 0\)[\s\S]*?translate3d\(0, 100%, 0\)/,
  'Markdown preview should animate downward to bottom when closing',
);
assert.match(
  runSheetCss,
  /\.run-sheet__reader-content table\s*\{[\s\S]*?overflow-x:\s*auto;/,
  'Markdown preview should render wide tables inside the sheet reader',
);
assert.match(
  runSheetCss,
  /\.run-sheet__reader-content pre\s*\{[\s\S]*?overflow-x:\s*auto;/,
  'Markdown preview should render code blocks inside the sheet reader',
);
assert.match(
  runSheetCss,
  /\.run-sheet__reader-content img\s*\{[\s\S]*?max-width:\s*100%;/,
  'Markdown preview should render images inside the sheet reader',
);
assert.match(
  runSheetCss,
  /\.run-sheet__plan-details\s*\{[\s\S]*?background:\s*color-mix/,
  'Run Sheet expanded progress details should use the sheet surface language',
);
assert.match(
  runSheetCss,
  /\.run-sheet__plan-item--in_progress \.run-sheet__plan-marker/,
  'Run Sheet full progress list should highlight the current step',
);
assert.match(
  runSheetSource,
  /data-artifact-file-id=/,
  'Run Sheet artifact file cards should carry the backend artifact file id',
);
assert.match(
  runSheetSource,
  /artifactFiles:\s*Array\.isArray\(view\.artifactFiles\)/,
  'Run Sheet should consume artifact file records from its dedicated projection',
);
assert.match(
  runSheetSource,
  /progressPlans:\s*progressPlan \? \[progressPlan\] : \[\]/,
  'Run Sheet should consume only the current progress plan',
);
assert.doesNotMatch(
  runSheetSource,
  /fetchAllSessionEvents|RagentWorkbench/,
  'Run Sheet model building should not call full-events or audit-model code',
);

const renderEventStart = realtimeSource.indexOf('function renderEvent(');
const switchStart = realtimeSource.indexOf('switch (evt.type)', renderEventStart);
const formalOutputStart = realtimeSource.indexOf('RagentRunActivity?.noteFormalOutput', renderEventStart);
assert.ok(renderEventStart >= 0, 'realtime renderer should expose its event rendering function');
assert.ok(formalOutputStart > renderEventStart && formalOutputStart < switchStart);
assert.match(
  realtimeSource.slice(renderEventStart, switchStart),
  /evt\?\.type === "text_delta"/,
  'formal text deltas should suppress the inline summary before rendering',
);
assert.match(
  runActivitySource,
  /function getLivePresentation\(\)[\s\S]*?currentProgress/,
  'Run Activity should expose a Live Bar-specific progress presentation',
);
assert.match(
  runActivitySource,
  /function noteProgressPlan\(event = \{\}\)/,
  'Run Activity should track progress plan updates separately from action summaries',
);
assert.match(
  liveStatusSource,
  /RagentRunActivity\?\.getLivePresentation\?\.\(\)/,
  'Live Bar should prefer unfinished execution progress when available',
);

// ---- Refresh stability (flicker / auto-collapse fixes) ----
assert.match(
  runSheetSource,
  /BACKGROUND_RUNNING_POLL_MS = 10000;/,
  'running-session polling should drop to a disconnected fallback cadence',
);
assert.match(
  runSheetSource,
  /BACKGROUND_IDLE_POLL_MS = 30000;/,
  'idle polling should drop to a disconnected fallback cadence',
);
assert.match(
  runSheetSource,
  /if \(state\.model\) \{\s*\/\/ Cache fallback: keep showing the last good model/,
  'a fetch failure with a cached model should keep the last good content',
);
assert.match(
  runSheetSource,
  /openDetails = Array\.from\(dom\.content\.querySelectorAll\("details"\)\)/,
  'a rebuild should capture open details state before replacing content',
);
assert.match(
  runSheetSource,
  /for \(const index of openDetails\) \{\s*const el = details\[index\];\s*if \(el\) el\.open = true;/,
  'a rebuild should restore open details so the plan list never auto-collapses',
);
assert.match(
  runSheetSource,
  /RagentIcons\?\.render\?\.\("chevron-right"/,
  'the plan details chevron should render the right-pointing icon when collapsed',
);
assert.match(
  runSheetSource,
  /RagentIcons\?\.render\?\.\("chevron-down"/,
  'the plan details chevron should render the down-pointing icon when expanded',
);
assert.match(
  runSheetSource,
  /if \(dom\.sheet && dom\.sheet\.contains\(event\.target\)\) return;[\s\S]*?if \(dom\.reader && dom\.reader\.contains\(event\.target\)\) return;/,
  'pointerdown should not dismiss when clicking inside runsheet or reader',
);
assert.match(
  runSheetSource,
  /readerFocusScopeDeactivate = root\.RagentFocusScope\?\.activate\?\.\(dom\.reader,\s*\{[\s\S]*?containmentRoot:\s*dom\.reader,[\s\S]*?modal:\s*false,/,
  'reader focus scope should use containmentRoot dom.reader and modal false to avoid making runsheet inert',
);

console.log('test-chat-run-sheet-live-summary: ok');

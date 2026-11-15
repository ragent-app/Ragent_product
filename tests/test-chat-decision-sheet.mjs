#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const storeSource = read('static/chat/decisions-store.js');
const sheetSource = read('static/chat/decision-sheet.js');
const realtimeRenderSource = read('static/chat/realtime-render.js');
const liveStatusSource = read('static/chat/live-status-ui.js');
const bootstrapSource = read('static/chat/bootstrap.js');
const chatHtml = read('templates/chat.html');
const i18nSource = read('static/chat/i18n.js');
const cssSource = read('static/chat/chat-decision-sheet.css');
const attentionCssSource = read('static/chat/chat-attention-popup.css');
const attentionSource = read('static/chat/attention-popup.js');
const uiSource = read('static/chat/ui.js');
const sessionHttpSource = read('static/chat/session-http.js');
const messagesCssSource = read('static/chat/chat-messages.css');
const realtimeSource = read('static/chat/realtime.js');
const helpersSource = read('static/chat/session-http-helpers.js');

// ---------------------------------------------------------------------------
// 1. Decisions store — pub/sub shape (mirrors run-activity-ui.js)
// ---------------------------------------------------------------------------
assert.match(
  storeSource,
  /root\.RagentDecisions\s*=\s*Object\.freeze\(\{[\s\S]*?\bsubscribe\b[\s\S]*?\bnoteRequest\b[\s\S]*?\bnoteResponse\b[\s\S]*?\bgetPending\b[\s\S]*?\breset\b[\s\S]*?\}\);/,
  'RagentDecisions must expose subscribe/noteRequest/noteResponse/getPending/reset, frozen',
);
assert.match(
  storeSource,
  /subscribers\.add\(subscriber\);\s*\n\s*subscriber\(snapshot\(\)\);/,
  'subscribe must fire the subscriber immediately with the current snapshot (late-loader catch-up)',
);
assert.match(
  storeSource,
  /return\s*\(\)\s*=>\s*subscribers\.delete\(subscriber\)/,
  'subscribe must return an unsubscribe function',
);
assert.match(storeSource, /noteApprovedActionResolution/, 'approved-action batch responses close the pending store immediately');

// ---------------------------------------------------------------------------
// 2. Emit wiring in realtime-render.js (guarded, after the in-stream render)
// ---------------------------------------------------------------------------
assert.match(
  realtimeRenderSource,
  /case "approval_request":[\s\S]*?window\.RagentDecisions\?\.noteRequest\(evt\);/,
  'approval_request must notify RagentDecisions (the Decision Sheet store)',
);
assert.match(
  realtimeRenderSource,
  /case "approval_request":[\s\S]*?!historyPrepend[\s\S]*?window\.RagentDecisions\?\.noteRequest\(evt\);/,
  'approval_request must not notify the store on history replays (scroll-up pagination)',
);
assert.match(
  realtimeRenderSource,
  /case "approval_request":[\s\S]*?approvalRequestLiveId/,
  'full-sync page renders must gate approval_request on approvalRequestLiveId',
);
assert.doesNotMatch(
  realtimeRenderSource,
  /renderApprovalRequest\(evt\)/,
  'in-stream approval request rendering must be removed (2026-08-04)',
);
assert.match(
  realtimeRenderSource,
  /renderApprovalResponse\(evt\);[\s\S]*?!historyPrepend[\s\S]*?window\.RagentDecisions\?\.noteResponse\(evt\);/,
  'approval_response must notify RagentDecisions (skipped on history replays) so the sheet can dismiss',
);
assert.match(
  realtimeRenderSource,
  /case "approved_action_batch_request":[\s\S]*?approvalRequestLiveId[\s\S]*?noteApprovedAction\?\.\(evt\)/,
  'managed agent-creation approvals must only restore the sheet for the live batch',
);
assert.match(
  realtimeRenderSource,
  /case "approved_action_state":[\s\S]*?noteApprovedActionState\?\.\(evt\)/,
  'managed agent-creation action states must update the Decision Sheet',
);
assert.match(
  realtimeRenderSource,
  /case "approved_action_batch_response":[\s\S]*?noteApprovedActionResolution\?\.\(evt\)/,
  'managed agent-creation batch responses must close the Decision Sheet',
);

// ---------------------------------------------------------------------------
// 2b. Plan proposal <-> Decision Sheet bridge (2026-08-05)
// ---------------------------------------------------------------------------
// Claude Code plan-kind approvals keep an in-stream plan card (codex-proposal
// style) whose actions are live only for the pending prompt.
assert.match(
  realtimeRenderSource,
  /case "approval_request":[\s\S]*?String\(evt\?\.kind[\s\S]*?=== "plan"[\s\S]*?renderPlanApprovalCard\(evt,\s*\{/,
  'plan-kind approval_request must render an in-stream plan card (codex-proposal style)',
);
assert.match(
  realtimeRenderSource,
  /renderPlanApprovalCard[\s\S]*?livePrompt: !historyPrepend[\s\S]*?approvalRequestLiveId/,
  'the card actions must gate on the same history/liveId conditions as the store feed',
);
assert.match(
  realtimeRenderSource,
  /renderApprovalResponse\(evt\);[\s\S]*?updatePlanApprovalCardOnResponse\(evt\);/,
  'approval_response must flip the in-stream plan card to its final state',
);
// Codex proposals (plan events) feed the sheet under a synthesized approval id.
assert.match(
  realtimeRenderSource,
  /function planApprovalIdForPlanEvent[\s\S]*?return planId \? `plan:\$\{planId\}` : "";/,
  'plan proposals must use the "plan:<planId>" sheet identity (distinct from provider approval ids)',
);
assert.match(
  realtimeRenderSource,
  /case "plan":[\s\S]*?awaiting_decision[\s\S]*?buildPlanApprovalRequestEvent[\s\S]*?window\.RagentDecisions\?\.noteRequest\(sheetEvent\);/,
  'a live awaiting_decision plan must pop the Decision Sheet like a plan approval',
);
assert.match(
  realtimeRenderSource,
  /case "plan":[\s\S]*?!historyPrepend/,
  'plan sheet feed must never fire on history replays',
);
assert.match(
  realtimeRenderSource,
  /case "plan":[\s\S]*?isPlanSheetDismissState\(evt\)[\s\S]*?noteResponse\(\{\s*approvalId:\s*planApprovalId \}\)/,
  'executing/revising/terminal plan states must dismiss a matching sheet',
);
assert.match(
  realtimeRenderSource,
  /buildPlanApprovalRequestEvent[\s\S]*?kind:\s*"plan"[\s\S]*?planEventRef:\s*\{\s*planId/,
  'the synthesized approval event must carry kind plan + planEventRef for the sheet dispatch branch',
);
// Sheet dispatch: plan-derived approvals execute the artifact (or dismiss on
// deny) instead of POSTing a runtime_approval the provider does not know.
assert.match(
  sheetSource,
  /planEventRef[\s\S]*?submitPlanArtifactAction\([\s\S]*?"execute",\s*planId/,
  'sheet approve on a plan proposal must dispatch plan_action execute',
);
assert.match(
  sheetSource,
  /decision === "approve"[\s\S]*?root\.submitPlanArtifactAction[\s\S]*?root\.RagentDecisions\?\.noteResponse/,
  'sheet must clear the store after approving a plan proposal',
);
assert.match(
  sheetSource,
  /else \{[\s\S]*?ok = true;[\s\S]*?noteResponse\(\{\s*approvalId/,
  'sheet deny on a plan proposal must dismiss without a provider call (plan stays on its card)',
);
// In-stream plan approval card (ui.js): content mirrors the codex plan card,
// approve/deny buttons disabled unless the prompt is live.
assert.match(
  uiSource,
  /function renderPlanApprovalCardInto[\s\S]*?plan-card codex-plan-card plan-approval-card/,
  'the in-stream card must reuse the plan-card surface (codex-proposal look)',
);
assert.match(
  uiSource,
  /renderMarkdownFragmentIntoNode\(body,\s*reason\)/,
  'the card body must render through the shared markdown pipeline',
);
assert.match(
  uiSource,
  /createPlanApprovalActionButton\(evt,\s*"approve",\s*livePrompt\)[\s\S]*?createPlanApprovalModifyButton\(evt,\s*livePrompt,\s*card\)[\s\S]*?createPlanApprovalActionButton\(evt,\s*"deny",\s*livePrompt\)/,
  'the card must offer execute/modify/deny actions',
);
assert.match(
  uiSource,
  /button\.disabled\s*=\s*!livePrompt/,
  'card actions must be inert unless this is the live pending approval',
);
assert.match(
  uiSource,
  /function updatePlanApprovalCardOnResponseInto[\s\S]*?card\.dataset\.state\s*=\s*status[\s\S]*?actions\.hidden\s*=\s*true[\s\S]*?plan-card__status/,
  'approval_response must pin the final state on the card and hide its actions',
);
assert.match(
  uiSource,
  /function planApprovalIdFromPlan[\s\S]*?`plan:\$\{normalized\}`/,
  'ui.js must produce the same "plan:<planId>" id as realtime-render.js',
);
// Replay gate (session-http-helpers.js, loaded before session-http.js): a
// page with a pending plan proposal gates the full-sync render on its
// synthesized id, and stale/terminal plans never pop.
assert.match(
  helpersSource,
  /function resolvePendingApprovalEvent[\s\S]*?PLAN_STALE_STATES[\s\S]*?type === "plan"[\s\S]*?awaiting_decision/,
  'resolvePendingApprovalEvent must include codex plan proposals',
);
assert.match(
  helpersSource,
  /approvalId: `plan:\$\{planId\}`[\s\S]*?planEventRef:\s*\{\s*planId \}/,
  'the synthesized plan approval must use the shared id + planEventRef shape',
);
assert.match(
  helpersSource,
  /PLAN_STALE_STATES[\s\S]*?new Set\([\s\S]*?\["drafting",\s*"executing",\s*"revising",\s*"completed",\s*"failed",\s*"superseded",\s*"cancelled"/,
  'stale plan states (incl. cancelled) must shadow earlier awaiting_decision records',
);
// session-http.js keeps the replay-gate comment pointing at the shared helper.
assert.match(
  sessionHttpSource,
  /resolvePendingApprovalEvent \+ isPlanProgressEventLike moved to[\s\S]*?session-http-helpers\.js/,
  'session-http.js must reference the shared replay gate location',
);
// CSS contract for the in-stream card (chat-messages.css).
assert.match(
  messagesCssSource,
  /\.plan-approval-card \.plan-card__action\[data-approval-decision="approve"\]/,
  'approve action must get the accent emphasis',
);
assert.match(
  messagesCssSource,
  /\.plan-approval-card \.plan-card__status\s*\{/,
  'the card status line must be styled',
);

// ---------------------------------------------------------------------------
// 2c. Gone-approval handling (2026-08-05) — "Approval request not found" must
//     resolve the UI, not fail it. Same class as history-replay staleness: the
//     sheet/card can outlive the approval (run ended, provider resolved it).
// ---------------------------------------------------------------------------
assert.match(
  realtimeSource,
  /function isApprovalAlreadyEndedError[\s\S]*?APPROVAL_NOT_FOUND[\s\S]*?RUN_TERMINAL[\s\S]*?RUN_NOT_FOUND/,
  'realtime must recognize gone-approval server codes',
);
assert.match(
  realtimeSource,
  /isApprovalAlreadyEndedError[\s\S]*?noteResponse\(\{\s*approvalId \}\)[\s\S]*?approval\.alreadyResolved/,
  'a gone approval must dismiss the sheet and show the neutral notice instead of the error toast',
);
assert.match(
  realtimeSource,
  /case "session_confirmation":[\s\S]*?isApprovalAlreadyEndedError[\s\S]*?noteResponse/,
  'session confirmations get the same gone-approval treatment',
);
assert.match(
  helpersSource,
  /error\.code = String\(data\?\.code \|\| ""\)\.trim\(\) \|\| "";[\s\S]*?error\.status = res\.status/,
  'fetchJsonOrRedirect must attach server code + status to thrown errors',
);
assert.match(
  sheetSource,
  /function isApprovalAlreadyEndedError[\s\S]*?PRIVILEGED_BATCH_NOT_FOUND[\s\S]*?APPROVED_ACTION_BATCH_NOT_FOUND/,
  'decision sheet must classify stale batch/action responses without treating every 409 as terminal',
);
assert.match(
  sheetSource,
  /dismissPrivilegedBatchFromUi[\s\S]*?dismissApprovedActionFromUi/,
  'decision sheet must clear batch and approved-action stores on stale responses',
);
assert.match(
  attentionSource,
  /alreadyEnded[\s\S]*?remove\(item\.id, "action"\)/,
  'background stale batch actions must remove the whole attention card',
);
assert.match(
  realtimeSource,
  /function isPlanAlreadyEndedError[\s\S]*?PLAN_NOT_FOUND[\s\S]*?case "plan_action"[\s\S]*?return true/,
  'gone plan actions must resolve the plan surface instead of returning a failed action',
);
assert.match(
  uiSource,
  /\[\s*"cancelled",\s*"canceled"\s*\][\s\S]*?return "cancelled"/,
  'normalizeApprovalStatus must keep cancelled distinct from denied',
);
assert.match(
  uiSource,
  /\[\s*"resolved",\s*"ended",\s*"expired",\s*"stale",\s*"gone"\s*\][\s\S]*?return "resolved"/,
  'normalizeApprovalStatus must map gone-approval statuses to resolved',
);
assert.match(
  uiSource,
  /status === "cancelled"\) return t\("approval\.status\.cancelled"\)[\s\S]*?status === "resolved"\) return t\("approval\.status\.resolved"\)/,
  'cancelled/resolved statuses must render their own honest labels',
);
for (const key of ['approval.status.cancelled', 'approval.status.resolved', 'approval.alreadyResolved']) {
  assert.ok(
    (i18nSource.split(`"${key}"`).length - 1) >= 2,
    `i18n key ${key} must exist in both en and zh blocks`,
  );
}

// ---------------------------------------------------------------------------
// 3. Decision Sheet view — risk interface + dispatch reuse + bootstrap
// ---------------------------------------------------------------------------
assert.match(
  sheetSource,
  /evt\?\.risk\s*\?\?\s*evt\?\.riskLevel\s*\?\?\s*evt\?\.severity\s*\?\?\s*evt\?\.level/,
  'resolveApprovalRisk must probe the reserved backend fields (risk/riskLevel/severity/level)',
);
assert.match(
  sheetSource,
  /let tier = "none";[\s\S]*?if \(tier === "none"\) return \{\s*tier:\s*"none"/,
  'resolveApprovalRisk must default to none (hidden) when no risk data — never fabricate a guess',
);
assert.match(
  sheetSource,
  /function resolveApprovalRisk/,
  'resolveApprovalRisk must be a named, testable function',
);
assert.match(
  sheetSource,
  /root\.submitRuntimeApprovalDecision[\s\S]*?await root\.submitRuntimeApprovalDecision\(evt,\s*decision,\s*button,\s*choices(?:,\s*customAnswer)?\)/,
  'submitDecision must delegate to the canonical submitRuntimeApprovalDecision (no dispatch duplication)',
);
assert.match(
  sheetSource,
  /function injectDOM\(\)/,
  'decision-sheet must self-inject its DOM (hot-deploy resilience, mirrors run-sheet)',
);
assert.match(
  sheetSource,
  /getElementById\("inputArea"\) \|\| doc\.querySelector\("\.input-area"\)/,
  'injectDOM must mount inside the composer area (the positioned ancestor for the absolute anchor)',
);
assert.match(
  sheetSource,
  /root\.RagentDecisions && typeof root\.RagentDecisions\.subscribe === "function"/,
  'the view must subscribe to RagentDecisions on init',
);
// Reuse of ui.js helpers (not a re-implementation)
assert.match(sheetSource, /root\.getApprovalTitle/, 'reuses getApprovalTitle');
assert.match(sheetSource, /root\.describeApprovalPermissions/, 'reuses describeApprovalPermissions');
assert.match(sheetSource, /root\.isSessionConfirmationApproval/, 'reuses isSessionConfirmationApproval');

// Plan bodies must render through the shared markdown pipeline, not as raw code
assert.match(
  sheetSource,
  /approval\.detail\.plan"\)\s*,\s*evt\?\.reason,\s*"markdown"\]/,
  'plan scope rows must be marked "markdown" (raw code text would dump heading/bullet markers)',
);
assert.match(
  sheetSource,
  /mode === "markdown"[\s\S]*?root\.renderMarkdownIntoNode/,
  'markdown rows must render through renderMarkdownIntoNode (same marked pipeline as conversation bodies)',
);
assert.match(
  sheetSource,
  /decision-sheet__plan-body md-content/,
  'markdown plan bodies must carry the md-content class (shared typography)',
);
assert.match(
  sheetSource,
  /if \(!rendered\) bodyNode\.textContent/,
  'markdown rows must fall back to raw text when the renderer is unavailable',
);
assert.equal(
  sheetSource.split('input.autocomplete = "off";').length - 1,
  2,
  'free-form approval and plan inputs disable unrelated browser autofill',
);

// 3b. 人话解释区（explanation 快照，2026-08-07）——批量 op 与普通审批共用渲染
assert.match(
  sheetSource,
  /function appendExplanation\(explanation, container, skipSummary = false\)/,
  'appendExplanation must be a named, testable function',
);
assert.match(
  sheetSource,
  /if \(!explanation \|\| typeof explanation !== "object"\) return;/,
  'appendExplanation must no-op on missing/primitive explanation (no DOM without data)',
);
assert.match(
  sheetSource,
  /fields\.length === 0\) return;/,
  'appendExplanation must no-op when every field is blank (no DOM for empty rows)',
);
assert.match(
  sheetSource,
  /decision-sheet__explanation-title/,
  'explanation block must carry a title row',
);
assert.match(
  sheetSource,
  /decision-sheet__explanation-row[\s\S]*?decision-sheet__explanation-label[\s\S]*?decision-sheet__explanation-value/,
  'each explanation row must have label + value cells',
);
// 两处接线：批量 op 行首（appendRiskSignals 入口）+ 普通审批 scope 之后
assert.match(
  sheetSource,
  /function appendRiskSignals\(op, container\) \{\s*appendExplanation\(op\?\.explanation, container\);/,
  'appendRiskSignals must render op.explanation first (人话先行，技术细节随后)',
);
assert.match(
  sheetSource,
  /appendExplanation\(evt\?\.explanation, body,/,
  'appendScope must render evt.explanation after the scope rows',
);
// 批量 op 的事件源必须携带 explanation 字段（privileged-ops 快照）
assert.match(
  read('chat/privileged-ops.mjs'),
  /explanation: explanationForApproval\(\{ command: op\.command, cwd: op\.cwd \}\)/,
  'summarizePrivilegedOps must snapshot explanation per op (gate 权威 tier 才有)',
);
// i18n：en/zh 双语的解释区键必须存在（每键恰出现两次，每种语言一次）
for (const key of ['title', 'summary', 'reason', 'safer']) {
  const needle = `"decisionSheet.explanation.${key}"`;
  assert.equal(
    i18nSource.split(needle).length - 1,
    2,
    `decisionSheet.explanation.${key} must be defined in both en and zh`,
  );
}

// ---------------------------------------------------------------------------
// 4. Live Bar coexistence — no in-stream card to scroll since 2026-08-04
// ---------------------------------------------------------------------------
assert.doesNotMatch(
  liveStatusSource,
  /runtime-approval-card\[data-status="pending"\]/,
  'no in-stream card scroll path may remain in the Live Bar click handler',
);
assert.match(
  liveStatusSource,
  /typeof window\.openRunSheet === "function"/,
  'a Live Bar tap opens the Run Sheet (in-stream card scroll removed)',
);

// ---------------------------------------------------------------------------
// 5. Session-switch reset (no lingering prior-session approval)
// ---------------------------------------------------------------------------
assert.match(
  bootstrapSource,
  /nextState\.currentSessionId !== prevSessionId[\s\S]*?window\.RagentDecisions\?\.reset\?\.\(\)/,
  'session switch must reset RagentDecisions so a prior session approval does not linger',
);

// ---------------------------------------------------------------------------
// 6. chat.html — script + stylesheet tags in the right order
// ---------------------------------------------------------------------------
assert.match(chatHtml, /chat\/decisions-store\.js\?v=\{\{ASSET_VERSION\}\}/, 'decisions-store.js must be tagged');
assert.match(chatHtml, /chat\/decision-sheet\.js\?v=\{\{ASSET_VERSION\}\}/, 'decision-sheet.js must be tagged');
assert.match(chatHtml, /chat\/chat-decision-sheet\.css\?v=\{\{ASSET_VERSION\}\}/, 'chat-decision-sheet.css must be linked');
// Store loads before realtime-render (notifier exists before any approval event).
assert.ok(
  chatHtml.indexOf('decisions-store.js') < chatHtml.indexOf('realtime-render.js'),
  'decisions-store.js must load before realtime-render.js',
);
// View loads after ui.js (so reused helpers exist).
assert.ok(
  chatHtml.indexOf('ui.js') < chatHtml.indexOf('decision-sheet.js'),
  'decision-sheet.js must load after ui.js',
);

// ---------------------------------------------------------------------------
// 7. i18n keys (en + zh) for the sheet title and risk tiers
// ---------------------------------------------------------------------------
for (const key of ['decisionSheet.title', 'decisionSheet.risk.low', 'decisionSheet.risk.medium', 'decisionSheet.risk.high']) {
  const occ = i18nSource.split(key).length - 1;
  assert.ok(occ >= 2, `i18n key ${key} must exist in both en and zh blocks`);
}

// ---------------------------------------------------------------------------
// 8. CSS contract — notification-style approval surface, upward geometry, non-modal
// ---------------------------------------------------------------------------
assert.match(
  cssSource,
  /@media \(min-width:\s*768px\)\s*\{[\s\S]*?#decisionSheet\s*\{[\s\S]*?width:\s*min\(100%,\s*var\(--chat-column-width/,
  'desktop must align the sheet to the centered message column (not hide it)',
);
assert.match(sheetSource, /el\.className = "decision-sheet oneui-notification"/, 'in-session host must use the actual attention-notification component class');
assert.match(sheetSource, /oneui-notification__summary[\s\S]*?oneui-notification__disclosure/, 'approval header must reuse the notification summary row and disclosure affordance');
assert.match(sheetSource, /setSheetExpanded[\s\S]*?oneui-notification--detailed/, 'approval detail state must be the notification detailed state');
assert.match(cssSource, /#decisionSheet\.oneui-notification\s*\{[\s\S]*?--oneui-surface:\s*var\(--sys-surface-container\);[\s\S]*?background:\s*var\(--oneui-surface\);[\s\S]*?box-shadow:\s*var\(--m3-elevation-3\);/, 'approval host inherits the notification material roles');
assert.match(attentionCssSource, /oneui-notification--detailed[\s\S]*?\.oneui-notification__disclosure[\s\S]*?rotate\(90deg\)/, 'shared disclosure chevron turns down in the detailed state');
assert.match(cssSource, /#decisionSheet\.is-refreshing > \*/, 'approval replacement should crossfade the content without rebuilding the notification surface');
assert.match(cssSource, /@keyframes decision-sheet-rise\s*\{[\s\S]*?translate3d\(0, 100%, 0\)[\s\S]*?translate3d\(0, 0, 0\)/, 'collapsed approval must enter upward from below the composer');
assert.match(cssSource, /@keyframes decision-sheet-out\s*\{[\s\S]*?translate3d\(0, 0, 0\)[\s\S]*?translate3d\(0, 100%, 0\)/, 'resolved approval must exit downward below the composer');
assert.match(sheetSource, /const SHEET_HIDE_ANIMATION_MS = 180/, 'sheet removal waits for the 180ms downward exit animation');
assert.match(cssSource, /#decisionSheet \.oneui-notification__action:focus-visible\s*\{[\s\S]*?outline:\s*3px solid var\(--m3-state-focus\);/, 'approval actions retain a visible keyboard focus ring');
assert.match(attentionCssSource, /\.oneui-notification__action--primary\s*\{[\s\S]*?background:/, 'approval actions reuse the notification primary action treatment');
assert.match(sheetSource, /aria-describedby[\s\S]*decisionSheetContent/, 'decision sheet exposes its content description');
assert.match(sheetSource, /event\.key !== "Escape"[\s\S]*hideSheet\(\)/, 'Escape collapses the non-modal sheet without making a decision');
assert.match(sheetSource, /restoreReturnFocus/, 'decision sheet restores focus after closing');
assert.doesNotMatch(sheetSource, /focusSheetEntry/, 'an arriving approval must not steal the user\'s keyboard focus');
assert.match(
  cssSource,
  /#liveBar\.decision-sheet-open\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/,
  'the Live Bar must fade out while the sheet is open (sheet head carries the status)',
);
assert.match(
  cssSource,
  /#decisionSheet\s*\{[\s\S]*?position:\s*absolute[\s\S]*?bottom:\s*0[;\s]/,
  'the sheet must cover the composer slot without displacing the page',
);
assert.match(attentionCssSource, /\.oneui-notification__content\s*\{[\s\S]*?overflow-y:\s*auto/, 'surface content must scroll independently');
assert.match(attentionCssSource, /\.oneui-notification__footer\s*\{[\s\S]*?padding/, 'actions must live in a stable notification footer');
assert.match(attentionCssSource, /\.oneui-notification__action\s*\{[\s\S]*?min-height:\s*52px/, 'decision primary action reuses the 52px notification touch target');
assert.match(
  cssSource,
  /\.decision-sheet__scope \.decision-sheet__plan-body\s*\{[\s\S]*?max-height:\s*40vh[\s\S]*?overflow-y:\s*auto/,
  'plan bodies must be height-bounded with their own scroll inside the sheet (long plans stay scannable)',
);
assert.match(
  cssSource,
  /decision-sheet__plan-body > :first-child\s*\{[\s\S]*?margin-top:\s*0/,
  'plan body must not add leading margin above the first markdown block',
);
assert.match(cssSource, /prefers-reduced-motion/, 'must respect reduced motion');
assert.match(sheetSource, /function appendCompactApproval\(/, 'regular approvals should use progressive disclosure for technical details');
assert.match(sheetSource, /createNotificationHeader[\s\S]*?chevron-right/, 'regular approvals should disclose technical details through the shared right-facing chevron');
assert.match(attentionCssSource, /transition: transform 180ms/, 'shared disclosure chevron keeps the purposeful state-change transition');
assert.match(
  sheetSource,
  /const sessionActions = el\("div", "oneui-notification__actions decision-sheet__session-actions"\);[\s\S]*?details\.appendChild\(sessionActions\);[\s\S]*?const footer = el\("footer", "oneui-notification__footer"\);[\s\S]*?footer\.appendChild\(actions\);/,
  'session-wide approval belongs in expanded context; the brief footer keeps only the immediate decision rail',
);
assert.match(
  cssSource,
  /#decisionSheet\.oneui-notification\.oneui-notification--detailed\s*\{[\s\S]*?height:\s*min\(80dvh,\s*720px\);[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto/,
  'detailed approvals must pin the shared action footer while the content region scrolls',
);
assert.doesNotMatch(sheetSource, /decision-sheet__orb|KIND_ICONS/, 'approval card should not render a decorative icon layer');
assert.doesNotMatch(sheetSource, /decision-sheet__action-icon/, 'approval actions should be text-first');
assert.doesNotMatch(
  cssSource,
  /decision-sheet-backdrop|\.decision-sheet[^_]\{[\s\S]*?position:\s*fixed/,
  'non-modal: no backdrop / no fixed overlay that blocks the canvas',
);

// ===========================================================================
// 9. RUNTIME — exercise the store in a vm sandbox (no DOM needed for the store)
// ===========================================================================
const sandbox = { console, Object, Set, String, Number, Error, JSON };
vm.createContext(sandbox);
vm.runInContext(storeSource, sandbox);
const store = sandbox.RagentDecisions;
assert.ok(store, 'RagentDecisions attached to the global');

let calls = 0;
let snap = null;
const unsub = store.subscribe((s) => { calls += 1; snap = s; });
assert.equal(calls, 1, 'subscribe fires immediately');
assert.equal(snap.pending, false, 'initial snapshot has no pending approval');
assert.equal(store.getPending(), null, 'getPending null initially');

store.noteRequest({ approvalId: 'a1', kind: 'command', command: 'rm -rf /tmp/x' });
assert.equal(calls, 2, 'noteRequest notifies');
assert.equal(snap.pending, true, 'snapshot now pending');
assert.equal(snap.evt.approvalId, 'a1', 'snapshot carries the evt');
assert.equal(store.getPending().approvalId, 'a1', 'getPending returns the approval id');

// Replayed approval payloads are not state changes and must not restart the
// sheet's details animation or trigger another layout pass.
store.noteRequest({ command: 'rm -rf /tmp/x', kind: 'command', approvalId: 'a1' });
assert.equal(calls, 2, 'identical approval replay is deduplicated');
store.noteRequest({ approvalId: 'a1', kind: 'command', command: 'rm -rf /tmp/y' });
assert.equal(calls, 3, 'a changed approval payload still notifies');

store.noteResponse({ approvalId: 'a1' });
assert.equal(calls, 4, 'noteResponse notifies');
assert.equal(snap.pending, false, 'matching response clears pending');
assert.equal(store.getPending(), null, 'cleared after response');

// A response for a different approval id must NOT clear a pending one.
store.noteRequest({ approvalId: 'a2' });
const callsBefore = calls;
store.noteResponse({ approvalId: 'other' });
assert.equal(calls, callsBefore, 'mismatched response does not notify');
assert.equal(snap.pending, true, 'pending approval survives a mismatched response');

// reset() clears (session switch).
store.reset();
assert.equal(snap.pending, false, 'reset clears pending');
const callsAfterReset = calls;

// unsubscribe stops further notifications.
unsub();
store.noteRequest({ approvalId: 'a3' });
assert.equal(calls, callsAfterReset, 'no notifications after unsubscribe');

// ---------------------------------------------------------------------------
// 10. Privileged batch channel (Phase 5) — store contract
// ---------------------------------------------------------------------------
assert.match(
  storeSource,
  /Object\.freeze\(\{[\s\S]*?\bsubscribeBatch\b[\s\S]*?\bnotePrivilegedBatch\b[\s\S]*?\bnotePrivilegedBatchResponse\b[\s\S]*?\bgetPendingBatch\b[\s\S]*?\bgetBatchState\b[\s\S]*?\}\);/,
  'RagentDecisions must expose subscribeBatch/notePrivilegedBatch/notePrivilegedBatchResponse/getPendingBatch/getBatchState, frozen',
);
assert.match(
  storeSource,
  /subscribeBatch\(subscriber\)[\s\S]*?subscriber\(batchSnapshot\(\)\)/,
  'subscribeBatch must fire immediately with the current batch snapshot',
);

const batchRequest = {
  batchId: 'b1',
  runId: 'r1',
  other: [{ opId: 'op-other-1', command: 'systemctl restart nginx' }],
  delete: [{ opId: 'op-del-1', command: 'rm -rf /var/lib/foo' }],
  risk: 'danger',
  defaultSelected: { other: ['op-other-1'], delete: [] },
};
let batchCalls = 0;
let batchSnap = null;
const unsubBatch = store.subscribeBatch((s) => { batchCalls += 1; batchSnap = s; });
assert.equal(batchCalls, 1, 'subscribeBatch fires immediately');
assert.equal(batchSnap.pending, false, 'initial batch snapshot not pending');

store.notePrivilegedBatch(batchRequest);
assert.equal(batchCalls, 2, 'notePrivilegedBatch notifies');
assert.equal(batchSnap.pending, true, 'batch snapshot pending');
assert.equal(batchSnap.evt.batchId, 'b1', 'batch snapshot carries the evt');
assert.equal(store.getPendingBatch().batchId, 'b1', 'getPendingBatch returns the batch');
store.notePrivilegedBatch({
  defaultSelected: { delete: [], other: ['op-other-1'] },
  risk: 'danger',
  delete: [{ command: 'rm -rf /var/lib/foo', opId: 'op-del-1' }],
  other: [{ command: 'systemctl restart nginx', opId: 'op-other-1' }],
  runId: 'r1',
  batchId: 'b1',
});
assert.equal(batchCalls, 2, 'identical batch replay is deduplicated');
assert.deepEqual(
  [...store.getBatchState().resolved],
  [],
  'getBatchState starts with no resolved categories',
);

// A response for a different batch must not advance the pending one.
store.notePrivilegedBatchResponse({ batchId: 'other-batch', category: 'other' });
assert.equal(batchSnap.resolved.size, 0, 'foreign batch response is ignored');

// Resolving one category keeps the batch pending (the other group is open).
store.notePrivilegedBatchResponse({ batchId: 'b1', category: 'other' });
assert.equal(batchSnap.resolved.size, 1, 'matching response marks category resolved');
assert.ok(batchSnap.resolved.has('other'), 'resolved set carries the category');
assert.equal(store.getPendingBatch().batchId, 'b1', 'batch still pending with one category open');
store.notePrivilegedBatchResponse({ batchId: 'b1', category: 'privileged_other' });
assert.equal(batchSnap.resolved.size, 1, 'duplicate category response is deduplicated');

// The second category resolution clears the whole batch (all groups handled).
store.notePrivilegedBatchResponse({ batchId: 'b1', category: 'delete' });
assert.equal(batchSnap.pending, false, 'all categories resolved clears the batch');
assert.equal(store.getPendingBatch(), null, 'getPendingBatch null after full resolution');

// reset() also clears a pending batch.
store.notePrivilegedBatch(batchRequest);
store.reset();
assert.equal(batchSnap.pending, false, 'reset clears the pending batch');

// Server responses carry the classifier category constants
// (privileged_other / destructive_delete); the store must normalize them to
// the sheet's short group keys so the batch still collapses either way.
const longFormBatch = {
  ...batchRequest,
  batchId: 'b-long',
};
store.notePrivilegedBatch(longFormBatch);
store.notePrivilegedBatchResponse({ batchId: 'b-long', category: 'privileged_other' });
assert.equal(batchSnap.resolved.size, 1, 'long-form other marks a category resolved');
assert.ok(batchSnap.resolved.has('other'), 'long-form category normalized to the short key');
assert.equal(store.getPendingBatch().batchId, 'b-long', 'batch still pending with delete open');
store.notePrivilegedBatchResponse({ batchId: 'b-long', category: 'destructive_delete' });
assert.equal(batchSnap.pending, false, 'long-form delete clears the whole batch');
unsubBatch();

// ---------------------------------------------------------------------------
// 11. Realtime wiring — privileged batch events reach the decisions store
// ---------------------------------------------------------------------------
assert.match(
  realtimeRenderSource,
  /case "privileged_batch_request":[\s\S]*?!historyPrepend[\s\S]*?window\.RagentDecisions\?\.notePrivilegedBatch\(evt\);/,
  'privileged_batch_request must notify RagentDecisions, gated on history replays',
);
assert.match(
  realtimeRenderSource,
  /case "privileged_batch_response":[\s\S]*?!historyPrepend[\s\S]*?window\.RagentDecisions\?\.notePrivilegedBatchResponse\(evt\);/,
  'privileged_batch_response must notify RagentDecisions, gated on history replays',
);
// A terminal status (cancelled / error) must drop any leftover approval or
// batch surface — the belt-and-braces dismissal for events that race the
// run's end (run-finalize also emits per-approval cancelled responses).
assert.match(
  realtimeRenderSource,
  /case "status":[\s\S]*?statusText === "cancelled"[\s\S]*?statusText\.startsWith\("error:"\)[\s\S]*?RagentDecisions\?\.reset\?\.\(\)/,
  'terminal status events must reset the decisions store (approval + batch sheets)',
);

// ---------------------------------------------------------------------------
// 12. Sheet surface — batch rendering, signals detail and WebAuthn flow
// ---------------------------------------------------------------------------
assert.match(
  sheetSource,
  /function appendRiskSignals[\s\S]*?function renderBatchSheet\(/,
  'decision-sheet must render the privileged batch surface with signals detail',
);
assert.match(
  sheetSource,
  /async function approveBatchCategory[\s\S]*?obtainWebAuthnProof\([\s\S]*?submitBatchCategory\(/,
  'approve must run the WebAuthn flow (challenge -> assertion -> submit)',
);
assert.match(
  sheetSource,
  /async function obtainWebAuthnProof[\s\S]*?navigator\.credentials\.get\([\s\S]*?toBase64Url/,
  'WebAuthn proof must come from navigator.credentials.get() and encode base64url',
);
assert.match(
  sheetSource,
  /function hydrateWebAuthnPublicKey[\s\S]*?allowCredentials[\s\S]*?fromBase64Url\(credential\.id\)/,
  'decision-sheet must convert wire-format credential ids to ArrayBuffer values',
);
assert.equal(
  (sheetSource.match(/navigator\.credentials\.get\(\{\s*publicKey:\s*hydrateWebAuthnPublicKey/g) || []).length,
  2,
  'both privileged WebAuthn flows must hydrate public-key options before calling the browser',
);
assert.match(
  sheetSource,
  /function toBase64Url[\s\S]*?\.replace\(\/\\\+\/g,\s*"-"\)[\s\S]*?\.replace\(\/\\\/\/g,\s*"_"\)/,
  'base64url encoding must map + and / to - and _ (URL-safe)',
);
assert.match(
  sheetSource,
  /async function denyBatchCategory\(category, button\)[\s\S]*?checkedOpIds:\s*\[\]/,
  'deny submits zero checked ops and needs no biometric assertion',
);
assert.match(
  sheetSource,
  /BATCH_CATEGORIES\s*=\s*\["other",\s*"delete"\]/,
  'batch sheet renders the two independent popup groups in order',
);
assert.match(
  sheetSource,
  /decisionSheet\.privileged\.category\.\$\{category\}/,
  'per-category labels come from the decisionSheet.privileged namespace',
);
assert.match(
  sheetSource,
  /onDecisions\([\s\S]*?renderedKind\s*===\s*"batch"[\s\S]*?return/,
  'regular approval events must not interrupt a showing batch surface',
);
assert.match(
  sheetSource,
  /function renderBatchSection\([\s\S]*?defaultSelected[\s\S]*?box\.checked\s*=/,
  'op checkboxes must initialize from defaultSelected (other checked / delete unchecked)',
);
assert.match(sheetSource, /decision-sheet__batch-footer/, 'high-risk batch actions render in a fixed footer');
assert.match(sheetSource, /noteApprovedActionResolution/, 'approved-action HTTP success resolves the store immediately');
assert.match(
  sheetSource,
  /function batchRenderSignature[\s\S]*?renderedBatchSignature === signature/,
  'same batch snapshots must not rebuild the animated Decision Sheet DOM',
);
assert.match(
  sheetSource,
  /function defaultSelectedForCategory\([\s\S]*?privileged_other[\s\S]*?destructive_delete[\s\S]*?return selected\[key\]/,
  'batch defaults must accept canonical privileged category names from the server',
);
assert.match(
  sheetSource,
  /const defaults = defaultSelectedForCategory\(evt, category\)/,
  'batch rows must resolve defaults through the category compatibility mapping',
);
assert.match(
  sheetSource,
  /decisionSheet\.risk\.detail\.paths[\s\S]*?targetPaths[\s\S]*?reasons/,
  'signals detail must render target paths and reasons from risk.signals',
);

// i18n — privileged namespace exists in both locales.
assert.match(
  i18nSource,
  /"decisionSheet\.privileged\.title"[\s\S]*?"decisionSheet\.privileged\.action\.approve"/,
  'en locale must carry the privileged sheet keys',
);
assert.match(
  i18nSource,
  /"decisionSheet\.privileged\.category\.delete": "破坏性删除"/,
  'zh locale must carry the privileged sheet keys',
);

// CSS — batch surface styles exist and stay non-modal (no fixed overlay).
assert.match(
  cssSource,
  /\.decision-sheet__batch\s*\{[\s\S]*?overflow-y:\s*auto/,
  'batch surface must scroll internally instead of growing past the viewport',
);
assert.match(
  cssSource,
  /\.decision-sheet__batch-op-signals\s*\{/,
  'signals detail rows must have their own visual style',
);
assert.doesNotMatch(
  cssSource,
  /decision-sheet-backdrop|\.decision-sheet__batch[^_\s{]*[\s{]*position:\s*fixed/,
  'batch surface must stay non-modal (no fixed overlay)',
);

// Managed approved-action MCP channel: one durable batch surface, with a
// separate WebAuthn proof over the selected host subset.
assert.match(storeSource, /subscribeAction\(subscriber\)[\s\S]*?noteApprovedAction[\s\S]*?noteApprovedActionState/);
assert.match(realtimeRenderSource, /case "approved_action_batch_request"[\s\S]*?noteApprovedAction/);
assert.match(realtimeRenderSource, /case "approved_action_state"[\s\S]*?noteApprovedActionState/);
assert.match(sheetSource, /function renderApprovedActionSheet\([\s\S]*?dataset\.approvedActionId/);
assert.match(sheetSource, /function appendAgentDefinitionReview\([\s\S]*?agentDefinition[\s\S]*?perMessageSystemPrompt/);
assert.match(sheetSource, /appendAgentDefinitionReview\(action, list\)/);
assert.match(cssSource, /\.decision-sheet__agent-definition\s*\{/);
assert.match(sheetSource, /function obtainApprovedActionProof\([\s\S]*?webauthn-challenge/);
assert.match(sheetSource, /selectedHost[\s\S]*?obtainApprovedActionProof/);

console.log('✓ test-chat-decision-sheet — all assertions passed');

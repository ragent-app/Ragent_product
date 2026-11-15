#!/usr/bin/env node
// tests/test-chat-run-activity-core.mjs
//
// Stage 2: core/run-activity.js is a verbatim port of run-activity-ui.js's
// pure projections (event boundary, text clipping / base-name /
// trailing-period helpers, subject + human-summary chain, plan-item
// normalization and progress presentation, tool-kind inference, optimistic
// activity projections). i18n (t) is injected via the environment contract on
// the core side and read from the shared root on the legacy side; the module-state
// half (setActivity / applyEvent / getPresentation / subscribe) stays in
// the legacy module. The legacy export surface only exposes `format`, so
// the test splices a projection export into the legacy source before
// loading it. Every scenario runs against BOTH implementations (with
// stubs and, for the fallback paths, without) and compares at the
// primitive level.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const LABELS = {
  'activity.label.approval': '需要审批',
  'activity.label.command': '正在执行命令',
  'activity.label.execute': '正在运行',
  'activity.label.execute_composite': '正在执行复合命令',
  'activity.label.read': '正在读取文件',
  'activity.label.search': '正在搜索',
  'activity.label.file_edit': '正在修改文件',
  'activity.label.edit': '正在修改',
  'activity.label.delete': '正在删除',
  'activity.label.move': '正在移动',
  'activity.label.web': '正在访问网页',
  'activity.label.fetch': '正在访问',
  'activity.label.mcp': '正在使用工具',
  'activity.label.subagent': '正在执行子任务',
  'activity.label.other': '正在使用工具',
  'activity.label.planning': '正在制定计划',
  'activity.label.responding': '正在撰写回复',
  'activity.label.thinking': '正在分析',
  'activity.label.waiting': '正在等待',
  'activity.label.working': '正在工作',
  'activity.action.running.approval': '正在等待审批',
  'activity.action.running.command': '正在运行 {subject}',
  'activity.action.running.execute': '正在运行 {subject}',
  'activity.action.running.execute_composite': '正在执行命令',
  'activity.action.running.read': '正在读取 {subject}',
  'activity.action.running.edit': '正在修改 {subject}',
  'activity.action.running.search': '正在搜索 {subject}',
  'activity.action.running.file_edit': '正在修改 {subject}',
  'activity.action.running.delete': '正在删除 {subject}',
  'activity.action.running.move': '正在移动 {subject}',
  'activity.action.running.web': '正在搜索网页',
  'activity.action.running.fetch': '正在访问 {subject}',
  'activity.action.running.switch_mode': '正在切换到 {subject}',
  'activity.action.running.think': '正在思考',
  'activity.action.running.mcp': '正在调用 {subject}',
  'activity.action.running.subagent': '正在执行子任务 {subject}',
  'activity.action.running.other': '正在使用工具 {subject}',
  'activity.action.running.planning': '正在制定计划',
  'activity.action.running.responding': '正在撰写回复',
  'activity.action.running.thinking': '正在分析',
  'activity.action.running.waiting': '正在等待',
  'activity.action.running.working': '正在工作',
  'activity.action.waiting_approval': '等待审批',
  'activity.action.waiting_approval.approval': '等待审批：{subject}',
  'activity.action.waiting_approval.command': '等待审批运行 {subject}',
  'activity.action.waiting_approval.execute': '等待审批运行 {subject}',
  'activity.action.completed.command': '已运行 {subject}',
  'activity.action.completed.execute': '已运行 {subject}',
  'activity.action.completed.execute_composite': '已执行命令',
  'activity.action.completed.read': '已读取 {subject}',
  'activity.action.completed.edit': '已修改 {subject}',
  'activity.action.completed.search': '已搜索 {subject}',
  'activity.action.completed.file_edit': '已修改 {subject}',
  'activity.action.completed.delete': '已删除 {subject}',
  'activity.action.completed.move': '已移动 {subject}',
  'activity.action.completed.web': '已搜索网页',
  'activity.action.completed.fetch': '已访问 {subject}',
  'activity.action.completed.switch_mode': '已切换到 {subject}',
  'activity.action.completed.mcp': '已调用 {subject}',
  'activity.action.completed.subagent': '已完成子任务 {subject}',
  'activity.action.completed.other': '已完成工具调用 {subject}',
  'activity.action.completed.think': '已完成分析',
  'activity.action.completed.planning': '已制定计划',
  'activity.action.completed.responding': '已撰写回复',
  'activity.action.completed.thinking': '已完成分析',
  'activity.action.completed.working': '已完成工作',
  'activity.action.failed.command': '运行 {subject} 失败',
  'activity.action.failed.execute': '运行 {subject} 失败',
  'activity.action.failed.read': '读取 {subject} 失败',
  'activity.action.failed.edit': '修改 {subject} 失败',
  'activity.action.failed.file_edit': '修改 {subject} 失败',
  'activity.action.failed.search': '搜索 {subject} 失败',
  'activity.action.failed.web': '搜索网页失败',
  'activity.action.failed.fetch': '访问 {subject} 失败',
  'activity.action.failed.delete': '删除 {subject} 失败',
  'activity.action.failed.move': '移动 {subject} 失败',
  'activity.action.failed.switch_mode': '切换到 {subject} 失败',
  'activity.action.failed.think': '分析失败',
  'activity.action.failed.mcp': '调用 {subject} 失败',
  'activity.action.failed.other': '使用工具 {subject} 失败',
  'activity.action.failed.subagent': '子任务失败：{subject}',
  'activity.action.failed': '失败',
  'activity.action.declined': '已拒绝',
  'activity.action.interrupted': '已中断',
  'plan.progress.summary': '{completed}/{total} · {current}',
  'plan.progress.empty': '正在准备步骤',
};

function fakeT(key, vars = {}) {
  const template = LABELS[key];
  if (!template) return key;
  return template.replace(/\{(\w+)\}/g, (match, token) => (
    Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match
  ));
}

const PROJECTION_NAMES = [
  'eventBoundary', 'baseName', 'clip',
  'subjectForActivity', 'formatOperationActivity', 'formatRunActivitySummary', 'normalizePlanItemStatus',
  'normalizePlanItems', 'isProgressPlanEvent', 'buildProgressPresentation',
  'inferToolKind', 'optimisticActivityForEvent',
];

function loadLegacy({ stubs }) {
  let source = readFileSync(join(repoRoot, 'static/chat/run-activity-ui.js'), 'utf8');
  // The legacy contract object only exports `format`; splice a projection
  // export into the IIFE so parity can reach the internals verbatim.
  const marker = '  root.RagentRunActivity = {';
  source = source.replace(
    marker,
    `  root.__runActivityProjections = { ${PROJECTION_NAMES.join(', ')} };\n\n${marker}`,
  );
  const context = { console };
  if (stubs) {
    context.ragentT = fakeT;
  }
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'run-activity-ui.js' });
  return { api: context.__runActivityProjections, label: `legacy${stubs ? '' : '-fallback'}` };
}

function loadCore({ stubs }) {
  const context = {
    RagentRunActivityEnvironment: stubs ? { t: fakeT } : {},
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/core/run-activity.js'), 'utf8'),
    context,
    { filename: 'core/run-activity.js' },
  );
  return { api: context.RagentRunActivityCore, label: `core${stubs ? '' : '-fallback'}` };
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function runScenario(api) {
  const out = {};

  out.eventBoundary = [
    { endSeq: 7, seq: 1 }, { blockEndSeq: 9, seq: 2 }, { seq: 3 }, {},
    { endSeq: 0 }, { endSeq: -1 }, { seq: '4' }, null,
  ].map((e) => api.eventBoundary(e));

  out.baseName = [
    '/a/b/c.png', 'a\\b\\c.png', '/trailing/', 'file.txt', '', null, 42, '//',
  ].map((v) => api.baseName(v));

  out.clip = [
    'short', 'a'.repeat(48), 'a'.repeat(49), 'a'.repeat(96), '  spaced   out  ',
    '', null, 42, 'a'.repeat(120),
  ].map((v) => api.clip(v));
  out.clipCustom = ['abcdefghij', 4].map((v) => api.clip('abcdefghij', v));

  const mkActivity = (overrides = {}) => ({
    kind: 'file_edit', detail: '/repo/static/chat/ui.js', state: 'working',
    subject: '', ...overrides,
  });
  out.subjectForActivity = [
    mkActivity(),
    mkActivity({ subject: '  explicit subject  ' }),
    mkActivity({ kind: 'search', detail: 'foo · bar · baz' }),
    mkActivity({ kind: 'read', detail: '/a/b/notes.md' }),
    mkActivity({ kind: 'web', detail: 'https://example.com/page' }),
    mkActivity({ subject: 'summary' }),
    mkActivity({ kind: 'unknown_kind', detail: 'x' }),
    null,
  ].map((a) => api.subjectForActivity(a));

  out.formatRunActivitySummary = [
    mkActivity(),
    mkActivity({ kind: 'approval', summary: { zh: '需要你确认操作。', en: 'Confirm the action.' } }),
    mkActivity({ kind: 'command', summary: '正在执行 npm test', state: 'working' }),
    mkActivity({ kind: 'command', summary: { zh: '正在执行 npm test。', en: 'Running npm test.' } }),
    mkActivity({ kind: 'weird_kind', state: 'working' }),
    mkActivity({ state: 'idle' }),
    null,
    {},
  ].map((a) => api.formatRunActivitySummary(a));

  out.formatOperationActivity = [
    mkActivity({ kind: 'command', labelKind: 'command', detail: 'npm test', operationState: 'running' }),
    mkActivity({ kind: 'read', labelKind: 'read', detail: '/repo/package.json', operationState: 'completed' }),
    mkActivity({ kind: 'search', labelKind: 'search', subject: 'invoice', operationState: 'running' }),
    mkActivity({ kind: 'file_edit', labelKind: 'file_edit', subject: 'ui.js', operationState: 'failed' }),
    mkActivity({ kind: 'approval', labelKind: 'approval', subject: 'rm -rf /tmp/probe', operationState: 'waiting_approval' }),
    mkActivity({ state: 'idle', operationState: 'completed' }),
  ].map((a) => api.formatOperationActivity(a));

  out.normalizePlanItemStatus = [
    'completed', 'COMPLETE', 'done', 'success', 'succeeded', 'in_progress',
    'in-progress', 'active', 'current', 'running', 'started', 'pending',
    'blocked', 'unknown', '', null, 42, ' In Progress ',
  ].map((v) => api.normalizePlanItemStatus(v));

  out.normalizePlanItems = [
    { items: [{ text: 'step one', status: 'done' }, { text: 'step two', status: 'active' }, { text: '' }] },
    { plan: ['plain', { title: 'titled', state: 'completed' }, { step: 'stepped', completed: true }] },
    { items: [null, 'x', 42] },
    {},
    null,
  ].map((e) => api.normalizePlanItems(e));

  out.isProgressPlanEvent = [
    { type: 'plan', planIntent: 'progress' },
    { type: 'plan', planIntent: 'PROGRESS' },
    { type: 'plan', planIntent: 'formal' },
    { type: 'plan', interactionMode: 'agent' },
    { type: 'plan', interactionMode: 'human' },
    { type: 'operation' },
    {},
    null,
  ].map((e) => api.isProgressPlanEvent(e));

  out.buildProgressPresentation = [
    { type: 'plan', planIntent: 'progress', runId: 'run_1', endSeq: 41, items: [
      { text: 'one', status: 'done' }, { text: 'two', status: 'active' }, { text: 'three' },
    ] },
    { type: 'plan', items: [{ text: 'only', status: 'completed' }] },
    { type: 'plan', items: [] },
    {},
    null,
  ].map((e) => api.buildProgressPresentation(e));

  out.inferToolKind = [
    'write', 'edit', 'multiedit', 'NotebookEdit', 'apply_patch', 'read', 'view', 'cat',
    'grep', 'glob', 'search', 'rg', 'find', 'web_fetch', 'browser_navigate', 'mcp__agent',
    'codex_agent', 'bash', 'shell_command', 'command', 'totally_unknown',
  ].map((t) => api.inferToolKind({ toolName: t }));

  out.optimisticActivityForEvent = [
    { type: 'operation', kind: 'working', detail: 'd1', operationId: 'op1' },
    { type: 'operation', kind: 'READ', detail: 'd2', operationId: 'op2' },
    { type: 'file_change', filePath: '/a/b/c.md' },
    { type: 'tool_use', toolName: 'Bash', filePath: '/x' },
    { type: 'tool_use', toolName: 'web_fetch' },
    { type: 'thinking_block' },
    { type: 'reasoning' },
    { type: 'context_operation' },
    { type: 'context_barrier' },
    { type: 'status' },
    { type: 'message' },
    {},
    null,
  ].map((e) => api.optimisticActivityForEvent(e));

  return normalize(out);
}

async function main() {
  for (const stubs of [true, false]) {
    const [legacy, core] = [loadLegacy({ stubs }), loadCore({ stubs })];
    assert.deepEqual(
      runScenario(core.api),
      runScenario(legacy.api),
      `run-activity projections drifted (stubs=${stubs}): ${legacy.label} vs ${core.label}`,
    );
  }
  console.log('test-chat-run-activity-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

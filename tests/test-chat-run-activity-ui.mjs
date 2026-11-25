#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static/chat/run-activity-ui.js'), 'utf8');
const loaderSource = readFileSync(join(repoRoot, 'static/chat.js'), 'utf8');
const labels = {
  'activity.label.approval': '需要审批',
  'activity.label.command': '正在执行命令',
  'activity.label.execute': '正在运行',
  'activity.label.execute_composite': '正在执行复合命令',
  'activity.label.read': '正在读取文件',
  'activity.label.edit': '正在修改',
  'activity.label.search': '正在搜索',
  'activity.label.file_edit': '正在修改文件',
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
  'activity.action.running.file_edit': '正在修改 {subject}',
  'activity.action.running.search': '正在搜索 {subject}',
  'activity.action.running.execute': '正在运行 {subject}',
  'activity.action.running.execute_composite': '正在执行命令',
  'activity.action.running.edit': '正在修改 {subject}',
  'activity.action.waiting_approval.approval': '等待审批：{subject}',
  'activity.action.waiting_approval.command': '等待审批运行 {subject}',
  'activity.action.waiting_approval.execute': '等待审批运行 {subject}',
  'activity.status.awaitingProviderOutput': '等待 AgY 输出',
  'plan.progress.label': '执行进度',
  'plan.progress.summary': '{completed}/{total} · {current}',
  'plan.progress.empty': '正在准备步骤',
};
const window = {
  __testLocale: 'zh-CN',
  ragentT(key, vars = {}) {
    let text = labels[key] || key;
    for (const [name, value] of Object.entries(vars || {})) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
    return text;
  },
  ragentGetActiveUiLanguage() {
    return this.__testLocale;
  },
  ragentLocalizeContent(value) {
    if (value && typeof value === 'object') {
      const wantEn = String(this.__testLocale).toLowerCase().startsWith('en');
      return wantEn ? (value.en || value.zh || '') : (value.zh || value.en || '');
    }
    return String(value == null ? '' : value);
  },
};
const context = vm.createContext({ window, globalThis: window, console });
vm.runInContext(source, context);

const api = window.RagentRunActivity;
assert.ok(api, 'shared run activity UI API should be installed');
assert.match(loaderSource, /"chat\/run-activity-ui\.js"/, 'the split asset loader should load the shared activity module');

api.setActivity({
  state: 'working',
  kind: 'file_edit',
  detail: '/srv/ragent-promoted/static/chat/ui.js',
  subject: 'ui.js',
  sourceSeq: 8,
  outputBoundarySeq: 4,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '正在修改 ui.js…');
assert.equal(api.getPresentation().inlineVisible, true);
assert.equal(api.getLivePresentation().text, '正在修改 ui.js…');

api.noteProgressPlan({
  type: 'plan',
  interactionMode: 'agent',
  planIntent: 'progress',
  runId: 'run-1',
  seq: 11,
  items: [
    { text: '读代码', status: 'completed' },
    { text: '修 Live Bar', status: 'in_progress' },
    { text: '跑测试', status: 'pending' },
  ],
});
assert.equal(api.getPresentation().text, '正在修改 ui.js…', 'Run Sheet activity presentation should stay focused on the current action');
assert.equal(api.getLivePresentation().text, '正在修改 ui.js…', 'Live Bar should prefer the specific current action over progress');

api.noteProgressPlan({
  type: 'plan',
  interactionMode: 'agent',
  planIntent: 'progress',
  runId: 'run-1',
  seq: 12,
  items: [
    { text: '读代码', status: 'completed' },
    { text: '修 Live Bar', status: 'completed' },
    { text: '跑测试', status: 'completed' },
  ],
});
assert.equal(api.getLivePresentation().text, '正在修改 ui.js…', 'completed progress should no longer be shown in the Live Bar');

api.noteFormalOutput({ type: 'text_delta' });
assert.equal(api.getPresentation().inlineVisible, true, 'formal output must not hide the live activity row while the run is active');
assert.equal(api.getPresentation().text, '正在修改 ui.js…', 'global surfaces should keep the shared summary text');

api.setActivity({
  state: 'working',
  kind: 'file_edit',
  subject: 'ui.js',
  sourceSeq: 8,
  outputBoundarySeq: 4,
  inlineEligible: true,
});
assert.equal(api.getPresentation().inlineVisible, true, 'a refresh must preserve the live activity row while the run is active');

api.applyEvent({ type: 'operation', kind: 'search', detail: 'thinking row', seq: 9, endSeq: 9 });
assert.equal(api.getPresentation().text, '正在搜索 thinking row…');
assert.equal(api.getPresentation().inlineVisible, true, 'new work after output should restore the inline summary');

api.noteFormalOutput({ type: 'message', role: 'assistant', seq: 10, content: 'Next paragraph' });
assert.equal(api.getPresentation().inlineVisible, true);

api.setActivity({
  state: 'working',
  kind: 'responding',
  sourceSeq: 10,
  outputBoundarySeq: 10,
  inlineEligible: false,
});
assert.equal(api.getPresentation().text, '正在撰写回复…');
assert.equal(api.getPresentation().inlineVisible, true, 'responding is still an active run state');

// ToolCall projection supplies a language-neutral subject; UI supplies the verb.
api.setActivity({
  state: 'working',
  kind: 'execute',
  labelKind: 'execute',
  detail: 'du -sh /home/example',
  subject: 'du -sh /home/example',
  sourceSeq: 30,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '正在运行 du -sh /home/example…');
assert.equal(api.getPresentation().inlineVisible, true);

// Composite commands keep their raw detail behind a deterministic label instead
// of asking a model to infer intent.
api.setActivity({
  state: 'working',
  kind: 'execute',
  labelKind: 'execute_composite',
  detail: 'npm test && npm run lint',
  sourceSeq: 31,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '正在执行命令…');

// Long structured subjects are clipped, never allowed to expand the Live Bar.
api.setActivity({
  state: 'working',
  kind: 'execute',
  labelKind: 'execute',
  subject: '这是一个非常长的命令参数，'.repeat(20),
  sourceSeq: 32,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
const clippedText = api.getPresentation().text;
assert.ok(clippedText.length <= 96, `long subject should be clipped, got ${clippedText.length} chars`);
assert.ok(clippedText.endsWith('…'));

// Missing subject still leaves an understandable state label.
api.setActivity({
  state: 'working',
  kind: 'execute',
  labelKind: 'execute',
  detail: 'ls',
  sourceSeq: 33,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '正在运行 ls…');

api.setActivity({
  state: 'working',
  kind: 'execute',
  labelKind: 'execute',
  subject: 'long-command',
  providerLiveness: { phase: 'awaiting_provider_output' },
  sourceSeq: 34,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '正在运行 long-command · 等待 AgY 输出…');

// Approval remains a distinct state and never borrows activity-summary copy.
api.setActivity({
  state: 'waiting_user',
  kind: 'approval',
  detail: 'rm -rf /tmp/probe',
  subject: 'rm -rf /tmp/probe',
  sourceSeq: 35,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '等待审批：rm -rf /tmp/probe…');

// Structured subject is preferred for file operations.
api.setActivity({
  state: 'working',
  kind: 'edit',
  labelKind: 'edit',
  detail: '/srv/ragent-promoted/static/chat/ui.js',
  subject: 'ui.js',
  sourceSeq: 36,
  outputBoundarySeq: 20,
  inlineEligible: true,
});
assert.equal(api.getPresentation().text, '正在修改 ui.js…');

api.reset();
assert.equal(api.getPresentation().text, '');
assert.equal(api.getPresentation().inlineVisible, false);

console.log('test-chat-run-activity-ui: ok');

#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'live-status-ui.js'), 'utf8');

function makeElement() {
  const classes = new Set();
  const eventListeners = new Map();
  return {
    hidden: true,
    textContent: '',
    className: '',
    dataset: {},
    children: [],
    attributes: {},
    offsetWidth: 320,
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, listener) { eventListeners.set(type, listener); },
    click() { eventListeners.get('click')?.(); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    querySelector(selector) {
      if (selector === '.live-bar__label') {
        return this.children.find((child) => child.className === 'live-bar__label') || null;
      }
      if (selector === '.live-bar__elapsed') {
        return this.children.find((child) => child.className === 'live-bar__elapsed') || null;
      }
      return null;
    },
  };
}

let now = Date.parse('2026-07-28T18:00:13.000Z');
let nextTimerId = 1;
const activeTimers = new Map();
const pendingTimeouts = new Map();
const listeners = new Map();
const liveBar = makeElement();
const liveBarSlot = makeElement();
liveBar.parentElement = liveBarSlot;
const document = {
  hidden: false,
  getElementById(id) {
    if (id === 'liveBar') return liveBar;
    if (id === 'liveBarSlot') return liveBarSlot;
    return null;
  },
  createElement() { return makeElement(); },
  addEventListener(type, listener) { listeners.set(type, listener); },
};
let visualStatus = { key: 'running', label: '正在执行…' };
let actionPresentation = { text: '', sourceSeq: 0 };
let livePresentation = { text: '', sourceSeq: 0 };
const activitySubscribers = new Set();
const runActivity = {
  getPresentation() { return actionPresentation; },
  getLivePresentation() { return livePresentation; },
  subscribe(listener) {
    activitySubscribers.add(listener);
    listener(livePresentation);
    return () => activitySubscribers.delete(listener);
  },
};
const model = {
  getSessionVisualStatus(session) {
    return session?.activity?.run?.state === 'idle'
      ? { key: 'idle', label: '空闲' }
      : visualStatus;
  },
  createReadyStatus() {
    return { key: 'ready', label: '就绪' };
  },
};
let runSheetOpenCount = 0;
const context = vm.createContext({
  Date: class extends Date { static now() { return now; } },
  document,
  window: {
    RagentSessionStateModel: model,
    RagentRunActivity: runActivity,
    openRunSheet() { runSheetOpenCount += 1; },
  },
  setInterval(callback) {
    const id = nextTimerId++;
    activeTimers.set(id, callback);
    return id;
  },
  clearInterval(id) { activeTimers.delete(id); },
  setTimeout(callback, delay) {
    const id = nextTimerId++;
    pendingTimeouts.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) { pendingTimeouts.delete(id); },
});
vm.runInContext(source, context);

const liveBarLabel = () => liveBar.children.find((child) => child.className === 'live-bar__label');
const liveBarElapsed = () => liveBar.children.find((child) => child.className === 'live-bar__elapsed');

const runningSession = {
  id: 'session-1',
  activity: {
    run: {
      state: 'running',
      runId: 'run-1',
      startedAt: '2026-07-28T18:00:00.000Z',
    },
  },
};
context.updateLiveBar(runningSession);
assert.equal(liveBar.hidden, false);
assert.equal(liveBar.dataset.state, 'running');
assert.equal(liveBarLabel()?.textContent, '正在执行…');
assert.equal(liveBarLabel()?.dataset.shimmerText, undefined, 'Live Bar labels should not carry unused shimmer metadata');
assert.equal(liveBarElapsed()?.textContent, '13s');
assert.equal(liveBarElapsed()?.attributes['aria-hidden'], 'true');
assert.equal(activeTimers.size, 1);
assert.equal(liveBarSlot.classList.contains('is-revealing'), true);
assert.equal([...pendingTimeouts.values()].some((timer) => timer.delay === 10000), true);

actionPresentation = { text: '正在修改文件 ui.js…', sourceSeq: 12, activity: { state: 'working' } };
livePresentation = { text: '正在修改文件 ui.js…', sourceSeq: 12, progress: null };
for (const subscriber of activitySubscribers) subscriber(livePresentation);
assert.equal(liveBarLabel()?.textContent, '正在修改文件 ui.js…');
assert.equal(liveBarElapsed()?.textContent, '13s', 'summary changes should not reset elapsed run time');

livePresentation = {
  text: '1/3 · 修 Live Bar',
  sourceSeq: 14,
  progress: { sourceSeq: 14, completed: 1, total: 3, current: '修 Live Bar', runId: 'run-1' },
};
for (const subscriber of activitySubscribers) subscriber(livePresentation);
assert.equal(liveBarLabel()?.textContent, '1/3 · 修 Live Bar', 'unfinished progress should replace the action summary in the Live Bar without a label prefix');
assert.equal(
  [...pendingTimeouts.values()].some((timer) => timer.delay === 10000),
  false,
  'Live Bar should not keep or schedule the ten-second capsule timer while execution progress is visible',
);

livePresentation = {
  text: '1/3 · 旧 run',
  sourceSeq: 15,
  progress: { sourceSeq: 15, completed: 1, total: 3, current: '旧 run', runId: 'run-old' },
};
for (const subscriber of activitySubscribers) subscriber(livePresentation);
assert.equal(liveBarLabel()?.textContent, '正在修改文件 ui.js…', 'progress from an older run should not leak into the current Live Bar');
assert.ok(
  [...pendingTimeouts.values()].some((timer) => timer.delay === 10000),
  'Live Bar should restore the ten-second capsule timer after execution progress disappears',
);

actionPresentation = { text: '正在搜索 tests…', sourceSeq: 16, activity: { state: 'working' } };
livePresentation = { text: '正在搜索 tests…', sourceSeq: 16, progress: null };
for (const subscriber of activitySubscribers) subscriber(livePresentation);
assert.equal(liveBarLabel()?.textContent, '正在搜索 tests…', 'completed progress should disappear and allow regular activity text again');

now += 48_000;
[...activeTimers.values()][0]();
assert.equal(liveBarElapsed()?.textContent, '1m 1s');

document.hidden = true;
listeners.get('visibilitychange')();
assert.equal(activeTimers.size, 0, 'background tabs should stop elapsed-time timer work');
assert.equal(liveBar.dataset.motionPaused, 'true', 'background tabs should pause stateful Live Bar motion');

document.hidden = false;
listeners.get('visibilitychange')();
const autoHide = [...pendingTimeouts.entries()].find(([, timer]) => timer.delay === 10000);
assert.ok(autoHide, 'running Live Bar should schedule its ten-second visibility window');
pendingTimeouts.delete(autoHide[0]);
autoHide[1].callback();
assert.equal(liveBar.dataset.collapsed, 'capsule');
assert.equal(liveBar.hidden, false, 'capsule should keep the Live Bar visible');
assert.equal(liveBarSlot.classList.contains('is-collapsing'), false);
assert.equal(activeTimers.size, 1, 'capsule should keep elapsed time updating');

liveBar.click();
assert.equal(liveBar.dataset.collapsed, undefined, 'clicking capsule should expand the Live Bar');
assert.equal(runSheetOpenCount, 0, 'clicking the capsule should only expand the Live Bar');
liveBar.click();
assert.equal(runSheetOpenCount, 1, 'clicking the expanded Live Bar should open the Run Sheet');
const recollapse = [...pendingTimeouts.entries()].find(([, timer]) => timer.delay === 10000);
assert.ok(recollapse, 'expanded Live Bar should schedule another capsule collapse');
pendingTimeouts.delete(recollapse[0]);
recollapse[1].callback();
assert.equal(liveBar.dataset.collapsed, 'capsule');

livePresentation = {
  text: '2/3 · 最后验证',
  sourceSeq: 18,
  progress: { sourceSeq: 18, completed: 2, total: 3, current: '最后验证', runId: 'run-1' },
};
for (const subscriber of activitySubscribers) subscriber(livePresentation);
assert.equal(liveBar.dataset.collapsed, undefined, 'execution progress should expand an already-collapsed Live Bar');
assert.equal(liveBarLabel()?.textContent, '2/3 · 最后验证');
assert.equal(
  [...pendingTimeouts.values()].some((timer) => timer.delay === 10000),
  false,
  'expanded progress should remain full-width without scheduling capsule collapse',
);

actionPresentation = { text: '正在整理结果…', sourceSeq: 19, activity: { state: 'working' } };
livePresentation = { text: '正在整理结果…', sourceSeq: 19, progress: null };
for (const subscriber of activitySubscribers) subscriber(livePresentation);
const progressClearedRecollapse = [...pendingTimeouts.entries()].find(([, timer]) => timer.delay === 10000);
assert.ok(progressClearedRecollapse, 'progress disappearing from an expanded bar should restart the ten-second capsule timer');
pendingTimeouts.delete(progressClearedRecollapse[0]);
progressClearedRecollapse[1].callback();
assert.equal(liveBar.dataset.collapsed, 'capsule');

visualStatus = { key: 'waiting_user', label: '需要你的操作' };
context.updateLiveBar(runningSession);
const capsuleExit = [...pendingTimeouts.entries()].find(([, timer]) => timer.delay === 280);
assert.ok(capsuleExit, 'status change from capsule should schedule a capsule exit animation');
pendingTimeouts.delete(capsuleExit[0]);
capsuleExit[1].callback();
assert.equal(liveBar.dataset.collapsed, undefined, 'a status change should leave capsule mode after the exit animation');
assert.equal(liveBar.hidden, false, 'a later status change should reveal the full Live Bar');
assert.equal(liveBarSlot.classList.contains('is-revealing'), true);
assert.equal(liveBarLabel()?.textContent, '需要你的操作');

context.updateLiveBar({ activity: { run: { state: 'idle' } } });
assert.equal(liveBar.hidden, false, 'idle sessions should retain the persistent Ready Live Bar');
assert.equal(liveBar.dataset.state, 'ready');
assert.equal(liveBarLabel()?.textContent, '就绪');
assert.equal(activeTimers.size, 0);

console.log('test-chat-live-status-ui: ok');

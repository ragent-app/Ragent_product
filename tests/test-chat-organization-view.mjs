#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'organization-view.js'), 'utf8');

function createDOMContext() {
  const registry = new Map();

  function makeElement(tag = 'div', id = '') {
    const classes = new Set();
    const listeners = new Map();
    const attributes = {};
    const el = {
      tagName: tag.toUpperCase(),
      hidden: false,
      textContent: '',
      innerHTML: '',
      className: '',
      id,
      style: {},
      attributes,
      children: [],
      parentNode: null,
      nextSibling: null,
      classList: {
        add(...names) { names.forEach((n) => classes.add(n)); },
        remove(...names) { names.forEach((n) => classes.delete(n)); },
        contains(name) { return classes.has(name); },
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatch(type, eventObj = {}) {
        const list = listeners.get(type) || [];
        list.forEach((fn) => fn(eventObj));
      },
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] ?? null; },
      removeAttribute(name) { delete attributes[name]; },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      insertBefore(child, ref) {
        const idx = this.children.indexOf(ref);
        if (idx >= 0) {
          this.children.splice(idx, 0, child);
        } else {
          this.children.push(child);
        }
        child.parentNode = this;
        return child;
      },
      remove() {
        if (this.parentNode) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx >= 0) this.parentNode.children.splice(idx, 1);
          this.parentNode = null;
        }
      },
      focus() { this.focused = true; },
      closest() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 700 }; },
      getContext() {
        return {
          save() {},
          restore() {},
          beginPath() {},
          moveTo() {},
          bezierCurveTo() {},
          stroke() {},
          clearRect() {},
          arc() {},
          fill() {},
          fillRect() {},
          rotate() {},
          scale() {},
          translate() {},
        };
      },
      querySelector(sel) {
        if (sel.startsWith('#')) {
          const qId = sel.slice(1);
          if (!registry.has(qId)) {
            const child = makeElement('div', qId);
            registry.set(qId, child);
          }
          return registry.get(qId);
        }
        return makeElement('div');
      },
      querySelectorAll() { return []; },
    };
    if (id) registry.set(id, el);
    return el;
  }

  const messages = makeElement('div', 'messages');
  const homeWorkspace = makeElement('section', 'homeWorkspace');
  const radarBtn = makeElement('button', 'orgRadarBtn');
  radarBtn.hidden = true;
  const overflowRadarBtn = makeElement('button', 'headerOverflowOrgRadarBtn');
  overflowRadarBtn.hidden = true;
  const chatArea = makeElement('main');
  chatArea.className = 'chat-area';
  chatArea.appendChild(messages);
  chatArea.appendChild(homeWorkspace);

  const document = {
    getElementById(id) {
      if (!registry.has(id)) {
        registry.set(id, makeElement('div', id));
      }
      return registry.get(id);
    },
    querySelector(sel) {
      if (sel === '.chat-area') return chatArea;
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) {
      return makeElement(tag);
    },
    body: chatArea,
  };

  const window = {
    document,
    RagentI18n: {
      t(k) { return k; },
    },
    RagentIcons: {
      render(name) { return `<icon-${name}/>`; },
    },
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    setTimeout,
    clearTimeout,
  };
  window.window = window;
  return { window, document, messages, homeWorkspace, radarBtn, overflowRadarBtn };
}

async function runTests() {
  console.log('Running test-chat-organization-view...');

  const { window, messages, homeWorkspace, radarBtn, overflowRadarBtn } = createDOMContext();
  const context = vm.createContext(window);
  vm.runInContext(source, context);

  const orgView = window.RagentOrganizationView;
  assert.ok(orgView, 'RagentOrganizationView is attached to window');

  // 1. Initial State
  assert.equal(orgView.active, false, 'Organization view should start inactive');
  assert.equal(radarBtn.hidden, true, 'Radar button should start hidden when no session is loaded');

  // 2. Mode Toggle (Timeline <-> Radar)
  orgView.toggleOrganizationMode(true);
  assert.equal(orgView.active, true, 'Organization view is now active');
  assert.equal(messages.hidden, true, 'Messages should be hidden in radar mode');
  assert.equal(homeWorkspace.hidden, true, 'Home workspace should be hidden in radar mode');
  assert.equal(orgView.dom.surface.hidden, false, 'Radar surface should be visible');
  assert.ok(radarBtn.classList.contains('is-active'), 'Radar button has is-active class');

  orgView.toggleOrganizationMode(false);
  assert.equal(orgView.active, false, 'Organization view is now inactive');
  assert.equal(messages.hidden, false, 'Messages should be restored');
  assert.equal(orgView.dom.surface.hidden, true, 'Radar surface is hidden');

  // 3. Layout Engine Verification
  const mockProjection = {
    organizationId: 'org-test-1',
    revision: 2,
    objective: 'Deploy Distributed Pipeline',
    nodes: [
      { id: 'root', stableKey: 'root', nodeRole: 'manager', sessionClass: 'MANAGER', displayName: 'Root Leader', status: 'running' },
      { id: 'worker-1', parentNodeId: 'root', stableKey: 'worker-1', nodeRole: 'worker', displayName: 'Worker Alpha', status: 'running', currentActivity: 'Running test suite' },
      { id: 'worker-2', parentNodeId: 'root', stableKey: 'worker-2', nodeRole: 'worker', displayName: 'Worker Beta', status: 'idle' },
      { id: 'reviewer-1', parentNodeId: 'root', stableKey: 'reviewer-1', nodeRole: 'reviewer', displayName: 'Code Reviewer', status: 'waiting_review' },
    ],
    edges: [
      { id: 'e1', parentNodeId: 'root', childNodeId: 'worker-1', edgeType: 'MANAGES' },
      { id: 'e2', parentNodeId: 'root', childNodeId: 'worker-2', edgeType: 'MANAGES' },
      { id: 'e3', parentNodeId: 'root', childNodeId: 'reviewer-1', edgeType: 'REVIEWS' },
    ],
  };

  orgView.projection = mockProjection;
  orgView.processProjectionEvents(mockProjection);
  orgView.toggleOrganizationMode(true);
  orgView.render();

  assert.ok(orgView.layoutResult, 'Layout result calculated');
  const nodePositions = orgView.layoutResult.nodePositions;
  assert.ok(nodePositions['root'], 'Root node position exists');
  assert.ok(nodePositions['worker-1'], 'Worker 1 node position exists');
  assert.ok(nodePositions['worker-2'], 'Worker 2 node position exists');
  assert.ok(nodePositions['reviewer-1'], 'Reviewer 1 node position exists');

  // Root should be positioned near top-center
  assert.equal(nodePositions['root'].x, 390 / 2, 'Root centered horizontally');
  assert.ok(nodePositions['worker-1'].y > nodePositions['root'].y, 'Workers placed below root');

  // 4. Clustering verification with > 5 children
  const clusterProjection = {
    organizationId: 'org-cluster-test',
    revision: 1,
    objective: 'Scale Test',
    nodes: [
      { id: 'root', nodeRole: 'executive', displayName: 'Root' },
      { id: 'lead', parentNodeId: 'root', nodeRole: 'manager', displayName: 'Lead' },
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `sub-worker-${i}`,
        parentNodeId: 'lead',
        nodeRole: 'worker',
        displayName: `SubWorker ${i}`,
      })),
    ],
    edges: [
      { id: 'e-root-lead', parentNodeId: 'root', childNodeId: 'lead', edgeType: 'MANAGES' },
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `e-lead-${i}`,
        parentNodeId: 'lead',
        childNodeId: `sub-worker-${i}`,
        edgeType: 'MANAGES',
      })),
    ],
  };

  orgView.projection = clusterProjection;
  orgView.render();

  const clusterPositions = orgView.layoutResult.nodePositions;
  assert.ok(clusterPositions['cluster_lead'], 'Cluster node generated for >5 workers under lead');
  assert.equal(clusterPositions['cluster_lead'].clusterCount, 7, 'Cluster contains 7 children');
  assert.equal(clusterPositions['sub-worker-0'], undefined, 'Sub-worker is clustered and hidden from top layout');

  // Focus on lead to expand cluster
  orgView.focusNodeId = 'lead';
  orgView.render();
  const expandedPositions = orgView.layoutResult.nodePositions;
  assert.equal(expandedPositions['cluster_lead'], undefined, 'Cluster node removed when lead is focused');
  assert.ok(expandedPositions['sub-worker-0'], 'Sub-worker 0 now visible when focused');

  // 5. Communication Scheduler Verification
  const scheduler = orgView.communicationScheduler;
  scheduler.scheduleCommunication('c1', 'BLOCKER_ESCALATED', 'worker-1', 'root');
  scheduler.scheduleCommunication('c2', 'TASK_ASSIGNED', 'root', 'worker-2');
  assert.equal(scheduler.queue[0].type, 'BLOCKER_ESCALATED', 'Blocker escalated has highest priority in queue');

  const activeParticles = scheduler.updateTick(nodePositions, Date.now());
  assert.ok(activeParticles.length > 0, 'Particles dispatched from queue');
  assert.equal(activeParticles[0].type, 'BLOCKER_ESCALATED', 'Blocker escalated particle dispatched first');

  // 6. Bottom Sheet & Root Leader "Send Instruction"
  const rootNode = orgView.projection.nodes.find((n) => n.id === 'root');
  orgView.openBottomSheet(rootNode);
  assert.equal(orgView.selectedSheetNodeId, 'root', 'Selected sheet node is root');
  assert.equal(orgView.dom.sheet.hidden, false, 'Bottom sheet is open');

  const sendBtn = orgView.dom.sheet.querySelector('#orgSendInstructionBtn');
  assert.ok(sendBtn, 'Root Leader has Send Instruction button');

  // Trigger Send Instruction
  sendBtn.dispatch('click');
  assert.equal(orgView.active, false, 'Send instruction exits radar mode to Timeline');

  // 7. Invalidation hook
  let invalidationCalled = false;
  orgView.sessionId = 'test-session-1';
  orgView.fetchProjection = async () => {
    invalidationCalled = true;
    return clusterProjection;
  };
  window.handleOrganizationInvalidation({ organizationId: 'org-cluster-test', revision: 2 });
  assert.ok(invalidationCalled, 'WebSocket organization_invalidated invokes fetchProjection');

  console.log('test-chat-organization-view: ok');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

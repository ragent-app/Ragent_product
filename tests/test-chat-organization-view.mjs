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
      disabled: false,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      id,
      style: {},
      attributes,
      dataset: {},
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
      replaceChildren(...nodes) {
        this.children = [];
        for (const n of nodes) this.appendChild(n);
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
    setInterval,
    clearInterval,
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

  // 8. AgY native swarm members, display names, XSS-safe read-only board summary, & detached honesty
  orgView.sessionId = null;
  orgView.projection = { rootSessionId: 'test-session-agy', nodes: [], edges: [] };
  orgView.delegationRecords = [];
  orgView.delegationEvents = [];
  orgView.rawUnifiedMembers = {
    rootSessionId: 'test-session-agy',
    rootCanonicalId: 'root:test-session-agy',
    sourceCoverage: { harness: 'partial', gap: false },
    members: [
      {
        canonicalId: 'member_echoer',
        displayName: 'echoer',
        role: 'worker',
        model: 'gemini-3.8-flash-low',
        sourceTag: 'agy',
        executionHarnessId: 'agy',
        parentCanonicalId: 'root:test-session-agy',
        relationKnown: true,
        controlCapabilities: { readOnly: true, canControlMember: false, canMessageMember: false },
        activity: { state: 'working', kind: null, actionRequired: false, runId: 'run-agy-1', sourceSeq: 1 },
        conversation: { ref: 'ref-echoer', generation: 1, scope: 'activity_only' },
      },
      {
        canonicalId: 'member_detached',
        displayName: 'orphan-worker<script>',
        sourceTag: 'agy',
        executionHarnessId: 'agy',
        parentCanonicalId: null,
        relationKnown: false,
        activity: { state: 'idle', kind: null, actionRequired: false, runId: 'run-agy-1', sourceSeq: 2 },
      },
    ],
    board: {
      schemaVersion: 1,
      source: 'provider_native',
      provider: 'agy',
      readOnly: true,
      title: 'Agy Swarm <img src=x>',
      channels: [{ name: 'main', messageCount: 1, latestSeq: 1 }],
      messages: [
        { seq: 1, channel: 'main', sender: 'coordinator', text: '@echoer audit <script>alert(1)</script>', kind: 'brief' },
      ],
    },
  };
  orgView.toggleOrganizationMode(true);
  orgView.render();
  const agyModel = orgView.buildUnifiedGraphModel();
  const echoerUiNode = Object.values(agyModel.nodesMap).find((n) => n.displayName === 'echoer');
  const detachedUiNode = Object.values(agyModel.nodesMap).find((n) => n.displayName === 'orphan-worker<script>');
  assert.ok(echoerUiNode, 'AgY member keeps verified displayName');
  assert.equal(echoerUiNode.sourceTag, 'agy');
  assert.equal(echoerUiNode.executionHarnessId, 'agy');
  assert.equal(echoerUiNode.model, 'gemini-3.8-flash-low');
  assert.equal(echoerUiNode.isReadOnlyNative, true);
  assert.equal(echoerUiNode.coverage, 'activity_only');
  assert.ok(detachedUiNode, 'Detached AgY member is retained');
  assert.equal(detachedUiNode.parentId, null, 'Unverified parent stays detached');
  assert.equal(detachedUiNode.parentUnknown, true);
  assert.ok(orgView.dom.activityFeedList.innerHTML.includes('Swarm Board (Read-Only)'), 'Read-only board header rendered');
  assert.equal(orgView.dom.swarmBoardComposer.hidden, true, 'Composer must stay hidden for AgY native read-only board');
  assert.equal(orgView.dom.activityFeedList.innerHTML.includes('<script>'), false, 'Board XSS payload must be escaped');
  assert.ok(orgView.dom.activityFeedList.innerHTML.includes('&lt;script&gt;'), 'Escaped text survives cleanly');
  orgView.toggleOrganizationMode(false);

  // 9. Wave 2A: Writable Ragent Swarm Overview Header, Channels, Monotonic #seq Timeline, Composer & XSS safety
  const fetchCalls = [];
  window.ragentFetch = async (url, opts = {}) => {
    fetchCalls.push({ url, opts });
    if (url.includes('/organization/board/messages') && opts.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            message: { seq: 4, channel: 'review', sender: 'owner', senderKind: 'owner', bodyMarkdown: '@verifier-1 please check #2' },
            headSeq: 4,
          };
        },
      };
    }
    if (url.includes('/organization/swarm/kill') && opts.method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      if (!body.forceDiscard) {
        return {
          ok: false,
          status: 409,
          async json() {
            return {
              code: 'SWARM_WORKSPACE_UNMERGED_CHANGES',
              error: 'Refusing to kill worker-1: dirty files present',
              workspaceMode: 'worktree',
              workspaceBranch: 'swarm/worker-1',
              dirtyFiles: ['chat/router-organization-routes.mjs'],
              unmergedCommits: 1,
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() { return { killed: true, node: { nodeId: 'node-w1', swarmState: 'killed' } }; },
      };
    }
    if (url.includes('/organization/swarm/status')) {
      return { ok: true, status: 200, async json() { return orgView.swarmStatus; } };
    }
    if (url.includes('/organization/board')) {
      return { ok: true, status: 200, async json() { return orgView.boardProjection; } };
    }
    return { ok: false, status: 404, async json() { return { error: 'Not found' }; } };
  };

  orgView.onSessionChanged('sess-swarm-1');
  orgView.rawUnifiedMembers = null;
  orgView.nativeBoard = null;
  orgView.projection = {
    organizationId: 'org-swarm-1',
    rootSessionId: 'sess-swarm-1',
    objective: 'Cross-harness Swarm Audit',
    revision: 0,
    nodes: [
      { id: 'node-coord', stableKey: 'coordinator', nodeRole: 'root_leadership', sessionClass: 'ROOT_LEADERSHIP', displayName: 'coordinator', status: 'working' },
      { id: 'node-w1', parentNodeId: 'node-coord', stableKey: 'worker-1', nodeRole: 'worker', displayName: 'worker-1', status: 'working' },
      { id: 'node-v1', parentNodeId: 'node-coord', stableKey: 'verifier-1', nodeRole: 'reviewer', displayName: 'verifier-1', status: 'idle' },
    ],
    edges: [
      { id: 'e-c-w1', parentNodeId: 'node-coord', childNodeId: 'node-w1', edgeType: 'MANAGES' },
      { id: 'e-c-v1', parentNodeId: 'node-coord', childNodeId: 'node-v1', edgeType: 'MANAGES' },
    ],
  };
  orgView.swarmStatus = {
    organizationId: 'org-swarm-1',
    mode: 'ragent_swarm',
    headSeq: 3,
    isDone: false,
    counts: { working: 1, waiting: 1, stopped: 1, killed: 1, active: 3, total: 4 },
    activeStalls: [{ id: 'st-1', conditionKind: 'unconsumed_doorbell', targetNodeId: 'worker-1', alertCount: 2 }],
    budget: { limits: { maxTotalRuns: 10 }, totals: { runs: 3, tokens: 1200, costUsd: 0.045 }, reserved: { runs: 1 } },
    members: [
      { nodeId: 'node-coord', name: 'coordinator', stableKey: 'coordinator', role: 'coordinator', contractRole: 'root_leadership', swarmState: 'working', harness: 'agy', workspaceMode: 'inherit', channels: ['main'] },
      { nodeId: 'node-w1', name: 'worker-1', stableKey: 'worker-1', role: 'worker', contractRole: 'worker', swarmState: 'waiting', harness: 'codex', workspaceMode: 'worktree', workspaceBranch: 'swarm/worker-1', channels: ['main', 'review'] },
      { nodeId: 'node-v1', name: 'verifier-1', stableKey: 'verifier-1', role: 'reviewer', contractRole: 'reviewer', swarmState: 'stopped', harness: 'claude', workspaceMode: 'inherit', channels: ['review'] },
    ],
  };
  orgView.boardProjection = {
    rootSessionId: 'sess-swarm-1',
    mode: 'ragent_swarm',
    readOnly: false,
    channels: [
      { name: 'main', messageCount: 2, latestSeq: 3, unreadCount: 0 },
      { name: 'review', messageCount: 1, latestSeq: 2, unreadCount: 1 },
    ],
    board: {
      mode: 'ragent_swarm',
      readOnly: false,
      title: 'Cross-Harness <img src=x onerror=alert(1)>',
      headSeq: 3,
      isDone: false,
      activeStalls: [{ id: 'st-1', conditionKind: 'unconsumed_doorbell', targetNodeId: 'worker-1', alertCount: 2 }],
      messages: [
        // Intentionally out-of-order to verify monotonic seq sorting
        { seq: 3, channel: 'main', senderKind: 'system', sender: 'watchdog', senderRole: 'system', text: '[stall] @coordinator check <script>alert(9)</script>', isStallAlert: true },
        { seq: 1, channel: 'main', senderKind: 'node', senderNodeId: 'node-w1', sender: 'worker-1', text: 'Working on #main' },
        { seq: 2, channel: 'review', senderKind: 'node', senderNodeId: 'node-v1', sender: 'verifier-1', text: '@worker-1 verified #1 [done]', replyToSeq: 1, isDoneSignal: true },
      ],
    },
  };

  orgView.toggleOrganizationMode(true);
  orgView.render();

  const overviewHtml = orgView.dom.swarmOverview.innerHTML;
  assert.equal(orgView.dom.swarmOverview.hidden, false, 'Swarm overview header must be visible');
  assert.ok(overviewHtml.includes('working: 1') && overviewHtml.includes('waiting: 1') && overviewHtml.includes('stopped: 1') && overviewHtml.includes('killed: 1'), '4-state counts rendered');
  assert.ok(overviewHtml.includes('[stall]') && overviewHtml.includes('unconsumed_doorbell'), 'stall alert rendered');
  assert.ok(overviewHtml.includes('codex') && overviewHtml.includes('claude') && overviewHtml.includes('agy'), 'cross-harness badges rendered');
  assert.ok(overviewHtml.includes('swarm/worker-1'), 'worktree branch pill rendered');
  assert.ok(overviewHtml.includes('3/10') && overviewHtml.includes('$0.0450') && !overviewHtml.includes('%'), 'budget rendered factually without fabricated percentages');

  const boardHtml = orgView.dom.activityFeedList.innerHTML;
  assert.equal(orgView.dom.swarmBoardComposer.hidden, false, 'Writable Ragent Swarm board must show Owner composer');
  assert.ok(boardHtml.includes('#main') && boardHtml.includes('#review'), 'Channel tabs rendered');
  assert.ok(boardHtml.includes('org-board-channel-unread">1<'), 'Unread badge rendered on #review');
  assert.ok(
    boardHtml.indexOf('org-board-seq">#1<') < boardHtml.indexOf('org-board-seq">#2<') &&
    boardHtml.indexOf('org-board-seq">#2<') < boardHtml.indexOf('org-board-seq">#3<'),
    'Messages ordered monotonically by #seq',
  );
  assert.ok(boardHtml.includes('org-board-mention">@worker-1') && boardHtml.includes('[done]') && boardHtml.includes('[stall]'), 'Mentions and tags highlighted');
  assert.ok(boardHtml.includes('codex') && boardHtml.includes('claude'), 'Sender harness badges resolved');
  assert.equal(boardHtml.includes('<script>') || boardHtml.includes('<img src=x'), false, 'XSS payloads escaped cleanly');
  assert.ok(boardHtml.includes('&lt;img src=x onerror=alert(1)&gt;') && boardHtml.includes('&lt;script&gt;alert(9)&lt;/script&gt;'), 'Escaped XSS strings retained cleanly');

  // Switch to #review & submit owner board message
  orgView.selectBoardChannel('review');
  assert.equal(orgView.dom.activityFeedList.innerHTML.includes('Working on #main'), false, 'Channel switch filters messages');
  assert.ok(orgView.dom.activityFeedList.innerHTML.includes('verified'), 'Selected channel message stays visible');
  assert.equal(orgView.dom.swarmBoardTargetChannel.textContent, '#review', 'Composer targets selected channel');

  orgView.dom.swarmBoardInput.value = '@verifier-1 please check #2';
  await orgView.submitBoardMessage();
  const postCall = fetchCalls.find((c) => c.url.includes('/organization/board/messages') && c.opts.method === 'POST');
  assert.ok(postCall, 'Owner composer submits POST to /organization/board/messages');
  assert.deepEqual(JSON.parse(postCall.opts.body), { channel: 'review', bodyMarkdown: '@verifier-1 please check #2' });

  // 10. Read-Only Enforcement: even if server returns nativeBoard alongside provider_native, composer is strictly hidden
  fetchCalls.length = 0;
  orgView.swarmStatus = null;
  orgView.boardProjection = {
    rootSessionId: 'sess-swarm-1',
    mode: 'provider_native',
    readOnly: false, // malicious/spoofed readOnly=false on provider_native must NEVER enable composer!
    channels: [{ name: 'main', messageCount: 1 }],
    board: {
      mode: 'provider_native',
      source: 'provider_native',
      readOnly: false,
      title: 'Native Spoof Check',
      channels: [{ name: 'main', messageCount: 1 }],
      messages: [{ seq: 1, channel: 'main', sender: 'coordinator', text: 'native only' }],
    },
  };
  orgView.render();
  assert.equal(orgView.dom.swarmBoardComposer.hidden, true, 'Composer MUST stay hidden for provider_native even if readOnly flag spoofed');
  assert.ok(orgView.dom.activityFeedList.innerHTML.includes('Swarm Board (Read-Only)'), 'Explicit read-only banner shown for provider_native');
  const blockedPost = await orgView.submitBoardMessage('should not send');
  assert.equal(blockedPost, null, 'submitBoardMessage refuses read-only board');
  assert.equal(fetchCalls.filter((c) => c.opts.method === 'POST').length, 0, 'No POST dispatched on read-only board');

  // 11. Bottom Sheet Kill Guard (SWARM_WORKSPACE_UNMERGED_CHANGES -> Force Discard confirmation)
  orgView.swarmStatus = {
    organizationId: 'org-swarm-1',
    mode: 'ragent_swarm',
    counts: { working: 1, waiting: 1, stopped: 0, killed: 0, active: 2, total: 2 },
    members: [
      { nodeId: 'node-coord', name: 'coordinator', stableKey: 'coordinator', role: 'coordinator', contractRole: 'root_leadership', swarmState: 'working', harness: 'agy', workspaceMode: 'inherit' },
      { nodeId: 'node-w1', name: 'worker-1', stableKey: 'worker-1', role: 'worker', contractRole: 'worker', swarmState: 'waiting', harness: 'codex', workspaceMode: 'worktree', workspaceBranch: 'swarm/worker-1' },
    ],
  };
  orgView.openBottomSheet(orgView.projection.nodes.find((n) => n.id === 'node-coord'));
  assert.equal(orgView.dom.sheet.innerHTML.includes('orgSwarmKillBtn'), false, 'Root coordinator never shows Kill button');

  orgView.openBottomSheet(orgView.projection.nodes.find((n) => n.id === 'node-w1'));
  assert.ok(orgView.dom.sheet.innerHTML.includes('orgSwarmKillBtn'), 'Non-root swarm worker shows Kill button');
  assert.ok(orgView.dom.sheet.innerHTML.includes('swarm/worker-1'), 'Bottom sheet displays worktree branch pill');

  await orgView.killSwarmMemberRequest('node-w1', { forceDiscard: false });
  assert.ok(orgView.dom.sheet.innerHTML.includes('orgSwarmKillConflictCard'), '409 SWARM_WORKSPACE_UNMERGED_CHANGES shows unmerged conflict warning');
  assert.ok(orgView.dom.sheet.innerHTML.includes('orgSwarmForceKillBtn'), 'Force Discard & Kill button offered on conflict');

  await orgView.killSwarmMemberRequest('node-w1', { forceDiscard: true });
  const forceKillPost = fetchCalls.find((c) => c.url.includes('/organization/swarm/kill') && JSON.parse(c.opts.body).forceDiscard === true);
  assert.ok(forceKillPost, 'Explicit forceDiscard kill request dispatched');

  // 12. Phase 3 Model Switch & Candidate Promotion UI + Per-Epoch Model History (never fabricated for read-only native)
  fetchCalls.length = 0;
  orgView.swarmStatus = {
    organizationId: 'org-swarm-1',
    mode: 'ragent_swarm',
    counts: { working: 1, waiting: 1, stopped: 0, killed: 0, active: 2, total: 2 },
    usageByModel: [
      { modelKey: 'codex:gpt-5.4', tool: 'codex', model: 'gpt-5.4', totalTokens: 1200, costUsd: 0.015 },
      { modelKey: 'claude:claude-sonnet-4-6', tool: 'claude', model: 'claude-sonnet-4-6', totalTokens: 800, costUsd: 0.012 },
    ],
    members: [
      { nodeId: 'node-coord', name: 'coordinator', stableKey: 'coordinator', role: 'coordinator', contractRole: 'root_leadership', swarmState: 'working', harness: 'agy', workspaceMode: 'inherit' },
      {
        nodeId: 'node-w1',
        name: 'worker-1',
        stableKey: 'worker-1',
        role: 'worker',
        contractRole: 'worker',
        swarmState: 'waiting',
        harness: 'claude',
        model: 'claude-sonnet-4-6',
        bindingGeneration: 2,
        workspaceMode: 'worktree',
        workspaceBranch: 'swarm/worker-1',
        modelHistory: [
          {
            epochIndex: 1,
            bindingGeneration: 1,
            endedAt: '2026-11-20T00:10:00Z',
            requestedConfig: { tool: 'codex', model: 'gpt-5.4' },
            resolvedConfig: { tool: 'codex', model: 'gpt-5.4' },
            actualReportedConfig: { tool: 'codex', model: 'gpt-5.4' },
            usage: { totalTokens: 1200, costUsd: 0.015, runCount: 1 },
          },
          {
            epochIndex: 2,
            bindingGeneration: 2,
            endedAt: null,
            requestedConfig: { tool: 'claude', model: 'claude-sonnet-4-6' },
            resolvedConfig: { tool: 'claude', model: 'claude-sonnet-4-6' },
            actualReportedConfig: null,
            usage: { totalTokens: 800, costUsd: 0.012, runCount: 1 },
          },
        ],
      },
    ],
  };
  orgView.renderSwarmOverview();
  assert.ok(orgView.dom.swarmOverview.innerHTML.includes('codex:gpt-5.4 (1200 tok') && orgView.dom.swarmOverview.innerHTML.includes('claude:claude-sonnet-4-6 (800 tok'), 'Per-model epoch usage pills rendered separately');

  orgView.openBottomSheet(orgView.projection.nodes.find((n) => n.id === 'node-coord'));
  assert.ok(orgView.dom.sheet.innerHTML.includes('orgSwarmModelBtn') && orgView.dom.sheet.innerHTML.includes('Waiting Required'), 'Working member disables model switch cleanly');

  orgView.openBottomSheet(orgView.projection.nodes.find((n) => n.id === 'node-w1'));
  assert.ok(orgView.dom.sheet.innerHTML.includes('orgSwarmModelHistoryCard'), 'Separate model epochs rendered in member sheet');
  assert.ok(orgView.dom.sheet.innerHTML.includes('#1') && orgView.dom.sheet.innerHTML.includes('#2') && orgView.dom.sheet.innerHTML.includes('1200 tok') && orgView.dom.sheet.innerHTML.includes('800 tok'), 'Epoch metrics stay separated');
  assert.ok(orgView.dom.sheet.innerHTML.includes('orgSwarmPromoteBtn'), 'Isolated waiting worker offers Promote Candidate button');

  await orgView.switchSwarmMemberModelRequest('node-w1', { harness: 'codex', model: 'gpt-5.4', reason: 'ui switch' });
  const switchPost = fetchCalls.find((c) => c.url.includes('/organization/swarm/model') && c.opts.method === 'POST');
  assert.ok(switchPost && JSON.parse(switchPost.opts.body).model === 'gpt-5.4', 'UI dispatches /swarm/model POST');

  await orgView.promoteSwarmCandidateRequest('node-w1', { summary: 'promote from ui' });
  const promotePost = fetchCalls.find((c) => c.url.includes('/organization/swarm/promote-candidate') && c.opts.method === 'POST');
  assert.ok(promotePost && JSON.parse(promotePost.opts.body).targetNodeId === 'node-w1', 'UI dispatches /swarm/promote-candidate POST');

  // Read-only native member never renders switch/promote/kill buttons
  orgView.openBottomSheet({
    id: 'native:subagent-1',
    displayName: 'Native Subagent',
    role: 'WORKER',
    runtimeState: 'IDLE',
    isNativeMember: true,
    isReadOnlyNative: true,
    sourceTag: 'codex',
  });
  assert.equal(orgView.dom.sheet.innerHTML.includes('orgSwarmModelBtn'), false, 'Read-only native subagent never renders Switch Model');
  assert.equal(orgView.dom.sheet.innerHTML.includes('orgSwarmPromoteBtn'), false, 'Read-only native subagent never renders Promote Candidate');
  assert.equal(orgView.dom.sheet.innerHTML.includes('orgSwarmKillBtn'), false, 'Read-only native subagent never renders Kill');

  orgView.toggleOrganizationMode(false);
  orgView.onSessionChanged(null);
  console.log('test-chat-organization-view: ok');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
// tests/test-chat-project-overview-core.mjs
//
// Stage 2: transport/project-overview.js is a verbatim extraction of
// project-overview.js's pure projection set (the legacy module header already
// declares "pure functions only"; the only DOM token in it was the attach
// tail, replaced with the transport :{} idiom). The view layer keeps binding
// to the legacy attach until Stage 3, so this parity battery is the only lock
// between the two implementations: every scenario runs against BOTH modules
// with identical catalog inputs (projects/sessions), injected getSortTime /
// compare / isRunning variants, and compares primitive-level outputs.
//
// Date parsing in the fallback sort-time path (new Date(ISO stamp)) is
// deterministic, so no timestamp stripping is needed here.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function loadImplementation(relPath, attachName) {
  const context = { console, Date };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(repoRoot, relPath), 'utf8'), context, { filename: relPath });
  const moduleApi = context[attachName];
  assert.ok(moduleApi, `${relPath} should attach ${attachName}`);
  return {
    buildProjectOverview: (input) => moduleApi.buildProjectOverview(input),
    searchProjectView: (input) => moduleApi.searchProjectView(input),
    sessionsOfProject: (input) => moduleApi.sessionsOfProject(input),
    sortSessionsByActivity: (sessions, getSortTime, compare, isRunning) =>
      moduleApi.sortSessionsByActivity(sessions, getSortTime, compare, isRunning),
    sessionMatchesQuery: (s, q) => moduleApi.sessionMatchesQuery(s, q),
    projectMatchesQuery: (p, q) => moduleApi.projectMatchesQuery(p, q),
    label: attachName,
  };
}

const PROJECTS = [
  { id: 'p1', name: 'Alpha', rootPath: '/w/alpha' },
  { id: 'p2', name: 'Beta', rootPath: '/w/beta', pinned: true },
  { id: 'p3', name: 'gamma', rootPath: '/w/gamma/' }, // trailing slash root
  { name: 'no-id' }, // project without id — skipped entirely
];

// Sessions: project-bound (p1), folder-fallback (p2 via rootPath, p3 via
// normalized trailing slash), projectDetached → inbox, running / idle, and an
// orphan session with a folder that does not match any project root.
const SESSIONS = [
  { id: 's1', name: 'alpha session', projectId: 'p1', updatedAt: '2026-08-08T10:00:00.000Z' },
  { id: 's2', name: 'running beta', projectId: 'p2', updatedAt: '2026-08-08T09:00:00.000Z', activity: { run: { state: 'running', startedAt: '2026-08-08T08:00:00.000Z' } } },
  { id: 's3', name: 'idle beta', projectId: 'p2', updatedAt: '2026-08-08T11:00:00.000Z' },
  { id: 's4', name: 'gamma task', folder: '/w/gamma', updatedAt: '2026-08-08T07:00:00.000Z' },
  { id: 's5', name: 'detached', projectId: 'p1', projectDetached: true, updatedAt: '2026-08-08T06:00:00.000Z' },
  { id: 's6', name: 'folder beta', folder: '/w/beta', updatedAt: '2026-08-08T05:00:00.000Z' },
  { id: 's7', name: 'orphan session', folder: '/opt/orphan', updatedAt: '2026-08-08T04:00:00.000Z' },
];

const isRunning = (session) => session.activity?.run?.state === 'running';

function runScenario(impl) {
  const out = {};

  // 1. Overview: default limit/inbox, pinned first, recency order, folder
  //    fallback grouping, detached + unmatched-folder → inbox.
  out.overview = impl.buildProjectOverview({ projects: PROJECTS, sessions: SESSIONS });

  // 2. Overview variants: limit 1, inboxLast false, no sessions, empty input.
  out.overviewLimit1 = impl.buildProjectOverview({ projects: PROJECTS, sessions: SESSIONS, limit: 1 });
  out.overviewNoInbox = impl.buildProjectOverview({ projects: PROJECTS, sessions: SESSIONS, inboxLast: false });
  out.overviewEmptySessions = impl.buildProjectOverview({ projects: PROJECTS, sessions: [] });
  out.overviewNoInput = impl.buildProjectOverview();
  out.overviewNoProjects = impl.buildProjectOverview({ sessions: SESSIONS });

  // 3. Overview with injected getSortTime (weight) and compare / isRunning.
  const getWeight = (session) => session.weight || 0;
  const compareWeight = (a, b) => (b.weight || 0) - (a.weight || 0);
  out.overviewWeighted = impl.buildProjectOverview({
    projects: PROJECTS,
    sessions: SESSIONS.map((s) => ({ ...s, weight: s.id === 's3' ? 100 : 1 })),
    getSortTime: getWeight,
    compare: compareWeight,
    isRunning,
  });

  // 4. Search: empty/whitespace query → same shape as overview; then L1, L2,
  //    L3 and inbox-L2 match levels.
  out.searchEmpty = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS });
  out.searchBlank = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: '   ' });
  out.searchL1 = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'beta' }); // project Beta + running beta / idle beta sessions
  out.searchL2 = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'gamma' }); // session s4 only (project name 'gamma' also matches — L1)
  out.searchL2Only = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'task' }); // session-only → L2
  out.searchL3 = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'alpha' }); // project Alpha + session s1 → L1
  out.searchL3Only = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'betx' }); // project only? no — use pinned beta name
  out.searchL3Only = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'Alphx' }); // no session match, project name case-insensitive → L3
  out.searchInboxL2 = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'maint' }); // inbox orphan matches → L2 inbox
  out.searchWiden = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'session', limit: 1 }); // many matches → widened previews
  out.searchNoMatch = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'zzz' });
  out.searchLimit = impl.searchProjectView({ projects: PROJECTS, sessions: SESSIONS, query: 'beta', limit: 1 });

  // 5. sessionsOfProject: explicit id, empty id (folder fallback + orphans),
  //    whitespace id, missing input.
  out.ofProject = impl.sessionsOfProject({ sessions: SESSIONS, projectId: 'p1', projects: PROJECTS });
  out.ofProjectInbox = impl.sessionsOfProject({ sessions: SESSIONS, projectId: '', projects: PROJECTS });
  out.ofProjectBlank = impl.sessionsOfProject({ sessions: SESSIONS, projectId: '  ', projects: PROJECTS });
  out.ofProjectMissing = impl.sessionsOfProject();

  // 6. sortSessionsByActivity alone: fallback sort time (running startedAt
  //    wins over updatedAt), injected compare tie-break, isRunning partition,
  //    empty list.
  out.sortFallback = impl.sortSessionsByActivity(SESSIONS);
  out.sortWithCompare = impl.sortSessionsByActivity(SESSIONS, getWeight, compareWeight);
  out.sortPartitioned = impl.sortSessionsByActivity(SESSIONS, null, null, isRunning);
  out.sortEmpty = impl.sortSessionsByActivity([]);

  // 7. Query matchers: case-insensitivity, missing fields, empty query.
  out.matches = [
    impl.sessionMatchesQuery(SESSIONS[0], 'ALPHA'),
    impl.sessionMatchesQuery(SESSIONS[0], 'nope'),
    impl.sessionMatchesQuery(SESSIONS[0], ''),
    impl.sessionMatchesQuery(null, 'x'),
    impl.projectMatchesQuery(PROJECTS[0], 'alpha'),
    impl.projectMatchesQuery(PROJECTS[0], 'ALPH'),
    impl.projectMatchesQuery(PROJECTS[0], 'zzz'),
  ];

  // JSON round-trip: group arrays come from the vm realm and would fail
  // deepStrictEqual on prototype identity alone.
  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const [legacy, core] = [
    loadImplementation('static/chat/project-overview.js', 'RagentProjectOverview'),
    loadImplementation('static/chat/transport/project-overview.js', 'RagentProjectOverviewCore'),
  ];
  const [a, b] = [runScenario(legacy), runScenario(core)];
  assert.deepEqual(b, a, `project-overview drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-project-overview-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

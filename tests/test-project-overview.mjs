#!/usr/bin/env node
// Unit tests for the project-overview projection layer.
// Pure functions over sessions + projects; loaded in a vm sandbox like the
// other browser modules, with an injected getSortTime for deterministic times.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static/chat/project-overview.js'), 'utf8');

const sandbox = {};
vm.createContext(sandbox);
vm.runInNewContext(source, sandbox, { filename: 'static/chat/project-overview.js' });
const M = sandbox.RagentProjectOverview;

// Deterministic sort time: sessions carry sortTime directly.
const getSortTime = (session) => session?.sortTime || 0;

function session(id, { projectId = '', name = '', description = '', folder = '', sortTime = 0 } = {}) {
  return { id, projectId, name, description, folder, sortTime };
}

function project(id, name, rootPath = '', extra = {}) {
  return { id, name, rootPath, ...extra };
}

// Node's deepStrictEqual treats vm-realm string primitives as distinct from
// host-realm ones (same value, different context marker), so round-trip every
// projected value through JSON to re-create it in the host realm.
function ids(groups) {
  return JSON.parse(JSON.stringify(groups.map((group) => group.projectId || '(inbox)')));
}

function previewIds(group) {
  return JSON.parse(JSON.stringify(group.preview.map((session) => session.id)));
}

// ---- buildProjectOverview ----

{
  const projects = [project('p1', 'Alpha'), project('p2', 'Beta')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'one', sortTime: 100 }),
    session('s2', { projectId: 'p1', name: 'two', sortTime: 300 }),
    session('s3', { projectId: 'p1', name: 'three', sortTime: 200 }),
    session('s4', { projectId: 'p1', name: 'four', sortTime: 50 }),
    session('s5', { projectId: 'p2', name: 'five', sortTime: 90 }),
  ];
  const groups = M.buildProjectOverview({ projects, sessions, getSortTime });
  // Projects ordered by most recent session activity: p1 (300) before p2 (90).
  assert.deepEqual(ids(groups), ['p1', 'p2'], 'projects order by most recent session activity');
  // Preview capped at 3, most recent first.
  assert.deepEqual(previewIds(groups[0]), ['s2', 's3', 's1'], 'preview keeps 3 most recent sessions');
  assert.deepEqual(previewIds(groups[1]), ['s5'], 'small project shows its actual count');
}

{
  // Empty projects list; orphan sessions collect into the inbox group last.
  const sessions = [
    session('s1', { projectId: '', name: 'orphan', sortTime: 500 }),
    session('s2', { projectId: '', name: 'other', sortTime: 100 }),
  ];
  const groups = M.buildProjectOverview({ projects: [], sessions, getSortTime });
  assert.equal(groups.length, 1, 'inbox group created for orphan sessions');
  assert.equal(groups[0].inbox, true, 'inbox group flagged');
  assert.deepEqual(previewIds(groups[0]), ['s1', 's2'], 'inbox preview ordered by recency');
}

{
  // Inbox sits at the bottom even when its sessions are more recent.
  const projects = [project('p1', 'Alpha')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'in-project', sortTime: 100 }),
    session('s2', { projectId: '', name: 'orphan', sortTime: 999 }),
  ];
  const groups = M.buildProjectOverview({ projects, sessions, getSortTime });
  assert.deepEqual(ids(groups), ['p1', '(inbox)'], 'inbox pinned to the bottom');
}

{
  // A pinned project outranks a newer unpinned project, while a detached
  // session remains in the bottom inbox even if its old folder still matches.
  const projects = [
    project('p1', 'Pinned', '/tmp/pinned', { pinned: true }),
    project('p2', 'Recent', '/tmp/recent'),
  ];
  const sessions = [
    session('s-old', { projectId: 'p1', sortTime: 10 }),
    session('s-new', { projectId: 'p2', sortTime: 900 }),
    session('s-detached', { projectId: '', folder: '/tmp/pinned', sortTime: 800 }),
  ];
  sessions[2].projectDetached = true;
  const groups = M.buildProjectOverview({ projects, sessions, getSortTime });
  assert.deepEqual(ids(groups), ['p1', 'p2', '(inbox)'], 'pinned project stays above recent unpinned projects');
  assert.deepEqual(previewIds(groups[2]), ['s-detached'], 'detached session stays in inbox');
}

// ---- searchProjectView ----

{
  // L3: only the project name matches — show the 3 most recent sessions.
  const projects = [project('p1', 'Alpha')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'q1', sortTime: 100 }),
    session('s2', { projectId: 'p1', name: 'q2', sortTime: 300 }),
    session('s3', { projectId: 'p1', name: 'q3', sortTime: 200 }),
    session('s4', { projectId: 'p1', name: 'q4', sortTime: 50 }),
  ];
  const groups = M.searchProjectView({ projects, sessions, query: 'alpha', getSortTime });
  assert.equal(groups.length, 1, 'L3 group present');
  assert.equal(groups[0].matchLevel, M.MATCH_LEVEL_PROJECT, 'L3 level');
  assert.deepEqual(previewIds(groups[0]), ['s2', 's3', 's1'], 'L3 shows 3 most recent');
}

{
  // L2: session names match — matched float to the top, remaining slots fill
  // with the most recent unmatched sessions.
  const projects = [project('p1', 'Alpha')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'report one', sortTime: 100 }),
    session('s2', { projectId: 'p1', name: 'report two', sortTime: 400 }),
    session('s3', { projectId: 'p1', name: 'other three', sortTime: 300 }),
    session('s4', { projectId: 'p1', name: 'other four', sortTime: 200 }),
  ];
  const groups = M.searchProjectView({ projects, sessions, query: 'report', getSortTime });
  assert.equal(groups.length, 1, 'L2 group present');
  assert.equal(groups[0].matchLevel, M.MATCH_LEVEL_SESSION, 'L2 level');
  // s2 (400) and s1 (100) match; one slot remains for the most recent unmatched s3.
  assert.deepEqual(previewIds(groups[0]), ['s2', 's1', 's3'], 'matched float, gap fills by recency');
}

{
  // More matches than the limit: the group widens to show all matches.
  const projects = [project('p1', 'Alpha')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'report one', sortTime: 100 }),
    session('s2', { projectId: 'p1', name: 'report two', sortTime: 200 }),
    session('s3', { projectId: 'p1', name: 'report three', sortTime: 300 }),
    session('s4', { projectId: 'p1', name: 'report four', sortTime: 400 }),
    session('s5', { projectId: 'p1', name: 'other', sortTime: 500 }),
  ];
  const groups = M.searchProjectView({ projects, sessions, query: 'report', getSortTime });
  assert.deepEqual(previewIds(groups[0]), ['s4', 's3', 's2', 's1'], '4 matches all shown, no cap');
}

{
  // L1: project name AND session name match — ranks above L2 and L3 groups.
  const projects = [project('p1', 'Alpha'), project('p2', 'Beta'), project('p3', 'Gamma')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'alpha task', sortTime: 100 }),
    session('s2', { projectId: 'p2', name: 'alpha task', sortTime: 900 }), // L2: session matches
    session('s3', { projectId: 'p3', name: 'other', sortTime: 800 }),     // L3: project 'gamma' does not match
  ];
  const groups = M.searchProjectView({ projects, sessions, query: 'alpha', getSortTime });
  assert.equal(groups.length, 2, 'gamma drops out (no match)');
  assert.deepEqual(ids(groups), ['p1', 'p2'], 'L1 first, then L2');
  assert.equal(groups[0].matchLevel, M.MATCH_LEVEL_PROJECT_AND_SESSION, 'L1 level');
  assert.equal(groups[1].matchLevel, M.MATCH_LEVEL_SESSION, 'L2 level');
}

{
  // Inbox sessions can match by session name (L2) even though the group has
  // no project name to match. Project name must not match the query, else it
  // appears as a separate L3 group.
  const projects = [project('p1', 'Gamma')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'other', sortTime: 100 }),
    session('s2', { projectId: '', name: 'alpha task', sortTime: 900 }),
  ];
  const groups = M.searchProjectView({ projects, sessions, query: 'alpha', getSortTime });
  assert.equal(groups.length, 1, 'inbox match present');
  assert.equal(groups[0].inbox, true, 'inbox group');
  assert.equal(groups[0].matchLevel, M.MATCH_LEVEL_SESSION, 'inbox reaches only L2');
  assert.deepEqual(previewIds(groups[0]), ['s2'], 'matched inbox session shown');
}

{
  // Search by description also matches (same recall semantics as the session
  // search used by the main list).
  const projects = [project('p1', 'Alpha')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'cleanup', description: 'dedupe the export rows', sortTime: 100 }),
  ];
  const groups = M.searchProjectView({ projects, sessions, query: 'dedupe', getSortTime });
  assert.equal(groups.length, 1, 'description match surfaces the group');
  assert.deepEqual(previewIds(groups[0]), ['s1'], 'matched session shown');
}

{
  // Empty query falls back to the plain overview (inbox last, preview caps).
  const projects = [project('p1', 'Alpha')];
  const sessions = [
    session('s1', { projectId: 'p1', name: 'one', sortTime: 100 }),
    session('s2', { projectId: '', name: 'orphan', sortTime: 999 }),
  ];
  const groups = M.searchProjectView({ projects, sessions, query: '  ', getSortTime });
  assert.deepEqual(ids(groups), ['p1', '(inbox)'], 'blank query behaves as overview');
}

// ---- sessionsOfProject ----

{
  const sessions = [
    session('s1', { projectId: 'p1' }),
    session('s2', { projectId: 'p1' }),
    session('s3', { projectId: 'p2' }),
    session('s4', { projectId: '' }),
  ];
  const filtered = M.sessionsOfProject({ sessions, projectId: 'p1' });
  assert.deepEqual(filtered.map((s) => s.id), ['s1', 's2'], 'filters by projectId');
  assert.equal(M.sessionsOfProject({ sessions, projectId: '' }).length, 1, 'empty key selects the inbox');
}

{
  // Cross-project regression: sessions of another project are not pulled into
  // the browsed project's second level (and vice versa).
  const sessions = [
    session('s1', { projectId: 'p1' }),
    session('s2', { projectId: 'p2' }),
  ];
  assert.deepEqual(
    M.sessionsOfProject({ sessions, projectId: 'p2' }).map((s) => s.id),
    ['s2'],
    'browsing p2 shows only p2 sessions',
  );
}

{
  // Folder fallback: an unbounded session whose folder belongs to a project's
  // rootPath surfaces under that project instead of the inbox (mirrors the
  // backend listSessions contract used by unbounded sessions).
  const projects = [
    project('p1', 'Alpha', '/srv/ragent-promoted'),
    project('p2', 'Beta', '/home/example'),
  ];
  const sessions = [
    session('s1', { projectId: 'p1' }),
    session('s2', { folder: '/srv/ragent-promoted', sortTime: 100 }),   // unbounded, p1 root
    session('s3', { folder: '/home/example', sortTime: 200 }),              // unbounded, p2 root
    session('s4', { folder: '/var/lib/ragent/workspace', sortTime: 50 }), // no project root -> inbox
  ];
  const groups = M.buildProjectOverview({ projects, sessions, getSortTime });
  assert.deepEqual(ids(groups), ['p2', 'p1', '(inbox)'], 'unbounded sessions group under their folder project');
  assert.deepEqual(previewIds(groups[1]), ['s2', 's1'], 'p1 preview includes the folder-matched session');
  assert.deepEqual(
    M.sessionsOfProject({ sessions, projectId: 'p1', projects }).map((s) => s.id),
    ['s1', 's2'],
    'L2 for p1 includes folder-matched unbounded sessions',
  );
  assert.deepEqual(
    M.sessionsOfProject({ sessions, projectId: 'p2', projects }).map((s) => s.id),
    ['s3'],
    'L2 for p2 includes its folder-matched unbounded session',
  );
  assert.deepEqual(
    M.sessionsOfProject({ sessions, projectId: '', projects }).map((s) => s.id),
    ['s4'],
    'only truly orphan sessions reach the inbox',
  );
}

console.log('test-project-overview: ok');

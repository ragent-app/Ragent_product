#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);

function option(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`usage: node capture-fixtures.mjs [--target all|mobile|sidebar|activity|livebar|sessionlist|regenerate|sendstates] [--repo <root>] [--output <dir>]

Runs the synthetic visual fixtures against the real CSS, writes screenshots plus
a manifest.json under the output directory.

  --target   which fixture set to run (default: all)
  --repo     repo root; fixture scripts resolve relative to it. Run from the repo
             root or pass this explicitly — running from skills/.../scripts
             without it resolves tests/ against the wrong directory.
  --output   screenshot output directory (default: a timestamped dir under
             /var/lib/ragent/workspace/visual-ui-reviews)`);
  process.exit(0);
}

const target = option('--target', 'all');
const allowedTargets = new Set(['all', 'sidebar', 'activity', 'livebar', 'sessionlist', 'regenerate', 'sendstates', 'mobile']);
if (!allowedTargets.has(target)) {
  console.error(`Unknown target: ${target}. Expected all, mobile, sidebar, activity, livebar, sessionlist, regenerate, or sendstates.`);
  process.exit(2);
}

const repoRoot = resolve(option('--repo', process.cwd()));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputRoot = resolve(option(
  '--output',
  join('/var/lib/ragent/workspace/visual-ui-reviews', stamp),
));
mkdirSync(outputRoot, { recursive: true });

const visualCases = {
  sidebar: {
    script: 'tests/test-chat-sidebar-navigation-visual.mjs',
    outputDir: 'sidebar',
  },
  activity: {
    script: 'tests/test-chat-live-activity-visual.mjs',
    outputDir: 'activity',
  },
  livebar: {
    script: 'tests/test-chat-live-bar-states-visual.mjs',
    outputDir: 'livebar',
  },
  sessionlist: {
    script: 'tests/test-chat-session-list-indicators-visual.mjs',
    outputDir: 'sessionlist',
  },
  regenerate: {
    script: 'tests/test-chat-regenerate-visual.mjs',
    outputDir: 'regenerate',
  },
  sendstates: {
    script: 'tests/test-chat-send-states-visual.mjs',
    outputDir: 'sendstates',
  },
};

const mobileChecks = [
  'tests/test-chat-mobile-unified-surfaces.mjs',
  'tests/test-message-viewport-browser.mjs',
  'tests/test-chat-mobile-decision-sheet.mjs',
  'tests/test-chat-mobile-composer-config-sheet.mjs',
  'tests/test-chat-composer-menu-portal.mjs',
  'tests/test-mobile-sidebar-search-layout.mjs',
  'tests/test-right-sidebar-mobile-back.mjs',
  'tests/test-workspace-file-reader-mobile-layout.mjs',
  'tests/test-chat-scroll-to-bottom-fab-visual.mjs',
  'tests/test-chat-send-failed-retry-visual.mjs',
];

const selectedVisuals = target === 'all' || target === 'mobile'
  ? ['sidebar', 'activity', 'livebar', 'sessionlist', 'regenerate', 'sendstates']
  : [target];
const selectedChecks = target === 'all' || target === 'mobile' ? mobileChecks : [];
const results = [];

function runScript(script, extraEnv = {}) {
  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = {
    script,
    startedAt,
    status: run.status,
    stdout: String(run.stdout || '').trim(),
    stderr: String(run.stderr || '').trim(),
  };
  results.push(result);
  const label = run.status === 0 ? 'ok' : 'failed';
  console.log(`${label}: ${script}`);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  return run.status === 0;
}

let ok = true;
for (const name of selectedVisuals) {
  const visualCase = visualCases[name];
  const screenshotDir = join(outputRoot, visualCase.outputDir);
  mkdirSync(screenshotDir, { recursive: true });
  ok = runScript(visualCase.script, { RAGENT_VISUAL_OUTPUT_DIR: screenshotDir }) && ok;
}

for (const script of selectedChecks) {
  ok = runScript(script) && ok;
}

function collectPngs(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectPngs(path));
    else if (entry.isFile() && entry.name.endsWith('.png')) {
      files.push({ path, bytes: statSync(path).size });
    }
  }
  return files;
}

const manifest = {
  createdAt: new Date().toISOString(),
  repoRoot,
  target,
  ok,
  screenshots: collectPngs(outputRoot),
  results,
};
writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`review output: ${outputRoot}`);
console.log(`screenshots: ${manifest.screenshots.length}`);
process.exit(ok ? 0 : 1);

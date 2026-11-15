import assert from 'assert/strict';
import { homedir, tmpdir } from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  collectGeneratedResultFilesFromRun,
  collectResultFileSearchRoots,
  collectUnresolvedAssistantFileReferences,
  looksLikeResultFilePath,
  resolveResultFileWorkspaceRoots,
  stripAssistantArtifactDeliveryHints,
} from '../chat/session-result-files.mjs';

assert.equal(looksLikeResultFilePath('/subscribe/calendar'), false, 'product-local helper paths should not be treated as result files');
assert.equal(looksLikeResultFilePath('/subscribe/calendar?format=https'), false, 'product-local helper paths with query strings should not be treated as result files');
assert.equal(looksLikeResultFilePath('/root/report.xlsx'), true, 'real local file paths should still be detected');

assert.deepEqual(
  collectResultFileSearchRoots({
    folder: '/workspace/project',
    developerInstructions: 'Use the local render-review workflow under ~/code/render-review.',
  }).slice(-2),
  [`${homedir()}/code/render-review`, '/workspace/project'],
  'result-file discovery should consider paths from runtime developer instructions',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('点这里：[点击订阅日历](/subscribe/calendar)。'),
  '点这里：[点击订阅日历](/subscribe/calendar)。',
  'product-local markdown links should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('手动入口：[使用 HTTPS 订阅](/subscribe/calendar?format=https)。'),
  '手动入口：[使用 HTTPS 订阅](/subscribe/calendar?format=https)。',
  'product-local markdown links with query strings should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('下载：[report.xlsx](/root/report.xlsx)。'),
  '下载：/root/report.xlsx。',
  'real local result-file links without a matched asset should display the original path',
);

// ── collectUnresolvedAssistantFileReferences ─────────────────────────

async function unresolvedAssistantFixture() {
  const work = mkdtempSync(join(tmpdir(), 'ragent-result-files-'));
  writeFileSync(join(work, 'chart.png'), 'fake-png-bytes');
  const manifest = { folder: work };
  const events = [
    {
      type: 'message',
      role: 'assistant',
      seq: 1,
      content: `![chart](chart.png)\n\nArtifacts:\n- chart.png`,
    },
    {
      type: 'message',
      role: 'assistant',
      seq: 2,
      content: `![missing](missing.png)\n\nArtifacts:\n- missing.png`,
    },
    {
      type: 'message',
      role: 'assistant',
      seq: 3,
      content: `![chart](chart.png) 且 [report](../outside-report.pdf)`,
    },
  ];
  const failures = await collectUnresolvedAssistantFileReferences(manifest, events);
  rmSync(work, { recursive: true, force: true });
  return failures;
}

{
  const failures = await unresolvedAssistantFixture();
  const candidates = failures.map((failure) => failure.candidate);
  assert.ok(candidates.includes('missing.png'), 'missing referenced image should be reported as unresolved');
  assert.ok(!candidates.includes('chart.png'), 'existing referenced image should not be reported as unresolved');
  assert.equal(failures.filter((failure) => failure.candidate === 'missing.png').length, 1, 'duplicate unresolved references should be deduped');
  assert.ok(candidates.includes('../outside-report.pdf'), 'unresolvable markdown links should be reported');
}

// ── workspace-anchored relative references (user-reported shape) ──────
//
// An agent reports bullet code-span paths like `./n2_4c_results/x.md` relative
// to the run workspace. Cards must resolve by joining the workspace root, even
// when manifest.folder is empty and the harness emits a non-`bash` command
// tool name.

function makeWorkspaceFile(work, relativePath, contents = 'fake-bytes') {
  const filePath = join(work, relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, contents);
}

// executionScope.cwd.realPath anchors relative references on new manifests
// even with no legacy folder, and Claude-style `Bash` tool_use (JSON-serialized
// input) must not block collection.
{
  const work = mkdtempSync(join(tmpdir(), 'ragent-rf-scope-'));
  try {
    makeWorkspaceFile(work, 'n2_4c_results/n2_4c_final_report.md');
    makeWorkspaceFile(work, 'n2_4c_results/n2_4c_reproducibility_report.json');
    makeWorkspaceFile(work, 'n2_4c_phenotype_runs/b4_05/launch.log');
    const manifest = { folder: '', executionScope: { cwd: { realPath: work } } };
    const events = [
      {
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'ls n2_4c_results', description: 'list outputs' }),
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          '- `./n2_4c_results/n2_4c_final_report.md`',
          '- `./n2_4c_results/n2_4c_reproducibility_report.json`',
          '- `./n2_4c_phenotype_runs/b4_05/launch.log`',
        ].join('\n'),
      },
    ];

    assert.deepEqual(
      resolveResultFileWorkspaceRoots(manifest, events),
      [work],
      'executionScope cwd should be the primary workspace anchor',
    );

    const files = await collectGeneratedResultFilesFromRun({}, manifest, events);
    const names = files.map((file) => file.originalName).sort();
    assert.deepEqual(
      names,
      ['launch.log', 'n2_4c_final_report.md', 'n2_4c_reproducibility_report.json'],
      'workspace-relative bullet references should all resolve to published files',
    );
    assert.ok(files.every((file) => file.localPath.startsWith(`${work}/`)), 'resolved files must live under the run workspace');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Codex-style commandExecution events anchor via the surfaced cwd, and
// capitalized external-harness command names (`Shell`) still unlock cd-root
// discovery — previously only a literal lowercase `bash` matched.
{
  const base = mkdtempSync(join(tmpdir(), 'ragent-rf-base-'));
  const out = mkdtempSync(join(tmpdir(), 'ragent-rf-out-'));
  try {
    makeWorkspaceFile(out, 'report.md', '# report');
    const manifest = { folder: '', executionScope: { cwd: { realPath: base } } };
    const events = [
      {
        type: 'tool_use',
        toolName: 'Shell',
        toolInput: `cd ${out} && ./render.sh`,
        cwd: out,
      },
      { type: 'message', role: 'assistant', content: 'Saved to `./report.md`.' },
    ];

    const files = await collectGeneratedResultFilesFromRun({}, manifest, events);
    assert.deepEqual(
      files.map((file) => file.localPath),
      [join(out, 'report.md')],
      'cd-target and command cwd anchors should resolve files outside the session folder',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

// file_change events anchor the directory the harness actually wrote into.
{
  const base = mkdtempSync(join(tmpdir(), 'ragent-rf-edit-'));
  const edited = mkdtempSync(join(tmpdir(), 'ragent-rf-edited-'));
  try {
    makeWorkspaceFile(edited, 'generated/out.csv', 'a,b\n1,2\n');
    const manifest = { folder: base };
    const events = [
      {
        type: 'file_change',
        filePath: join(edited, 'generated/out.csv'),
        changeType: 'write',
      },
      { type: 'message', role: 'assistant', content: 'Wrote `out.csv`.' },
    ];

    const files = await collectGeneratedResultFilesFromRun({}, manifest, events);
    assert.deepEqual(
      files.map((file) => file.localPath),
      [join(edited, 'generated/out.csv')],
      'file_change paths should anchor resolution at the edited directory',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(edited, { recursive: true, force: true });
  }
}

console.log('test-session-result-files: ok');

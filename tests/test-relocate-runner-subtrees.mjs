#!/usr/bin/env node
// P0-C migration helper regression tests.
//
// The relocation logic is the riskiest part of the P0-C production layout
// change (it moves live run spools and provider credentials between
// directories), so it must be provable on a temp tree: fresh relocation,
// idempotency, dry-run, partial migration, and the "no-op when env matches
// legacy" guard.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { relocateSubtree, resolveSubtreePairs } from '../scripts/relocate-runner-subtrees.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function writeTree(base, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(base, rel);
    if (typeof content === 'string') {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    } else if (content === null) {
      await mkdir(full, { recursive: true });
    }
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'ragent-relocate-'));
  try {
    // ── 1) no pair when the env target equals the legacy location ──────────
    {
      const configDir = join(root, 'config');
      const pairs = resolveSubtreePairs({
        env: {
          RAGENT_RUN_SPOOL_DIR: join(configDir, 'chat-runs'),
          RAGENT_PROVIDER_HOMES_DIR: join(configDir, 'provider-runtime-homes'),
        },
        configDir,
      });
      assert.equal(pairs.length, 0, 'identical env targets must produce no relocation');
    }

    // ── 2) fresh relocation: move contents, create target, drop empty legacy ──
    {
      const configDir = join(root, 'c2');
      const target = join(root, 'results');
      await writeTree(configDir, {
        'chat-runs/run_aaa/spool.jsonl': 'line\n',
        'chat-runs/run_aaa/status.json': '{}',
        'chat-runs/run_bbb/result.json': '{}',
      });
      const result = await relocateSubtree(
        { kind: 'spool', legacy: join(configDir, 'chat-runs'), target },
        { dryRun: false },
      );
      assert.equal(result.created, true, 'target dir must be created');
      assert.equal(result.moved, 2, 'two top-level run dirs must move');
      assert.equal(result.removedLegacy, true, 'emptied legacy dir must be removed');
      assert.deepEqual(
        (await readdir(target)).sort(),
        ['run_aaa', 'run_bbb'],
        'run dirs must land in the target',
      );
      assert.equal(
        await (async () => {
          try { await readdir(join(configDir, 'chat-runs')); return true; } catch { return false; }
        })(),
        false,
        'legacy spool dir must be gone after full relocation',
      );

      const providerLegacy = join(configDir, 'provider-runtime-homes');
      const providerTarget = join(root, 'provider-homes');
      await writeTree(providerLegacy, {
        'codex/auth.json': '{}\n',
        'codex/config.toml': 'model = "test"\n',
      });
      await chmod(join(providerLegacy, 'codex'), 0o700);
      await chmod(join(providerLegacy, 'codex/auth.json'), 0o600);
      const owner = process.getuid?.() ?? null;
      const group = process.getgid?.() ?? null;
      await relocateSubtree(
        { kind: 'providerHomes', legacy: providerLegacy, target: providerTarget },
        { ownerUid: owner, ownerGid: group },
      );
      assert.equal((await stat(join(providerTarget, 'codex'))).mode & 0o777, 0o770);
      assert.equal((await stat(join(providerTarget, 'codex/auth.json'))).mode & 0o777, 0o640);
    }

    // ── 3) idempotent: populated target is never overwritten ───────────────
    {
      const configDir = join(root, 'c3');
      const target = join(root, 'results3');
      await writeTree(configDir, { 'chat-runs/run_x/spool.jsonl': 'x\n' });
      await writeTree(target, { 'run_x/spool.jsonl': 'kept\n' });
      const result = await relocateSubtree(
        { kind: 'spool', legacy: join(configDir, 'chat-runs'), target },
        { dryRun: false },
      );
      assert.equal(result.moved, 0, 'existing target content must be left untouched');
      assert.equal(
        await (async () => {
          try { const t = await readdir(join(target, 'run_x')); return t.join(','); } catch { return ''; }
        })(),
        'spool.jsonl',
      );
    }

    // ── 4) dry-run reports but changes nothing ─────────────────────────────
    {
      const configDir = join(root, 'c4');
      const target = join(root, 'results4');
      await writeTree(configDir, { 'chat-runs/run_a/spool.jsonl': 'a\n' });
      const logged = [];
      const result = await relocateSubtree(
        { kind: 'spool', legacy: join(configDir, 'chat-runs'), target },
        { dryRun: true, log: (line) => logged.push(line) },
      );
      assert.equal(result.moved, 1, 'dry-run still counts what would move');
      assert.equal(result.created, true, 'dry-run reports the create');
      assert.equal(
        await (async () => {
          try { await readdir(join(configDir, 'chat-runs')); return true; } catch { return false; }
        })(),
        true,
        'dry-run must not remove the legacy dir',
      );
      assert.equal(logged.some((line) => line.includes('move ')), true, 'dry-run must log moves');
    }

    // ── 5) partial migration moves only the missing entries ────────────────
    {
      const configDir = join(root, 'c5');
      const target = join(root, 'results5');
      await writeTree(configDir, {
        'chat-runs/run_1/spool.jsonl': '1\n',
        'chat-runs/run_2/spool.jsonl': '2\n',
      });
      await writeTree(target, { 'run_1/spool.jsonl': 'already\n' });
      const result = await relocateSubtree(
        { kind: 'spool', legacy: join(configDir, 'chat-runs'), target },
        { dryRun: false },
      );
      assert.equal(result.moved, 1, 'only the missing entry must move');
      assert.deepEqual((await readdir(target)).sort(), ['run_1', 'run_2']);
      // Re-run is a no-op.
      const again = await relocateSubtree(
        { kind: 'spool', legacy: join(configDir, 'chat-runs'), target },
        { dryRun: false },
      );
      assert.equal(again.moved, 0, 're-run must move nothing');
    }

    // ── 6) env pair resolution picks only non-legacy targets ───────────────
    {
      const configDir = join(root, 'c6');
      const pairs = resolveSubtreePairs({
        env: {
          RAGENT_RUN_SPOOL_DIR: '/var/lib/ragent-run/results',
          RAGENT_PROVIDER_HOMES_DIR: join(configDir, 'provider-runtime-homes'),
        },
        configDir,
      });
      assert.equal(pairs.length, 1, 'only the spool differs from legacy');
      assert.equal(pairs[0].kind, 'spool');
      assert.equal(pairs[0].target, '/var/lib/ragent-run/results');
    }

    console.log('test-relocate-runner-subtrees: ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { CHAT_COLLABORATIONS_DIR, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import {
  bindAttemptRun,
  claimTaskAttempt,
  completeAttempt,
  createCollaborationRecord,
  markReadyTasks,
} from './collaboration-store.mjs';
import {
  captureFactoryBaseline,
  preflightFactoryWorkspace,
  sealFactoryCandidate,
  verifyFactoryCandidate,
} from './factory-candidates.mjs';
import {
  executeFactoryCommand,
  getFactoryWorkItem,
  updateFactoryBinding,
} from './factory-control.mjs';
import { factoryTargetBranch, factoryTargetHead } from './factory-integration.mjs';
import { createStagingWorkspace, discardStaging, resolveStagingDiff } from './managed-writer.mjs';
import { postBoardMessage } from './organization-board-store.mjs';
import { getBudgetCounter } from './organization-governor.mjs';
import { invalidateOrganizationProjectionCache } from './organization-projection-cache.mjs';
import { withOrganizationDatabase } from './organization-store.mjs';
import {
  SWARM_MEMBER_BUSY,
  SWARM_MEMBER_KILLED,
  SWARM_WORKSPACE_UNMERGED_CHANGES,
  inspectWorkspaceUnmergedChanges,
  markSwarmDone,
  spawnSwarmMembers,
} from './organization-swarm.mjs';
import { createExecutionPacket, getResultPacket } from './result-packets.mjs';
import { getRun, getRunAcceptanceEvidence, isTerminalRunState } from './runs.mjs';
import { event as recordFactoryEvent, encode, factoryTransaction, now as workNow } from './work-graph-store.mjs';

const execFileAsync = promisify(execFile);

export const SWARM_PROMOTE_REQUIRES_ISOLATED_WORKSPACE = 'SWARM_PROMOTE_REQUIRES_ISOLATED_WORKSPACE';
export const SWARM_PROMOTE_RUN_REQUIRED = 'SWARM_PROMOTE_RUN_REQUIRED';
export const SWARM_WORKSPACE_EMPTY_DIFF = 'SWARM_WORKSPACE_EMPTY_DIFF';
export const SWARM_WORK_ITEM_SCOPE_EXCEEDED = 'SWARM_WORK_ITEM_SCOPE_EXCEEDED';
export const SWARM_CHILDREN_STILL_ACTIVE = 'SWARM_CHILDREN_STILL_ACTIVE';

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.cache', 'build', 'dist']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function bridgeError(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function ownerActor(actor = null, fallbackId = 'owner') {
  if (actor && actor.kind === 'user' && actor.role === 'owner' && trimString(actor.principalId)) {
    return actor;
  }
  return {
    kind: 'user',
    role: 'owner',
    principalId: trimString(actor?.principalId) || trimString(fallbackId) || 'owner',
  };
}

function splitDepsAndOptions(firstArg, secondArg) {
  if (secondArg && typeof secondArg === 'object') {
    return { deps: firstArg && typeof firstArg === 'object' ? firstArg : {}, options: secondArg };
  }
  return { deps: {}, options: firstArg && typeof firstArg === 'object' ? firstArg : {} };
}

function normalizeRelativeScopePath(rawPath) {
  const clean = trimString(rawPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean || clean === '.' || clean.includes('\0') || isAbsolute(rawPath || '') || /^[A-Za-z]:/.test(rawPath || '')) {
    throw bridgeError('SWARM_WORK_ITEM_SCOPE_EXCEEDED', `Invalid relative path "${rawPath}"`, 400);
  }
  const parts = clean.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw bridgeError('SWARM_WORK_ITEM_SCOPE_EXCEEDED', `Path escapes workspace scope: "${rawPath}"`, 400);
  }
  if (parts.some((p) => EXCLUDED_NAMES.has(p.toLowerCase()))) {
    throw bridgeError('SWARM_WORK_ITEM_SCOPE_EXCEEDED', `Path enters excluded directory: "${rawPath}"`, 400);
  }
  return clean;
}

function pathWithinAllowed(candidatePath, allowedPaths = []) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return true;
  const candidate = normalizeRelativeScopePath(candidatePath);
  return allowedPaths.some((rawRoot) => {
    const root = normalizeRelativeScopePath(rawRoot);
    return candidate === root || candidate.startsWith(`${root}/`);
  });
}

async function resolveExistingAncestor(candidatePath) {
  let current = resolve(candidatePath);
  const tail = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        const parent = dirname(current);
        if (parent === current) throw error;
        tail.push(basename(current));
        current = parent;
        continue;
      }
      throw error;
    }
  }
}

function pathIsInsideRealRoot(realRoot, realCandidate) {
  const rel = relative(realRoot, realCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function normalizePromotionScopePath(rawPath, realCanonicalCwd) {
  const raw = trimString(rawPath);
  if (!raw || raw.includes('\0')) {
    throw bridgeError(SWARM_WORK_ITEM_SCOPE_EXCEEDED, `Invalid writable path "${rawPath}"`, 400);
  }
  if (!isAbsolute(raw) && !/^[A-Za-z]:/.test(raw)) {
    return normalizeRelativeScopePath(raw);
  }
  const realCandidate = await resolveExistingAncestor(resolve(raw)).catch(() => null);
  if (!realCandidate || !pathIsInsideRealRoot(realCanonicalCwd, realCandidate)) {
    throw bridgeError(SWARM_WORK_ITEM_SCOPE_EXCEEDED, `Writable path "${rawPath}" escapes project root`, 403);
  }
  const rel = relative(realCanonicalCwd, realCandidate).replace(/\\/g, '/');
  return normalizeRelativeScopePath(rel);
}

async function resolveStartWorkItemWritablePaths(rawPaths = [], rawProjectRoot = '', coordWritablePaths = []) {
  const rawList = Array.isArray(rawPaths) ? rawPaths.map(trimString).filter(Boolean) : [];
  if (rawList.length === 0) return [];
  const rootCandidate = trimString(rawProjectRoot);
  if (!rootCandidate) {
    throw bridgeError(SWARM_WORK_ITEM_SCOPE_EXCEEDED, 'Verified projectRoot is required to resolve Work Item paths', 403);
  }
  const realRoot = await realpath(rootCandidate).catch(() => null);
  if (!realRoot) {
    throw bridgeError(SWARM_WORK_ITEM_SCOPE_EXCEEDED, `Verified projectRoot is unavailable: ${rootCandidate}`, 403);
  }
  const parentList = Array.isArray(coordWritablePaths) ? coordWritablePaths.map(trimString).filter(Boolean) : [];
  const absParents = parentList.filter((p) => isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p));
  const hasOnlyRelativeParents = parentList.length > 0 && absParents.length === 0;

  let emitPrefix = realRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const parentEntry of absParents) {
    const realParent = await realpath(parentEntry).catch(() => null);
    if (realParent && sameResolvedPath(realParent, realRoot)) {
      emitPrefix = parentEntry.replace(/\\/g, '/').replace(/\/+$/, '');
      break;
    }
  }

  const resolved = [];
  for (const entry of rawList) {
    const rel = normalizeRelativeScopePath(entry);
    const candidateAbs = resolve(realRoot, ...rel.split('/'));
    const realCandidate = await resolveExistingAncestor(candidateAbs).catch(() => null);
    if (!realCandidate || !pathIsInsideRealRoot(realRoot, realCandidate)) {
      throw bridgeError(
        SWARM_WORK_ITEM_SCOPE_EXCEEDED,
        `Path "${entry}" escapes verified projectRoot`,
        403,
      );
    }
    resolved.push(hasOnlyRelativeParents ? rel : `${emitPrefix}/${rel}`);
  }
  return [...new Set(resolved)];
}

async function listTreeFiles(dir, basePrefix = '') {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = basePrefix ? posix.join(basePrefix, entry.name) : entry.name;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw bridgeError('FACTORY_CANDIDATE_INVALID', `Symlinks are forbidden in isolated workspace: ${rel}`, 409);
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_NAMES.has(entry.name.toLowerCase())) continue;
      out.push(...await listTreeFiles(full, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function parsePorcelainPaths(stdout = '') {
  const entries = [];
  const tokens = String(stdout || '').split('\0').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const rec = tokens[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const p1 = rec.slice(3).replace(/\\/g, '/');
    if (p1) entries.push(p1);
    if (status[0] === 'R' || status[0] === 'C') {
      const p2 = tokens[i + 1];
      if (p2) entries.push(p2.replace(/\\/g, '/'));
      i += 1;
    }
  }
  return entries;
}

async function discoverIsolatedChangedPaths({ workspaceMode, workspacePath, canonicalCwd, baseRef, execFn }) {
  if (workspaceMode === 'worktree') {
    const paths = new Set();
    const statusRes = await execFn('git', ['-C', workspacePath, 'status', '--porcelain', '-z', '-uall'], {
      cwd: workspacePath,
      maxBuffer: 2 * 1024 * 1024,
    });
    for (const p of parsePorcelainPaths(statusRes.stdout)) paths.add(p);

    const ref = trimString(baseRef) || 'HEAD';
    try {
      const committedRes = await execFn('git', ['-C', workspacePath, 'diff', '--name-only', '-z', `${ref}..HEAD`], {
        cwd: workspacePath,
        maxBuffer: 2 * 1024 * 1024,
      });
      for (const p of String(committedRes.stdout || '').split('\0').filter(Boolean)) {
        paths.add(p.replace(/\\/g, '/'));
      }
    } catch {}

    return [...paths].map(normalizeRelativeScopePath).sort();
  }

  // staging mode: discover files in stagingDir OR resolved diff against canonicalCwd
  const stagingFiles = await listTreeFiles(workspacePath);
  if (stagingFiles.length > 0) {
    const changed = [];
    for (const rel of stagingFiles) {
      const norm = normalizeRelativeScopePath(rel);
      const stFile = join(workspacePath, ...norm.split('/'));
      const canFile = join(canonicalCwd, ...norm.split('/'));
      const [stBytes, canBytes] = await Promise.all([
        readFile(stFile),
        readFile(canFile).catch(() => null),
      ]);
      const stHash = createHash('sha256').update(stBytes).digest('hex');
      const canHash = canBytes ? createHash('sha256').update(canBytes).digest('hex') : '';
      if (stHash !== canHash) changed.push(norm);
    }
    if (changed.length > 0) return changed.sort();
  }
  const diff = await resolveStagingDiff({ stagingDir: workspacePath, canonicalCwd, writablePaths: stagingFiles.length ? stagingFiles : [] }).catch(() => []);
  return [...new Set((Array.isArray(diff) ? diff : []).map((d) => normalizeRelativeScopePath(d.path || String(d))))].sort();
}

async function syncPathsIntoPromotionStaging({ sourceWorkspaceDir, stagingDir, canonicalCwd, writablePaths }) {
  const realSourceRoot = await realpath(sourceWorkspaceDir);
  const realStagingRoot = await realpath(stagingDir);
  const realCanonicalRoot = await realpath(canonicalCwd);

  for (const relScope of writablePaths) {
    const scopeParts = relScope.split('/');
    const srcTarget = join(realSourceRoot, ...scopeParts);
    const stgTarget = join(realStagingRoot, ...scopeParts);
    const canTarget = join(realCanonicalRoot, ...scopeParts);

    // Clear destination subtree first so deletions are represented accurately.
    await rm(stgTarget, { recursive: true, force: true });

    const srcStat = await lstat(srcTarget).catch((e) => (e?.code === 'ENOENT' ? null : Promise.reject(e)));
    if (!srcStat) {
      // File or subtree deleted in isolated workspace; leaving it removed from stagingDir records a delete!
      continue;
    }
    if (srcStat.isSymbolicLink()) {
      throw bridgeError('FACTORY_CANDIDATE_INVALID', `Symlinks are forbidden: ${relScope}`, 409);
    }
    const resolvedSrc = await realpath(srcTarget);
    const relFromSrc = relative(realSourceRoot, resolvedSrc);
    if (relFromSrc === '..' || relFromSrc.startsWith(`..${sep}`) || isAbsolute(relFromSrc)) {
      throw bridgeError('FACTORY_CANDIDATE_INVALID', `Source path escapes isolated workspace: ${relScope}`, 409);
    }

    if (srcStat.isFile()) {
      await mkdir(dirname(stgTarget), { recursive: true });
      await copyFile(resolvedSrc, stgTarget);
    } else if (srcStat.isDirectory()) {
      const subFiles = await listTreeFiles(resolvedSrc);
      for (const subRel of subFiles) {
        const subSrc = join(resolvedSrc, ...subRel.split('/'));
        const subDst = join(stgTarget, ...subRel.split('/'));
        await mkdir(dirname(subDst), { recursive: true });
        await copyFile(subSrc, subDst);
      }
    }
    void canTarget;
  }
}

async function ensureOrganizationHasProject(organizationId, fallbackProjectId = '') {
  return withOrganizationDatabase((conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
    if (!orgRow) throw bridgeError('ORGANIZATION_NOT_FOUND', `Organization ${organizationId} not found`, 404);
    const resolvedProjectId = trimString(orgRow.project_id) || trimString(fallbackProjectId) || `swarm_${organizationId}`;
    if (!trimString(orgRow.project_id)) {
      conn.prepare('UPDATE organizations SET project_id = ?, updated_at = ? WHERE id = ?')
        .run(resolvedProjectId, new Date().toISOString(), organizationId);
    }
    return { orgRow: { ...orgRow, project_id: resolvedProjectId }, projectId: resolvedProjectId };
  }, { mutate: true });
}

export async function validateWorkItemSpawnBoundary(conn, {
  organizationId,
  parentWorkItemId = '',
  writablePaths = [],
  requestedCount = 1,
}) {
  const workItemId = trimString(parentWorkItemId);
  if (!workItemId) return null;
  const itemRow = conn.prepare('SELECT * FROM factory_work_items WHERE id = ? AND organization_id = ?').get(workItemId, organizationId);
  if (!itemRow) {
    throw bridgeError('FACTORY_NOT_FOUND', `Parent Work Item ${workItemId} not found in organization`, 404);
  }
  if (['completed', 'cancelled'].includes(itemRow.state) || itemRow.ownership !== 'active' || itemRow.control_state !== 'none') {
    throw bridgeError('FACTORY_CONFLICT', `Parent Work Item ${workItemId} is not open for bounded Swarm work (${itemRow.state})`, 409);
  }
  const contractRow = conn.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id = ? AND revision = ?')
    .get(workItemId, itemRow.contract_revision);
  const contract = parseJson(contractRow?.contract_json, {});
  const allowedPaths = Array.isArray(contract?.allowedPaths) ? contract.allowedPaths : [];
  if (allowedPaths.length > 0 && Array.isArray(writablePaths)) {
    for (const p of writablePaths) {
      if (!pathWithinAllowed(p, allowedPaths)) {
        throw bridgeError(
          SWARM_WORK_ITEM_SCOPE_EXCEEDED,
          `Requested writable path "${p}" is outside Work Item ${workItemId} allowedPaths (${allowedPaths.join(', ')})`,
          403,
        );
      }
    }
  }
  const budget = contract?.budget || {};
  if (Number.isInteger(budget.maxTotalAgents) || Number.isInteger(budget.maxAgents)) {
    const maxAgents = Number(budget.maxTotalAgents ?? budget.maxAgents);
    const existingChildren = conn.prepare(`
      SELECT grant_json FROM organization_nodes
      WHERE organization_id = ? AND lifecycle_mode = 'ephemeral_swarm' AND lifecycle_state = 'active' AND retired_revision IS NULL
    `).all(organizationId).filter((r) => {
      const g = parseJson(r.grant_json, {});
      return trimString(g?.parentWorkItemId || g?.workItemId) === workItemId;
    });
    if (existingChildren.length + Number(requestedCount || 1) > maxAgents) {
      throw bridgeError(
        'ORG_BUDGET_EXCEEDED',
        `Work Item ${workItemId} child Swarm agent budget exhausted (${existingChildren.length}/${maxAgents})`,
        409,
      );
    }
  }
  return { workItemRow: itemRow, contract, allowedPaths };
}

export async function promoteSwarmWorkspaceToCandidate(firstArg, secondArg) {
  const { deps, options } = splitDepsAndOptions(firstArg, secondArg);
  const {
    organizationId,
    targetNameOrNodeId = '',
    targetNodeId = '',
    actorNodeId = '',
    goalId = '',
    workItemId = '',
    title = '',
    objective = '',
    criterionId = 'manual_review',
    criterionTitle = 'Verified isolated Swarm workspace deliverable',
    writablePaths: explicitWritablePaths = null,
    targetBranch: requestedTargetBranch = '',
    runId: explicitRunId = '',
    summary = '',
    projectRoot: explicitProjectRoot = '',
    postToBoard = true,
    idempotencyKey = '',
    actor: rawActor = null,
  } = options;

  const normalizedOrgId = trimString(organizationId);
  const targetQuery = trimString(targetNameOrNodeId || targetNodeId);
  if (!normalizedOrgId || !targetQuery) {
    throw bridgeError('BAD_REQUEST', 'organizationId and targetNameOrNodeId are required', 400);
  }

  // 1. Validate org, actor authorization, and member isolated workspace state.
  const lookup = await withOrganizationDatabase((conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw bridgeError('ORGANIZATION_NOT_FOUND', `Organization ${normalizedOrgId} not found`, 404);
    if (['archived', 'lifecycle_pending'].includes(orgRow.state)) {
      throw bridgeError('ORG_ARCHIVED', `Organization ${normalizedOrgId} is ${orgRow.state}`, 409);
    }
    if (trimString(actorNodeId)) {
      const actorNode = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?')
        .get(trimString(actorNodeId), normalizedOrgId);
      const role = trimString(actorNode?.node_role).toLowerCase();
      const sClass = trimString(actorNode?.session_class).toUpperCase();
      if (!actorNode || (role !== 'root_leadership' && sClass !== 'ROOT_LEADERSHIP' && role !== 'manager')) {
        throw bridgeError('SWARM_PROMOTE_FORBIDDEN', 'Only Coordinator, Manager, or Owner may promote a Swarm workspace to Factory candidate', 403);
      }
    }
    const targetRow = conn.prepare(
      'SELECT * FROM organization_nodes WHERE organization_id = ? AND (id = ? OR LOWER(stable_key) = LOWER(?)) LIMIT 1',
    ).get(normalizedOrgId, targetQuery, targetQuery);
    if (!targetRow) throw bridgeError('ORGANIZATION_NODE_NOT_FOUND', `Swarm member "${targetQuery}" not found`, 404);
    if (targetRow.lifecycle_state !== 'active' || targetRow.retired_revision !== null || trimString(targetRow.swarm_state) === 'killed') {
      throw bridgeError(SWARM_MEMBER_KILLED, `Swarm member "${targetRow.stable_key}" is permanently killed`, 409);
    }
    if (trimString(targetRow.swarm_state) === 'working') {
      throw bridgeError(SWARM_MEMBER_BUSY, `Cannot promote while Swarm member "${targetRow.stable_key}" is still working`, 409);
    }
    return { orgRow, targetRow, targetGrant: parseJson(targetRow.grant_json, {}), orgPolicy: parseJson(orgRow.policy_json, {}) };
  });

  const { orgRow, targetRow, targetGrant, orgPolicy } = lookup;
  const wsMeta = targetGrant?.swarmWorkspace && typeof targetGrant.swarmWorkspace === 'object' ? targetGrant.swarmWorkspace : {};
  const workspaceMode = trimString(targetRow.workspace_mode || wsMeta.mode || 'inherit').toLowerCase();
  const workspacePath = trimString(targetRow.workspace_path || wsMeta.path);
  if (!['worktree', 'staging'].includes(workspaceMode) || !workspacePath) {
    throw bridgeError(
      SWARM_PROMOTE_REQUIRES_ISOLATED_WORKSPACE,
      `Member "${targetRow.stable_key}" does not own an isolated worktree or staging workspace (mode=${workspaceMode})`,
      409,
    );
  }
  const canonicalCwd = trimString(explicitProjectRoot)
    || trimString(wsMeta.projectRoot)
    || trimString(orgPolicy?.projectRoot)
    || trimString(orgPolicy?.workspaceScope);
  if (!canonicalCwd) {
    throw bridgeError('FACTORY_INVALID', 'Project canonical root path is unavailable for candidate promotion', 409);
  }
  const realCanonicalCwd = await realpath(canonicalCwd);
  await stat(workspacePath).catch(() => {
    throw bridgeError('FACTORY_CANDIDATE_INVALID', `Isolated workspace path is unavailable on disk: ${workspacePath}`, 409);
  });

  // 2. Verify a completed canonical Run exists (fail-closed: never fabricate a run).
  const candidateRunId = trimString(explicitRunId) || trimString(targetGrant?.lastRunId);
  const runGetter = typeof deps.getRun === 'function' ? deps.getRun : getRun;
  const runEvidenceGetter = typeof deps.getRunAcceptanceEvidence === 'function' ? deps.getRunAcceptanceEvidence : getRunAcceptanceEvidence;
  const completedRun = candidateRunId ? await runGetter(candidateRunId).catch(() => null) : null;
  if (!completedRun || completedRun.state !== 'completed') {
    throw bridgeError(
      SWARM_PROMOTE_RUN_REQUIRED,
      `A completed canonical Run is required before promoting member "${targetRow.stable_key}" workspace`,
      409,
    );
  }
  const runAcceptance = await runEvidenceGetter(candidateRunId).catch(() => null);
  if (!runAcceptance || runAcceptance.state !== 'completed') {
    throw bridgeError(
      SWARM_PROMOTE_RUN_REQUIRED,
      `Canonical Run ${candidateRunId} lacks verifiable publication/completion evidence`,
      409,
    );
  }

  // 3. Determine changed files & validate writablePaths boundaries.
  const execFn = deps.execFile || execFileAsync;
  const discoveredChanges = await discoverIsolatedChangedPaths({
    workspaceMode,
    workspacePath,
    canonicalCwd: realCanonicalCwd,
    baseRef: trimString(wsMeta.baseRef),
    execFn,
  });
  let writablePaths = Array.isArray(explicitWritablePaths) && explicitWritablePaths.length > 0
    ? explicitWritablePaths.map(normalizeRelativeScopePath)
    : (Array.isArray(targetGrant?.writablePaths) && targetGrant.writablePaths.length > 0
      ? await Promise.all(targetGrant.writablePaths.map((p) => normalizePromotionScopePath(p, realCanonicalCwd)))
      : discoveredChanges);
  writablePaths = [...new Set(writablePaths)].sort();
  if (writablePaths.length === 0 || discoveredChanges.length === 0) {
    throw bridgeError(
      SWARM_WORKSPACE_EMPTY_DIFF,
      `Isolated ${workspaceMode} workspace for "${targetRow.stable_key}" has no changes to promote`,
      409,
    );
  }
  for (const changed of discoveredChanges) {
    if (!pathWithinAllowed(changed, writablePaths)) {
      throw bridgeError(
        SWARM_WORK_ITEM_SCOPE_EXCEEDED,
        `Changed file "${changed}" falls outside allowed writablePaths (${writablePaths.join(', ')})`,
        403,
      );
    }
  }

  // 4. Verify git repository HEAD/branch & ensure Goal + WorkItem + Contract.
  const currentBranch = await factoryTargetBranch(realCanonicalCwd);
  const currentHead = await factoryTargetHead(realCanonicalCwd);
  const effectiveTargetBranch = trimString(requestedTargetBranch) || currentBranch;
  if (effectiveTargetBranch !== currentBranch) {
    throw bridgeError(
      'FACTORY_INTEGRATION_BLOCKED',
      `Requested targetBranch "${effectiveTargetBranch}" does not match checked-out branch "${currentBranch}"`,
      409,
    );
  }

  await mkdir(MANAGED_WORK_ROOT_DIR, { recursive: true });
  await mkdir(CHAT_COLLABORATIONS_DIR, { recursive: true });

  const { projectId } = await ensureOrganizationHasProject(normalizedOrgId, trimString(completedRun.projectId));
  const actor = ownerActor(rawActor, trimString(actorNodeId) || 'owner');
  const commandSalt = trimString(idempotencyKey) || `${targetRow.id}:${candidateRunId}:${Date.now()}`;

  let activeGoalId = trimString(goalId);
  if (!activeGoalId) {
    const goalRes = await executeFactoryCommand({
      commandId: `cmd_swarm_goal_${randomUUID()}`,
      idempotencyKey: `swarm_goal_${normalizedOrgId}_${commandSalt}`,
      organizationId: normalizedOrgId,
      targetId: normalizedOrgId,
      type: 'CreateGoal',
      payload: {
        projectId,
        objective: trimString(objective) || trimString(title) || `Promote Swarm deliverable from ${targetRow.stable_key}`,
        acceptanceBaseline: [{ id: trimString(criterionId) || 'manual_review', title: trimString(criterionTitle) }],
      },
    }, actor);
    activeGoalId = goalRes.goal.id;
  }

  let item = null;
  const explicitWorkItemId = trimString(workItemId);
  const targetWorkItemId = explicitWorkItemId || trimString(targetGrant?.parentWorkItemId || targetGrant?.workItemId);
  if (targetWorkItemId) {
    const loaded = await getFactoryWorkItem(normalizedOrgId, targetWorkItemId, actor).catch(() => null);
    if (explicitWorkItemId && !loaded?.item) {
      throw bridgeError('FACTORY_NOT_FOUND', `Work Item ${explicitWorkItemId} not found in organization ${normalizedOrgId}`, 404);
    }
    if (loaded?.item) {
      item = loaded.item;
      if (item.ownership !== 'active') {
        throw bridgeError('FACTORY_CONFLICT', `Work Item ${item.id} is not active ownership (${item.ownership})`, 409);
      }
      if (item.controlState !== 'none') {
        throw bridgeError('FACTORY_CONFLICT', `Work Item ${item.id} has pending control (${item.controlState})`, 409);
      }
      if (!['ready', 'claimed'].includes(item.state)) {
        throw bridgeError(
          'FACTORY_CONFLICT',
          `Work Item ${item.id} state "${item.state}" is not eligible for candidate promotion (contract approval and dependencies must be satisfied first)`,
          409,
        );
      }
      if (item.state === 'claimed' && item.assigneeNodeId && item.assigneeNodeId !== targetRow.id) {
        throw bridgeError('FACTORY_CONFLICT', `Work Item ${item.id} is already claimed by another node (${item.assigneeNodeId})`, 409);
      }
      if (Array.isArray(item.contract?.allowedPaths) && item.contract.allowedPaths.length > 0) {
        for (const p of writablePaths) {
          if (!pathWithinAllowed(p, item.contract.allowedPaths)) {
            throw bridgeError(
              SWARM_WORK_ITEM_SCOPE_EXCEEDED,
              `Writable path "${p}" is outside Work Item ${item.id} allowedPaths`,
              403,
            );
          }
        }
      }
    }
  }

  const effectiveCriterionId = trimString(criterionId)
    || item?.contract?.acceptanceCriteria?.[0]?.id
    || 'manual_review';

  if (!item) {
    const createdItemRes = await executeFactoryCommand({
      commandId: `cmd_swarm_wi_${randomUUID()}`,
      idempotencyKey: `swarm_wi_${normalizedOrgId}_${commandSalt}`,
      organizationId: normalizedOrgId,
      targetId: normalizedOrgId,
      type: 'CreateWorkItem',
      payload: {
        goalId: activeGoalId,
        kind: 'execution',
        assigneeNodeId: targetRow.id,
        source: { swarmNodeId: targetRow.id, swarmMember: targetRow.stable_key, workspaceMode },
        contract: {
          objective: trimString(objective) || `Integrate verified Swarm output from ${targetRow.stable_key}`,
          targetBranch: effectiveTargetBranch,
          allowedPaths: writablePaths,
          integrationApprovalRequired: false,
          acceptanceCriteria: [
            { id: effectiveCriterionId, title: trimString(criterionTitle), method: 'manual' },
          ],
        },
      },
    }, actor);
    const approvedItemRes = await executeFactoryCommand({
      commandId: `cmd_swarm_approve_${randomUUID()}`,
      idempotencyKey: `swarm_approve_${normalizedOrgId}_${commandSalt}`,
      organizationId: normalizedOrgId,
      targetId: createdItemRes.item.id,
      type: 'ApproveContract',
      expectedVersion: createdItemRes.item.rowVersion,
      payload: {},
    }, actor);
    item = approvedItemRes.item;
  }

  // 5. Preflight + materialize clean staging workspace -> capture real Factory baseline -> apply member diffs -> seal candidate!
  // `resolveStagingDiff` validates every directory entry in `stagingDir` against `writablePaths`,
  // so nested relative files (`a/b/c.js`) require top-level staging roots (`a`) while change sync still
  // touches only the exact authorized `writablePaths`.
  const stagingWritableScopes = [...new Set(writablePaths.map((p) => (p.includes('/') ? p.split('/')[0] : p)))].sort();
  await preflightFactoryWorkspace({ canonicalCwd: realCanonicalCwd, writablePaths: stagingWritableScopes });
  const staging = await createStagingWorkspace(realCanonicalCwd, stagingWritableScopes, { includeRootReferenceFiles: false });
  const existingIntentBinding = (item.state === 'claimed' && Array.isArray(item.bindings))
    ? item.bindings.find((b) => ['intent', 'running', 'unknown'].includes(b.status))
    : null;
  if (item.state === 'claimed' && existingIntentBinding && (existingIntentBinding.status !== 'intent' || existingIntentBinding.runId || existingIntentBinding.attemptId)) {
    throw bridgeError('FACTORY_CONFLICT', `Work Item ${item.id} already has an active or bound execution binding (${existingIntentBinding.id})`, 409);
  }
  const bindingEpoch = existingIntentBinding ? Number(existingIntentBinding.executionEpoch) : Number(item.executionEpoch || 0) + 1;
  const bindingGen = existingIntentBinding ? Number(existingIntentBinding.bindingGeneration) : Math.max(1, Number(targetRow.binding_generation || 1));
  const dispatchKey = existingIntentBinding
    ? existingIntentBinding.dispatchKey
    : `swarm_promote:${normalizedOrgId}:${item.id}:${bindingEpoch}:${bindingGen}:${randomBytes(6).toString('hex')}`;
  const candidateContext = {
    organizationId: normalizedOrgId,
    workItemId: item.id,
    contractRevision: item.contractRevision,
    executionEpoch: bindingEpoch,
    bindingGeneration: bindingGen,
    dispatchKey,
  };

  let baselineDigest = '';
  let sealed = null;
  let packet = null;
  let collaborationId = '';
  let taskId = '';
  let attemptId = '';
  let submitted = null;

  try {
    baselineDigest = await captureFactoryBaseline(candidateContext, {
      stagingDir: staging.stagingDir,
      canonicalCwd: realCanonicalCwd,
      writablePaths: stagingWritableScopes,
    });

    await syncPathsIntoPromotionStaging({
      sourceWorkspaceDir: workspacePath,
      stagingDir: staging.stagingDir,
      canonicalCwd: realCanonicalCwd,
      writablePaths,
    });

    // Bridge Run -> Collaboration Task Attempt -> Execution ResultPacket.
    taskId = `swarm_task_${randomBytes(8).toString('hex')}`;
    const collab = await createCollaborationRecord({
      rootSessionId: orgRow.root_session_id || targetRow.current_session_id,
      title: `Swarm Candidate Promotion: ${targetRow.stable_key}`,
      policy: {
        swarmPromotion: {
          organizationId: normalizedOrgId,
          nodeId: targetRow.id,
          workItemId: item.id,
          bindingGeneration: bindingGen,
        },
      },
      plan: {
        version: 1,
        tasks: [
          {
            id: taskId,
            title: trimString(title) || `Deliverable by ${targetRow.stable_key}`,
            agentId: targetRow.stable_key,
            role: 'worker',
            projectId,
            objective: trimString(objective) || `Promote Swarm output for ${item.id}`,
            dependsOn: [],
            acceptance: [],
            writablePaths,
            retry: { maxAttempts: 1, retryOn: [] },
            runtime: {},
            timeoutMs: 600000,
          },
        ],
      },
      idempotencyKey: dispatchKey,
    });
    collaborationId = collab.id;
    await markReadyTasks(collaborationId);

    const claimedAttempt = await claimTaskAttempt(taskId, {
      sessionId: targetRow.current_session_id || completedRun.sessionId,
      runId: candidateRunId,
    });
    if (!claimedAttempt) {
      throw bridgeError('FACTORY_CONFLICT', 'Failed to claim collaboration attempt for Swarm candidate promotion', 409);
    }
    attemptId = claimedAttempt.id;
    await bindAttemptRun(attemptId, {
      sessionId: targetRow.current_session_id || completedRun.sessionId,
      runId: candidateRunId,
    });

    packet = await createExecutionPacket({
      runId: candidateRunId,
      projectId,
      sessionId: completedRun.sessionId || targetRow.current_session_id,
      taskId,
      attemptId,
      organizationId: normalizedOrgId,
      nodeId: targetRow.id,
      revision: Number(orgRow.current_revision || 0),
    });

    await completeAttempt(attemptId, {
      state: 'succeeded',
      resultPacketId: packet.packetId,
    });

    sealed = await sealFactoryCandidate({
      context: candidateContext,
      workspace: {
        stagingDir: staging.stagingDir,
        canonicalCwd: realCanonicalCwd,
        writablePaths: stagingWritableScopes,
      },
      runId: candidateRunId,
    });

    // Ensure workItem is in claimed+intent (reusing unbound intent or inserting cleanly after ready guard), then bind_run -> submit_candidate!
    const claimedItem = await factoryTransaction((db) => {
      const ts = workNow();
      const row = db.prepare('SELECT * FROM factory_work_items WHERE id = ? AND organization_id = ?').get(item.id, normalizedOrgId);
      if (!row) throw bridgeError('FACTORY_NOT_FOUND', `Work item ${item.id} missing`, 404);
      if (row.ownership !== 'active' || row.control_state !== 'none' || !['ready', 'claimed'].includes(row.state)) {
        throw bridgeError('FACTORY_CONFLICT', `Work item ${item.id} is no longer eligible for candidate claim (${row.state})`, 409);
      }
      const activeBinding = db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id = ? AND status IN ('intent','running','unknown')").get(row.id);
      if (activeBinding) {
        if (!existingIntentBinding || activeBinding.id !== existingIntentBinding.id || activeBinding.status !== 'intent' || activeBinding.run_id) {
          throw bridgeError('FACTORY_CONFLICT', `Work item ${item.id} already has an active execution binding (${activeBinding.id}:${activeBinding.status})`, 409);
        }
        return row;
      }
      const bindingId = `binding_${randomUUID()}`;
      db.prepare(`
        INSERT INTO factory_execution_bindings
          (id, work_item_id, contract_revision, execution_epoch, binding_generation, dispatch_key, status, collaboration_id, task_id, attempt_id, run_id, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'intent', NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(
        bindingId,
        row.id,
        row.contract_revision,
        bindingEpoch,
        bindingGen,
        dispatchKey,
        encode({ source: 'swarm_promote', nodeId: targetRow.id, member: targetRow.stable_key, expectedHead: currentHead, baselineDigest }),
        ts,
        ts,
      );
      db.prepare(`
        UPDATE factory_work_items
        SET state = 'claimed', assignee_node_id = ?, execution_epoch = ?, binding_generation = ?, row_version = row_version + 1, updated_at = ?
        WHERE id = ? AND row_version = ?
      `).run(targetRow.id, bindingEpoch, bindingGen, ts, row.id, row.row_version);
      recordFactoryEvent(db, normalizedOrgId, row.id, 'SwarmWorkspacePromotedClaim', {
        bindingId,
        nodeId: targetRow.id,
        member: targetRow.stable_key,
        dispatchKey,
      });
      return db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(row.id);
    });

    const boundRes = await updateFactoryBinding({
      organizationId: normalizedOrgId,
      workItemId: item.id,
      expectedVersion: claimedItem.row_version,
      contractRevision: item.contractRevision,
      executionEpoch: bindingEpoch,
      bindingGeneration: bindingGen,
      action: 'bind_run',
      payload: {
        collaborationId,
        taskId,
        attemptId,
        runId: candidateRunId,
      },
    }, actor);

    submitted = await updateFactoryBinding({
      organizationId: normalizedOrgId,
      workItemId: item.id,
      expectedVersion: boundRes.item.rowVersion,
      contractRevision: item.contractRevision,
      executionEpoch: bindingEpoch,
      bindingGeneration: bindingGen,
      action: 'submit_candidate',
      payload: {
        candidateId: sealed.candidateId,
        digest: sealed.digest,
        baselineDigest,
        terminalEvidenceRef: `run:${candidateRunId}`,
        resultPacketId: packet.packetId,
        packetId: packet.packetId,
        packetDigest: packet.digest,
        sourceNodeId: targetRow.id,
        sourceMember: targetRow.stable_key,
        workspaceMode,
        workspaceBranch: trimString(targetRow.workspace_branch),
        expectedHead: currentHead,
        writablePaths,
      },
    }, actor, {
      verifyCandidate: ({ db, binding, item: currentItem, payload }) => verifyFactoryCandidate({
        db,
        binding,
        item: currentItem,
        payload,
      }),
    });
  } finally {
    await discardStaging(staging.stagingDir).catch(() => {});
  }

  // 6. Persist promoted/sealed reference back onto Swarm node & post factual board event.
  let boardPost = null;
  await withOrganizationDatabase(async (conn) => {
    const freshRow = conn.prepare('SELECT grant_json FROM organization_nodes WHERE id = ? AND organization_id = ?')
      .get(targetRow.id, normalizedOrgId);
    if (freshRow) {
      const nextGrant = parseJson(freshRow.grant_json, {});
      nextGrant.swarmWorkspace = {
        ...(nextGrant.swarmWorkspace && typeof nextGrant.swarmWorkspace === 'object' ? nextGrant.swarmWorkspace : {}),
        sealedCandidateId: sealed.candidateId,
        promotedCandidateDigest: sealed.digest,
        promotedWorkItemId: submitted.item.id,
        promotedGoalId: activeGoalId,
        promotedResultPacketId: packet.packetId,
        promotedAt: new Date().toISOString(),
      };
      conn.prepare('UPDATE organization_nodes SET grant_json = ?, version = version + 1 WHERE id = ? AND organization_id = ?')
        .run(encode(nextGrant), targetRow.id, normalizedOrgId);
    }
    invalidateOrganizationProjectionCache(normalizedOrgId);

    if (postToBoard !== false) {
      const boardSummary = trimString(summary)
        || `Promoted ${targetRow.stable_key} (${workspaceMode}) -> Work Item ${submitted.item.id} candidate ${sealed.candidateId} (sha256:${sealed.digest.slice(0, 12)}, packet ${packet.packetId}).`;
      const res = await postBoardMessage(conn, {
        organizationId: normalizedOrgId,
        channel: 'main',
        senderKind: trimString(actorNodeId) ? 'node' : 'owner',
        senderNodeId: trimString(actorNodeId),
        bodyMarkdown: boardSummary,
        artifactRefs: [
          { kind: 'factory_candidate', workItemId: submitted.item.id, candidateId: sealed.candidateId, digest: sealed.digest, packetId: packet.packetId },
        ],
        kind: 'message',
      });
      boardPost = res.message;
    }
  }, { mutate: true });

  return {
    organizationId: normalizedOrgId,
    goalId: activeGoalId,
    workItem: submitted.item,
    binding: submitted.binding,
    candidate: {
      candidateId: sealed.candidateId,
      digest: sealed.digest,
      baselineDigest,
      expectedHead: currentHead,
      targetBranch: effectiveTargetBranch,
      writablePaths,
    },
    resultPacket: packet,
    boardPost,
  };
}

export async function startWorkItemSwarm(firstArg, secondArg) {
  const { deps, options } = splitDepsAndOptions(firstArg, secondArg);
  const {
    organizationId,
    workItemId,
    actorNodeId = '',
    actorSessionId = '',
    members = [],
    brief = '',
    channels = [],
    projectRoot = '',
    deferDelivery = false,
    idempotencyKey = '',
    actor: rawActor = null,
  } = options;

  const normalizedOrgId = trimString(organizationId);
  const normalizedWorkItemId = trimString(workItemId);
  if (!normalizedOrgId || !normalizedWorkItemId) {
    throw bridgeError('BAD_REQUEST', 'organizationId and workItemId are required', 400);
  }
  const actor = ownerActor(rawActor, trimString(actorNodeId) || 'owner');
  const { item } = await getFactoryWorkItem(normalizedOrgId, normalizedWorkItemId, actor);
  if (['completed', 'cancelled'].includes(item.state) || item.ownership !== 'active' || item.controlState !== 'none') {
    throw bridgeError('FACTORY_CONFLICT', `Work Item ${item.id} is not eligible for child Swarm execution (${item.state})`, 409);
  }

  const memberList = Array.isArray(members) ? members : [];
  const allowedPaths = Array.isArray(item.contract?.allowedPaths) ? item.contract.allowedPaths : [];
  for (const spec of memberList) {
    const specPaths = Array.isArray(spec?.writablePaths) ? spec.writablePaths : [];
    for (const p of specPaths) {
      if (!pathWithinAllowed(p, allowedPaths)) {
        throw bridgeError(
          SWARM_WORK_ITEM_SCOPE_EXCEEDED,
          `Child member writablePath "${p}" exceeds parent Work Item ${item.id} allowedPaths (${allowedPaths.join(', ')})`,
          403,
        );
      }
    }
  }

  const preflightScope = await withOrganizationDatabase((conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw bridgeError('ORGANIZATION_NOT_FOUND', `Organization ${normalizedOrgId} not found`, 404);
    const coordinator = trimString(actorNodeId)
      ? conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(trimString(actorNodeId), normalizedOrgId)
      : conn.prepare("SELECT * FROM organization_nodes WHERE organization_id = ? AND (node_role = 'root_leadership' OR session_class = 'ROOT_LEADERSHIP') LIMIT 1").get(normalizedOrgId);
    if (!coordinator) throw bridgeError('SWARM_ACTOR_NOT_FOUND', 'Coordinator node not found in organization', 404);
    const coordGrant = parseJson(coordinator.grant_json, {});
    const policy = parseJson(orgRow.policy_json, {});
    return {
      policyProjectRoot: trimString(policy?.projectRoot || policy?.workspaceScope),
      coordWorkspaceScope: trimString(coordGrant?.workspaceScope || coordGrant?.scope?.workspaceScope),
      coordWritablePaths: Array.isArray(coordGrant?.writablePaths) ? coordGrant.writablePaths : [],
    };
  });
  const effectiveProjectRoot = trimString(projectRoot)
    || preflightScope.policyProjectRoot
    || preflightScope.coordWorkspaceScope
    || trimString(preflightScope.coordWritablePaths.find((p) => isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p)));
  await resolveStartWorkItemWritablePaths(allowedPaths, effectiveProjectRoot, preflightScope.coordWritablePaths);
  const resolvedMemberWritablePaths = await Promise.all(memberList.map((spec) => {
    const rawMemberPaths = Array.isArray(spec?.writablePaths) && spec.writablePaths.length
      ? spec.writablePaths
      : allowedPaths;
    return resolveStartWorkItemWritablePaths(rawMemberPaths, effectiveProjectRoot, preflightScope.coordWritablePaths);
  }));

  const bindingState = await withOrganizationDatabase((conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw bridgeError('ORGANIZATION_NOT_FOUND', `Organization ${normalizedOrgId} not found`, 404);
    const coordinator = trimString(actorNodeId)
      ? conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(trimString(actorNodeId), normalizedOrgId)
      : conn.prepare("SELECT * FROM organization_nodes WHERE organization_id = ? AND (node_role = 'root_leadership' OR session_class = 'ROOT_LEADERSHIP') LIMIT 1").get(normalizedOrgId);
    if (!coordinator) throw bridgeError('SWARM_ACTOR_NOT_FOUND', 'Coordinator node not found in organization', 404);
    const coordGrant = parseJson(coordinator.grant_json, {});
    if (coordGrant?.canDelegate !== true) {
      throw bridgeError('SWARM_DELEGATION_FORBIDDEN', 'Parent Work Item actor lacks delegation authority', 403);
    }
    const maxDepth = Number(coordGrant.maxDepth ?? 3);
    const remainingDepth = Math.max(0, maxDepth - Number(coordinator.depth || 0));
    if (remainingDepth < 1) {
      throw bridgeError('SWARM_DEPTH_EXCEEDED', 'Delegation depth exhausted for bounded child Swarm', 403);
    }

    const policy = parseJson(orgRow.policy_json, {});
    const headRow = conn.prepare('SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?').get(normalizedOrgId);
    const kickoffSeq = Number(headRow?.head_seq || 0) + 1;
    const nextPolicy = {
      ...policy,
      swarmEnabled: true,
      mode: 'ragent_swarm',
      workItemSwarms: {
        ...(policy.workItemSwarms && typeof policy.workItemSwarms === 'object' ? policy.workItemSwarms : {}),
        [item.id]: {
          workItemId: item.id,
          contractRevision: item.contractRevision,
          allowedPaths,
          parentNodeId: coordinator.id,
          kickoffSeq,
          budget: item.contract?.budget || null,
          startedAt: new Date().toISOString(),
        },
      },
    };
    conn.prepare('UPDATE organizations SET policy_json = ?, updated_at = ? WHERE id = ?')
      .run(encode(nextPolicy), new Date().toISOString(), normalizedOrgId);
    invalidateOrganizationProjectionCache(normalizedOrgId);
    return {
      coordinatorId: coordinator.id,
      coordinatorSessionId: trimString(actorSessionId || coordinator.current_session_id || orgRow.root_session_id),
      remainingDepth,
      kickoffSeq,
    };
  }, { mutate: true });

  await factoryTransaction((db) => {
    recordFactoryEvent(db, normalizedOrgId, item.id, 'WorkItemSwarmStarted', {
      organizationId: normalizedOrgId,
      workItemId: item.id,
      parentNodeId: bindingState.coordinatorId,
      allowedPaths,
    });
  });

  const spawnedMembers = [];
  for (let i = 0; i < memberList.length; i += 1) {
    const spec = memberList[i] || {};
    const spawnRes = await spawnSwarmMembers(deps, {
      organizationId: normalizedOrgId,
      actorNodeId: bindingState.coordinatorId,
      actorSessionId: bindingState.coordinatorSessionId,
      name: spec.name,
      role: spec.role || 'worker',
      domain: spec.domain || '',
      responsibility: spec.responsibility || '',
      brief: trimString(spec.brief) || trimString(brief) || trimString(item.contract?.objective),
      tasks: spec.tasks || null,
      n: spec.n || 1,
      workspace: spec.workspace || 'inherit',
      harness: spec.harness || '',
      provider: spec.provider || '',
      model: spec.model || '',
      effort: spec.effort || '',
      channels: Array.isArray(spec.channels) && spec.channels.length ? spec.channels : channels,
      writablePaths: resolvedMemberWritablePaths[i] || [],
      workItemId: item.id,
      parentWorkItemId: item.id,
      projectRoot: effectiveProjectRoot,
      deferDelivery,
      ...(trimString(idempotencyKey) ? { idempotencyKey: `${trimString(idempotencyKey)}:${i}` } : {}),
    });
    spawnedMembers.push(...(spawnRes.members || []));
  }

  return {
    organizationId: normalizedOrgId,
    workItemId: item.id,
    contractRevision: item.contractRevision,
    allowedPaths,
    remainingDepth: bindingState.remainingDepth,
    parentNodeId: bindingState.coordinatorId,
    members: spawnedMembers,
  };
}

export async function completeWorkItemSwarm(firstArg, secondArg) {
  const { deps, options } = splitDepsAndOptions(firstArg, secondArg);
  const {
    organizationId,
    workItemId,
    actorNodeId = '',
    summary = '',
    runId: explicitRunId = '',
    boardSeqFrom = 0,
    boardSeqTo = null,
    evidenceRefs: explicitEvidenceRefs = [],
    tests: explicitTests = [],
    projectRoot: explicitProjectRoot = '',
    forceDiscard = false,
    markDone = false,
    actor: rawActor = null,
  } = options;

  const normalizedOrgId = trimString(organizationId);
  const normalizedWorkItemId = trimString(workItemId);
  if (!normalizedOrgId || !normalizedWorkItemId) {
    throw bridgeError('BAD_REQUEST', 'organizationId and workItemId are required', 400);
  }

  const actor = ownerActor(rawActor, trimString(actorNodeId) || 'owner');
  const { item } = await getFactoryWorkItem(normalizedOrgId, normalizedWorkItemId, actor);

  // 1. Inspect all child Swarm members scoped to this Work Item.
  const orgSnapshot = await withOrganizationDatabase((conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw bridgeError('ORGANIZATION_NOT_FOUND', `Organization ${normalizedOrgId} not found`, 404);
    const orgPolicy = parseJson(orgRow.policy_json, {});
    const allRows = conn.prepare('SELECT * FROM organization_nodes WHERE organization_id = ?').all(normalizedOrgId);
    const childRows = allRows.filter((row) => {
      if (row.lifecycle_state !== 'active' || row.retired_revision !== null || trimString(row.swarm_state) === 'killed') {
        return false;
      }
      const grant = parseJson(row.grant_json, {});
      return trimString(grant?.parentWorkItemId || grant?.workItemId) === normalizedWorkItemId;
    });
    const coordinator = allRows.find((r) => trimString(r.node_role).toLowerCase() === 'root_leadership' || trimString(r.session_class).toUpperCase() === 'ROOT_LEADERSHIP');
    const swarmMeta = orgPolicy?.workItemSwarms?.[normalizedWorkItemId] || {};
    const fromSeq = Math.max(0, Number(boardSeqFrom || swarmMeta.kickoffSeq || 0));
    const maxSeq = Number.isInteger(boardSeqTo) ? boardSeqTo : Number.MAX_SAFE_INTEGER;
    const messages = conn.prepare(
      'SELECT seq, channel_name, sender_node_id, sender_name, kind, body_markdown, artifact_refs_json, created_at FROM organization_board_messages WHERE organization_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT 200',
    ).all(normalizedOrgId, fromSeq, maxSeq);
    return { orgRow, orgPolicy, childRows, coordinator, messages };
  });

  // 2. Ensure every child Swarm member has settled and no unmerged dirty changes remain.
  const activeWorking = orgSnapshot.childRows.filter((r) => trimString(r.swarm_state) === 'working');
  if (activeWorking.length > 0) {
    throw bridgeError(
      SWARM_CHILDREN_STILL_ACTIVE,
      `Child Swarm member(s) still working: ${activeWorking.map((r) => r.stable_key).join(', ')}`,
      409,
      { activeMembers: activeWorking.map((r) => r.stable_key) },
    );
  }
  const effectiveRoot = trimString(explicitProjectRoot)
    || trimString(orgSnapshot.orgPolicy?.projectRoot)
    || trimString(orgSnapshot.orgPolicy?.workspaceScope);
  if (!forceDiscard) {
    for (const child of orgSnapshot.childRows) {
      const wsCheck = await inspectWorkspaceUnmergedChanges(deps, child, effectiveRoot);
      if (wsCheck?.unmerged) {
        throw bridgeError(
          SWARM_WORKSPACE_UNMERGED_CHANGES,
          `Child member "${child.stable_key}" has unsealed/unmerged changes: ${wsCheck.reason}`,
          409,
          { member: child.stable_key, ...wsCheck },
        );
      }
    }
  }

  // 3. Gather verified evidence (#seq refs, child candidates, model usage across epochs).
  const boardRefs = orgSnapshot.messages.map((m) => `board:#${m.seq}`);
  const sealedCandidateRefs = [];
  const childRunIds = [];
  const childSessionIds = [];
  const aggregatedUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 };

  for (const row of orgSnapshot.childRows) {
    const grant = parseJson(row.grant_json, {});
    if (trimString(row.current_session_id)) childSessionIds.push(trimString(row.current_session_id));
    if (trimString(grant?.lastRunId)) childRunIds.push(trimString(grant.lastRunId));
    if (trimString(grant?.swarmWorkspace?.sealedCandidateId)) {
      sealedCandidateRefs.push(`candidate:${grant.swarmWorkspace.sealedCandidateId}`);
    }
    for (const epoch of Array.isArray(grant?.modelHistory) ? grant.modelHistory : []) {
      const u = epoch?.usage || {};
      aggregatedUsage.inputTokens += Number(u.inputTokens || 0);
      aggregatedUsage.outputTokens += Number(u.outputTokens || 0);
      aggregatedUsage.cachedInputTokens += Number(u.cachedInputTokens || 0);
      aggregatedUsage.cacheReadTokens += Number(u.cacheReadTokens || 0);
      aggregatedUsage.cacheCreationTokens += Number(u.cacheCreationTokens || 0);
      aggregatedUsage.totalTokens += Number(u.totalTokens || 0);
      aggregatedUsage.costUsd = Math.round((aggregatedUsage.costUsd + Number(u.costUsd || 0)) * 1e6) / 1e6;
      for (const rId of Array.isArray(u.runIds) ? u.runIds : []) childRunIds.push(rId);
    }
  }

  // 4. Resolve authoritative terminal Run and create immutable ResultPacket.
  const latestBinding = Array.isArray(item.bindings) && item.bindings.length > 0 ? item.bindings[item.bindings.length - 1] : null;
  const coordGrant = parseJson(orgSnapshot.coordinator?.grant_json, {});
  const targetRunId = trimString(explicitRunId)
    || trimString(latestBinding?.runId)
    || trimString(coordGrant?.lastRunId)
    || trimString(childRunIds[childRunIds.length - 1]);
  if (!targetRunId) {
    throw bridgeError('SWARM_PROMOTE_RUN_REQUIRED', `No terminal Run found to synthesize ResultPacket for Work Item ${item.id}`, 409);
  }
  const runGetter = typeof deps.getRun === 'function' ? deps.getRun : getRun;
  const targetRun = await runGetter(targetRunId).catch(() => null);
  if (!targetRun || !isTerminalRunState(targetRun.state)) {
    throw bridgeError('WORKSPACE_LEASE_CONFLICT', `Run ${targetRunId} is missing or not terminal`, 409);
  }

  const packet = typeof deps.createExecutionPacket === 'function'
    ? await deps.createExecutionPacket({
      runId: targetRunId,
      projectId: item.projectId,
      sessionId: targetRun.sessionId || orgSnapshot.coordinator?.current_session_id,
      taskId: latestBinding?.taskId || item.id,
      attemptId: latestBinding?.attemptId || '',
      organizationId: normalizedOrgId,
      nodeId: trimString(actorNodeId) || orgSnapshot.coordinator?.id || '',
      revision: Number(orgSnapshot.orgRow.current_revision || 0),
    })
    : await createExecutionPacket({
      runId: targetRunId,
      projectId: item.projectId,
      sessionId: targetRun.sessionId || orgSnapshot.coordinator?.current_session_id,
      taskId: latestBinding?.taskId || item.id,
      attemptId: latestBinding?.attemptId || '',
      organizationId: normalizedOrgId,
      nodeId: trimString(actorNodeId) || orgSnapshot.coordinator?.id || '',
      revision: Number(orgSnapshot.orgRow.current_revision || 0),
      ...(deps.packetDeps ? { deps: deps.packetDeps } : {}),
    });

  const combinedEvidenceRefs = [...new Set([
    ...boardRefs,
    ...sealedCandidateRefs,
    ...(Array.isArray(explicitEvidenceRefs) ? explicitEvidenceRefs.map(trimString).filter(Boolean) : []),
    `packet:${packet.packetId}`,
  ])];

  // 5. Record immutable synthesis event & annotate Work Item binding metadata.
  const synthesis = {
    workItemId: item.id,
    resultPacketId: packet.packetId,
    resultPacketDigest: packet.digest,
    childMemberCount: orgSnapshot.childRows.length,
    childMembers: orgSnapshot.childRows.map((r) => r.stable_key),
    boardMessageCount: orgSnapshot.messages.length,
    boardSeqRange: orgSnapshot.messages.length
      ? { from: orgSnapshot.messages[0].seq, to: orgSnapshot.messages[orgSnapshot.messages.length - 1].seq }
      : null,
    evidenceRefs: combinedEvidenceRefs,
    tests: Array.isArray(explicitTests) ? explicitTests : [],
    aggregatedChildUsage: aggregatedUsage,
    summary: trimString(summary) || `Completed child Swarm (${orgSnapshot.childRows.length} members, ${orgSnapshot.messages.length} board posts).`,
  };

  await factoryTransaction((db) => {
    if (latestBinding && ['intent', 'running', 'unknown'].includes(latestBinding.status)) {
      const nextDetails = {
        ...(latestBinding.details && typeof latestBinding.details === 'object' ? latestBinding.details : {}),
        workItemSwarmSynthesis: synthesis,
      };
      db.prepare('UPDATE factory_execution_bindings SET details_json = ?, updated_at = ? WHERE id = ?')
        .run(encode(nextDetails), workNow(), latestBinding.id);
    }
    recordFactoryEvent(db, normalizedOrgId, item.id, 'WorkItemSwarmCompleted', synthesis);
  });

  if (markDone === true) {
    await markSwarmDone(deps, {
      organizationId: normalizedOrgId,
      actorNodeId: trimString(actorNodeId) || orgSnapshot.coordinator?.id || '',
      summary: synthesis.summary,
      postToBoard: true,
    });
  }

  return {
    organizationId: normalizedOrgId,
    workItemId: item.id,
    resultPacket: packet,
    synthesis,
  };
}

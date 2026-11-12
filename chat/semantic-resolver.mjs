/**
 * chat/semantic-resolver.mjs — 服务端 context resolver（Phase 1，fixture 只读模式）。
 *
 * 职责（notes/directional/semantic-operation-policy-architecture-2026-08-10.md
 * §5 / §6.4 / §13 Phase 1）：
 *   - 计算 canonical 路径、project root containment（computed，不信任 caller 的
 *     projectRoot/cwd 声明 —— caller 声明只进 evidence，绝不出现在 computed scope）；
 *   - symlink 链、mount 边界（fixture 注入 mountId）、缺失叶子（绑定最近存在父目录
 *     identity + no-follow）；
 *   - .git / tracked / modified、敏感目录、generated 检测、tree count/size 事实；
 *   - package / service 只读 metadata 事实（fixture 注入）；
 *   - 输出 { scope, impact, resourceSnapshot, unknowns, evidence }。
 *
 * I/O 边界以「注入 fs facts provider」实现：Linux 默认 provider 提供 realpath /
 * lstat / readdir / stat 的真实适配；Windows 由 platform provider 提供固定
 * PowerShell facts（git/package 等未实现事实仍返回 null）。测试注入确定性
 * fake facts，零真实磁盘访问。
 *
 * 安全基线：scope.computed 只有在服务端真正算出资源事实后才为 true；
 * variable / glob / batch / remote / interpreter / script 内容未解析 →
 * computed=false + unknowns，绝不允许下游把 refusal 当 allow。
 */

import path from 'node:path';

import { realpath, lstat, stat, readdir } from 'node:fs/promises';
import {
  SEMANTIC_RESOLVER_VERSION,
  sha256Hex,
} from './semantic-operation.mjs';
import { resolveWindowsSemanticContext } from './semantic-resolver-windows.mjs';
import { inspectMacosPackagePreview } from './macos-package-preview.mjs';
import { computeSelfProtectionFacts, deriveAgentoCSelfProtectionRoots } from './self-protection.mjs';

export const RESOLVER_PLATFORM = 'linux';
export const RESOLVER_SUPPORTED_PLATFORMS = Object.freeze(['linux', 'win32']);
export const RESOLVER_PROVIDER_VERSION = 'resource-resolver/v1';
export const SYMLINK_POLICY_REJECT_ESCAPE = 'reject_escape';
export { SEMANTIC_RESOLVER_VERSION };

export const DEFAULT_GENERATED_DIR_NAMES = Object.freeze([
  'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt', 'coverage',
  '.cache', '__pycache__', '.venv', 'venv', '.tox', '.turbo', 'bazel-bin', 'bazel-out',
]);

export const DEFAULT_SENSITIVE_DIRS = Object.freeze([
  '/etc', '/root', '/boot', '/sys', '/proc', '/dev', '/var',
]);

const HOME_CREDENTIAL_SUBDIRS = Object.freeze([
  '.ssh', '.gnupg', '.aws', '.azure', '.netrc', '.password-store', '.kube', '.config',
]);

const GIT_METADATA_DIR_NAME = '.git';

function isMissingError(error) {
  return Boolean(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function stableIdentity(parts) {
  if (!parts || parts.length === 0) return 'unresolved';
  return sha256Hex(JSON.stringify(sortKeysDeep(parts)));
}

function dedupe(values) {
  return [...new Set(Array.isArray(values) ? values : [])];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 只有服务端从 ExecutionScope / run manifest 取回的上下文可以出现在这里。
 * caller 是 provider/agent 输入，只保留为 evidence，绝不能决定 containment。
 */
function trustedContext(options) {
  const context = options && options.trustedContext;
  return {
    cwd: nonEmptyString(context && context.cwd) ? context.cwd : null,
    projectRoot: nonEmptyString(context && context.projectRoot) ? context.projectRoot : null,
    home: nonEmptyString(context && context.home) ? context.home : null,
    workspaceRoot: nonEmptyString(context && context.workspaceRoot)
      ? context.workspaceRoot : null,
  };
}

// --- 默认 fs facts provider（真实 fs 适配；git/package/service 为 shadow 占位） ---

export function statToFacts(st) {
  // Node's default number-based stat can round device and inode identifiers.
  // Keep them as exact decimal strings; file size is advisory and becomes
  // unknown if it cannot be represented safely by existing consumers.
  const device = String(st.dev);
  const inode = String(st.ino);
  const size = typeof st.size === 'bigint'
    ? (st.size >= 0n && st.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(st.size) : null)
    : (Number.isSafeInteger(st.size) && st.size >= 0 ? st.size : null);
  return {
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other',
    dev: device,
    ino: inode,
    size,
    mountId: device,
    identity: `${device}:${inode}`,
  };
}

/**
 * 真实 fs 适配。git/package/service 事实在 shadow 阶段不执行外部命令：
 * gitFacts 返回 supported:false，packageFacts/serviceFacts 返回 null。
 */
export function createDefaultFsProvider() {
  return {
    name: 'default',
    async realpath(p) { return realpath(p); },
    async lstat(p) { return statToFacts(await lstat(p, { bigint: true })); },
    async stat(p) { return statToFacts(await stat(p, { bigint: true })); },
    async readdir(p) {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
      }));
    },
    async mountId(p) { return String((await stat(p, { bigint: true })).dev); },
    async identity(p) { const st = await stat(p, { bigint: true }); return `${st.dev}:${st.ino}`; },
    async gitFacts() { return { supported: false, gitRoot: null, tracked: null, modified: null }; },
    async packageFacts() { return null; },
    async serviceFacts() { return null; },
  };
}

// --- canonical 路径计算 ---

function splitPrefixes(absolutePath) {
  const parts = absolutePath.split('/').filter(Boolean);
  const prefixes = ['/'];
  let current = '/';
  for (const part of parts) {
    current = current === '/' ? `/${part}` : `${current}/${part}`;
    prefixes.push(current);
  }
  return prefixes;
}

async function statFacts(provider, canonicalPath) {
  const st = await provider.stat(canonicalPath);
  return {
    type: st.type || 'other',
    identity: st.identity || `${st.dev}:${st.ino}`,
    mountId: st.mountId || String(st.dev || ''),
    size: Number.isFinite(st.size) ? st.size : null,
  };
}

/**
 * canonical 化单个路径（纯依赖注入的 provider）。
 * - 存在：realpath 求 canonical，记录 symlink 链、identity、mountId、父目录 identity；
 * - 缺失：向上找到最近存在父目录，绑定其 identity + no-follow 叶子名。
 */
async function canonicalizePath(rawPath, { provider, baseDir }) {
  if (!nonEmptyString(rawPath)) {
    const error = new Error('semantic target path is empty or invalid');
    error.code = 'EINVAL';
    throw error;
  }
  const absolute = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(baseDir || '/', rawPath);

  const symlinkChain = [];
  for (const probe of splitPrefixes(absolute)) {
    let lst = null;
    try {
      lst = await provider.lstat(probe);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }
    if (lst && (lst.type === 'symlink' || lst.symlink)) {
      let resolved = '';
      try {
        resolved = await provider.realpath(probe);
      } catch {
        resolved = lst.symlinkTarget || '';
      }
      symlinkChain.push({ path: probe, target: resolved });
    }
  }

  try {
    const canonicalPath = await provider.realpath(absolute);
    const f = await statFacts(provider, canonicalPath);
    const parentPath = path.dirname(canonicalPath);
    let expectedParentIdentity = 'unresolved';
    try {
      const parent = await statFacts(provider, parentPath);
      expectedParentIdentity = parent.identity;
    } catch (parentError) {
      if (!isMissingError(parentError)) throw parentError;
      expectedParentIdentity = f.identity;
    }
    return {
      requested: rawPath,
      absolute,
      canonicalPath,
      exists: true,
      symlinkChain,
      type: f.type,
      identity: f.identity,
      mountId: f.mountId,
      size: f.size,
      expectedParentIdentity,
      parentPath,
      noFollow: false,
    };
  } catch (error) {
    if (!isMissingError(error)) throw error;
    // 缺失叶子：向上绑定最近存在父目录。
    let ancestor = path.dirname(absolute);
    let ancestorCanon = null;
    let ancestorFacts = null;
    for (;;) {
      try {
        const a = await provider.realpath(ancestor);
        const af = await statFacts(provider, a);
        ancestorCanon = a;
        ancestorFacts = af;
        break;
      } catch (e2) {
        if (!isMissingError(e2)) throw e2;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    const missingPathSegments = ancestorCanon
      ? path.relative(ancestor, absolute).split(path.sep).filter(Boolean)
      : [];
    const missingPath = missingPathSegments.join('/');
    const leafName = missingPathSegments.at(-1) || path.basename(absolute);
    const canonicalPath = ancestorCanon
      ? path.join(ancestorCanon, ...missingPathSegments)
      : absolute;
    return {
      requested: rawPath,
      absolute,
      canonicalPath,
      exists: false,
      symlinkChain,
      type: 'missing',
      identity: ancestorFacts ? `no-follow:${ancestorFacts.identity}:${missingPath || leafName}` : 'unresolved',
      mountId: ancestorFacts ? ancestorFacts.mountId : 'unresolved',
      size: null,
      expectedParentIdentity: ancestorFacts ? ancestorFacts.identity : 'unresolved',
      parentPath: ancestorCanon || ancestor,
      noFollow: true,
      missingLeaf: leafName,
      missingPathSegments,
      parentIsDirectory: Boolean(ancestorFacts && ancestorFacts.type === 'dir'),
    };
  }
}

function containmentFor(canonicalPath, projectRoot) {
  if (!projectRoot) return 'unavailable';
  const rel = path.relative(projectRoot, canonicalPath);
  if (rel === '') return 'equal';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return 'inside';
  return 'outside';
}

function isSensitivePath(canonicalPath, sensitiveDirs, homeCanon) {
  const normalized = canonicalPath.replace(/\/+$/, '');
  for (const dir of sensitiveDirs || []) {
    const d = String(dir).replace(/\/+$/, '');
    if (d && (normalized === d || normalized.startsWith(d + '/'))) return true;
  }
  if (homeCanon) {
    const home = homeCanon.replace(/\/+$/, '');
    for (const sub of HOME_CREDENTIAL_SUBDIRS) {
      const target = `${home}/${sub}`;
      if (normalized === target || normalized.startsWith(target + '/')) return true;
    }
  }
  return false;
}

function isHomeCredentialPath(canonicalPath, homeCanon) {
  if (!homeCanon) return false;
  const normalized = canonicalPath.replace(/\/+$/, '');
  const home = homeCanon.replace(/\/+$/, '');
  for (const sub of HOME_CREDENTIAL_SUBDIRS) {
    const target = `${home}/${sub}`;
    if (normalized === target || normalized.startsWith(target + '/')) return true;
  }
  return false;
}

function isGeneratedPath(canonicalPath, projectRoot, generatedDirNames) {
  const names = new Set(generatedDirNames || []);
  const components = canonicalPath.split('/').filter(Boolean);
  return components.some((c) => names.has(c));
}

function containsGitMetadataPath(canonicalPath) {
  return canonicalPath.split('/').some((c) => c === GIT_METADATA_DIR_NAME);
}

async function walkTree(provider, canonicalPath, options) {
  const maxEntries = Number.isFinite(options.maxTreeEntries) ? options.maxTreeEntries : 2000;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 24;
  let count = 0;
  let dirs = 0;
  let files = 0;
  let size = 0;
  let exceeded = false;
  let unreadable = false;
  let depthExceeded = false;
  let containsSymlink = false;
  let mountBoundary = false;
  let rootMountId = null;
  try {
    rootMountId = (await statFacts(provider, canonicalPath)).mountId;
  } catch {
    unreadable = true;
  }
  const stack = [{ dir: canonicalPath, depth: 0 }];
  while (stack.length > 0 && !exceeded) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await provider.readdir(dir);
    } catch {
      unreadable = true;
      break;
    }
    for (const entry of entries || []) {
      count += 1;
      if (count > maxEntries) {
        exceeded = true;
        break;
      }
      const full = path.join(dir, entry.name);
      let linkFacts;
      try {
        linkFacts = await provider.lstat(full);
      } catch {
        unreadable = true;
        continue;
      }
      if (linkFacts.type === 'symlink' || linkFacts.symlink) {
        // Recursive traversal must not follow a child link while preparing a
        // future no-follow execution constraint.
        containsSymlink = true;
        continue;
      }
      let f;
      try {
        f = await provider.stat(full);
      } catch {
        unreadable = true;
        continue;
      }
      if (rootMountId && f.mountId && f.mountId !== rootMountId) {
        mountBoundary = true;
        continue;
      }
      if (f.type === 'dir') {
        dirs += 1;
        if (depth + 1 < maxDepth) {
          stack.push({ dir: full, depth: depth + 1 });
        } else {
          depthExceeded = true;
        }
      } else {
        files += 1;
        if (!Number.isSafeInteger(f.size) || f.size < 0) unreadable = true;
        else size += f.size;
        if (!Number.isSafeInteger(size)) unreadable = true;
      }
    }
  }
  return {
    count, size, dirs, files, exceeded, unreadable, depthExceeded,
    containsSymlink, mountBoundary, maxEntries, maxDepth,
  };
}

// --- 目标类型分发 ---

function unresolvedScope(unknowns, impact = {}) {
  return {
    scope: { computed: false, kind: 'unresolvable' },
    impact: {
      containsTrackedFiles: false,
      containsModifiedFiles: false,
      containsSensitiveMaterial: false,
      reversible: false,
      ...impact,
    },
    unknowns: dedupe(unknowns),
  };
}

async function resolveFilesystemTarget(target, caller, options, provider) {
  const evidence = [];
  const trusted = trustedContext(options);
  const baseDir = trusted.cwd || trusted.projectRoot || '/';

  // project root 必须来自服务端绑定的 trustedContext；caller 值仅作审计证据。
  let computedProjectRoot = null;
  if (trusted.projectRoot) {
    try {
      const canon = await canonicalizePath(trusted.projectRoot, { provider, baseDir: '/' });
      if (canon.exists) {
        computedProjectRoot = canon.canonicalPath;
        evidence.push({ field: 'trustedProjectRoot', computed: computedProjectRoot });
      } else {
        evidence.push({ field: 'trustedProjectRoot', computed: null, reason: 'missing' });
      }
    } catch {
      evidence.push({ field: 'trustedProjectRoot', computed: null, reason: 'unresolvable' });
    }
  }
  let homeCanon = null;
  if (trusted.home) {
    try {
      const canon = await canonicalizePath(trusted.home, { provider, baseDir: '/' });
      if (canon.exists) homeCanon = canon.canonicalPath;
      evidence.push({ field: 'trustedHome', computed: homeCanon });
    } catch {
      evidence.push({ field: 'trustedHome', computed: null });
    }
  }

  const rawPaths = Array.isArray(target.paths) && target.paths.length
    ? target.paths
    : (target.root ? [target.root] : []);
  if (rawPaths.length === 0) {
    const unresolved = unresolvedScope(['scope:no-target']);
    return { ...unresolved, scope: { computed: false, kind: 'unresolvable' }, evidence };
  }
  if (rawPaths.some((rawPath) => !nonEmptyString(rawPath))) {
    const unresolved = unresolvedScope(['target:invalid-path']);
    return {
      ...unresolved,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        observedAt: options.now || new Date().toISOString(),
        identity: 'unresolved',
        provider: provider.name || 'fixture',
      },
      evidence: [...evidence, ...callerEvidence(caller)],
    };
  }
  if (rawPaths.some((rawPath) => !path.isAbsolute(rawPath)) && !trusted.cwd && !trusted.projectRoot) {
    const unresolved = unresolvedScope(['scope:trusted-cwd-unavailable']);
    return {
      ...unresolved,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        observedAt: options.now || new Date().toISOString(),
        identity: 'unresolved',
        provider: provider.name || 'fixture',
      },
      evidence: [...evidence, ...callerEvidence(caller)],
    };
  }

  const resolvedPaths = [];
  const unknowns = [];
  let anyOutside = false;
  let anySymlinkEscape = false;
  let anyMountBoundary = false;
  let anySensitive = false;
  let anyHomeCredential = false;
  let anySystem = false;
  let anyFilesystemRoot = false;
  let anyTmp = false;
  let anyGitMetadata = false;
  let anyTracked = false;
  let anyModified = false;
  let anyGenerated = false;
  let anyUnreadable = false;
  let anyExceeds = false;
  let totalItems = 0;
  let totalSize = 0;
  let anyNoFollow = false;
  let anyTreeSymlink = false;
  let revalidationRequired = false;

  const projectMountId = computedProjectRoot ? (await canonicalizePath(computedProjectRoot, { provider, baseDir: '/' })).mountId : null;
  const sensitiveDirs = options.sensitiveDirs || DEFAULT_SENSITIVE_DIRS;
  const generatedDirNames = options.generatedDirNames || DEFAULT_GENERATED_DIR_NAMES;
  const recursive = Boolean(target.recursive || target.kind === 'filesystem_tree'
    || target.kind === 'filesystem_root' || target.kind === 'filesystem_symlink');

  for (const rawPath of rawPaths) {
    let resolved;
    try {
      resolved = await canonicalizePath(rawPath, { provider, baseDir });
    } catch {
      const unresolved = unresolvedScope(['scope:path-unresolvable']);
      return {
        ...unresolved,
        resourceSnapshot: {
          resolverVersion: SEMANTIC_RESOLVER_VERSION,
          observedAt: options.now || new Date().toISOString(),
          identity: 'unresolved',
          provider: provider.name || 'fixture',
        },
        evidence: [...evidence, ...callerEvidence(caller)],
      };
    }
    resolvedPaths.push({
      requested: rawPath,
      canonical: resolved.canonicalPath,
      identity: resolved.identity,
      expectedParentIdentity: resolved.expectedParentIdentity,
      mountId: resolved.mountId,
      type: resolved.type,
      noFollow: Boolean(resolved.noFollow),
      symlinkChain: resolved.symlinkChain,
      missingPathSegments: resolved.missingPathSegments || [],
      parentIsDirectory: resolved.parentIsDirectory !== false,
    });
    if (resolved.noFollow) anyNoFollow = true;
    if (resolved.noFollow && resolved.parentIsDirectory === false) {
      unknowns.push('target:non-directory-parent');
    }

    const containment = containmentFor(resolved.canonicalPath, computedProjectRoot);
    if (containment === 'outside') {
      anyOutside = true;
      unknowns.push('scope:outside-project');
    }

    if (resolved.symlinkChain.length > 0 && containment === 'outside') {
      anySymlinkEscape = true;
      unknowns.push('scope:symlink-escape');
    }

    if (computedProjectRoot && projectMountId && resolved.mountId !== projectMountId) {
      anyMountBoundary = true;
      unknowns.push('scope:mount-boundary');
    }

    const sensitive = isSensitivePath(resolved.canonicalPath, sensitiveDirs, homeCanon);
    if (sensitive) anySensitive = true;
    if (isHomeCredentialPath(resolved.canonicalPath, homeCanon)) anyHomeCredential = true;
    if (isUnderDir(resolved.canonicalPath, '/etc')
      || isUnderDir(resolved.canonicalPath, '/var')
      || isUnderDir(resolved.canonicalPath, '/root')
      || isUnderDir(resolved.canonicalPath, '/usr')
      || isUnderDir(resolved.canonicalPath, '/bin')
      || isUnderDir(resolved.canonicalPath, '/sbin')) anySystem = true;
    if (resolved.canonicalPath === '/') anyFilesystemRoot = true;
    if (isUnderDir(resolved.canonicalPath, '/tmp') || isUnderDir(resolved.canonicalPath, '/var/tmp')) anyTmp = true;
    if (containsGitMetadataPath(resolved.canonicalPath)) anyGitMetadata = true;

    const generated = isGeneratedPath(resolved.canonicalPath, computedProjectRoot, generatedDirNames);
    if (generated) anyGenerated = true;

    let gitFacts = null;
    try {
      gitFacts = await provider.gitFacts(resolved.canonicalPath);
    } catch {
      gitFacts = null;
    }
    if (gitFacts && gitFacts.supported) {
      if (gitFacts.tracked) anyTracked = true;
      if (gitFacts.modified) anyModified = true;
      if (gitFacts.gitRoot) evidence.push({ field: 'gitRoot', computed: gitFacts.gitRoot });
    } else if (gitFacts && gitFacts.gitRoot) {
      evidence.push({ field: 'gitRoot', computed: gitFacts.gitRoot });
    }

    if (resolved.type === 'dir' && recursive) {
      const tree = await walkTree(provider, resolved.canonicalPath, options);
      totalItems += tree.count;
      totalSize += tree.size;
      if (!Number.isSafeInteger(totalSize)) unknowns.push('scope:file-size-unavailable');
      if (tree.unreadable) {
        anyUnreadable = true;
        unknowns.push('scope:tree-unreadable');
      }
      if (tree.exceeded) {
        anyExceeds = true;
        unknowns.push('tree:too-large');
      }
      if (tree.depthExceeded) {
        anyExceeds = true;
        unknowns.push('tree:depth-limit');
      }
      if (tree.containsSymlink) {
        anyTreeSymlink = true;
        unknowns.push('tree:contains-symlink');
      }
      if (tree.mountBoundary) {
        anyMountBoundary = true;
        unknowns.push('scope:mount-boundary');
      }
    } else if (resolved.type === 'dir' || resolved.type === 'file') {
      totalItems += 1;
      if (resolved.type === 'file' && (!Number.isSafeInteger(resolved.size) || resolved.size < 0)) {
        unknowns.push('scope:file-size-unavailable');
      } else {
        totalSize += Number.isSafeInteger(resolved.size) ? resolved.size : 0;
        if (!Number.isSafeInteger(totalSize)) unknowns.push('scope:file-size-unavailable');
      }
    } else {
      totalItems += 0;
    }

    if (options.previousSnapshot
      && options.previousSnapshot.expectedParentIdentity
      && options.previousSnapshot.expectedParentIdentity !== resolved.expectedParentIdentity) {
      revalidationRequired = true;
      unknowns.push('revalidation:parent-identity-changed');
    }
  }

  // caller 声明只进 evidence。
  if (caller.declaredScope !== undefined) {
    evidence.push({ field: 'declaredScope', declared: caller.declaredScope });
  }
  if (caller.declaredGenerated !== undefined) {
    evidence.push({ field: 'declaredGenerated', declared: caller.declaredGenerated });
  }
  if (caller.declaredSafe !== undefined) {
    evidence.push({ field: 'declaredSafe', declared: caller.declaredSafe });
  }
  evidence.push(...callerEvidence(caller));

  if (!computedProjectRoot) {
    unknowns.push('scope:trusted-project-root-unavailable');
  }

  const snapshotPaths = resolvedPaths.map((r) => ({
    requested: r.requested,
    canonical: r.canonical,
    identity: r.identity,
    expectedParentIdentity: r.expectedParentIdentity,
    mountId: r.mountId,
    noFollow: r.noFollow,
    symlinkChain: r.symlinkChain,
    missingPathSegments: r.missingPathSegments,
    parentIsDirectory: r.parentIsDirectory,
  }));
  const snapshotIdentity = stableIdentity(snapshotPaths);
  if (options.previousSnapshot) {
    const previous = options.previousSnapshot;
    if (!nonEmptyString(previous.identity) || !Array.isArray(previous.paths)) {
      revalidationRequired = true;
      unknowns.push('revalidation:snapshot-unverifiable');
    } else if (previous.resolverVersion !== SEMANTIC_RESOLVER_VERSION
      || previous.identity !== snapshotIdentity) {
      revalidationRequired = true;
      unknowns.push('revalidation:snapshot-changed');
    }
  }
  const incompleteScope = unknowns.some((code) => (
    code === 'scope:trusted-project-root-unavailable'
    || code === 'scope:file-size-unavailable'
    || code === 'scope:tree-unreadable'
    || code === 'tree:too-large'
    || code === 'tree:depth-limit'
    || code === 'tree:contains-symlink'
    || code === 'target:non-directory-parent'
    || code.startsWith('revalidation:')
  ));

  let kind = 'unknown';
  if (anyFilesystemRoot) kind = 'filesystem_root';
  else if (anySymlinkEscape) kind = 'symlink_escape';
  else if (anyHomeCredential) kind = 'home_credential';
  else if (anySystem) kind = 'system';
  else if (anyMountBoundary) kind = 'mount_boundary';
  else if (anyTmp) kind = 'tmp';
  else if (anyOutside) kind = 'outside_project';
  else if (computedProjectRoot) {
    const rootTarget = resolvedPaths.some((r) => r.canonical === computedProjectRoot);
    kind = rootTarget ? 'project_root' : (anyGenerated ? 'project_generated' : 'project');
  } else if (anySensitive) kind = 'sensitive';
  else kind = 'uncontained';

  const scope = {
    computed: Boolean(computedProjectRoot) && !incompleteScope,
    kind,
    ...(computedProjectRoot ? { projectRoot: computedProjectRoot } : {}),
    ...(projectMountId ? { mountId: projectMountId } : {}),
    containment: anyOutside ? 'outside' : (computedProjectRoot ? 'inside' : 'unavailable'),
    symlinkPolicy: SYMLINK_POLICY_REJECT_ESCAPE,
    expectedParentIdentity: resolvedPaths.map((r) => r.expectedParentIdentity).sort().join('|'),
  };
  const selfProtection = computeSelfProtectionFacts({
    canonicalPaths: resolvedPaths.map((entry) => entry.canonical),
    protectedRoots: options.selfProtectionRoots || deriveAgentoCSelfProtectionRoots({ platform: 'linux' }),
    workspaceRoot: trusted.workspaceRoot || trusted.projectRoot || '',
    platform: 'linux',
  });
  scope.selfProtection = selfProtection;
  evidence.push({ field: 'selfProtection', computed: selfProtection });
  if (anyMountBoundary) scope.mountBoundary = true;
  if (anySymlinkEscape) scope.symlinkEscape = true;
  if (anyNoFollow) scope.noFollow = true;
  if (anyTreeSymlink) scope.treeContainsSymlink = true;
  if (revalidationRequired) scope.revalidationRequired = true;

  const impact = {
    estimatedItems: totalItems,
    treeCount: totalItems,
    totalSize,
    containsTrackedFiles: anyTracked,
    containsModifiedFiles: anyModified,
    containsSensitiveMaterial: anySensitive,
    containsGitMetadata: anyGitMetadata,
    generated: anyGenerated,
    treeUnreadable: anyUnreadable,
    treeExceedsLimit: anyExceeds,
    reversible: false,
  };

  const resourceSnapshot = {
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    observedAt: options.now || new Date().toISOString(),
    identity: snapshotIdentity,
    paths: snapshotPaths,
    provider: provider.name || 'fixture',
  };

  return {
    scope,
    impact,
    resourceSnapshot,
    unknowns: dedupe(unknowns),
    evidence,
  };
}


function isUnderDir(canonicalPath, dir) {
  const t = canonicalPath.replace(/\/+$/, '');
  const d = dir.replace(/\/+$/, '');
  return t === d || t.startsWith(d + '/');
}

async function resolvePackageTarget(target, caller, options, provider) {
  const evidence = callerEvidence(caller);
  const query = {
    manager: target.manager || '',
    packages: target.packages || [],
    operation: target.operation || 'install',
  };
  let facts = null;
  try {
    facts = await provider.packageFacts(query);
  } catch {
    facts = null;
  }
  if (!facts) {
    const unresolved = unresolvedScope(['package:metadata-unavailable'], {
      estimatedItems: (query.packages || []).length,
    });
    return {
      ...unresolved,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        observedAt: options.now || new Date().toISOString(),
        identity: 'unresolved',
        provider: provider.name || 'fixture',
      },
      evidence,
    };
  }
  const packages = facts.packages || query.packages.map((name) => ({ name }));
  const source = facts.source || 'unknown';
  const unknowns = source === 'unknown' ? ['package:source-unverified'] : [];
  const scope = {
    computed: unknowns.length === 0,
    kind: 'system',
    manager: facts.manager || query.manager,
    packages,
    repositories: facts.repositories || [],
    source,
  };
  const impact = {
    estimatedItems: packages.length,
    treeCount: 0,
    totalSize: 0,
    containsTrackedFiles: false,
    containsModifiedFiles: false,
    containsSensitiveMaterial: false,
    containsGitMetadata: false,
    generated: false,
    treeUnreadable: false,
    treeExceedsLimit: false,
    reversible: false,
  };
  const resourceSnapshot = {
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    observedAt: options.now || new Date().toISOString(),
    identity: stableIdentity([
      {
        manager: scope.manager,
        packages: packages.map((p) => ({
          name: p.name,
          requestedVersion: p.requestedVersion || '',
          availableVersion: p.availableVersion || '',
        })).sort((left, right) => left.name.localeCompare(right.name)),
        source: scope.source,
        repositories: scope.repositories,
      },
    ]),
    manager: scope.manager,
    packages: packages.map((p) => ({
      name: p.name,
      requestedVersion: p.requestedVersion || '',
      availableVersion: p.availableVersion || '',
    })),
    source: scope.source,
    repositories: scope.repositories,
    provider: provider.name || 'fixture',
  };
  return { scope, impact, resourceSnapshot, unknowns, evidence };
}

async function resolveServiceTarget(target, caller, options, provider) {
  const evidence = callerEvidence(caller);
  const query = { unit: target.unit || '', action: target.action || '' };
  let facts = null;
  try {
    facts = await provider.serviceFacts(query);
  } catch {
    facts = null;
  }
  if (!facts) {
    const unresolved = unresolvedScope(['service:metadata-unavailable']);
    return {
      ...unresolved,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        observedAt: options.now || new Date().toISOString(),
        identity: 'unresolved',
        provider: provider.name || 'fixture',
      },
      evidence,
    };
  }
  const unknowns = facts.exists ? [] : ['service:unit-unavailable'];
  const scope = {
    computed: unknowns.length === 0,
    kind: 'system',
    manager: facts.manager || 'systemd',
    unit: facts.unit || query.unit,
    action: facts.action || query.action,
    exists: Boolean(facts.exists),
    active: Boolean(facts.active),
    definitionHash: facts.definitionHash || null,
  };
  const impact = {
    estimatedItems: 1,
    treeCount: 0,
    totalSize: 0,
    containsTrackedFiles: false,
    containsModifiedFiles: false,
    containsSensitiveMaterial: false,
    containsGitMetadata: false,
    generated: false,
    treeUnreadable: false,
    treeExceedsLimit: false,
    reversible: false,
  };
  const resourceSnapshot = {
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    observedAt: options.now || new Date().toISOString(),
    identity: stableIdentity([{ unit: scope.unit, action: scope.action, definitionHash: scope.definitionHash }]),
    unit: scope.unit,
    definitionHash: scope.definitionHash,
    provider: provider.name || 'fixture',
  };
  return { scope, impact, resourceSnapshot, unknowns, evidence };
}

async function resolveGitTarget(target, caller, options, provider) {
  const evidence = callerEvidence(caller);
  const trusted = trustedContext(options);
  const baseDir = trusted.cwd || trusted.projectRoot || '/';
  let projectRoot = null;
  if (trusted.projectRoot) {
    try {
      const canon = await canonicalizePath(trusted.projectRoot, { provider, baseDir: '/' });
      if (canon.exists) {
        projectRoot = canon.canonicalPath;
        evidence.push({ field: 'trustedProjectRoot', computed: projectRoot });
      }
    } catch {
      // 保持 null
    }
  }
  let gitFacts = null;
  try {
    gitFacts = await provider.gitFacts(projectRoot || baseDir);
  } catch {
    gitFacts = null;
  }
  const unknowns = [];
  if (!projectRoot) unknowns.push('scope:trusted-project-root-unavailable');
  if (!gitFacts || !gitFacts.supported) unknowns.push('git:metadata-unavailable');
  const modified = Boolean(gitFacts && gitFacts.modified);
  const scope = {
    computed: unknowns.length === 0,
    kind: projectRoot ? 'project' : 'uncontained',
    ...(projectRoot ? { projectRoot } : {}),
    remote: target.remote || '',
    ref: target.ref || '',
    force: target.force || false,
    dryRun: Boolean(target.dryRun),
  };
  const impact = {
    estimatedItems: 1,
    treeCount: 0,
    totalSize: 0,
    containsTrackedFiles: Boolean(gitFacts && gitFacts.tracked),
    containsModifiedFiles: modified,
    containsSensitiveMaterial: false,
    containsGitMetadata: false,
    generated: false,
    treeUnreadable: false,
    treeExceedsLimit: false,
    reversible: false,
  };
  const resourceSnapshot = {
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    observedAt: options.now || new Date().toISOString(),
    identity: stableIdentity([{ remote: target.remote || '', ref: target.ref || '', gitRoot: gitFacts && gitFacts.gitRoot }]),
    gitRoot: gitFacts && gitFacts.gitRoot,
    provider: provider.name || 'fixture',
  };
  return { scope, impact, resourceSnapshot, unknowns, evidence };
}

function resolveUnresolvableTarget(target, unknownMarker, options, provider) {
  const unresolved = unresolvedScope([unknownMarker]);
  return {
    ...unresolved,
    resourceSnapshot: {
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      observedAt: options.now || new Date().toISOString(),
      identity: 'unresolved',
      provider: provider.name || 'fixture',
    },
    evidence: [],
  };
}

function callerEvidence(caller) {
  const evidence = [];
  if (caller.cwd !== undefined) {
    evidence.push({ field: 'caller.cwd', declared: caller.cwd });
  }
  if (caller.projectRoot !== undefined) {
    evidence.push({ field: 'caller.projectRoot', declared: caller.projectRoot });
  }
  if (caller.home !== undefined) {
    evidence.push({ field: 'caller.home', declared: caller.home });
  }
  if (caller.declaredScope !== undefined) {
    evidence.push({ field: 'declaredScope', declared: caller.declaredScope });
  }
  if (caller.declaredGenerated !== undefined) {
    evidence.push({ field: 'declaredGenerated', declared: caller.declaredGenerated });
  }
  if (caller.declaredSafe !== undefined) {
    evidence.push({ field: 'declaredSafe', declared: caller.declaredSafe });
  }
  if (caller.declaredTrusted !== undefined) {
    evidence.push({ field: 'declaredTrusted', declared: caller.declaredTrusted });
  }
  return evidence;
}

/**
 * 服务端 context resolver 入口（fixture 注入模式）。
 *
 * @param {object} input
 * @param {object} [input.operation] 编译后的 SemanticOperation（取其 target）
 * @param {object} [input.target] 直接给 target 描述符（测试/独立使用）
 * @param {object} [input.caller] { cwd, projectRoot, home, declaredScope, declaredGenerated, declaredSafe }
 * @param {object} [input.options] { fsProvider, now, sensitiveDirs, generatedDirNames,
 *   maxTreeEntries, maxDepth, previousSnapshot }
 * @returns {Promise<{scope:object, impact:object, resourceSnapshot:object,
 *   unknowns:string[], evidence:object[]}>}
 */
export async function resolveSemanticContext({ operation, target, caller = {}, options = {} } = {}) {
  const t = target || (operation && operation.target);
  if (!t || typeof t !== 'object') {
    return { ...resolveUnresolvableTarget(null, 'scope:no-target', options, options.fsProvider || createDefaultFsProvider()), evidence: callerEvidence(caller) };
  }
  if (nonEmptyString(t.platform) && !RESOLVER_SUPPORTED_PLATFORMS.includes(t.platform)) {
    const provider = options.fsProvider || createDefaultFsProvider();
    const unresolved = resolveUnresolvableTarget(t, 'platform:unsupported', options, provider);
    // Diagnostic only: the platform stays unsupported and scope uncomputed.
    // Never let a caller's platform claim run a macOS inspection on another OS.
    if (process.platform === 'darwin' && t.platform === 'darwin'
        && t.kind === 'package_artifact' && t.manager === 'installer') {
      const preview = await inspectMacosPackagePreview({
        file: t.root,
        projectRoot: trustedContext(options).projectRoot,
      });
      unresolved.resourceSnapshot.macosPackagePreview = preview;
    }
    return { ...unresolved, evidence: callerEvidence(caller) };
  }
  if (t.platform === 'win32') {
    return resolveWindowsSemanticContext({ operation, target: t, caller, options });
  }
  const provider = options.fsProvider || createDefaultFsProvider();

  switch (t.kind) {
    case 'filesystem_file':
    case 'filesystem_tree':
    case 'filesystem_root':
    case 'filesystem_symlink':
    case 'credential_dir':
    case 'filesystem_batch':
      if (t.kind === 'filesystem_batch') {
        return {
          ...resolveUnresolvableTarget(t, 'scope:batch-targets-unresolved', options, provider),
          evidence: callerEvidence(caller),
        };
      }
      return resolveFilesystemTarget(t, caller, options, provider);
    case 'filesystem_glob':
      return {
        ...resolveUnresolvableTarget(t, 'target:glob', options, provider),
        evidence: callerEvidence(caller),
      };
    case 'variable':
      return {
        ...resolveUnresolvableTarget(t, 'target:variable-expansion', options, provider),
        evidence: callerEvidence(caller),
      };
    case 'remote_url':
      return {
        ...resolveUnresolvableTarget(t, 'target:remote-content-unpinned', options, provider),
        evidence: callerEvidence(caller),
      };
    case 'interpreter':
    case 'interpreter_code':
      return {
        ...resolveUnresolvableTarget(t, 'target:interpreter-code', options, provider),
        evidence: callerEvidence(caller),
      };
    case 'script_file':
      return {
        ...resolveUnresolvableTarget(t, 'target:script-content', options, provider),
        evidence: callerEvidence(caller),
      };
    case 'package':
    case 'package_artifact':
    case 'package_source':
      return resolvePackageTarget(t, caller, options, provider);
    case 'systemd_unit':
    case 'systemd_manager':
    case 'systemd_unit_file':
      return resolveServiceTarget(t, caller, options, provider);
    case 'git_remote':
    case 'git_remote_config':
      return resolveGitTarget(t, caller, options, provider);
    default:
      return {
        ...resolveUnresolvableTarget(t, 'scope:no-target', options, provider),
        evidence: callerEvidence(caller),
      };
  }
}

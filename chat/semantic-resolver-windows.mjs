/**
 * Server-owned Windows resource resolver facts.
 *
 * The default provider is a server-owned fixed-argv Windows facts adapter.
 * Callers may inject deterministic fixtures for contract tests, but caller
 * claims are retained only as evidence. This module is usable on Linux because
 * the default adapter fails closed unless the runtime platform is win32.
 */

import path from 'node:path';

import { SEMANTIC_RESOLVER_VERSION, sha256Hex } from './semantic-operation.mjs';
import {
  WINDOWS_ACL_PROVIDER,
  WINDOWS_SERVICE_MANAGER,
  validateWindowsAclFacts,
  validateWindowsServiceFacts,
} from './semantic-windows-boundary.mjs';
import {
  createWindowsRuntimeFactsProvider,
} from './windows-runtime-facts-provider.mjs';
import { computeSelfProtectionFacts, deriveRagentSelfProtectionRoots } from './self-protection.mjs';
import { systemPathRootsForPlatform } from './risk-policy.mjs';
import { validateWindowsSelectedInstallerFacts } from './windows-winget-installer-facts.mjs';
import { createWindowsPrivilegedBrokerClient } from './windows-privileged-broker.mjs';

export const WINDOWS_RESOLVER_PLATFORM = 'win32';
export const WINDOWS_RESOLVER_PROVIDER_VERSION = 'windows-resource-resolver/v1';

const WINDOWS_CREDENTIAL_SUFFIXES = Object.freeze([
  '\\AppData\\Roaming\\Microsoft\\Credentials',
  '\\AppData\\Local\\Microsoft\\Credentials',
  '\\AppData\\Roaming\\Microsoft\\Protect',
  '\\NTUSER.DAT',
]);
const WINDOWS_PROFILE_SENSITIVE = /(?:^|\\)(?:ntuser\.dat(?:\.log\d*)?|appdata\\(?:local|roaming)\\microsoft\\(?:credentials|protect))(?:\\|$)/i;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function dedupe(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = sortKeysDeep(value[key]);
    return output;
  }
  return value;
}

function stableIdentity(value) {
  return sha256Hex(JSON.stringify(sortKeysDeep(value)));
}

function trustedContext(options = {}) {
  const context = options.trustedContext || {};
  return {
    cwd: trimString(context.cwd),
    projectRoot: trimString(context.projectRoot),
    home: trimString(context.home),
    workspaceRoot: trimString(context.workspaceRoot),
  };
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function normalize(value) {
  return path.win32.normalize(String(value || '')).replace(/[\\/]+$/, (match) => match.includes('\\') ? '\\' : match);
}

function samePath(left, right) {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

function contained(root, candidate) {
  if (!root || !candidate) return false;
  const relative = path.win32.relative(normalize(root), normalize(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative));
}

function isSensitivePath(candidate, home, additionalRoots = []) {
  const value = normalize(candidate).toLowerCase();
  const roots = [...systemPathRootsForPlatform('win32'), ...additionalRoots].filter((root) => typeof root === 'string');
  if (roots.some((root) => contained(root, candidate))) return true;
  if (/^[a-z]:\\(?:system volume information|\$recycle\.bin)(?:\\|$)/i.test(value)) return true;
  if (WINDOWS_PROFILE_SENSITIVE.test(value)) return true;
  if (home && WINDOWS_CREDENTIAL_SUFFIXES.some((suffix) => value === `${normalize(home)}${suffix}`.toLowerCase() || value.startsWith(`${normalize(home)}${suffix}\\`.toLowerCase()))) return true;
  return false;
}

async function statFacts(provider, canonicalPath) {
  const result = await provider.stat(canonicalPath);
  return {
    type: result.type || 'other',
    identity: trimString(result.identity) || `${result.volumeSerial || ''}:${result.fileId || ''}`,
    mountId: trimString(result.mountId) || trimString(result.volumeSerial),
    size: Number.isFinite(result.size) ? result.size : null,
    reparsePoint: result.reparsePoint === true || result.type === 'reparse-point' || result.type === 'symlink',
  };
}

async function canonicalize(rawPath, provider, baseDir) {
  const value = trimString(rawPath);
  if (!value || value.includes('\0')) throw Object.assign(new Error('Windows path is invalid'), { code: 'EINVAL' });
  if (!path.win32.isAbsolute(value) && (!baseDir || !path.win32.isAbsolute(baseDir))) {
    throw Object.assign(new Error('Windows relative path has no trusted absolute base'), { code: 'EINVAL' });
  }
  const absolute = path.win32.normalize(path.win32.isAbsolute(value) ? value : path.win32.resolve(baseDir, value));
  let linkFacts = null;
  if (typeof provider.lstat === 'function') {
    try { linkFacts = await statFacts(provider, absolute); } catch {}
  }
  try {
    const real = normalize(await provider.realpath(absolute));
    const facts = await statFacts(provider, real);
    const parent = path.win32.dirname(real);
    let parentFacts = null;
    try { parentFacts = await statFacts(provider, parent); } catch {}
    return {
      requested: value,
      canonical: real,
      identity: facts.identity,
      mountId: facts.mountId,
      type: facts.type,
      size: facts.size,
      reparsePoint: Boolean(linkFacts?.reparsePoint || facts.reparsePoint),
      expectedParentIdentity: parentFacts?.identity || '',
      noFollow: false,
      symlinkChain: [],
      missingPathSegments: [],
      parentIsDirectory: true,
    };
  } catch (error) {
    if (!isMissing(error)) throw error;
    let probe = absolute;
    const missing = [];
    while (probe && probe !== path.win32.dirname(probe)) {
      try {
        await statFacts(provider, probe);
        // The target does not exist, so resolve the closest existing ancestor
        // before appending the missing components. Otherwise a junction in the
        // ancestor can make a protected destination appear to be in the project.
        const realParent = normalize(await provider.realpath(probe));
        const parentFacts = await statFacts(provider, realParent);
        const resolvedPath = path.win32.join(realParent, ...missing);
        return {
          requested: value,
          canonical: resolvedPath,
          identity: `no-follow:${parentFacts.identity}:${missing.join('\\')}`,
          mountId: parentFacts.mountId,
          type: 'file',
          size: null,
          expectedParentIdentity: parentFacts.identity,
          noFollow: true,
          symlinkChain: [],
          missingPathSegments: [...missing],
          parentIsDirectory: parentFacts.type === 'dir',
          reparsePoint: !samePath(probe, realParent) || parentFacts.reparsePoint,
        };
      } catch (parentError) {
        if (!isMissing(parentError)) throw parentError;
        missing.unshift(path.win32.basename(probe));
        probe = path.win32.dirname(probe);
      }
    }
    throw error;
  }
}

async function walkTree(provider, root, options = {}) {
  const maxEntries = Number.isFinite(Number(options.maxTreeEntries)) ? Number(options.maxTreeEntries) : 10_000;
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 32;
  const queue = [{ path: root, depth: 0 }];
  let count = 0;
  let size = 0;
  let unreadable = false;
  let exceeded = false;
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try { entries = await provider.readdir(current.path); } catch { unreadable = true; continue; }
    for (const entry of entries || []) {
      count += 1;
      if (count > maxEntries) { exceeded = true; return { count, size, unreadable, exceeded, depthExceeded: false }; }
      const child = path.win32.join(current.path, entry.name);
      let facts;
      try { facts = await statFacts(provider, child); } catch { unreadable = true; continue; }
      if (facts.reparsePoint) continue;
      size += Number.isFinite(facts.size) ? facts.size : 0;
      if (facts.type === 'dir') {
        if (current.depth + 1 >= maxDepth) return { count, size, unreadable, exceeded, depthExceeded: true };
        queue.push({ path: child, depth: current.depth + 1 });
      }
    }
  }
  return { count, size, unreadable, exceeded, depthExceeded: false };
}

function callerEvidence(caller = {}) {
  return Object.entries(caller)
    .filter(([key]) => ['cwd', 'projectRoot', 'home', 'declaredScope', 'declaredSafe'].includes(key))
    .map(([field, declared]) => ({ field: `caller.${field}`, declared }));
}

function unresolved(unknowns, provider, options, caller) {
  return {
    scope: { computed: false, kind: 'unresolvable', containment: 'unavailable' },
    impact: {
      estimatedItems: 0, treeCount: 0, totalSize: 0, containsTrackedFiles: false,
      containsModifiedFiles: false, containsSensitiveMaterial: false, containsGitMetadata: false,
      generated: false, treeUnreadable: false, treeExceedsLimit: false, reversible: false,
    },
    resourceSnapshot: {
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      observedAt: options.now || new Date().toISOString(),
      identity: 'unresolved',
      provider: provider.name || WINDOWS_RESOLVER_PROVIDER_VERSION,
    },
    unknowns: dedupe(unknowns),
    evidence: callerEvidence(caller),
  };
}

async function resolveFilesystem(target, caller, options, provider) {
  const trusted = trustedContext(options);
  const systemRoots = Array.isArray(options.trustedContext?.systemPathRoots) ? options.trustedContext.systemPathRoots : [];
  let projectRoot = '';
  try {
    projectRoot = trusted.projectRoot ? (await canonicalize(trusted.projectRoot, provider, trusted.cwd)).canonical : '';
  } catch {}
  const resolved = await canonicalize(target.root, provider, trusted.cwd || projectRoot);
  const unknowns = [];
  const outside = projectRoot ? !contained(projectRoot, resolved.canonical) : true;
  if (!projectRoot) unknowns.push('scope:trusted-project-root-unavailable');
  // A resolved outside path is a location fact, not an unknown. The policy
  // separately checks the operation and its outside_project classification.
  if (resolved.noFollow && resolved.parentIsDirectory === false) unknowns.push('target:non-directory-parent');
  if (resolved.reparsePoint) unknowns.push('target:reparse-point');
  if (isSensitivePath(resolved.canonical, trusted.home, systemRoots)) unknowns.push('scope:windows-sensitive-path');
  let tree = { count: 1, size: resolved.size || 0, unreadable: false, exceeded: false, depthExceeded: false };
  if (target.recursive && resolved.type === 'dir') tree = await walkTree(provider, resolved.canonical, options);
  if (tree.unreadable) unknowns.push('scope:tree-unreadable');
  if (tree.exceeded) unknowns.push('tree:too-large');
  if (tree.depthExceeded) unknowns.push('tree:depth-limit');
  const snapshotPath = {
    requested: resolved.requested,
    canonical: resolved.canonical,
    identity: resolved.identity,
    expectedParentIdentity: resolved.expectedParentIdentity,
    mountId: resolved.mountId,
    noFollow: resolved.noFollow,
    symlinkChain: resolved.symlinkChain,
    missingPathSegments: resolved.missingPathSegments,
    parentIsDirectory: resolved.parentIsDirectory,
    reparsePoint: resolved.reparsePoint,
  };
  const kind = isSensitivePath(resolved.canonical, trusted.home, systemRoots) ? 'sensitive'
    : outside ? 'outside_project' : (target.recursive ? 'project' : 'project');
  const selfProtection = computeSelfProtectionFacts({
    canonicalPaths: [resolved.canonical],
    protectedRoots: options.selfProtectionRoots || deriveRagentSelfProtectionRoots({ platform: 'win32' }),
    workspaceRoot: trusted.workspaceRoot || trusted.projectRoot || '',
    platform: 'win32',
  });
  return {
    scope: {
      computed: unknowns.length === 0,
      kind,
      ...(projectRoot ? { projectRoot } : {}),
      containment: outside ? 'outside' : 'inside',
      expectedParentIdentity: resolved.expectedParentIdentity,
      ...(resolved.noFollow ? { noFollow: true } : {}),
      selfProtection,
    },
    impact: {
      estimatedItems: tree.count,
      treeCount: tree.count,
      totalSize: tree.size,
      containsTrackedFiles: false,
      containsModifiedFiles: false,
      containsSensitiveMaterial: isSensitivePath(resolved.canonical, trusted.home, systemRoots),
      containsGitMetadata: false,
      generated: false,
      treeUnreadable: tree.unreadable,
      treeExceedsLimit: tree.exceeded || tree.depthExceeded,
      reversible: false,
    },
    resourceSnapshot: {
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      observedAt: options.now || new Date().toISOString(),
      identity: stableIdentity([snapshotPath]),
      paths: [snapshotPath],
      provider: provider.name || WINDOWS_RESOLVER_PROVIDER_VERSION,
    },
    unknowns: dedupe(unknowns),
    evidence: callerEvidence(caller),
  };
}

async function resolvePackage(target, caller, options, provider) {
  const facts = await provider.packageFacts({ manager: target.manager, packages: target.packages, requestedVersion: target.requestedVersion || '', operation: target.operation || 'install' }).catch(() => null);
  if (!facts) return unresolved(['package:metadata-unavailable'], provider, options, caller);
  const packages = Array.isArray(facts.packages) ? facts.packages : [];
  const names = (target.packages || []).map(trimString).sort();
  const factNames = packages.map((entry) => trimString(entry.name)).sort();
  const unknowns = [];
  if (facts.manager !== target.manager || JSON.stringify(names) !== JSON.stringify(factNames)) unknowns.push('package:target-mismatch');
  if (facts.source !== target.source || facts.sourceTrust !== 'configured') unknowns.push('package:source-unverified');
  if (target.exact !== true) unknowns.push('package:exact-match-required');
  let selectedInstaller = null;
  if (facts.selectedInstaller != null) {
    const resolvedPackage = packages.length === 1 ? packages[0] : null;
    selectedInstaller = validateWindowsSelectedInstallerFacts(facts.selectedInstaller, {
      packageId: resolvedPackage?.name, packageVersion: resolvedPackage?.availableVersion,
    });
    if (!selectedInstaller) unknowns.push('package:selected-installer-unverified');
  }
  const snapshot = {
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    observedAt: options.now || new Date().toISOString(),
    manager: facts.manager,
    source: facts.source,
    sourceTrust: facts.sourceTrust,
    packages: packages.map((entry) => ({ name: entry.name, requestedVersion: entry.requestedVersion || '', availableVersion: entry.availableVersion || '' })),
    repositories: facts.repositories || [],
    ...(selectedInstaller ? { selectedInstaller } : {}),
    identity: stableIdentity([{ manager: facts.manager, source: facts.source, packages, repositories: facts.repositories || [], ...(selectedInstaller ? { selectedInstaller } : {}) }]),
    provider: provider.name || WINDOWS_RESOLVER_PROVIDER_VERSION,
  };
  return {
    scope: { computed: unknowns.length === 0, kind: 'system', manager: facts.manager, packages, source: facts.source },
    impact: { estimatedItems: packages.length, treeCount: 0, totalSize: 0, containsTrackedFiles: false, containsModifiedFiles: false, containsSensitiveMaterial: false, containsGitMetadata: false, generated: false, treeUnreadable: false, treeExceedsLimit: false, reversible: false },
    resourceSnapshot: snapshot,
    unknowns,
    evidence: callerEvidence(caller),
  };
}

async function resolvePackageArtifact(target, caller, options, provider) {
  const trusted = trustedContext(options);
  const resolved = await canonicalize(target.root, provider, trusted.cwd);
  const facts = await provider.artifactFacts({ canonicalPath: resolved.canonical }).catch(() => null);
  const digest = trimString(facts?.digest).toLowerCase();
  const identity = trimString(facts?.identity);
  const unknowns = [];
  if (!facts || facts.exists !== true || !identity || !/^[0-9a-f]{64}$/.test(digest)) {
    unknowns.push('package:artifact-unverified');
  }
  if (target.digest && target.digest !== 'unverified' && target.digest.toLowerCase() !== digest) {
    unknowns.push('package:artifact-digest-changed');
  }
  const snapshot = {
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    observedAt: options.now || new Date().toISOString(),
    identity: stableIdentity([{ path: resolved.canonical, identity, digest }]),
    artifactPath: resolved.canonical,
    artifactIdentity: identity,
    artifactDigest: digest,
    provider: provider.name || WINDOWS_RESOLVER_PROVIDER_VERSION,
  };
  return {
    scope: { computed: unknowns.length === 0, kind: 'system', manager: target.manager, source: target.source, artifactPath: resolved.canonical },
    impact: { estimatedItems: 1, treeCount: 0, totalSize: Number(facts?.size) || 0, containsTrackedFiles: false, containsModifiedFiles: false, containsSensitiveMaterial: false, containsGitMetadata: false, generated: false, treeUnreadable: false, treeExceedsLimit: false, reversible: false },
    resourceSnapshot: snapshot,
    unknowns,
    evidence: callerEvidence(caller),
  };
}

async function resolveService(target, caller, options, provider) {
  const facts = await provider.serviceFacts({ serviceName: target.serviceName, action: target.action }).catch(() => null);
  const checked = validateWindowsServiceFacts(facts || {}, { serviceName: target.serviceName });
  if (!checked.ok) return unresolved([`service:${checked.code.toLowerCase()}`], provider, options, caller);
  return {
    scope: { computed: true, kind: 'system', manager: WINDOWS_SERVICE_MANAGER, serviceName: checked.serviceName, action: target.action, definitionHash: checked.definitionHash },
    impact: { estimatedItems: 1, treeCount: 0, totalSize: 0, containsTrackedFiles: false, containsModifiedFiles: false, containsSensitiveMaterial: false, containsGitMetadata: false, generated: false, treeUnreadable: false, treeExceedsLimit: false, reversible: false },
    resourceSnapshot: { resolverVersion: SEMANTIC_RESOLVER_VERSION, observedAt: options.now || new Date().toISOString(), identity: stableIdentity([{ serviceName: checked.serviceName, definitionHash: checked.definitionHash }]), serviceName: checked.serviceName, definitionHash: checked.definitionHash, provider: provider.name || WINDOWS_RESOLVER_PROVIDER_VERSION },
    unknowns: [],
    evidence: callerEvidence(caller),
  };
}

async function resolveAcl(target, caller, options, provider) {
  const resolved = await canonicalize(target.root, provider, trustedContext(options).cwd);
  const facts = await provider.aclFacts({ canonicalPath: resolved.canonical }).catch(() => null);
  const checked = validateWindowsAclFacts(facts || {}, { canonicalPath: resolved.canonical });
  if (!checked.ok) return unresolved([`acl:${checked.code.toLowerCase()}`], provider, options, caller);
  return {
    scope: { computed: true, kind: 'system', provider: WINDOWS_ACL_PROVIDER, canonicalPath: resolved.canonical },
    impact: { estimatedItems: 1, treeCount: 0, totalSize: 0, containsTrackedFiles: false, containsModifiedFiles: false, containsSensitiveMaterial: true, containsGitMetadata: false, generated: false, treeUnreadable: false, treeExceedsLimit: false, reversible: false },
    resourceSnapshot: { resolverVersion: SEMANTIC_RESOLVER_VERSION, observedAt: options.now || new Date().toISOString(), identity: stableIdentity([{ path: resolved.canonical, identity: resolved.identity, descriptorHash: checked.descriptorHash }]), paths: [{ requested: resolved.requested, canonical: resolved.canonical, identity: resolved.identity, expectedParentIdentity: resolved.expectedParentIdentity, mountId: resolved.mountId, noFollow: resolved.noFollow, symlinkChain: [], missingPathSegments: [], parentIsDirectory: resolved.parentIsDirectory }], acl: checked, provider: provider.name || WINDOWS_RESOLVER_PROVIDER_VERSION },
    unknowns: [],
    evidence: callerEvidence(caller),
  };
}

export function createDefaultWindowsFactsProvider({
  platform = process.platform,
  serviceMode = process.env.RAGENT_WINDOWS_SERVICE_MODE === '1',
  createProvider = createWindowsRuntimeFactsProvider,
  broker = createWindowsPrivilegedBrokerClient(),
} = {}) {
  const provider = createProvider({
    // The provider itself fails closed on non-Windows hosts. Keeping this
    // default server-owned object available preserves the resolver contract
    // while allowing Linux tests and deployments to resolve Windows targets
    // only through an explicit fixture/provider.
    platform,
    timeoutMs: 5_000,
    serviceInspector: broker.inspectService,
  });
  if (platform !== 'win32' || !serviceMode) return provider;
  const originalPackageFacts = provider.packageFacts.bind(provider);
  provider.packageFacts = async (input) => {
    const direct = await originalPackageFacts(input);
    if (direct) return direct;
    const id = input?.packages?.[0];
    const version = input?.requestedVersion;
    if (input?.manager !== 'winget' || input?.operation !== 'install'
      || input?.packages?.length !== 1 || typeof id !== 'string' || typeof version !== 'string' || !version) return null;
    // The native broker pins the WinGet module and validates the trusted
    // source, exact package/version and selected installer before returning
    // these facts. This read-only request grants no installation authority.
    let selected;
    try { selected = await broker.inspectAutoInstall({ packageId: id, packageVersion: version }); }
    catch { return null; }
    const verified = validateWindowsSelectedInstallerFacts(selected, { packageId: id, packageVersion: version });
    if (!verified || verified.source !== 'winget' || verified.scope !== 'System') return null;
    return { manager: 'winget', source: 'winget', sourceTrust: 'configured',
      packages: [{ name: id, requestedVersion: version, availableVersion: version }],
      repositories: [{ id: 'winget', trust: 'configured' }], selectedInstaller: verified };
  };
  return provider;
}

export async function resolveWindowsSemanticContext({ operation, target, caller = {}, options = {} } = {}) {
  const provider = options.windowsFactsProvider || options.fsProvider || createDefaultWindowsFactsProvider();
  const descriptor = target || operation?.target;
  if (!descriptor || typeof descriptor !== 'object') return unresolved(['scope:no-target'], provider, options, caller);
  if (descriptor.platform !== 'win32') return unresolved(['platform:unsupported'], provider, options, caller);
  try {
    if (['filesystem_file', 'filesystem_tree', 'filesystem_root', 'filesystem_symlink'].includes(descriptor.kind)) return await resolveFilesystem(descriptor, caller, options, provider);
    if (descriptor.kind === 'package') return await resolvePackage(descriptor, caller, options, provider);
    if (descriptor.kind === 'package_artifact') return await resolvePackageArtifact(descriptor, caller, options, provider);
    if (descriptor.kind === 'windows_service') return await resolveService(descriptor, caller, options, provider);
    if (descriptor.kind === 'windows_acl') return await resolveAcl(descriptor, caller, options, provider);
  } catch (error) {
    return unresolved([`resolver:${trimString(error?.code) || 'facts-unavailable'}`], provider, options, caller);
  }
  return unresolved(['scope:windows-target-unsupported'], provider, options, caller);
}

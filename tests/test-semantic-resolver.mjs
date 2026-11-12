#!/usr/bin/env node
import assert from 'assert/strict';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  createDefaultFsProvider,
  statToFacts,
  resolveSemanticContext,
  RESOLVER_PLATFORM,
  SEMANTIC_RESOLVER_VERSION,
} from '../chat/semantic-resolver.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const NOW = '2026-08-11T00:00:00.000Z';

function makeFixture(overrides = {}) {
  const tree = new Map();
  const put = (p, facts) => {
    tree.set(path.normalize(p), { dev: 'dev1', ino: 0, size: 0, type: 'file', ...facts });
  };
  put('/project', { type: 'dir', ino: 100 });
  put('/project/build', { type: 'dir', ino: 101 });
  put('/project/build/cache', { type: 'dir', ino: 102 });
  put('/project/build/cache/x.o', { type: 'file', ino: 103, size: 100 });
  put('/project/build/cache/y.o', { type: 'file', ino: 104, size: 200 });
  put('/project/app.js', { type: 'file', ino: 105, size: 50 });
  put('/project/.git', { type: 'dir', ino: 106 });
  put('/project/link', { type: 'symlink', target: '/home/user/secret', ino: 107 });
  put('/project/mount-sub', { type: 'dir', dev: 'dev2', ino: 108 });
  put('/project/mount-sub/f.txt', { type: 'file', dev: 'dev2', ino: 109, size: 10 });
  put('/home/user', { type: 'dir', ino: 200 });
  put('/home/user/.ssh', { type: 'dir', ino: 201 });
  put('/home/user/.ssh/id_rsa', { type: 'file', ino: 202, size: 10 });
  put('/home/user/secret', { type: 'file', ino: 203, size: 10 });
  put('/etc', { type: 'dir', dev: 'dev0', ino: 300 });
  put('/etc/passwd', { type: 'file', dev: 'dev0', ino: 301, size: 500 });
  put('/tmp', { type: 'dir', dev: 'dev9', ino: 400 });
  put('/tmp/x', { type: 'file', dev: 'dev9', ino: 401, size: 10 });

  const lookup = (p) => tree.get(path.normalize(p)) || null;
  const follow = (p) => {
    const entry = lookup(p);
    return entry && entry.type === 'symlink' ? path.normalize(entry.target) : path.normalize(p);
  };
  const missing = () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    return err;
  };

  const provider = {
    name: 'fixture',
    async realpath(p) {
      const n = follow(p);
      if (!lookup(n)) throw missing();
      return n;
    },
    async lstat(p) {
      const e = lookup(p);
      if (!e) throw missing();
      return {
        type: e.type,
        symlink: e.type === 'symlink',
        symlinkTarget: e.target || null,
        dev: e.dev,
        ino: e.ino,
        size: e.size,
        mountId: String(e.dev),
        identity: `${e.dev}:${e.ino}`,
      };
    },
    async stat(p) {
      const e = lookup(follow(p));
      if (!e) throw missing();
      return {
        type: e.type,
        dev: e.dev,
        ino: e.ino,
        size: e.size,
        mountId: String(e.dev),
        identity: `${e.dev}:${e.ino}`,
      };
    },
    async readdir(p) {
      const n = path.normalize(p);
      const prefix = n === '/' ? '/' : `${n}/`;
      const children = [...tree.keys()]
        .filter((k) => k.startsWith(prefix) && k.slice(prefix.length).indexOf('/') === -1);
      if (children.length === 0 && !lookup(n)) throw missing();
      return children.map((k) => ({ name: k.slice(prefix.length), type: tree.get(k).type }));
    },
    async mountId(p) { return String((await provider.stat(p)).dev); },
    async identity(p) { return (await provider.stat(p)).identity; },
    gitFacts: overrides.gitFacts || (async () => ({ supported: false, gitRoot: null, tracked: null, modified: null })),
    packageFacts: overrides.packageFacts || null,
    serviceFacts: overrides.serviceFacts || null,
  };
  if (overrides.mutate) overrides.mutate({ tree, put, provider, lookup });
  return { tree, put, provider, lookup };
}

function opts(provider, extra = {}) {
  return {
    fsProvider: provider.provider,
    now: NOW,
    maxTreeEntries: 1000,
    maxDepth: 16,
    trustedContext: { cwd: '/project', projectRoot: '/project', home: '/home/user' },
    ...extra,
  };
}

const caller = {
  cwd: '/project',
  projectRoot: '/project',
  home: '/home/user',
};

// --- 版本常量 / provider 契约 ---

eq('resolver version pinned', SEMANTIC_RESOLVER_VERSION, 'semantic-resolver/v1');
const defaultProvider = createDefaultFsProvider();
check('default provider shape', typeof defaultProvider.realpath === 'function'
  && typeof defaultProvider.lstat === 'function'
  && typeof defaultProvider.readdir === 'function'
  && typeof defaultProvider.stat === 'function');
eq('default provider git shadow', defaultProvider.gitFacts && typeof defaultProvider.gitFacts === 'function', true);
const largeFacts = statToFacts({
  dev: 9007199254740993n, ino: 9007199254740995n, size: 9007199254740997n,
  isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
});
eq('large identity retains exact integers', largeFacts.identity, '9007199254740993:9007199254740995');
eq('unrepresentable advisory size is unknown', largeFacts.size, null);
const ownPath = fileURLToPath(import.meta.url);
const actualStat = await stat(ownPath, { bigint: true });
const actualFacts = await defaultProvider.stat(ownPath);
eq('default provider identity matches native bigints', actualFacts.identity, `${actualStat.dev}:${actualStat.ino}`);
eq('default identity probe matches native bigints', await defaultProvider.identity(ownPath), `${actualStat.dev}:${actualStat.ino}`);
const unknownSizeFixture = makeFixture({ mutate: ({ put }) => put('/project/app.js', { type: 'file', ino: 105, size: null }) });
const unknownSize = await resolveSemanticContext({
  target: { kind: 'filesystem_file', root: '/project/app.js' }, caller, options: opts(unknownSizeFixture),
});
eq('unknown file size cannot produce complete scope', unknownSize.scope.computed, false);
check('unknown file size is recorded', unknownSize.unknowns.includes('scope:file-size-unavailable'));
const unknownTreeFixture = makeFixture({ mutate: ({ put }) => put('/project/build/cache/x.o', { type: 'file', ino: 103, size: null }) });
const unknownTree = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true }, caller, options: opts(unknownTreeFixture),
});
eq('unknown tree file size cannot produce complete scope', unknownTree.scope.computed, false);
check('unknown tree file size is recorded', unknownTree.unknowns.includes('scope:tree-unreadable'));

// --- golden：项目内普通删除 ---

const golden = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(fixture1()),
});
function fixture1() { return makeFixture(); }

eq('golden scope computed', golden.scope.computed, true);
eq('golden scope kind project_generated', golden.scope.kind, 'project_generated');
eq('golden projectRoot computed', golden.scope.projectRoot, '/project');
eq('golden containment inside', golden.scope.containment, 'inside');
eq('golden symlinkPolicy', golden.scope.symlinkPolicy, 'reject_escape');
eq('golden expectedParentIdentity', golden.scope.expectedParentIdentity, 'dev1:101');
eq('golden impact items', golden.impact.estimatedItems, 2);
eq('golden impact treeCount', golden.impact.treeCount, 2);
eq('golden impact totalSize', golden.impact.totalSize, 300);
eq('golden generated', golden.impact.generated, true);
eq('golden no sensitive', golden.impact.containsSensitiveMaterial, false);
eq('golden snapshot version', golden.resourceSnapshot.resolverVersion, SEMANTIC_RESOLVER_VERSION);
eq('golden snapshot observedAt', golden.resourceSnapshot.observedAt, NOW);
check('golden snapshot identity present', typeof golden.resourceSnapshot.identity === 'string' && golden.resourceSnapshot.identity.length > 0);
eq('golden snapshot canonical', golden.resourceSnapshot.paths[0].canonical, '/project/build/cache');
eq('golden snapshot noFollow', golden.resourceSnapshot.paths[0].noFollow, false);
eq('golden unknowns empty', golden.unknowns.length, 0);

// --- caller 声明只进 evidence；服务端 trustedContext 独立决定 scope ---

const conflict = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/home/user/secret', recursive: true },
  caller: {
    cwd: '/home/user',
    projectRoot: '/home/user',
    home: '/home/user',
    declaredScope: { kind: 'home_credential', computed: true },
    declaredGenerated: true,
  },
  options: opts(fixture2()),
});
function fixture2() { return makeFixture(); }
eq('conflict computed projectRoot wins', conflict.scope.projectRoot, '/project');
eq('conflict scope kind computed wins', conflict.scope.kind, 'outside_project');
eq('conflict computed scope not declared', conflict.scope.computed === true && conflict.scope.kind !== 'home_credential', true);
eq('conflict generated computed false', conflict.scope.generated === undefined || conflict.scope.generated === false, true);
check('conflict evidence has declaredScope',
  conflict.evidence.some((e) => e.field === 'declaredScope' && e.declared && e.declared.kind === 'home_credential'));
check('conflict evidence has declaredGenerated',
  conflict.evidence.some((e) => e.field === 'declaredGenerated' && e.declared === true));
check('conflict evidence has fake projectRoot',
  conflict.evidence.some((e) => e.field === 'caller.projectRoot' && e.declared === '/home/user'));
check('scope never carries declared fields', !Object.keys(conflict.scope).some((k) => k.startsWith('declared')));

// --- 动态 target（$TARGET）→ computed=false ---

const dynamic = await resolveSemanticContext({
  target: { kind: 'variable', variableName: 'TARGET' },
  caller,
  options: opts(fixture3()),
});
function fixture3() { return makeFixture(); }
eq('variable scope computed false', dynamic.scope.computed, false);
eq('variable scope kind', dynamic.scope.kind, 'unresolvable');
check('variable unknown marker', dynamic.unknowns.includes('target:variable-expansion'));
eq('variable snapshot identity', dynamic.resourceSnapshot.identity, 'unresolved');

// --- symlink 逃逸 ---

const symlinkFixture = makeFixture();
const symlink = await resolveSemanticContext({
  target: { kind: 'filesystem_symlink', root: '/project/link', recursive: false },
  caller,
  options: opts(symlinkFixture),
});
eq('symlink canonical target', symlink.resourceSnapshot.paths[0].canonical, '/home/user/secret');
check('symlink escape unknown', symlink.unknowns.includes('scope:symlink-escape'));
eq('symlink scope kind', symlink.scope.kind, 'symlink_escape');
eq('symlink scope flag', symlink.scope.symlinkEscape, true);
eq('symlink containment outside', symlink.scope.containment, 'outside');
eq('symlink chain detected', symlink.resourceSnapshot.paths[0].symlinkChain.length, 1);
eq('symlink chain target', symlink.resourceSnapshot.paths[0].symlinkChain[0].target, '/home/user/secret');

// --- mount 逃逸 ---

const mountFixture = makeFixture();
const mount = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/mount-sub', recursive: true },
  caller,
  options: opts(mountFixture),
});
check('mount boundary unknown', mount.unknowns.includes('scope:mount-boundary'));
eq('mount scope flag', mount.scope.mountBoundary, true);
eq('mount scope kind', mount.scope.kind, 'mount_boundary');
eq('mount path mountId dev2', mount.resourceSnapshot.paths[0].mountId, 'dev2');

// --- 敏感目录：~/.ssh ---

const sshFixture = makeFixture();
const ssh = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/home/user/.ssh', recursive: true },
  caller,
  options: opts(sshFixture),
});
eq('ssh scope kind', ssh.scope.kind, 'home_credential');
eq('ssh sensitive', ssh.impact.containsSensitiveMaterial, true);
check('ssh outside unknown', ssh.unknowns.includes('scope:outside-project'));
eq('ssh containment outside', ssh.scope.containment, 'outside');

// --- .git / tracked / modified ---

const gitFixture = makeFixture();
const gitMeta = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/.git', recursive: true },
  caller,
  options: opts(gitFixture),
});
eq('git metadata detected', gitMeta.impact.containsGitMetadata, true);

const gitTrackedFixture = makeFixture({
  gitFacts: async (p) => ({
    supported: true,
    gitRoot: '/project',
    tracked: p.startsWith('/project/'),
    modified: p.startsWith('/project/') && !p.includes('/.git'),
  }),
});
const gitTracked = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(gitTrackedFixture),
});
eq('tracked files detected', gitTracked.impact.containsTrackedFiles, true);
eq('modified files detected', gitTracked.impact.containsModifiedFiles, true);

// --- 路径越界（../ 归一化后 containment=outside） ---

const traversalFixture = makeFixture();
const traversal = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/../etc/passwd', recursive: false },
  caller,
  options: opts(traversalFixture),
});
eq('traversal canonical', traversal.resourceSnapshot.paths[0].canonical, '/etc/passwd');
eq('traversal scope kind', traversal.scope.kind, 'system');
check('traversal outside unknown', traversal.unknowns.includes('scope:outside-project'));
eq('traversal containment outside', traversal.scope.containment, 'outside');

// --- 父目录替换 race fixture ---

const raceFixture = makeFixture();
const first = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(raceFixture),
});
eq('race first parent identity', first.scope.expectedParentIdentity, 'dev1:101');
raceFixture.tree.set(path.normalize('/project/build'), { type: 'dir', dev: 'dev1', ino: 999, size: 0 });
const second = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(raceFixture, { previousSnapshot: first.resourceSnapshot }),
});
check('race snapshot changed unknown', second.unknowns.includes('revalidation:snapshot-changed'));
eq('race revalidation required', second.scope.revalidationRequired, true);
eq('race second parent identity', second.scope.expectedParentIdentity, 'dev1:999');

// 完整 snapshot 必须覆盖 leaf identity，而不仅是 parent identity。
const leafRaceFixture = makeFixture();
const leafFirst = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(leafRaceFixture),
});
leafRaceFixture.tree.set(path.normalize('/project/build/cache'), { type: 'dir', dev: 'dev1', ino: 998, size: 0 });
const leafSecond = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(leafRaceFixture, { previousSnapshot: leafFirst.resourceSnapshot }),
});
check('leaf replacement snapshot changed', leafSecond.unknowns.includes('revalidation:snapshot-changed'));
eq('leaf replacement revalidation required', leafSecond.scope.revalidationRequired, true);
eq('leaf replacement scope not computed', leafSecond.scope.computed, false);

// symlink 和 mount swap 也属于 capability 执行前必须拒绝的 snapshot 变化。
const linkRaceFixture = makeFixture();
const linkFirst = await resolveSemanticContext({
  target: { kind: 'filesystem_symlink', root: '/project/link', recursive: false },
  caller,
  options: opts(linkRaceFixture),
});
linkRaceFixture.tree.set(path.normalize('/project/link'), { type: 'symlink', target: '/etc/passwd', dev: 'dev1', ino: 107, size: 0 });
const linkSecond = await resolveSemanticContext({
  target: { kind: 'filesystem_symlink', root: '/project/link', recursive: false },
  caller,
  options: opts(linkRaceFixture, { previousSnapshot: linkFirst.resourceSnapshot }),
});
check('symlink swap snapshot changed', linkSecond.unknowns.includes('revalidation:snapshot-changed'));
eq('symlink swap revalidation required', linkSecond.scope.revalidationRequired, true);

const mountRaceFixture = makeFixture();
const mountFirst = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/mount-sub', recursive: true },
  caller,
  options: opts(mountRaceFixture),
});
mountRaceFixture.tree.set(path.normalize('/project/mount-sub'), { type: 'dir', dev: 'dev3', ino: 108, size: 0 });
const mountSecond = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/mount-sub', recursive: true },
  caller,
  options: opts(mountRaceFixture, { previousSnapshot: mountFirst.resourceSnapshot }),
});
check('mount swap snapshot changed', mountSecond.unknowns.includes('revalidation:snapshot-changed'));
eq('mount swap revalidation required', mountSecond.scope.revalidationRequired, true);

// --- 缺失叶子：no-follow + 父目录 identity 绑定 ---

const missingFixture = makeFixture();
const missingLeaf = await resolveSemanticContext({
  target: { kind: 'filesystem_file', root: '/project/build/newfile', recursive: false },
  caller,
  options: opts(missingFixture),
});
eq('missing leaf computed', missingLeaf.scope.computed, true);
eq('missing leaf kind', missingLeaf.scope.kind, 'project_generated');
eq('missing leaf noFollow', missingLeaf.resourceSnapshot.paths[0].noFollow, true);
eq('missing leaf identity', missingLeaf.resourceSnapshot.paths[0].identity, 'no-follow:dev1:101:newfile');
eq('missing leaf parent identity', missingLeaf.scope.expectedParentIdentity, 'dev1:101');
eq('missing leaf canonical', missingLeaf.resourceSnapshot.paths[0].canonical, '/project/build/newfile');

// 缺失的多段路径必须保留完整 no-follow suffix，不能折叠成最后一个叶子。
const missingNested = await resolveSemanticContext({
  target: { kind: 'filesystem_file', root: '/project/build/a/b', recursive: false },
  caller,
  options: opts(makeFixture()),
});
eq('nested missing canonical', missingNested.resourceSnapshot.paths[0].canonical, '/project/build/a/b');
eq('nested missing identity', missingNested.resourceSnapshot.paths[0].identity, 'no-follow:dev1:101:a/b');
eq('nested missing segments', JSON.stringify(missingNested.resourceSnapshot.paths[0].missingPathSegments), JSON.stringify(['a', 'b']));

// Tree 内部的 symlink 绝不能被 shadow traversal 跟随或计为已安全遍历。
const treeLinkFixture = makeFixture({
  mutate: ({ put }) => put('/project/build/cache/escape', { type: 'symlink', target: '/home/user/secret', ino: 601 }),
});
const treeLink = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(treeLinkFixture),
});
check('tree symlink unknown', treeLink.unknowns.includes('tree:contains-symlink'));
eq('tree symlink scope flag', treeLink.scope.treeContainsSymlink, true);
eq('tree symlink scope not computed', treeLink.scope.computed, false);

// caller supplied paths cannot establish a project scope when server facts are absent.
const noTrustedContext = await resolveSemanticContext({
  target: { kind: 'filesystem_file', root: '/project/app.js', recursive: false },
  caller,
  options: opts(makeFixture(), { trustedContext: null }),
});
eq('no trusted context computed false', noTrustedContext.scope.computed, false);
check('no trusted context unknown', noTrustedContext.unknowns.includes('scope:trusted-project-root-unavailable'));

// --- 多路径聚合：任一敏感即整体抬升 ---

const multiFixture = makeFixture();
const multi = await resolveSemanticContext({
  target: {
    kind: 'filesystem_tree',
    paths: ['/project/build/cache', '/home/user/.ssh'],
    recursive: true,
  },
  caller,
  options: opts(multiFixture),
});
eq('multi scope kind', multi.scope.kind, 'home_credential');
eq('multi sensitive', multi.impact.containsSensitiveMaterial, true);
eq('multi items', multi.impact.estimatedItems, 3);
eq('multi paths count', multi.resourceSnapshot.paths.length, 2);

// --- package fixture（只读 metadata） ---

const pkgFixture = makeFixture({
  packageFacts: async (q) => ({
    manager: q.manager,
    source: 'trusted_repository',
    repositories: [{ id: 'debian-bookworm-main', trust: 'configured' }],
    packages: q.packages.map((name) => ({
      name,
      requestedVersion: '',
      availableVersion: '2.0.1',
      installed: false,
      pinned: false,
    })),
  }),
});
const pkg = await resolveSemanticContext({
  target: { kind: 'package', manager: 'apt', packages: ['cmake'], source: 'trusted_repository' },
  caller,
  options: opts(pkgFixture),
});
eq('package scope computed', pkg.scope.computed, true);
eq('package scope kind', pkg.scope.kind, 'system');
eq('package manager', pkg.scope.manager, 'apt');
eq('package name', pkg.scope.packages[0].name, 'cmake');
eq('package repo trust', pkg.scope.repositories[0].trust, 'configured');
eq('package impact items', pkg.impact.estimatedItems, 1);
check('package snapshot identity', pkg.resourceSnapshot.identity.length > 0);

// package metadata 不可用 → computed=false。
const pkgNone = await resolveSemanticContext({
  target: { kind: 'package', manager: 'apt', packages: ['cmake'] },
  caller,
  options: opts(makeFixture()),
});
eq('package unavailable computed false', pkgNone.scope.computed, false);
check('package unavailable unknown', pkgNone.unknowns.includes('package:metadata-unavailable'));

// --- service fixture（只读 metadata） ---

const svcFixture = makeFixture({
  serviceFacts: async (q) => ({
    manager: 'systemd',
    unit: q.unit,
    action: q.action,
    exists: true,
    active: false,
    definitionHash: 'sha256:unit-hash',
  }),
});
const svc = await resolveSemanticContext({
  target: { kind: 'systemd_unit', unit: 'agentoc.service', action: 'restart' },
  caller,
  options: opts(svcFixture),
});
eq('service scope computed', svc.scope.computed, true);
eq('service scope kind', svc.scope.kind, 'system');
eq('service unit', svc.scope.unit, 'agentoc.service');
eq('service definitionHash', svc.scope.definitionHash, 'sha256:unit-hash');
eq('service impact items', svc.impact.estimatedItems, 1);

// --- batch / glob → computed=false（不可展开集合） ---

const batch = await resolveSemanticContext({
  target: { kind: 'filesystem_batch', source: 'xargs', command: 'rm -rf' },
  caller,
  options: opts(makeFixture()),
});
eq('batch computed false', batch.scope.computed, false);
check('batch unknown marker', batch.unknowns.includes('scope:batch-targets-unresolved'));

const glob = await resolveSemanticContext({
  target: { kind: 'filesystem_glob', root: '/project/build/*.o' },
  caller,
  options: opts(makeFixture()),
});
eq('glob computed false', glob.scope.computed, false);
check('glob unknown marker', glob.unknowns.includes('target:glob'));

// --- 确定性：同一输入同一 snapshot identity ---

const detA = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(makeFixture()),
});
const detB = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(makeFixture()),
});
eq('deterministic identity', detA.resourceSnapshot.identity, detB.resourceSnapshot.identity);
eq('deterministic observedAt', detA.resourceSnapshot.observedAt, detB.resourceSnapshot.observedAt);
const detC = await resolveSemanticContext({
  target: { kind: 'filesystem_tree', root: '/project/build/cache', recursive: true },
  caller,
  options: opts(makeFixture(), { now: '2026-08-12T00:00:00.000Z' }),
});
check('observedAt varies with now', detC.resourceSnapshot.observedAt !== detA.resourceSnapshot.observedAt);

// --- 单文件 / 普通删除 file kind ---

const fileFixture = makeFixture();
const file = await resolveSemanticContext({
  target: { kind: 'filesystem_file', root: '/project/app.js', recursive: false },
  caller,
  options: opts(fileFixture),
});
eq('file computed', file.scope.computed, true);
eq('file kind', file.scope.kind, 'project');
eq('file items', file.impact.estimatedItems, 1);
eq('file identity', file.resourceSnapshot.paths[0].identity, 'dev1:105');

// --- no target ---

const noTarget = await resolveSemanticContext({ caller, options: opts(makeFixture()) });
eq('no target computed false', noTarget.scope.computed, false);
check('no target unknown', noTarget.unknowns.includes('scope:no-target'));

const windowsTarget = await resolveSemanticContext({
  target: { kind: 'filesystem_file', platform: 'win32', root: 'C:\\project\\file.txt' },
  caller,
  options: opts(makeFixture()),
});
eq('Windows resolver without native facts computed false', windowsTarget.scope.computed, false);
check('Windows resolver is not rejected as an unsupported product platform', !windowsTarget.unknowns.includes('platform:unsupported'));

console.log(`semantic-resolver: ${passed} checks passed`);

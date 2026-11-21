/**
 * chat/command-parser.mjs — Shell 命令结构解析（纯逻辑，无 I/O）。
 *
 * 从一条 bash 命令提取“结构化风险事实”，供风险分类器
 * （chat/risk-classifier.mjs）、人话解释（chat/risk-explanation.mjs）
 * 与 OPA shadow 适配器消费。它不判定 tier —— tier 永远由策略层决定。
 *
 * 覆盖（阶段 2）：
 * - 前导包装命令解包：env / command / nohup / nice / timeout / exec，
 *   以及包装后的 sudo（`env sudo apt install` 等此前会被当作 env 而漏判）；
 * - 内嵌脚本：bash -c / sh -c / python -c / node -e（递归解析内层命令）；
 * - 下载后执行：curl|sh、wget -O- | bash、下载 && 执行；
 * - find -exec / xargs 批量执行；
 * - rm -rf 的递归 / 通配符 / 变量目标与目标作用域（system/项目/home/tmp/根/.git）。
 */

import { posix as POSIX_PATH, win32 as WIN32_PATH } from 'node:path';

import { classifyPrivilegedOperation, stripSudo, tokenizeCommand } from './privileged-classifier.mjs';
import {
  DESTRUCTIVE_PROGRAMS,
  DESTRUCTIVE_SCRIPT_KEYWORDS,
  isComplexCommand,
  NETWORK_PROGRAMS,
  platformFor,
  classifyRiskTargetScope,
  RISK_TARGET_SCOPE,
  SCRIPT_INTERPRETERS,
  SENSITIVE_SYSTEM_PATHS,
  systemPathRootsForPlatform,
} from './risk-policy.mjs';

// curl/wget 管道到 shell，或下载落盘后 && 执行：远程不可信代码直接在本机运行。
const DOWNLOAD_AND_EXECUTE_PATTERNS = [
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  /\bwget\b[^\n]*\s-O\s*-[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  /\b(curl|wget)\b[^\n]*\s-o\s+\S+[^\n]*&&\s*(sudo\s+)?(sh|bash|zsh|chmod\s+\S+\s+|\.[/\w.-]+)/i,
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function joinTokens(tokens) {
  return (tokens || []).join(' ');
}

function readEnvironmentAssignment(token) {
  const match = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/.exec(token || '');
  if (!match) return null;
  return { name: match.groups.name, value: match.groups.value };
}

// 前导包装命令解包。返回剩余 token 与包装名列表。
// 保守策略：只解包能安全“看穿”的包装；`command -v/-V` 是查询，不解包。
function unwrapCommand(tokens) {
  let index = 0;
  const wrappers = [];
  const environmentAssignments = [];
  while (index < tokens.length) {
    const token = tokens[index];
    const assignment = readEnvironmentAssignment(token);
    if (assignment) {
      environmentAssignments.push(assignment);
      index += 1;
      continue;
    }
    if (token === 'env') {
      wrappers.push('env');
      index += 1;
      // 跳过环境变量赋值与 -i/-u 等 flag。
      while (index < tokens.length) {
        const envAssignment = readEnvironmentAssignment(tokens[index]);
        if (envAssignment) {
          environmentAssignments.push(envAssignment);
          index += 1;
          continue;
        }
        if (['-i', '--ignore-environment', '-u', '--unset'].includes(tokens[index])
          || (tokens[index].startsWith('-u') && tokens[index].length > 2)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (token === 'command') {
      if (tokens[index + 1] === '-v' || tokens[index + 1] === '-V') break;
      wrappers.push('command');
      index += 1;
      continue;
    }
    if (token === 'nohup' || token === 'exec') {
      wrappers.push(token);
      index += 1;
      continue;
    }
    if (token === 'nice') {
      wrappers.push('nice');
      index += 1;
      if (tokens[index] === '-n' && tokens[index + 1]) index += 2;
      else if (tokens[index] && /^-\d+$/.test(tokens[index])) index += 1;
      continue;
    }
    if (token === 'timeout') {
      wrappers.push('timeout');
      index += 1;
      if (tokens[index] === '-s' && tokens[index + 1] && tokens[index + 2]) index += 3;
      else if (tokens[index] && (/^\d/.test(tokens[index]) || tokens[index] === '--preserve-status')) index += 1;
      continue;
    }
    break;
  }
  return { remaining: tokens.slice(index), wrappers, environmentAssignments };
}

/**
 * 按顶层复合操作符切分命令段（| ; && || 换行），引号/转义/命令替换
 * $()/子shell ()/花括号 {} 嵌套感知。返回 [{ text }]，空段过滤。
 * 只做结构切分，不做语义判断——每段由 parseCommandFacts 单独解析。
 */
export function splitCommandSegments(command) {
  const text = String(command || '');
  const segments = [];
  let buffer = '';
  let quote = ''; // '' | "'" | '"' | '`'
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      buffer += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      buffer += ch;
      continue;
    }
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      buffer += ch;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      buffer += ch;
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      buffer += ch;
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) braceDepth -= 1;
      buffer += ch;
      continue;
    }
    if (parenDepth === 0 && braceDepth === 0) {
      const andOp = ch === '&' && text[i + 1] === '&';
      const orOp = ch === '|' && text[i + 1] === '|';
      const plainSep = ch === '|' || ch === ';' || ch === '\n';
      if (andOp || orOp || plainSep) {
        if (andOp || orOp) i += 1;
        const segment = buffer.trim();
        if (segment) segments.push({ text: segment });
        buffer = '';
        continue;
      }
    }
    buffer += ch;
  }
  const tail = buffer.trim();
  if (tail) segments.push({ text: tail });
  return segments;
}

function normalizedProgramName(program) {
  const value = typeof program === 'string' ? program.trim() : '';
  const slash = value.lastIndexOf('/');
  return (slash >= 0 ? value.slice(slash + 1) : value).toLowerCase();
}

// 从解释器调用中提取内嵌脚本（bash -c / python -c / node -e 等）。
function extractInnerScript(rest, program) {
  const normalizedProgram = normalizedProgramName(program);
  const shell = normalizedProgram === 'bash' || normalizedProgram === 'sh' || normalizedProgram === 'zsh';
  if (shell) {
    const commandFlagIndex = rest.findIndex((arg) => (
      arg === '--command'
      || (typeof arg === 'string' && /^-[^-]*c/.test(arg))
    ));
    if (commandFlagIndex >= 0) {
      return {
        script: rest[commandFlagIndex + 1] || '',
        command: rest[commandFlagIndex + 1] || '',
      };
    }
  }
  if ((normalizedProgram === 'python' || normalizedProgram === 'python3') && rest[0] === '-c') {
    return { script: rest[1] || '', command: rest[1] || '' };
  }
  if (normalizedProgram === 'node' && (rest[0] === '-e' || rest[0] === '--eval')) {
    return { script: rest[1] || '', command: rest[1] || '' };
  }
  return { script: '', command: '' };
}

// --- 路径与作用域（与 risk-classifier 同语义，避免循环依赖而在本模块镜像） ---

function pathApiFor(riskContext) {
  return riskContext?.platform === 'win32' || process.platform === 'win32'
    ? WIN32_PATH
    : POSIX_PATH;
}

function pathInside(target, root, riskContext) {
  if (!target || !root) return false;
  const pathApi = pathApiFor(riskContext);
  const rootResolved = pathApi.resolve(root);
  const targetResolved = pathApi.resolve(target);
  const rel = pathApi.relative(rootResolved, targetResolved);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

function isSystemPath(p, riskContext) {
  if (!p) return false;
  const pathApi = pathApiFor(riskContext);
  const roots = Array.isArray(riskContext?.systemPathRoots)
    ? riskContext.systemPathRoots
    : systemPathRootsForPlatform(pathApi === WIN32_PATH ? 'win32' : 'posix');
  return roots.some((root) => pathInside(p, root, riskContext));
}

function resolveAgainst(p, cwd, riskContext) {
  if (!p) return '';
  const pathApi = pathApiFor(riskContext);
  if (pathApi.isAbsolute(p)) return pathApi.resolve(p);
  if (cwd) return pathApi.resolve(cwd, p);
  return p;
}

function firstSystemPathArg(tokens, cwd, riskContext) {
  const pathApi = pathApiFor(riskContext);
  let selected = '';
  let selectedRank = -1;
  const scopeRank = {
    [RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE]: 0,
    [RISK_TARGET_SCOPE.TRUSTED_WORKSPACE]: 1,
    [RISK_TARGET_SCOPE.SYSTEM]: 2,
    [RISK_TARGET_SCOPE.PROTECTED_CONTROL]: 3,
  };
  for (const token of tokens) {
    const candidates = (token.includes('{') || token.includes('}'))
      ? token.split(/[{},]/)
      : [token];
    for (const candidate of candidates) {
      if (!pathApi.isAbsolute(candidate)) continue;
      const resolved = resolveAgainst(candidate, cwd, riskContext);
      const scope = classifyRiskTargetScope(resolved, { riskContext });
      if (scope !== RISK_TARGET_SCOPE.SYSTEM && scope !== RISK_TARGET_SCOPE.PROTECTED_CONTROL) continue;
      const rank = scopeRank[scope] ?? 0;
      if (rank > selectedRank) {
        selected = candidate;
        selectedRank = rank;
      }
    }
  }
  return selected;
}

// Commands in this list accept filesystem operands. We retain those operands
// as scope facts so an admission-bound workspace can distinguish `mkdir
// ../outside` from `mkdir build`; the classifier still decides whether the
// operation is risky.
const PATH_OPERAND_PROGRAMS = new Set([
  'cd', 'mkdir', 'touch', 'rm', 'rmdir', 'unlink', 'shred', 'truncate',
  'cp', 'mv', 'install', 'chmod', 'chown', 'chgrp', 'ln', 'tee', 'dd',
  'mkfs', 'mount', 'umount', 'find', 'git',
]);

function commandPathOperands(program, rest, cwd, riskContext) {
  const normalizedProgram = normalizedProgramName(program);
  if (!PATH_OPERAND_PROGRAMS.has(normalizedProgram)) return [];
  const pathApi = pathApiFor(riskContext);
  const operands = [];
  for (const raw of rest) {
    const token = trimString(raw);
    if (!token || token === '--' || token.startsWith('-')) {
      // `--output=/path` and `of=/path` still describe a filesystem operand.
      const equalsIndex = token.indexOf('=');
      if (equalsIndex > 0) {
        const value = token.slice(equalsIndex + 1).trim();
        if (value && (pathApi.isAbsolute(value) || value.startsWith('.') || value.startsWith('~'))) {
          operands.push(value);
        }
      }
      continue;
    }
    // URLs and ordinary git/package words are not paths. Relative path-like
    // operands are kept because `../outside` is meaningful against cwd.
    if (pathApi.isAbsolute(token) || token.startsWith('.') || token.startsWith('~')) {
      operands.push(token);
    }
  }
  return operands.map((operand) => ({
    path: operand,
    resolved: resolveAgainst(operand, cwd, riskContext),
    scope: classifyRiskTargetScope(resolveAgainst(operand, cwd, riskContext), { riskContext }),
  }));
}

function mostRestrictiveTargetScope(scopes, fallback) {
  const rank = {
    [RISK_TARGET_SCOPE.TRUSTED_WORKSPACE]: 0,
    [RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE]: 1,
    [RISK_TARGET_SCOPE.SYSTEM]: 2,
    [RISK_TARGET_SCOPE.PROTECTED_CONTROL]: 3,
  };
  const candidates = scopes.length > 0 ? scopes : [fallback];
  return candidates
    .filter(Boolean)
    .sort((left, right) => (rank[right] ?? 1) - (rank[left] ?? 1))[0]
    || RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE;
}

function hasFlag(rest, names, shortPattern) {
  return rest.some((arg) => names.includes(arg) || (shortPattern && shortPattern.test(arg)));
}

// 非 flag 参数即删除目标。
function deleteTargets(rest) {
  const targets = [];
  let afterDoubleDash = false;
  for (const arg of rest) {
    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith('-')) continue;
    targets.push(arg);
  }
  return targets;
}

function gitCleanForced(rest) {
  return rest.slice(1).some((arg) => arg === '--force' || /^-[a-z]*f/i.test(arg));
}

function gitPushForceOrDelete(rest) {
  return rest.slice(1).some((arg) =>
    arg === '--force'
    || arg === '--force-with-lease'
    || arg === '--delete'
    || /^-[a-z]*f/i.test(arg));
}

// `~`/`~/...` 对 home 展开，其余相对 cwd。
function resolveDeleteTarget(target, cwd, home, riskContext) {
  const pathApi = pathApiFor(riskContext);
  if (target === '~') return home ? pathApi.resolve(home) : target;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return home ? pathApi.resolve(home, target.slice(2)) : target;
  }
  return resolveAgainst(target, cwd, riskContext);
}

function locateDeleteTargetScope(target, cwd, projectRoot, home, riskContext) {
  const pathApi = pathApiFor(riskContext);
  const resolved = resolveDeleteTarget(target, cwd, home, riskContext);
  if (resolved && pathApi.parse(resolved).root === resolved) return 'root';
  const targetScope = classifyRiskTargetScope(resolved, { riskContext });
  if (targetScope === RISK_TARGET_SCOPE.PROTECTED_CONTROL) return 'system';
  if (targetScope === RISK_TARGET_SCOPE.TRUSTED_WORKSPACE) {
    const proj = projectRoot ? pathApi.resolve(projectRoot) : '';
    if (proj && pathApi.resolve(resolved) === proj) return 'project-root';
    return 'inside-project';
  }
  if (targetScope === RISK_TARGET_SCOPE.SYSTEM
    || (!riskContext && isSystemPath(resolved, riskContext))) return 'system';
  if (/(^|\/)\.git(\/|$)/.test(resolved)) return 'git-metadata';
  const proj = projectRoot ? pathApi.resolve(projectRoot) : '';
  if (proj && pathApi.resolve(resolved) === proj) return 'project-root';
  const hm = home ? pathApi.resolve(home) : '';
  if (hm && pathApi.resolve(resolved) === hm) return 'home-root';
  // With an admission context, projectRoot is merely display metadata. Do not
  // let it turn a target outside the frozen workspace into an in-project edit.
  if (!riskContext && pathInside(resolved, proj, riskContext)) return 'inside-project';
  if (resolved.startsWith('/tmp')) return 'temp';
  if (hm && pathInside(resolved, hm, riskContext)) return 'inside-home';
  return 'unknown';
}

function analyzeDeleteShape({ program, verb, rest, tokens, cwd, projectRoot, home, riskContext }) {
  const targets = deleteTargets(rest);
  const recursive = hasFlag(rest, ['-r', '-R', '--recursive'], /^-[a-z]*r/i);
  const glob = targets.some((t) => /[*?\[\]]/.test(t));
  const variable = targets.some((t) => /\$[A-Za-z_{]/.test(t));
  const scopes = targets.map((t) => locateDeleteTargetScope(t, cwd, projectRoot, home, riskContext));
  // 只有真正的破坏性程序（rm/find/...）才算“危险删除”；
  // cat/curl 等普通程序即使参数里有 /etc 也不构成删除形状。
  const isDestructiveProgram = DESTRUCTIVE_PROGRAMS.has(program) || program === 'find';
  const dangerDelete = isDestructiveProgram
    && (scopes.some((s) =>
      ['root', 'system', 'git-metadata', 'project-root', 'home-root'].includes(s))
      || (recursive && (glob || variable)));
  const irreversible = DESTRUCTIVE_PROGRAMS.has(program)
    || (program === 'find' && rest.includes('-delete'))
    || (program === 'git' && verb === 'clean' && gitCleanForced(rest))
    || (program === 'git' && verb === 'push' && gitPushForceOrDelete(rest));
  const fileCountEstimate = (recursive || glob || scopes.includes('system') || targets.length > 1 || program === 'find')
    ? 'many'
    : (targets.length === 1 ? 'one' : 'few');
  return {
    recursive,
    glob,
    variable,
    deleteTargets: targets,
    targetScopes: scopes,
    dangerDelete,
    irreversible,
    fileCountEstimate,
  };
}

/**
 * 解析一条命令的结构化风险事实。
 *
 * @param {string} command
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.projectRoot]
 * @param {string} [options.home]
 * @param {string} [options.declaredCategory]
 * @param {object} [options.riskContext] Frozen Run risk context.
 * @returns {object|null}
 */
export function parseCommandFacts(command, options = {}) {
  const cwd = trimString(options.cwd);
  const projectRoot = trimString(options.projectRoot);
  const home = trimString(options.home);
  const riskContext = options.riskContext && typeof options.riskContext === 'object'
    ? options.riskContext
    : null;
  const text = trimString(command);
  if (!text) return null;
  // 段级解析只做一层（展示/召回用），避免嵌套复合命令无限递归。
  const segmentDepth = Number.isInteger(options._segmentDepth) ? options._segmentDepth : 0;

  const legacy = tokenizeCommand(text);
  const literalArgv = options.literalArgv;
  const useLiteral = Array.isArray(literalArgv) && literalArgv.length > 0
    && literalArgv.every(value => typeof value === 'string' && !value.includes('\0'))
    && /^[A-Za-z0-9_.+-]+$/.test(literalArgv[0])
    && !['env', 'command', 'nohup', 'nice', 'timeout', 'exec', 'sudo'].includes(literalArgv[0]);
  const tokens = useLiteral ? [...literalArgv] : legacy.tokens;
  const composite = legacy.composite;
  const { remaining, wrappers, environmentAssignments } = unwrapCommand(tokens);
  const unwrappedCommand = useLiteral && wrappers.length === 0 && environmentAssignments.length === 0 ? text : joinTokens(remaining);
  const stripped = stripSudo(remaining);
  const program = stripped.program;
  const rest = stripped.rest;
  const verb = (rest[0] || '').toLowerCase();
  const sawSudo = stripped.sawSudo;
  const inner = extractInnerScript(rest, program);

  const pc = classifyPrivilegedOperation({
    command: unwrappedCommand,
    cwd,
    declaredCategory: options.declaredCategory || '',
  });
  const deleteShape = analyzeDeleteShape({
    program,
    verb,
    rest,
    tokens: remaining,
    cwd,
    projectRoot,
    home,
    riskContext,
  });

  // The executable itself is not a filesystem target. Looking at `remaining`
  // here made absolute invocations such as `/usr/bin/bash -lc ...` appear to
  // write a system path. `rest` contains only the command arguments.
  const systemPath = firstSystemPathArg(rest, cwd, riskContext);
  const systemPathScope = systemPath
    ? classifyRiskTargetScope(resolveAgainst(systemPath, cwd, riskContext), { riskContext })
    : RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE;
  const cwdScope = classifyRiskTargetScope(cwd, { riskContext });
  const pathOperands = commandPathOperands(program, rest, cwd, riskContext);
  const targetScope = mostRestrictiveTargetScope(
    pathOperands.map((operand) => operand.scope),
    systemPath ? systemPathScope : cwdScope,
  );
  // Prefer a sensitive path when a brace expansion contains several system
  // paths (`{/etc/passwd,/etc/shadow}`); the first path is not necessarily the
  // most security-relevant one.
  const sensitiveSystemPath = SENSITIVE_SYSTEM_PATHS.find((path) => text.includes(path)) || '';
  const network = NETWORK_PROGRAMS.has(program)
    || (program === 'git' && ['push', 'fetch', 'pull', 'clone'].includes(verb));
  const scriptInterpreter = SCRIPT_INTERPRETERS.has(normalizedProgramName(program));
  const destructiveKeyword = scriptInterpreter
    && DESTRUCTIVE_SCRIPT_KEYWORDS.test(inner.command || text);
  const downloadAndExecute = DOWNLOAD_AND_EXECUTE_PATTERNS.some((re) => re.test(text));
  const findExec = program === 'find'
    && (rest.includes('-exec') || rest.includes('-execdir'));
  const findExecDestructive = findExec
    && rest.some((arg) => DESTRUCTIVE_PROGRAMS.has(arg));
  // 直呼 xargs：`xargs rm < list`。管道形态（`echo x | xargs rm`）由 composite
  // 保守 caution 兜底，避免在解析器里重复发明管道语义。
  const xargs = program === 'xargs' || rest.includes('xargs');
  const xargsDestructive = program === 'xargs'
    && rest.some((arg) => DESTRUCTIVE_PROGRAMS.has(arg));
  const forcePush = program === 'git' && verb === 'push' && gitPushForceOrDelete(rest);
  const gitCleanForcedFlag = program === 'git' && verb === 'clean' && gitCleanForced(rest);

  // 复合命令分段（仅顶层一层）：每段独立解析，暴露管道/条件链中隐藏的
  // 危险信号（如 `echo x | xargs rm` 的删除段）。只影响展示与增强召回，
  // 绝不参与 tier 判定。
  const segments = composite && segmentDepth === 0
    ? splitCommandSegments(text)
      .map((segment) => {
        const facts = parseCommandFacts(segment.text, {
          cwd,
          projectRoot,
          home,
          riskContext,
          _segmentDepth: segmentDepth + 1,
        });
        return facts
          ? {
            text: segment.text,
            program: facts.program,
            sudo: facts.sudo,
            network: facts.network,
            dangerDelete: facts.dangerDelete,
            downloadAndExecute: facts.downloadAndExecute,
            unknownProgram: facts.unknownProgram,
            findExecDestructive: facts.findExecDestructive,
            xargsDestructive: facts.xargsDestructive,
            forcePush: facts.forcePush,
            destructiveKeyword: facts.destructiveKeyword,
          }
          : { text: segment.text, program: '', sudo: false, network: false, dangerDelete: false, downloadAndExecute: false, unknownProgram: true, findExecDestructive: false, xargsDestructive: false, forcePush: false, destructiveKeyword: false };
      })
    : [];

  return {
    platform: platformFor(text),
    command: text,
    unwrappedCommand,
    wrappers,
    environmentAssignments,
    tokens: remaining,
    composite,
    complex: isComplexCommand(text),
    program,
    verb,
    args: rest,
    sudo: sawSudo,
    category: pc.category,
    categoryConfidence: pc.confidence,
    network,
    systemPath,
    systemPathScope,
    targetScope,
    targetPaths: pathOperands.map((operand) => operand.path),
    targetPathScopes: pathOperands.map((operand) => operand.scope),
    sensitiveSystemPath,
    scriptInterpreter,
    innerScript: inner.script,
    innerCommand: inner.command,
    destructiveKeyword,
    downloadAndExecute,
    findExec,
    findExecDestructive,
    xargs,
    xargsDestructive,
    forcePush,
    gitCleanForced: gitCleanForcedFlag,
    unknownProgram: !program,
    segments,
    ...deleteShape,
  };
}

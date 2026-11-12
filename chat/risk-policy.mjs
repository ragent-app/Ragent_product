/**
 * chat/risk-policy.mjs — 统一风险判定契约（纯逻辑，无 I/O）。
 *
 * 风险判定的“策略”层元数据与稳定 reason code。分类器
 * （chat/risk-classifier.mjs）继续作为兼容入口，但输出统一升级为：
 *
 *   { tier, source, policyVersion, platform, confidence,
 *     reasons: [{ code, message }], facts }
 *
 * - tier / facts 由确定性分类器产生（source: 'deterministic'）；
 * - reasons 从“人类可读字符串”升级为稳定 code（前端、审计、测试、
 *   LLM 总结统一消费 code，不再依赖易变文案）；
 * - policyVersion 让每个审批事件可追溯所用策略版本；
 * - 本模块同时承载解析器（chat/command-parser.mjs）与分类器共享的
 *   常量与模式，避免两边对同一命令给出不一致的事实。
 */

import { posix as POSIX_PATH, win32 as WIN32_PATH } from 'node:path';

export const RISK_POLICY_VERSION = 'risk-v3';

export const RISK_POLICY_CONTEXT_VERSION = 1;

export const RISK_SOURCE_DETERMINISTIC = 'deterministic';

export const RISK_PLATFORM = Object.freeze({
  BASH: 'linux-bash',
  POWERSHELL: 'powershell',
  FILE_TOOL: 'file-tool',
  NONE: 'none',
});

// Path scope is an audit fact, not an authorization decision. The order is
// security-significant: a trusted workspace must never exempt a protected
// control-plane root that happens to be located below a system directory.
export const RISK_TARGET_SCOPE = Object.freeze({
  PROTECTED_CONTROL: 'protected-control',
  TRUSTED_WORKSPACE: 'trusted-workspace',
  SYSTEM: 'system',
  OUTSIDE_WORKSPACE: 'outside-workspace',
});

// 稳定 reason code —— 审批事件、审计、测试与 LLM 总结都消费这些 code，
// 人类文案只作为展示兜底（message 可随语言/措辞调整而不破坏契约）。
export const RISK_REASON_CODES = Object.freeze({
  // 删除类
  DELETE_FILESYSTEM_ROOT: 'delete_filesystem_root',
  DELETE_SYSTEM_PATH: 'delete_system_path',
  DELETE_GIT_METADATA: 'delete_git_metadata',
  DELETE_PROJECT_ROOT: 'delete_project_root',
  DELETE_HOME_ROOT: 'delete_home_root',
  DELETE_GLOB_PATTERN: 'delete_glob_pattern',
  DELETE_VARIABLE_TARGET: 'delete_variable_target',
  DELETE_NO_TARGET: 'delete_no_target',
  DELETE_FIND_BATCH: 'delete_find_batch',
  DELETE_HOME: 'delete_home',
  DELETE_IN_PROJECT: 'delete_in_project',
  DELETE_RECURSIVE_PROJECT: 'delete_recursive_project',
  DELETE_TEMP_FILE: 'delete_temp_file',
  DELETE_RECURSIVE_TEMP: 'delete_recursive_temp',
  DELETE_UNRESOLVABLE: 'delete_unresolvable',
  DELETE_MULTI_TARGET: 'delete_multi_target',
  DELETE_RMDIR: 'delete_rmdir',
  DESTRUCTIVE_ERASE: 'destructive_erase',

  // 文件工具
  FILE_EDIT_SYSTEM_PATH: 'file_edit_system_path',
  FILE_EDIT_PROJECT: 'file_edit_project',
  FILE_EDIT_OUTSIDE_PROJECT: 'file_edit_outside_project',

  // 安装
  INSTALL_IN_SCOPE_AUTO: 'install_in_scope_auto',
  INSTALL_SUDO: 'install_sudo',
  INSTALL_OUT_OF_SCOPE: 'install_out_of_scope',

  // sudo / 提权
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  SUDO_SCRIPT_INTERPRETER: 'sudo_script_interpreter',
  SUDO_SYSTEM_ADMIN: 'sudo_system_admin',
  SUDO_SERVICE_CONTROL: 'sudo_service_control',
  DECLARED_PRIVILEGED_OP: 'declared_privileged_op',

  // git
  GIT_CLEAN_FORCE: 'git_clean_force',
  GIT_CLEAN_UNFORCED: 'git_clean_unforced',
  GIT_PUSH_FORCE: 'force_push',
  GIT_REMOTE_OPERATION: 'git_remote_operation',

  // 系统路径
  PROTECTED_CONTROL_PATH: 'protected_control_path',
  PROTECTED_CONTROL_READ: 'protected_control_read',
  SYSTEM_PATH_WRITE: 'system_path_write',
  SENSITIVE_SYSTEM_READ: 'sensitive_system_read',
  SHELL_CONTROL_SYSTEM_PATH: 'shell_control_system_path',
  SHELL_CONTROL_DESTRUCTIVE: 'shell_control_destructive',

  // 网络
  NETWORK_EGRESS: 'network_egress',

  // 脚本解释器 / 下载执行 / find 批量
  INTERPRETER_DESTRUCTIVE_KEYWORD: 'interpreter_destructive_keyword',
  SCRIPT_INTERPRETER_DESTRUCTIVE: 'script_interpreter_destructive',
  SCRIPT_INTERPRETER_SUDO: 'script_interpreter_sudo',
  SCRIPT_INTERPRETER_DELETE: 'script_interpreter_delete',
  SCRIPT_INTERPRETER_SYSTEM_PATH: 'script_interpreter_system_path',
  SCRIPT_INTERPRETER_FORCE_PUSH: 'script_interpreter_force_push',
  SCRIPT_INTERPRETER_DOWNLOAD_EXEC: 'script_interpreter_download_exec',
  SCRIPT_INTERPRETER_NESTED: 'script_interpreter_nested',
  DOWNLOAD_AND_EXECUTE: 'download_and_execute',
  FIND_EXEC_DESTRUCTIVE: 'find_exec_destructive',
  FIND_EXEC_BATCH: 'find_exec_batch',
  XARGS_DESTRUCTIVE: 'xargs_destructive',
  XARGS_BATCH: 'xargs_batch',

  // 组合 / 未知
  COMPOSITE_UNANALYZED: 'composite_unanalyzed',
  OUTSIDE_WORKSPACE_TARGET: 'outside_workspace_target',
  ENVIRONMENT_INJECTION: 'environment_injection',
  UNKNOWN_COMMAND: 'unknown_command',

  // 常规
  ORDINARY_COMMAND: 'ordinary_command',
  NO_COMMAND: 'no_command',

  // 兜底（理论上不应出现在正式输出中，测试会守住）
  UNCLASSIFIED: 'unclassified',
});

const R = RISK_REASON_CODES;

// code → 默认英文文案（展示兜底；正式消费方请用 code）。
export const RISK_REASON_MESSAGES = Object.freeze({
  [R.DELETE_FILESYSTEM_ROOT]: 'delete of filesystem root',
  [R.DELETE_SYSTEM_PATH]: 'delete on system path',
  [R.DELETE_GIT_METADATA]: 'delete of git metadata (.git)',
  [R.DELETE_PROJECT_ROOT]: 'delete of project root',
  [R.DELETE_HOME_ROOT]: 'delete of home root',
  [R.DELETE_GLOB_PATTERN]: 'recursive delete of glob pattern',
  [R.DELETE_VARIABLE_TARGET]: 'recursive delete with variable target',
  [R.DELETE_NO_TARGET]: 'delete with no explicit target',
  [R.DELETE_FIND_BATCH]: 'batch delete via find',
  [R.DELETE_HOME]: 'delete outside project (home)',
  [R.DELETE_IN_PROJECT]: 'in-project delete',
  [R.DELETE_RECURSIVE_PROJECT]: 'recursive delete in project',
  [R.DELETE_TEMP_FILE]: 'temp-dir delete',
  [R.DELETE_RECURSIVE_TEMP]: 'recursive delete in temp dir',
  [R.DELETE_UNRESOLVABLE]: 'delete with unresolvable target',
  [R.DELETE_MULTI_TARGET]: 'multi-target delete',
  [R.DELETE_RMDIR]: 'remove empty directory',
  [R.DESTRUCTIVE_ERASE]: 'irreversible data destruction',
  [R.FILE_EDIT_SYSTEM_PATH]: 'write to system path',
  [R.FILE_EDIT_PROJECT]: 'in-project file edit',
  [R.FILE_EDIT_OUTSIDE_PROJECT]: 'file edit outside project root',
  [R.INSTALL_IN_SCOPE_AUTO]: 'in-scope install (install-auto)',
  [R.INSTALL_SUDO]: 'sudo install',
  [R.INSTALL_OUT_OF_SCOPE]: 'out-of-scope install',
  [R.PRIVILEGE_ESCALATION]: 'sudo / privilege escalation',
  [R.SUDO_SCRIPT_INTERPRETER]: 'sudo with script interpreter (arbitrary code)',
  [R.SUDO_SYSTEM_ADMIN]: 'sudo system administration',
  [R.SUDO_SERVICE_CONTROL]: 'sudo service control',
  [R.DECLARED_PRIVILEGED_OP]: 'declared privileged op (sentinel)',
  [R.GIT_CLEAN_FORCE]: 'git clean --force',
  [R.GIT_CLEAN_UNFORCED]: 'git clean (unforced)',
  [R.GIT_PUSH_FORCE]: 'git push --force/--delete',
  [R.GIT_REMOTE_OPERATION]: 'git remote operation',
  [R.SYSTEM_PATH_WRITE]: 'targets system path',
  [R.PROTECTED_CONTROL_PATH]: 'targets Ragent control-plane path',
  [R.PROTECTED_CONTROL_READ]: 'reads Ragent control-plane path',
  [R.SENSITIVE_SYSTEM_READ]: 'read sensitive system file',
  [R.SHELL_CONTROL_SYSTEM_PATH]: 'shell control structure reading system path',
  [R.SHELL_CONTROL_DESTRUCTIVE]: 'destructive command inside shell control structure',
  [R.NETWORK_EGRESS]: 'network egress',
  [R.INTERPRETER_DESTRUCTIVE_KEYWORD]: 'interpreter with destructive keyword',
  [R.SCRIPT_INTERPRETER_DESTRUCTIVE]: 'destructive command inside script interpreter',
  [R.SCRIPT_INTERPRETER_SUDO]: 'sudo inside script interpreter',
  [R.SCRIPT_INTERPRETER_DELETE]: 'delete inside script interpreter',
  [R.SCRIPT_INTERPRETER_SYSTEM_PATH]: 'script interpreter writes system path',
  [R.SCRIPT_INTERPRETER_FORCE_PUSH]: 'git push --force inside script interpreter',
  [R.SCRIPT_INTERPRETER_DOWNLOAD_EXEC]: 'download and execute inside script interpreter',
  [R.SCRIPT_INTERPRETER_NESTED]: 'nested script interpreter',
  [R.DOWNLOAD_AND_EXECUTE]: 'download and execute remote script',
  [R.FIND_EXEC_DESTRUCTIVE]: 'destructive find -exec',
  [R.FIND_EXEC_BATCH]: 'batch find -exec',
  [R.XARGS_DESTRUCTIVE]: 'destructive xargs',
  [R.XARGS_BATCH]: 'batch execute via xargs',
  [R.COMPOSITE_UNANALYZED]: 'composite command (partly analyzed)',
  [R.OUTSIDE_WORKSPACE_TARGET]: 'path outside trusted workspace',
  [R.ENVIRONMENT_INJECTION]: 'environment variable can inject code or alter runtime behavior',
  [R.UNKNOWN_COMMAND]: 'unknown command',
  [R.ORDINARY_COMMAND]: 'ordinary command',
  [R.NO_COMMAND]: 'no command',
  [R.UNCLASSIFIED]: 'unclassified reason',
});

// 分类器历史文案 → code（精确匹配优先，参数化文案走正则）。
const REASON_EXACT = Object.freeze({
  'remove empty directory': R.DELETE_RMDIR,
  'delete of filesystem root': R.DELETE_FILESYSTEM_ROOT,
  'delete of git metadata (.git)': R.DELETE_GIT_METADATA,
  'delete of project root': R.DELETE_PROJECT_ROOT,
  'delete of home root': R.DELETE_HOME_ROOT,
  'recursive delete of glob pattern': R.DELETE_GLOB_PATTERN,
  'recursive delete with variable target': R.DELETE_VARIABLE_TARGET,
  'delete with no explicit target': R.DELETE_NO_TARGET,
  'batch delete via find': R.DELETE_FIND_BATCH,
  'delete outside project (home)': R.DELETE_HOME,
  'in-project delete': R.DELETE_IN_PROJECT,
  'recursive delete in project': R.DELETE_RECURSIVE_PROJECT,
  'temp-dir delete': R.DELETE_TEMP_FILE,
  'recursive delete in temp dir': R.DELETE_RECURSIVE_TEMP,
  'delete with unresolvable target': R.DELETE_UNRESOLVABLE,
  'multi-target delete': R.DELETE_MULTI_TARGET,
  'write to system path': R.FILE_EDIT_SYSTEM_PATH,
  'in-project file edit': R.FILE_EDIT_PROJECT,
  'file edit outside project root': R.FILE_EDIT_OUTSIDE_PROJECT,
  'no command': R.NO_COMMAND,
  'in-scope install (install-auto)': R.INSTALL_IN_SCOPE_AUTO,
  'sudo install': R.INSTALL_SUDO,
  'out-of-scope install': R.INSTALL_OUT_OF_SCOPE,
  'sudo with script interpreter (arbitrary code)': R.SUDO_SCRIPT_INTERPRETER,
  'sudo system administration': R.SUDO_SYSTEM_ADMIN,
  'sudo system administration requires approval': R.SUDO_SYSTEM_ADMIN,
  'sudo service control': R.SUDO_SERVICE_CONTROL,
  'sudo service control requires approval': R.SUDO_SERVICE_CONTROL,
  'sudo / privilege escalation': R.PRIVILEGE_ESCALATION,
  'declared privileged op (sentinel)': R.DECLARED_PRIVILEGED_OP,
  'git clean --force': R.GIT_CLEAN_FORCE,
  'git clean (unforced)': R.GIT_CLEAN_UNFORCED,
  'git push --force/--delete': R.GIT_PUSH_FORCE,
  'read sensitive system file': R.SENSITIVE_SYSTEM_READ,
  'destructive command inside shell control structure': R.SHELL_CONTROL_DESTRUCTIVE,
  'shell control structure reading system path': R.SHELL_CONTROL_SYSTEM_PATH,
  'targets system path': R.SYSTEM_PATH_WRITE,
  'targets Ragent control-plane path': R.PROTECTED_CONTROL_PATH,
  'targets AgentoC control-plane path': R.PROTECTED_CONTROL_PATH,
  'reads Ragent control-plane path': R.PROTECTED_CONTROL_READ,
  'reads AgentoC control-plane path': R.PROTECTED_CONTROL_READ,
  'interpreter with destructive keyword': R.INTERPRETER_DESTRUCTIVE_KEYWORD,
  'network egress': R.NETWORK_EGRESS,
  'git remote operation': R.GIT_REMOTE_OPERATION,
  'composite command (partly analyzed)': R.COMPOSITE_UNANALYZED,
  'path outside trusted workspace': R.OUTSIDE_WORKSPACE_TARGET,
  'environment variable can inject code or alter runtime behavior': R.ENVIRONMENT_INJECTION,
  'ordinary command': R.ORDINARY_COMMAND,
  'download and execute remote script': R.DOWNLOAD_AND_EXECUTE,
  'destructive find -exec': R.FIND_EXEC_DESTRUCTIVE,
  'batch find -exec': R.FIND_EXEC_BATCH,
  'destructive xargs': R.XARGS_DESTRUCTIVE,
  'batch execute via xargs': R.XARGS_BATCH,
  'sudo inside script interpreter': R.SCRIPT_INTERPRETER_SUDO,
  'destructive command inside script interpreter': R.SCRIPT_INTERPRETER_DESTRUCTIVE,
  'delete inside script interpreter': R.SCRIPT_INTERPRETER_DELETE,
  'script interpreter writes system path': R.SCRIPT_INTERPRETER_SYSTEM_PATH,
  'git push --force inside script interpreter': R.SCRIPT_INTERPRETER_FORCE_PUSH,
  'download and execute inside script interpreter': R.SCRIPT_INTERPRETER_DOWNLOAD_EXEC,
  'nested script interpreter': R.SCRIPT_INTERPRETER_NESTED,
});

const REASON_PATTERNS = Object.freeze([
  [/^delete on system path /, R.DELETE_SYSTEM_PATH],
  [/ \(irreversible data destruction\)$/, R.DESTRUCTIVE_ERASE],
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 任意历史/自定义 reason 文案 → 稳定 code（无匹配时 UNCLASSIFIED）。 */
export function codeForReason(message) {
  const text = trimString(message);
  if (!text) return R.UNCLASSIFIED;
  const exact = REASON_EXACT[text];
  if (exact) return exact;
  for (const [re, code] of REASON_PATTERNS) {
    if (re.test(text)) return code;
  }
  return R.UNCLASSIFIED;
}

/** 消息数组 → [{ code, message }]；保持顺序，去重保留首个。 */
export function normalizeReasonMessages(messages) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(messages) ? messages : []) {
    const message = trimString(raw);
    if (!message || seen.has(message)) continue;
    seen.add(message);
    out.push({ code: codeForReason(message), message });
  }
  return out;
}

export function isKnownReasonCode(code) {
  return Object.values(RISK_REASON_CODES).includes(code);
}

function pathInsideRoot(target, root, platform = process.platform) {
  if (!target || !root) return false;
  const pathApi = platform === 'win32' ? WIN32_PATH : POSIX_PATH;
  const rootResolved = pathApi.resolve(root);
  const targetResolved = pathApi.resolve(target);
  const rel = pathApi.relative(rootResolved, targetResolved);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

function riskRootPaths(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => typeof entry === 'string' ? entry.trim() : entry?.path?.trim?.() || '')
    .filter(Boolean);
}

/**
 * Resolve the audit scope of an already-resolved target path.
 *
 * This function intentionally has no filesystem calls. The caller supplies
 * realpath-derived roots from Run admission; path strings alone are not an
 * execution or authorization boundary.
 */
export function classifyRiskTargetScope(target, { riskContext = null, systemPathRoots } = {}) {
  const context = riskContext && typeof riskContext === 'object' ? riskContext : {};
  const platform = context.platform === 'win32' ? 'win32' : process.platform;
  const protectedRoots = riskRootPaths(context.protectedRoots);
  if (protectedRoots.some((root) => pathInsideRoot(target, root, platform))) {
    return RISK_TARGET_SCOPE.PROTECTED_CONTROL;
  }

  const trustedRoot = typeof context.trustedWorkspaceRoot === 'string'
    ? context.trustedWorkspaceRoot.trim()
    : '';
  if (trustedRoot && pathInsideRoot(target, trustedRoot, platform)) {
    return RISK_TARGET_SCOPE.TRUSTED_WORKSPACE;
  }

  const configuredSystemRoots = Array.isArray(systemPathRoots)
    ? systemPathRoots
    : (Array.isArray(context.systemPathRoots)
      ? context.systemPathRoots
      : systemPathRootsForPlatform(platform));
  if (configuredSystemRoots.some((root) => pathInsideRoot(target, root, platform))) {
    return RISK_TARGET_SCOPE.SYSTEM;
  }
  return RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE;
}

/** 命令 → 平台标识（PowerShell 仅做前缀识别；其余按 bash 语义处理）。 */
export function platformFor(command) {
  const text = trimString(command);
  if (/^(pwsh|powershell)\b/i.test(text)) return RISK_PLATFORM.POWERSHELL;
  if (!text) return RISK_PLATFORM.NONE;
  return RISK_PLATFORM.BASH;
}

// --- 解析器与分类器共享的语义常量（单一事实源） ---

// 会从网络拉取/推送的程序。
export const NETWORK_PROGRAMS = Object.freeze(new Set([
  'curl', 'wget', 'scp', 'rsync', 'ssh', 'ftp', 'nc', 'netcat',
]));

// 可运行任意内嵌脚本的解释器（启发式）。
export const SCRIPT_INTERPRETERS = Object.freeze(new Set([
  'python', 'python3', 'node', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh',
]));

// 解释器内暗示破坏性意图的关键字。
export const DESTRUCTIVE_SCRIPT_KEYWORDS = /rmtree|shutil\.rmtree|os\.remove|os\.unlink|fs\.rm|fs\.unlink|fs\.rmdir|rmSync|unlinkSync|rmdirSync|\bunlink\(|\bremove\(|DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE/i;

// 无条件销毁数据的程序（窄集）：进入删除分析即 danger，永不降级。
// 注意：`rm` 不在其中——rm 由 analyzeDelete 按目标作用域细分，
// 单文件项目内删除是 safe，递归/通配符/系统路径才是 danger。
export const DESTRUCTIVE_ERASE_PROGRAMS = Object.freeze(new Set([
  'dropdb', 'droprole', 'shred', 'truncate',
]));

// 破坏性程序（宽集）：用于“命令内是否出现破坏性程序”的复合判断
// 与 find -exec 批量执行识别；不直接决定 rm 的 tier。
export const DESTRUCTIVE_PROGRAMS = Object.freeze(new Set([
  'rm', 'shred', 'truncate', 'dd', 'mkfs', 'fdisk', 'parted', 'dropdb',
  'droprole', 'psql',
]));

// 修改系统根路径的后果在项目之外。
export const SYSTEM_PATH_ROOTS = Object.freeze([
  '/etc', '/usr', '/var', '/boot', '/proc', '/sys', '/dev', '/lib', '/lib64',
  '/sbin', '/bin', '/root',
]);

// Windows has no portable root-relative equivalent of POSIX `/etc` or `/var`.
// Admission adds the host's concrete SystemRoot/ProgramFiles roots; these
// defaults keep direct classifier calls conservative when that context is
// unavailable.
export const WINDOWS_SYSTEM_PATH_ROOTS = Object.freeze([
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
]);

export function systemPathRootsForPlatform(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return SYSTEM_PATH_ROOTS;
  return Object.freeze([...new Set([
    env?.SystemRoot,
    env?.WINDIR,
    // In a 32-bit process ProgramFiles may point at the x86 directory while
    // ProgramW6432 names the native installation directory (on any drive).
    env?.ProgramW6432,
    env?.ProgramFiles,
    env?.['ProgramFiles(x86)'],
    env?.ProgramData,
    ...WINDOWS_SYSTEM_PATH_ROOTS,
  ].map(trimString).filter(Boolean))]);
}

// 读取即危险（内容为密钥/根策略）。
export const SENSITIVE_SYSTEM_PATHS = Object.freeze([
  '/etc/shadow', '/etc/gshadow', '/etc/sudoers',
]);

// 组合构造：管道、命令替换、变量展开、控制流、heredoc。
// 只作为 LLM 二次意见的触发，绝不单独升级 tier。
const COMPLEX_COMMAND_PATTERNS = [
  /\|\s*\S/,                    // pipe into another program
  /\$\(/,                       // $( command substitution
  /`[^`]+`/,                    // backtick substitution
  /\$\{/,                       // ${var} expansion
  /&&|\|\|/,                    // short-circuit chain
  /\b(for|while|until|if|case|function)\b/, // control flow
  /<<[-]?\w*/,                  // heredoc / here-string
];

export function isComplexCommand(command) {
  const text = trimString(command);
  if (!text) return false;
  // 单重定向（> / >> / 2>&1 / 2>/dev/null）极常见且不隐藏程序，刻意不匹配。
  return COMPLEX_COMMAND_PATTERNS.some((re) => re.test(text));
}

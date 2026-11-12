import path from 'node:path';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { parseLiteralBashWords } from './windows-bash-actions.mjs';

const elevationPrograms = new Set(['runas', 'runas.exe', 'gsudo', 'gsudo.exe', 'sudo', 'sudo.exe']);
// These cmdlets are Windows account/service administration, rather than
// ordinary file or package commands. Read-only counterparts remain untouched.
const adminCmdlets = new Set(['new-localuser', 'set-localuser', 'remove-localuser', 'enable-localuser', 'disable-localuser',
  'new-localgroup', 'set-localgroup', 'remove-localgroup', 'add-localgroupmember', 'remove-localgroupmember',
  'new-service', 'remove-service', 'set-service', 'start-service', 'stop-service', 'restart-service',
  'new-netfirewallrule', 'set-netfirewallrule', 'remove-netfirewallrule', 'enable-netfirewallrule', 'disable-netfirewallrule',
  'set-netfirewallprofile', 'set-mppreference', 'add-mppreference', 'remove-mppreference']);
const registryWriteCmdlets = new Set(['new-item', 'set-item', 'remove-item', 'clear-item',
  'new-itemproperty', 'set-itemproperty', 'remove-itemproperty', 'clear-itemproperty']);
const nameOf = value => path.win32.basename(String(value || '').replaceAll('/', '\\')).toLowerCase();

function directAdminProgram(name, args) {
  if (adminCmdlets.has(name)) return true;
  if (name === 'winget' || name === 'winget.exe') {
    const verb = String(args[0] || '').toLowerCase();
    const machineScope = args.some((arg, index) => /^--scope=machine$/i.test(String(arg))
      || (/^--scope$/i.test(String(arg)) && /^machine$/i.test(String(args[index + 1] || ''))));
    // Machine-scope installation needs the broker even when the operation
    // itself is safe to approve automatically. The broker still verifies the
    // package operation, arguments and executable independently.
    if (['install', 'upgrade'].includes(verb) && machineScope) return true;
  }
  if (registryWriteCmdlets.has(name)) {
    let target = args[0] && !String(args[0]).startsWith('-') ? String(args[0]) : '';
    for (let i = 0; i < args.length; i += 1) {
      const match = String(args[i] || '').match(/^-(?:literalpath|path)(?::(.*))?$/i);
      if (match) { target = match[1] ?? String(args[i + 1] || ''); break; }
    }
    return /^(?:hklm:\\|registry::hkey_local_machine(?:\\|$))/i.test(target);
  }
  // Avoid treating queries such as `sc query` and `net user` as writes.
  // In Windows PowerShell, bare `sc` is an alias for Set-Content.
  if (name === 'sc.exe') {
    const verb = String(args[0] || '').toLowerCase();
    return ['create', 'delete', 'config', 'failure', 'sdset'].includes(verb) ||
      (['start', 'stop'].includes(verb) && args.length > 1);
  }
  if (name === 'net.exe' || name === 'net') {
    const subcommand = String(args[0] || '').toLowerCase();
    return (['start', 'stop'].includes(subcommand) && args.length > 1) ||
      (['user', 'localgroup'].includes(subcommand) && args.slice(1).some(arg => /^\/(?:add|delete)$/i.test(String(arg))));
  }
  // Registry machine-hive writes normally need an administrator. Limit this
  // guidance to literal machine targets; queries and user-hive changes keep
  // their existing approval handling.
  if (name === 'reg.exe' || name === 'reg') {
    const verb = String(args[0] || '').toLowerCase();
    if (!['add', 'delete', 'copy', 'restore', 'load', 'unload'].includes(verb)) return false;
    const target = args[verb === 'copy' ? 2 : 1];
    return /^(?:hklm|hkey_local_machine)(?:\\|$)/i.test(String(target || ''));
  }
  return false;
}

// The server calls this with the already parsed, run-bound argv. A provider's
// declared category is never sufficient to establish a host operation.
export function isWindowsAdministrativeArgv(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.every(arg => typeof arg === 'string') &&
    directAdminProgram(nameOf(argv[0]), argv.slice(1));
}

// This is guidance for explicit elevation, not a privilege or risk classifier.
// Unrecognized and dynamic commands remain with the existing approval policy.
export async function needsWindowsElevationGuidance(command, shell = 'PowerShell', parse = parseWindowsPowerShellAst) {
  if (typeof command !== 'string' || !/runas|gsudo|sudo|winget|localuser|localgroup|netfirewall|mppreference|hklm:|hkey_local_machine|(?:^|[\\/\s'\"])(?:sc|net|reg)(?:\.exe)?['\"]?(?:\s|$)|(?:new|remove|set|start|stop|restart)-service/i.test(command)) return false;
  if (shell === 'Bash') {
    const words = parseLiteralBashWords(command);
    if (!words || words.length < 2) return false;
    const name = nameOf(words[0]);
    // Claude on Windows commonly invokes PowerShell through its Bash tool.
    // This path only provides a denial and guidance; it does not attest or
    // authorize the outer executable. Inspect the fixed literal script so a
    // direct administrative command receives the same guidance as a native
    // PowerShell request.
    if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) {
      const flag = words.findIndex((word, index) => index > 0 && /^-(?:command|c)$/i.test(word));
      if (flag > 0 && flag === words.length - 2 && words.slice(1, flag).every(word => /^-(?:noprofile|nologo|noninteractive)$/i.test(word))) {
        return needsWindowsElevationGuidance(words[flag + 1], 'PowerShell', parse);
      }
    }
    return (elevationPrograms.has(name) && !/^--?(help|version)$/i.test(words[1])) || directAdminProgram(name, words.slice(1));
  }
  let ast;
  try { ast = await parse(command); } catch { return false; }
  if (ast.errors?.length || !Array.isArray(ast.commands)) return false;
  return ast.commands.some(item => {
    const name = nameOf(item.name);
    const elements = item.elements || [];
    if (registryWriteCmdlets.has(name)) {
      const args = [];
      for (const element of elements.slice(1)) {
        if (element.kind === 'literal') args.push(String(element.value));
        else if (element.kind === 'parameter') {
          args.push(`-${element.name}`);
          if (element.argumentType) args.push(typeof element.value === 'string' ? element.value : '');
        } else args.push('');
      }
      if (directAdminProgram(name, args)) return true;
    }
    if (directAdminProgram(name, elements.slice(1).map(element => element.kind === 'literal' ? element.value : ''))) return true;
    if (elevationPrograms.has(name)) {
      const arg = elements[1];
      return !!arg && !(arg.kind === 'literal' && /^--?(help|version)$/i.test(arg.value));
    }
    if (!['start-process', 'start', 'saps'].includes(name)) return false;
    return elements.some((element, index) => element.kind === 'parameter' && /^verb$/i.test(element.name) &&
      ((element.argumentType === 'StringConstantExpressionAst' && /^runas$/i.test(String(element.value))) ||
       (element.argumentType == null && elements[index + 1]?.kind === 'literal' && /^runas$/i.test(elements[index + 1].value))));
  });
}

export function windowsElevationGuidance(channelAvailable) {
  return channelAvailable
    ? 'Use Ragent’s separate managed privileged executor through the ragent_request_actions tool for the underlying concrete command. For service start or stop, submit Start-Service or Stop-Service with the exact service name. Do not use direct elevation wrappers. The current approval policy still applies; if the operation is unsupported, report that limitation.'
    : 'Ragent’s managed privileged action channel is unavailable. Do not use direct elevation wrappers; report that the operation is blocked.';
}

// Guidance is useful even in unattended modes or without an MCP binding. It
// does not grant permissions; without the channel the message reports that
// managed elevation is unavailable. Planning and the workbench policy retain
// their existing behavior.
export function shouldInstallWindowsElevationHook({ platform, runtimeFamily, interactionMode, permissionMode, workbenchPolicy } = {}) {
  return platform === 'win32' && runtimeFamily === 'codex-app-server-json' && !workbenchPolicy &&
    interactionMode !== 'plan' && permissionMode !== 'plan';
}

export async function buildCodexWindowsElevationGuidance({ event, channel } = {}) {
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' ||
      typeof event.tool_use_id !== 'string' || !event.tool_use_id.trim() || event.tool_use_id.length > 1024 ||
      !await needsWindowsElevationGuidance(event.tool_input?.command)) return {};
  const available = !!(channel?.endpoint && channel?.token && channel?.sessionId && channel?.runId && channel?.turnId);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: windowsElevationGuidance(available) } };
}

import { CONFIG_DIR } from './config.mjs';
import {
  loadExternalCodexOwnershipState,
  observeExternalCodexOwnership,
  takeoverExternalCodexAccount,
} from './provider-runtime/external-codex-ownership.mjs';
import {
  inspectExternalCodexAuth,
  resolveExternalCodexAuthFile,
  resolveExternalCodexHandoffPolicy,
} from './provider-runtime/run-provider-prepare.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:
  ragent oauth status [--json]
  ragent oauth takeover --account <account-id> [--json]

说明:
  status     查看外部 Codex 当前账号和 Ragent owner 状态（不输出 token）
  takeover   外部 Codex 已退出/切号且旧进程已关闭后，显式接管 pending 账号
`);
}

function parseArgs(argv = []) {
  const options = { action: '', accountId: '', json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-') && !options.action) {
      options.action = arg;
      continue;
    }
    switch (arg) {
      case '--account':
        options.accountId = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function publicState(state) {
  return {
    currentExternalAccountId: state?.currentExternalAccountId || '',
    currentExternalFingerprint: state?.currentExternalFingerprint || '',
    currentExternalObservedAt: state?.currentExternalObservedAt || '',
    records: Array.isArray(state?.records) ? state.records : [],
    updatedAt: state?.updatedAt || '',
  };
}

function renderStatus(result) {
  const external = result.external || {};
  const lines = [
    `external auth: ${external.status || 'unknown'}`,
    `external account: ${external.accountId || '(none)'}`,
    `auth file: ${result.authFile}`,
  ];
  for (const record of result.ownership?.records || []) {
    lines.push(`  ${record.accountId}: ${record.status}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runExternalCodexOAuthCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);
  if (options.help || !options.action) {
    printHelp(stdout);
    return options.help ? 0 : 2;
  }

  const authFile = resolveExternalCodexAuthFile();
  if (options.action === 'status') {
    const inspected = await inspectExternalCodexAuth({ externalCodexAuthFile: authFile });
    const loaded = await loadExternalCodexOwnershipState({ configDir: CONFIG_DIR });
    let state = loaded.state;
    if (inspected.ok) {
      const observed = await observeExternalCodexOwnership({
        configDir: CONFIG_DIR,
        accountId: inspected.status === 'logged-in' ? inspected.accountId : '',
        fingerprint: inspected.status === 'logged-in' ? inspected.fingerprint : '',
        handoffPolicy: resolveExternalCodexHandoffPolicy(),
      });
      if (observed.ok) state = observed.state;
    }
    const result = {
      ok: inspected.ok && loaded.ok,
      authFile,
      external: inspected.ok
        ? {
          status: inspected.status,
          accountId: inspected.accountId,
          fingerprint: inspected.fingerprint,
        }
        : { status: inspected.status || 'unreadable', accountId: '', fingerprint: '' },
      ownership: publicState(state),
      ...(inspected.ok ? {} : { reason: inspected.reason }),
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(renderStatus(result));
    return result.ok ? 0 : 2;
  }

  if (options.action === 'takeover') {
    if (!options.accountId) {
      throw new Error('takeover requires --account <account-id>; run ragent oauth status first');
    }
    const result = await takeoverExternalCodexAccount({
      configDir: CONFIG_DIR,
      accountId: options.accountId,
    });
    if (!result.ok) {
      const messages = {
        'external-codex-account-still-active': 'External Codex still owns this account; log out or switch accounts first.',
        'external-codex-account-not-pending': 'This account is not waiting for takeover.',
        'external-codex-ownership-state-unreadable': 'External Codex ownership state is unreadable.',
      };
      throw new Error(messages[result.reason] || result.reason || 'OAuth takeover failed');
    }
    const output = { ok: true, accountId: result.accountId, ownership: publicState(result.state) };
    if (options.json) stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else stdout.write(`Ragent now owns OAuth account ${result.accountId}.\n`);
    return 0;
  }

  stderr.write(`ragent oauth: unknown action "${options.action}"\n`);
  printHelp(stderr);
  return 2;
}

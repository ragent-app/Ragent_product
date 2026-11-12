import { spawn } from 'child_process';

import {
  createAgentoCHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
} from './agentoc-http-client.mjs';
import {
  buildPlatformSpawnSpec,
  resolveExecutableCommandPathAsync,
} from './executable-resolution.mjs';
function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printHelp(stdout) {
  stdout.write(`Usage:
  agentoc pair [options]

Options:
  --base-url <url>     Local AgentoC API URL (default: local port 7690)
  --ttl-seconds <n>    Invitation lifetime (30-600, default: 120)
  --no-qr              Print text without terminal QR rendering
  --json               Print machine-readable invitation JSON
  --help               Show this help
`);
}

function parseArgs(argv = []) {
  const options = {
    baseUrl: (process.env.RAGENT_CHAT_BASE_URL || process.env.AGENTOC_CHAT_BASE_URL) || DEFAULT_CHAT_BASE_URL,
    ttlSeconds: 120,
    noQr: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--ttl-seconds':
        options.ttlSeconds = Number.parseInt(argv[index + 1] || '', 10);
        index += 1;
        break;
      case '--no-qr':
        options.noQr = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown pair option: ${argv[index]}`);
    }
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 30 || options.ttlSeconds > 600) {
    throw new Error('--ttl-seconds must be between 30 and 600');
  }
  return options;
}

export async function renderQr(payload, command = 'qrcode-terminal', {
  resolveCommand = resolveExecutableCommandPathAsync,
  buildSpawnSpec = buildPlatformSpawnSpec,
  spawnImpl = spawn,
} = {}) {
  const resolved = await resolveCommand(command);
  if (!resolved) {
    const error = new Error(`QR renderer command not found: ${command}`);
    error.code = 'QR_RENDERER_NOT_FOUND';
    throw error;
  }
  const spawnSpec = buildSpawnSpec(resolved, []);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(spawnSpec.file, spawnSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: spawnSpec.shell,
      ...(spawnSpec.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      reject(new Error(
        Buffer.concat(stderr).toString('utf8').trim()
        || `${resolved} exited with code ${code}`,
      ));
    });
    child.stdin.end(`${payload}\n`);
  });
}

export async function runPairCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(stdout);
    return 0;
  }

  const client = createAgentoCHttpClient({ baseUrl: options.baseUrl });
  const response = await client.request('/api/device-pairing/invitations', {
    method: 'POST',
    body: {
      ttlMs: options.ttlSeconds * 1000,
    },
  });
  if (!response.response.ok || !response.json?.invitation) {
    throw new Error(response.json?.error || response.text || 'Failed to create pairing invitation');
  }

  const invitation = response.json.invitation;
  if (options.json) {
    stdout.write(`${JSON.stringify({ invitation }, null, 2)}\n`);
    return 0;
  }

  stdout.write('AgentoC 手机配对\n\n');
  if (!options.noQr) {
    try {
      const rendered = await renderQr(invitation.pairingUri, trimString(io.qrCommand) || 'qrcode-terminal');
      stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    } catch (error) {
      stderr.write(`二维码渲染不可用，已回退为文本：${error.message}\n`);
    }
  }
  stdout.write(`短码: ${invitation.shortCode}\n`);
  stdout.write(`有效期至: ${invitation.expiresAt}\n`);
  stdout.write('用途: 一次性账号认领；连接由 Accounts rendezvous 和签名 bootstrap 完成\n');
  stdout.write(`配对载荷: ${invitation.pairingUri}\n`);
  return 0;
}

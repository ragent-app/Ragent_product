#!/usr/bin/env node
import { execFile, spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { promisify } from 'util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const [,, command, ...args] = process.argv;

function scriptPath(name) {
  return path.join(__dirname, name);
}

function modulePath(name) {
  return pathToFileURL(scriptPath(name)).href;
}

async function runShell(script) {
  try {
    await spawnFile('bash', [scriptPath(script)]);
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

async function runWindowsServiceLifecycle(action, service = 'all') {
  const { runWindowsServiceLifecycle: runLifecycle } = await import(modulePath('lib/windows-service-control.mjs'));
  try {
    await runLifecycle({ action, service });
  } catch (err) {
    if (err?.message) console.error(err.message);
    process.exit(err?.status ?? 1);
  }
}

function spawnFile(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(signal ? `${command} exited with signal ${signal}` : `${command} exited with code ${code}`);
      error.status = code ?? 1;
      reject(error);
    });
  });
}

function printHelp() {
  console.log(`Ragent v${pkg.version}

Usage:
  ragent setup                    Configure the local Ragent host
  ragent start                    Start all services
  ragent stop                     Stop all services
  ragent restart [service]        Restart services; Linux/macOS chat restart blocks active runs unless --force
  ragent doctor [--json]          Print read-only per-user runtime diagnostics
  ragent doctor --service [--json] Inspect the installed MSI service instance
  ragent doctor --owner-bootstrap [--json] Check installed Owner bootstrap trust
  ragent upgrade-check             Check whether an upgrade can preserve active Runs
  ragent upgrade-prepare           Enter upgrade drain after validating active Runs
  ragent provision-host           Plan or execute whole-host provider provisioning
  ragent bootstrap-host           Converge a Linux host into a Ragent host baseline
  ragent install-profile          Resolve modules from install env and render runtime plan
  ragent validate-profile         Validate host + profile health and report degradation
  ragent guest-instance           Create isolated guest instances on this machine
  ragent chat                     Run chat server in foreground
  ragent api                      Call the local Ragent HTTP API with owner auth
  ragent mail                     Manage agent mailbox and send outbound email
  ragent assistant-message        Append an assistant message with optional local-file attachments
  ragent pair                     Create a trusted-device pairing QR and short code
  ragent signal                   Run metadata-only P2P signaling
  ragent p2p-host                 Run the local WebRTC DataChannel host
  ragent connector                Run or inspect the outbound host connector
  ragent local-bridge            Manage linked local helper bridges for a session
  ragent agenda                  Manage the instance calendar feed
  ragent trigger                  Manage durable session triggers
  ragent managed-process          Start and control processes that outlive a Run
  ragent usage-summary            Summarize local Codex token usage
  ragent session-spawn            Spawn a focused parallel session from a source session
  ragent collaborate              Durable multi-Agent collaboration control
  ragent consult                  Consultation round control (create|status|dispatch|decide|cancel|decisions)
  ragent set-password             Set username & password for login
  ragent --help                   Show this help message
  ragent --version                Show version`);
}

switch (command) {
  case 'setup':
    if (process.platform === 'win32') {
      const { runWindowsSetupCommand } = await import(modulePath('lib/windows-setup-command.mjs'));
      try {
        process.exitCode = await runWindowsSetupCommand(args);
      } catch (error) {
        console.error(error.message || String(error));
        process.exitCode = 1;
      }
    } else {
      await runShell('setup.sh');
    }
    break;

  case 'start':
    if (process.platform === 'win32') await runWindowsServiceLifecycle('start');
    else await runShell('start.sh');
    break;

  case 'stop':
    if (process.platform === 'win32') await runWindowsServiceLifecycle('stop');
    else await runShell('stop.sh');
    break;

  case 'doctor': {
    const { runDoctorCommand } = await import(modulePath('lib/doctor-command.mjs'));
    process.exitCode = await runDoctorCommand(args);
    break;
  }

  case 'restart': {
    const force = args.includes('--force');
    const service = args.find((arg) => !arg.startsWith('--')) || 'all';
    if (process.platform === 'win32') {
      // Windows ServiceHost owns the restart boundary. `--force` remains a
      // compatible CLI flag for scripts shared with Linux/macOS.
      await runWindowsServiceLifecycle('restart', service);
    } else {
      try {
        await spawnFile('bash', [scriptPath('restart.sh'), service, ...(force ? ['--force'] : [])]);
      } catch (err) {
        process.exit(err.status ?? 1);
      }
    }
    break;
  }

  case 'restart-check': {
    const { beginRestartDrain, endRestartDrain, listBlockingActiveRuns } = await import(modulePath('lib/restart-interlock.mjs'));
    const json = args.includes('--json');
    const force = args.includes('--force');
    const end = args.includes('--end');
    const checkOnly = args.includes('--check-only');
    const excludeSessionIds = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--exclude-session' && args[index + 1]) {
        excludeSessionIds.push(args[index + 1]);
        index += 1;
      }
    }
    if (process.env.AGENTOC_RESTART_EXCLUDE_SESSION) {
      excludeSessionIds.push(process.env.AGENTOC_RESTART_EXCLUDE_SESSION);
    }
    const ttlIndex = args.indexOf('--ttl-ms');
    const ttlMs = ttlIndex >= 0 ? Number.parseInt(args[ttlIndex + 1] || '', 10) : undefined;
    let result;
    if (end) {
      await endRestartDrain();
      result = { ok: true, ended: true, blockingRuns: [] };
    } else if (checkOnly) {
      const blockingRuns = await listBlockingActiveRuns({ excludeSessionIds });
      result = { ok: blockingRuns.length === 0 || force, blockingRuns };
    } else {
      result = await beginRestartDrain({
        force,
        excludeSessionIds,
        ...(Number.isInteger(ttlMs) && ttlMs > 0 ? { ttlMs } : {}),
      });
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) {
      console.error(`Restart blocked: ${result.blockingRuns.length} active run(s) are still alive.`);
      for (const run of result.blockingRuns.slice(0, 10)) {
        console.error(`  ${run.id} ${run.provider || 'provider'} ${run.state}`);
      }
      console.error('Wait for them to finish, or use --force only when interruption is intentional.');
    }
    process.exitCode = result.ok ? 0 : 3;
    break;
  }

  case 'upgrade-check': {
    const {
      assessRunUpgradeSafety,
      listBlockingActiveRuns,
    } = await import(modulePath('lib/restart-interlock.mjs'));
    const json = args.includes('--json');
    const excludeSessionIds = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--exclude-session' && args[index + 1]) {
        excludeSessionIds.push(args[index + 1]);
        index += 1;
      }
    }
    const activeRuns = await listBlockingActiveRuns({ excludeSessionIds });
    const evaluatedRuns = await Promise.all(activeRuns.map(async (run) => ({
      ...run,
      ...(await assessRunUpgradeSafety(run)),
    })));
    const blockingRuns = evaluatedRuns.filter((run) => run.safe !== true);
    const result = {
      ok: blockingRuns.length === 0,
      activeRuns: evaluatedRuns,
      blockingRuns,
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.ok) {
      console.error(`Upgrade blocked: ${blockingRuns.length} active Run(s) cannot be proven restart-safe.`);
      for (const run of blockingRuns.slice(0, 10)) {
        console.error(`  ${run.id} ${run.provider || 'provider'} ${run.state}: ${run.reason}`);
      }
      console.error('Wait for unsafe Runs to finish, or repair runner isolation before upgrading.');
    } else {
      console.log(`Upgrade safe: ${evaluatedRuns.length} active Run(s) are independently managed.`);
    }
    process.exitCode = result.ok ? 0 : 3;
    break;
  }

  case 'upgrade-prepare': {
    const {
      beginUpgradeDrain,
      endRestartDrain,
    } = await import(modulePath('lib/restart-interlock.mjs'));
    const json = args.includes('--json');
    const force = args.includes('--force');
    const excludeSessionIds = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--exclude-session' && args[index + 1]) {
        excludeSessionIds.push(args[index + 1]);
        index += 1;
      }
    }
    const result = await beginUpgradeDrain({ force, excludeSessionIds });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.ok) {
      console.error(`Upgrade blocked: ${result.blockingRuns.length} active Run(s) cannot be proven restart-safe.`);
      for (const run of result.blockingRuns.slice(0, 10)) {
        console.error(`  ${run.id} ${run.provider || 'provider'} ${run.state}: ${run.reason}`);
      }
      console.error('Wait for unsafe Runs to finish, or repair runner isolation before upgrading.');
    } else {
      console.log('Upgrade drain active; new Runs are temporarily paused until the new control plane is ready.');
    }
    // Keep the drain file for the package postinst/new server to clear. The
    // explicit --end path remains available through restart-check.
    if (!result.ok) await endRestartDrain();
    process.exitCode = result.ok ? 0 : 3;
    break;
  }

  case 'provision-host':
  case 'bootstrap-host':
  case 'install-profile':
  case 'validate-profile': {
    const { runInstanceFactoryCommand } = await import(modulePath('lib/instance-factory-command.mjs'));
    try {
      process.exitCode = await runInstanceFactoryCommand(command, args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'chat':
    await import(modulePath('chat-server.mjs'));
    break;

  case 'release': {
    console.error('`agentoc release` has been removed. Ragent now runs the current source tree after restart. Use `agentoc restart chat` for the owner surface.');
    process.exit(1);
    break;
  }

  case 'guest-instance':
  case 'guest-instances': {
    const { runGuestInstanceCommand } = await import(modulePath('lib/guest-instance-command.mjs'));
    try {
      process.exitCode = await runGuestInstanceCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'api': {
    const { runAgentoCApiCommand } = await import(modulePath('lib/agentoc-api-command.mjs'));
    try {
      process.exitCode = await runAgentoCApiCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      // Let HTTP/stdio handles finish closing. Forced exit with active fetch
      // handles can abort Windows Node in UV_HANDLE_CLOSING instead of exit 1.
      process.exitCode = 1;
    }
    break;
  }

  case 'mail':
  case 'email': {
    const { runAgentMailCommand } = await import(modulePath('lib/agent-mail-command.mjs'));
    try {
      process.exitCode = await runAgentMailCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'assistant-message':
  case 'assistant-messages': {
    const { runAssistantMessageCommand } = await import(modulePath('lib/assistant-message-command.mjs'));
    try {
      process.exitCode = await runAssistantMessageCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'pair': {
    const { runPairCommand } = await import(modulePath('lib/pair-command.mjs'));
    try {
      process.exitCode = await runPairCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'signal': {
    const { runP2PSignalCommand } = await import(modulePath('lib/p2p-signal-command.mjs'));
    await runP2PSignalCommand(args);
    break;
  }

  case 'p2p-host': {
    const { runP2PHostCommand } = await import(modulePath('lib/p2p-host-command.mjs'));
    try {
      process.exitCode = await runP2PHostCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'local-bridge': {
    const { runLocalBridgeCommand } = await import(modulePath('lib/local-bridge-command.mjs'));
    try {
      process.exitCode = await runLocalBridgeCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'agenda': {
    const { runAgendaCommand } = await import(modulePath('lib/agenda-command.mjs'));
    try {
      process.exitCode = await runAgendaCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'trigger':
  case 'triggers': {
    const { runTriggerCommand } = await import(modulePath('lib/trigger-command.mjs'));
    try {
      process.exitCode = await runTriggerCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'usage-summary': {
    const { runUsageSummaryCommand } = await import(modulePath('lib/usage-summary-command.mjs'));
    try {
      process.exitCode = await runUsageSummaryCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'managed-process':
  case 'managed-processes':
  case 'process': {
    const { runManagedProcessCommand } = await import(modulePath('lib/managed-process-command.mjs'));
    try {
      process.exitCode = await runManagedProcessCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'session-spawn':
  case 'spawn-session': {
    const { runSessionSpawnCommand } = await import(modulePath('lib/session-spawn-command.mjs'));
    try {
      process.exitCode = await runSessionSpawnCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'collaborate': {
    const { runCollaborationCommand } = await import(modulePath('lib/collaboration-command.mjs'));
    try {
      process.exitCode = await runCollaborationCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'consult': {
    const { createAgentoCHttpClient } = await import(modulePath('lib/agentoc-http-client.mjs'));

    function consultText(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    function printConsultHelp(stdout = process.stdout) {
      stdout.write(`Usage:
  agentoc consult create --root-session <id> --objective <text> --question <text> --experts <json> --quorum <n> --deadline <iso> [options]
  agentoc consult status <round-id>
  agentoc consult dispatch <round-id> [--expert-assignment <id>] [--agent <id>] [--expert-session <id>] [--attempt <id>] [--version <n>]
  agentoc consult decide <round-id> --decision <text> [options]
  agentoc consult cancel <round-id> [--reason <text>] [--version <n>]
  agentoc consult decisions <round-id>

Options:
  --root-session <id>      Root session that initiates the consultation
  --objective <text>       Strategic objective
  --question <text>        Question under consultation
  --experts <json>         JSON array of {role} expert assignments
  --quorum <n>             Number of distinct expert votes required
  --budget <json>          Optional budget declaration
  --deadline <iso>         ISO-8601 deadline
  --round-number <n>       Round number (default 1)
  --expert-assignment <id> Expert assignment id for dispatch
  --expert-session <id>    Managed expert session id for dispatch
  --attempt <id>           Attempt id for dispatch
  --agent <id>             Agent id; creates a managed expert session when set
  --version <n>            Optimistic round version (CAS)
  --decision <text>        Decision text for decide
  --rationale <text>       Decision rationale
  --required-guards <json> JSON array of typed guards
  --decided-by-session <id> Deciding session id
  --reason <text>          Cancellation reason
  --base-url <url>         Ragent base URL
  --json                   Print raw JSON response
  --help                   Show this help
`);
    }

    const options = { positional: [] };
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const take = () => args[index + 1] || '';
      if (arg === '--help' || arg === '-h') options.help = true;
      else if (arg === '--json') options.json = true;
      else if (arg === '--root-session') { options.rootSessionId = take(); index += 1; }
      else if (arg === '--objective') { options.objective = take(); index += 1; }
      else if (arg === '--question') { options.question = take(); index += 1; }
      else if (arg === '--experts') { options.experts = take(); index += 1; }
      else if (arg === '--quorum') { options.quorum = take(); index += 1; }
      else if (arg === '--budget') { options.budget = take(); index += 1; }
      else if (arg === '--deadline') { options.deadline = take(); index += 1; }
      else if (arg === '--round-number') { options.roundNumber = take(); index += 1; }
      else if (arg === '--expert-assignment') { options.expertAssignmentId = take(); index += 1; }
      else if (arg === '--expert-session') { options.expertSessionId = take(); index += 1; }
      else if (arg === '--attempt') { options.attemptId = take(); index += 1; }
      else if (arg === '--agent') { options.agentId = take(); index += 1; }
      else if (arg === '--version') { options.version = take(); index += 1; }
      else if (arg === '--decision') { options.decision = take(); index += 1; }
      else if (arg === '--rationale') { options.rationale = take(); index += 1; }
      else if (arg === '--required-guards') { options.requiredGuards = take(); index += 1; }
      else if (arg === '--decided-by-session') { options.decidedBySessionId = take(); index += 1; }
      else if (arg === '--reason') { options.reason = take(); index += 1; }
      else if (arg === '--base-url') { options.baseUrl = take(); index += 1; }
      else options.positional.push(arg);
    }

    const action = options.positional[0] || '';
    const id = options.positional[1] || '';
    if (options.help || !action) {
      printConsultHelp();
      if (options.help) break;
      process.exitCode = 1;
      break;
    }

    try {
      const client = createAgentoCHttpClient({ baseUrl: options.baseUrl });
      let path = '';
      let method = 'GET';
      let body;
      if (action === 'create') {
        method = 'POST';
        path = '/api/consultations';
        body = {
          rootSessionId: consultText(options.rootSessionId) || undefined,
          roundNumber: options.roundNumber ? Number(options.roundNumber) : undefined,
          objective: consultText(options.objective),
          question: consultText(options.question),
          experts: options.experts ? JSON.parse(options.experts) : [],
          quorum: options.quorum ? Number(options.quorum) : undefined,
          budget: options.budget ? JSON.parse(options.budget) : undefined,
          deadline: consultText(options.deadline),
        };
      } else if (action === 'status') {
        if (!id) throw new Error('status requires a round id');
        path = `/api/consultations/${encodeURIComponent(id)}`;
      } else if (action === 'dispatch') {
        if (!id) throw new Error('dispatch requires a round id');
        method = 'POST';
        path = `/api/consultations/${encodeURIComponent(id)}/dispatch`;
        body = {
          expertAssignmentId: consultText(options.expertAssignmentId) || undefined,
          expertSessionId: consultText(options.expertSessionId) || undefined,
          attemptId: consultText(options.attemptId) || undefined,
          agentId: consultText(options.agentId) || undefined,
          version: options.version === undefined ? undefined : Number(options.version),
        };
      } else if (action === 'decide') {
        if (!id) throw new Error('decide requires a round id');
        method = 'POST';
        path = `/api/consultations/${encodeURIComponent(id)}/decide`;
        body = {
          decision: consultText(options.decision),
          rationale: consultText(options.rationale) || undefined,
          requiredGuards: options.requiredGuards ? JSON.parse(options.requiredGuards) : undefined,
          decidedBySessionId: consultText(options.decidedBySessionId) || undefined,
          version: options.version === undefined ? undefined : Number(options.version),
        };
      } else if (action === 'cancel') {
        if (!id) throw new Error('cancel requires a round id');
        method = 'POST';
        path = `/api/consultations/${encodeURIComponent(id)}/cancel`;
        body = {
          reason: consultText(options.reason) || undefined,
          version: options.version === undefined ? undefined : Number(options.version),
        };
      } else if (action === 'decisions') {
        if (!id) throw new Error('decisions requires a round id');
        path = `/api/consultations/${encodeURIComponent(id)}/decisions`;
      } else {
        throw new Error(`Unknown consultation action: ${action}`);
      }

      const result = await client.request(path, {
        method,
        ...(body !== undefined ? { body } : {}),
      });
      if (!result.response.ok) {
        throw new Error(result.json?.error || result.text || `Consultation request failed (${result.response.status})`);
      }
      const output = result.json ?? { text: result.text };
      console.log(options.json ? JSON.stringify(output) : JSON.stringify(output, null, 2));
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'generate-token': {
    try {
      await spawnFile('node', [scriptPath('generate-token.mjs')]);
    } catch (err) {
      process.exit(err.status ?? 1);
    }
    break;
  }

  case 'set-password': {
    await import(modulePath('set-password.mjs'));
    break;
  }

  case '--version':
  case '-v':
    console.log(pkg.version);
    break;

  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "agentoc --help" for usage.');
    process.exit(1);
}

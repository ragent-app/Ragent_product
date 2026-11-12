// Runs inside the systemd fixture as agentoc-runner, not as the control UID.
import { waitForProtectedLinuxRunReady } from '../../chat/linux-run-peer-result-client.mjs';
import { writeRunResult } from '../../chat/runs.mjs';
const runId = 'run_peerhandofffixture1';
await waitForProtectedLinuxRunReady({ runId, launchAttempt: 0,
  socketPath: process.env.AGENTOC_LINUX_PEER_RESULT_SOCKET,
  peerHelper: process.env.AGENTOC_LINUX_PEER_CREDENTIAL_HELPER });
await writeRunResult(runId, { completedAt: '2026-11-12T00:00:00.000Z', exitCode: 0, signal: null });

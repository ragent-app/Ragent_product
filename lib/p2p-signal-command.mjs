import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';
export async function runP2PSignalCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`Usage:\n  ragent signal [--host 127.0.0.1] [--port 7791]\n\nRuns metadata-only WebRTC signaling. It does not relay HTTP, WebSocket, or DataChannel traffic.\n`);
    return 0;
  }
  const hostIndex = argv.indexOf('--host'); const portIndex = argv.indexOf('--port');
  const host = hostIndex >= 0 ? argv[hostIndex + 1] : (process.env.RAGENT_P2P_SIGNAL_HOST || '127.0.0.1');
  const port = Number.parseInt(portIndex >= 0 ? argv[portIndex + 1] : (process.env.RAGENT_P2P_SIGNAL_PORT || '7791'), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be between 0 and 65535');
  const signal = createP2PSignalingServer({ host, port }); const address = await signal.listen();
  stdout.write(`Ragent P2P signaling listening on ${address.address}:${address.port}\n`);
  const stop = async () => { await signal.close(); process.exit(0); }; process.once('SIGTERM', stop); process.once('SIGINT', stop); return new Promise(() => {});
}

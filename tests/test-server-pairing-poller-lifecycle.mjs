import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

// Gate the selected package entrypoint as well as the module. A working module
// cannot authorize anything when the shipped server never starts its poller.
const source = (await readFile(process.env.RAGENT_SERVER_LIFECYCLE_SOURCE
  || resolve('chat-server.mjs'), 'utf8')).replaceAll('\r\n', '\n');
const pollers = [
  { module: 'account-pairing-service', start: 'startAccountPairingPoller', stop: 'stopAccountPairingPoller',
    failure: 'account_pairing_unavailable', known: 'account_pairing_inactive' },
  { module: 'temporary-control-runtime', start: 'startTemporaryControlPoller', stop: 'stopTemporaryControlPoller',
    failure: 'temporary_control_unavailable', known: 'temporary_control_inactive' },
];

function wiring(poller) {
  const initializer = `let ${poller.stop} = () => {};`;
  assert.equal(source.split(initializer).length - 1, 1, `Missing/duplicate ${poller.stop} initializer in selected entrypoint`);
  const prefix = `  void import('./chat/${poller.module}.mjs')`;
  assert.equal(source.split(prefix).length - 1, 1, `Selected server must start ${poller.start} exactly once`);
  const start = source.indexOf(prefix), catchStart = source.indexOf('}).catch(', start);
  assert(catchStart > start);
  const newline = source.indexOf('\n', catchStart);
  const block = source.slice(start, newline < 0 ? source.length : newline);
  assert(block.includes(poller.start)); assert(block.endsWith(';'));
  const shutdown = source.slice(source.indexOf('async function shutdown('), source.indexOf('server.listen('));
  assert.equal(shutdown.split(`${poller.stop}();`).length - 1, 1, `Shutdown must release ${poller.start}`);
  return { initializer, block };
}

function run(poller, factory) {
  const { initializer, block } = wiring(poller), warnings = [];
  const context = vm.createContext({ shuttingDown: false,
    console: { warn: (...args) => warnings.push(args) },
    load: async () => ({ [poller.start]: factory }),
  });
  // Execute only the actual startup promise chain, with its module loader
  // substituted. No server, timer, key, service or real poller is started.
  vm.runInContext(initializer + '\n' + block.replace(`import('./chat/${poller.module}.mjs')`, 'load()')
    + `\nglobalThis.stopForTest = () => ${poller.stop}();`, context);
  return { context, warnings };
}
const settle = async () => { await setImmediate(); await setImmediate(); };

for (const poller of pollers) {
  test(`${poller.start}: selected entrypoint owns one startup and shutdown`, async () => {
    let starts = 0, stops = 0;
    const { context, warnings } = run(poller, async () => { starts++; return () => { stops++; }; });
    await settle(); assert.equal(starts, 1); assert.equal(stops, 0);
    context.stopForTest(); assert.equal(stops, 1); assert.equal(warnings.length, 0);
  });
  test(`${poller.start}: startup resolving after shutdown cannot leak a poller`, async () => {
    let resolveStart, starts = 0, stops = 0;
    const pending = new Promise(resolve => { resolveStart = resolve; });
    const { context } = run(poller, async () => { starts++; return pending; });
    await settle(); context.shuttingDown = true; context.stopForTest();
    resolveStart(() => { stops++; }); await settle();
    assert.equal(starts, 1); assert.equal(stops, 1);
    context.stopForTest(); assert.equal(stops, 1);
  });
  test(`${poller.start}: startup rejection exports fixed diagnostics`, async () => {
    const { context, warnings } = run(poller, async () => { throw new Error('secret-token-must-not-escape'); });
    await settle(); context.stopForTest(); assert.equal(warnings.length, 1);
    assert(!JSON.stringify(warnings).includes('secret-token-must-not-escape'));
  });
  test(`${poller.start}: runtime error callback redacts unknown details`, async () => {
    let callback;
    const { warnings } = run(poller, async options => { callback = options.onError; return () => {}; });
    await settle(); assert.equal(typeof callback, 'function');
    if (poller.module === 'account-pairing-service') {
      callback({ code: poller.known }); callback({ code: 'secret-token-must-not-escape' });
    } else {
      // The temporary runtime already narrows its callback to a fixed code.
      callback(poller.known);
    }
    assert(JSON.stringify(warnings).includes(poller.known));
    assert(!JSON.stringify(warnings).includes('secret-token-must-not-escape'));
    if (poller.module === 'account-pairing-service') assert(JSON.stringify(warnings).includes(poller.failure));
  });
}

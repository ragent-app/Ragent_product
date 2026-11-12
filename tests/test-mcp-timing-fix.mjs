#!/usr/bin/env node
/**
 * MCP Timing Fix Verification Test
 *
 * This test verifies the MCP timing fix implementation ensures:
 * 1. Correct sequence: mcp ready → turn/start
 * 2. Tool calls occur when MCP is ready
 * 3. Safe failure: MCP not ready → Run terminates
 * 4. Capability binding: productAgentCreate only exposed when MCP supported
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = process.cwd();
const RUNNER_SIDECAR_PATH = join(PROJECT_ROOT, 'chat', 'runner-sidecar.mjs');

function testMCPReadyBeforeTurnStart() {
  console.log('Testing: MCP ready before turn/start...');

  const source = readFileSync(RUNNER_SIDECAR_PATH, 'utf-8');

  // Test 1: Check that maybeStartCodexAppServerTurn checks the verified
  // readiness object before writing turn/start.
  const turnStartPattern = /function maybeStartCodexAppServerTurn\([^)]+\)[^{]*\{[\s\S]*?if \(state\.mcpRequired\)[\s\S]*?readiness\.state !== 'ready'/;
  assert.match(source, turnStartPattern,
    'maybeStartCodexAppServerTurn must check verified MCP readiness before starting turn');

  // Test 2: Startup readiness is only an inventory-refresh edge. The verified
  // inventory response, not the status notification alone, sets mcpReady.
  const readyPattern = /if \(startup\.status === 'ready'\)\s*\{[\s\S]*?state\.mcpReadyStatusObserved\s*=\s*true[\s\S]*?requestCodexAppServerMcpStatusList\([^)]*force:\s*true/;
  assert.match(source, readyPattern,
    'startup ready must force a fresh MCP inventory before the turn can start');

  // Test 3: The verified inventory response starts the deferred turn.
  const triggerPattern = /consumeCodexAppServerMcpStatusList[\s\S]*?readiness\.state === 'ready'[\s\S]*?maybeStartCodexAppServerTurn\([^)]*\{[\s\S]*?thread\/started[\s\S]*?\}\)/;
  assert.match(source, triggerPattern,
    'verified MCP inventory must trigger the deferred turn start');

  console.log('✅ MCP ready before turn/start: PASS');
}

function testProductAgentCreateConditional() {
  console.log('Testing: productAgentCreate conditional exposure...');

  const source = readFileSync(RUNNER_SIDECAR_PATH, 'utf-8');

  // Test 4: The grant must be projected into spawnEnv BEFORE overlay
  // preparation (the codex overlay snapshots the env into config.toml, and
  // codex MCP children do not inherit the process env), and still only when
  // the manifest grants productAgentCreate.
  const grantPattern = /if \(approvedActionChannel\.productAgentCreate === true\)\s*\{\s*spawnEnv\.AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED = '1';\s*\}/;
  const grantMatch = grantPattern.exec(source);
  assert.ok(grantMatch, 'productAgentCreate env grant must be conditioned on the manifest flag');
  const prepareIndex = source.indexOf('await prepareManagedMcpOverlay(');
  assert.ok(prepareIndex > 0, 'overlay preparation call must exist');
  assert.ok(grantMatch.index < prepareIndex,
    'productAgentCreate env grant must be set before overlay preparation snapshots the env');

  // Test 5: Check that ragent_create_agent is only added when MCP is supported
  const toolPattern = /if \(approvedActionChannel\.productAgentCreate === true\) requiredToolNames\.push\(['"]ragent_create_agent['"]\)/;
  assert.match(source, toolPattern,
    'ragent_create_agent tool must only be added when productAgentCreate is enabled');

  console.log('✅ productAgentCreate conditional exposure: PASS');
}

function testMCPTimeoutSafety() {
  console.log('Testing: MCP timeout safety mechanism...');

  const source = readFileSync(RUNNER_SIDECAR_PATH, 'utf-8');

  // Test 6: Check that timeout handler checks startedTurn before failing
  const timeoutPattern = /if \(!state\.startedTurn\)[\s\S]*?failCodexAppServerMcpReadiness\([^)]*MCP_READINESS_TIMEOUT/;
  assert.match(source, timeoutPattern,
    'Timeout handler must check startedTurn before failing the run');

  // Test 7: Check that failCodexAppServerMcpReadiness terminates the run
  const failPattern = /async function failCodexAppServerMcpReadiness\([^)]*\)[^{]*\{[\s\S]*?state\.terminalSeen\s*=\s*true[\s\S]*?terminate/;
  assert.match(source, failPattern,
    'failCodexAppServerMcpReadiness must set terminalSeen and call terminate');

  console.log('✅ MCP timeout safety mechanism: PASS');
}

function testMCPReadyInventoryRaceSafety() {
  console.log('Testing: MCP ready/inventory race safety...');

  const source = readFileSync(RUNNER_SIDECAR_PATH, 'utf-8');

  assert.match(source, /mcpStatusRequestAfterReady/,
    'MCP status requests must record whether they were sent after startup readiness');
  assert.match(source, /const requestWasAfterReady = state\.mcpStatusRequestAfterReady === true/,
    'MCP status responses must preserve the request timing metadata');
  assert.match(source, /if \(state\.mcpReadyStatusObserved && !requestWasAfterReady\)[\s\S]*?requestCodexAppServerMcpStatusList\([^)]*force:\s*true/,
    'a pre-ready inventory response must trigger a verified post-ready refresh');

  console.log('✅ MCP ready/inventory race safety: PASS');
}

function testNoDirectTurnStartOnThreadStarted() {
  console.log('Testing: No direct turn/start on thread/started...');

  const source = readFileSync(RUNNER_SIDECAR_PATH, 'utf-8');

  // Test 8: Check that the old direct call to maybeStartCodexAppServerTurn has been removed
  // from the verifyCodexAppServerMcpToolReadiness function
  const verifyFunction = /async function verifyCodexAppServerMcpToolReadiness\([^)]*\)[^{]*\{[\s\S]*?\n\}/;
  const verifyMatch = source.match(verifyFunction);

  if (verifyMatch) {
    const verifyCode = verifyMatch[0];
    // Count occurrences of maybeStartCodexAppServerTurn in verifyCodexAppServerMcpToolReadiness
    const calls = verifyCode.match(/maybeStartCodexAppServerTurn/g);
    assert.strictEqual(calls?.length || 0, 0,
      'verifyCodexAppServerMcpToolReadiness should not call maybeStartCodexAppServerTurn directly');
  }

  console.log('✅ No direct turn/start on thread/started: PASS');
}

function main() {
  console.log('🧪 MCP Timing Fix Verification Test\n');

  try {
    testMCPReadyBeforeTurnStart();
    testProductAgentCreateConditional();
    testMCPTimeoutSafety();
    testMCPReadyInventoryRaceSafety();
    testNoDirectTurnStartOnThreadStarted();

    console.log('\n✅ All MCP timing fix tests PASSED');
    console.log('\n📋 Summary:');
    console.log('   - MCP ready → turn/start sequence enforced');
    console.log('   - productAgentCreate conditionally exposed');
    console.log('   - MCP timeout safety mechanism in place');
    console.log('   - Pre-ready MCP inventory cannot trigger false missing-tool failures');
    console.log('   - Removed direct turn/start on thread/started');

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Test FAILED: ${error.message}`);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  testMCPReadyBeforeTurnStart,
  testProductAgentCreateConditional,
  testMCPTimeoutSafety,
  testMCPReadyInventoryRaceSafety,
};

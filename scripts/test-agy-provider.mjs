#!/usr/bin/env node
/**
 * AgY Provider Integration Test for Ragent
 *
 * This script tests the AgY CLI integration with Ragent:
 * 1. Checks if AgY CLI is available
 * 2. Tests basic AgY commands (models, agents, version)
 * 3. Tests AgY prompt execution
 * 4. Verifies AgY provider routes
 * 5. Tests AgY authentication setup
 */

import { resolveAgyPath, ensureAgyAvailable, getAgyVersion, listAgyModels, listAgyAgents, executeAgyPrompt } from '../lib/agy-manager.mjs';
import { syncAgyCredentials, getAgyStatus, setupAgyAuthentication } from '../lib/agy-auth.mjs';

const TEST_TIMEOUT = 120000;
let passedTests = 0;
let failedTests = 0;

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'info': 'ℹ️',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️'
  }[type] || 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

async function testAgyAvailability() {
  log('Testing AgY CLI availability...', 'info');

  try {
    const available = await ensureAgyAvailable();
    if (available) {
      const path = await resolveAgyPath();
      log(`AgY CLI found at: ${path}`, 'success');
      passedTests++;
      return true;
    } else {
      log('AgY CLI not available', 'error');
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`AgY availability test failed: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function testAgyVersion() {
  log('Testing AgY version...', 'info');

  try {
    const version = await getAgyVersion();
    log(`AgY version: ${version}`, 'success');
    passedTests++;
    return true;
  } catch (error) {
    log(`AgY version test failed: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function testAgyModels() {
  log('Testing AgY models listing...', 'info');

  try {
    const models = await listAgyModels();
    const labels = models.slice(0, 3).map((model) => model?.label || model?.id || model);
    log(`Found ${models.length} AgY models: ${labels.join(', ')}${models.length > 3 ? '...' : ''}`, 'success');
    passedTests++;
    return models;
  } catch (error) {
    log(`AgY models test failed: ${error.message}`, 'error');
    failedTests++;
    return [];
  }
}

async function testAgyAgents() {
  log('Testing AgY agents listing...', 'info');

  try {
    const agents = await listAgyAgents();
    log(`Found ${agents.length} AgY agents: ${agents.slice(0, 3).join(', ')}${agents.length > 3 ? '...' : ''}`, 'success');
    passedTests++;
    return agents;
  } catch (error) {
    log(`AgY agents test failed: ${error.message}`, 'error');
    failedTests++;
    return [];
  }
}

async function testAgyExecution() {
  log('Testing AgY prompt execution...', 'info');

  try {
    const result = await executeAgyPrompt('What is 2+2? Answer with just the number.', {
      format: 'text',
      timeout: 60000
    });

    if (result.text && result.text.includes('4')) {
      log('AgY execution test passed - got correct answer', 'success');
      passedTests++;
      return true;
    } else {
      log(`AgY execution test failed - unexpected answer: ${result.text}`, 'error');
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`AgY execution test failed: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function testAgyAuth() {
  log('Testing AgY authentication setup...', 'info');

  try {
    const status = await getAgyStatus();
    log(`AgY auth status: configured=${status.configured}, managedHome=${status.managedHome}`, 'success');

    // Test sync (read-only)
    const syncResult = await syncAgyCredentials();
    log(`AgY credentials sync: found ${syncResult.credentialsFound} credentials`, 'success');

    passedTests++;
    return true;
  } catch (error) {
    log(`AgY auth test failed: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function runAllTests() {
  log('Starting AgY Provider Integration Tests...', 'info');
  log('===========================================', 'info');

  // Test 1: Availability
  const available = await testAgyAvailability();
  if (!available) {
    log('AgY CLI not available - skipping remaining tests', 'warning');
    return;
  }

  // Test 2: Version
  await testAgyVersion();

  // Test 3: Models
  const models = await testAgyModels();

  // Test 4: Agents
  const agents = await testAgyAgents();

  // Test 5: Authentication (read-only tests)
  await testAgyAuth();

  // Test 6: Basic execution (if models available)
  if (models.length > 0) {
    await testAgyExecution();
  } else {
    log('Skipping AgY execution test - no models available', 'warning');
  }

  // Summary
  log('===========================================', 'info');
  log(`Tests completed: ${passedTests} passed, ${failedTests} failed`, 'info');

  if (failedTests === 0) {
    log('🎉 All AgY integration tests passed!', 'success');
    process.exit(0);
  } else {
    log(`⚠️  ${failedTests} test(s) failed`, 'warning');
    process.exit(1);
  }
}

// Set timeout for entire test suite
setTimeout(() => {
  log('Test suite timed out', 'error');
  process.exit(1);
}, TEST_TIMEOUT);

// Run tests
runAllTests().catch(error => {
  log(`Test suite error: ${error.message}`, 'error');
  process.exit(1);
});

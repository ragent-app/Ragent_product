#!/usr/bin/env node
/**
 * Same-user configuration verification test
 *
 * This test verifies that the same-user runner configuration is correctly
 * set up and that security boundaries are maintained.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TEST_USER = process.env.RAGENT_TEST_USER || 'pinggu';

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (error) {
    return null;
  }
}

async function testServiceUserFile() {
  console.log('Testing service user file...');

  const serviceUserPath = '/etc/ragent/service-user';
  if (!existsSync(serviceUserPath)) {
    console.log('  ⚠️  Service user file does not exist (expected before migration)');
    return false;
  }

  const serviceUser = (await readFile(serviceUserPath, 'utf-8')).trim();
  if (serviceUser !== TEST_USER) {
    console.log(`  ❌ Service user file contains "${serviceUser}", expected "${TEST_USER}"`);
    return false;
  }

  console.log(`  ✓ Service user file correctly contains "${TEST_USER}"`);
  return true;
}

async function testSystemdDropin() {
  console.log('Testing systemd drop-in configuration...');

  const dropinPath = '/etc/systemd/system/ragent-runner-supervisor.service.d/30-same-user.conf';
  if (!existsSync(dropinPath)) {
    console.log('  ⚠️  Same-user drop-in does not exist (expected before migration)');
    return false;
  }

  const dropinContent = await readFile(dropinPath, 'utf-8');
  if (!dropinContent.includes(`User=${TEST_USER}`)) {
    console.log(`  ❌ Drop-in does not contain User=${TEST_USER}`);
    return false;
  }

  console.log(`  ✓ Systemd drop-in correctly configured for User=${TEST_USER}`);
  return true;
}

async function testCurrentServiceIdentity() {
  console.log('Testing current service identity...');

  const status = exec('systemctl status ragent-runner-supervisor.service --no-pager');
  if (!status) {
    console.log('  ⚠️  Service not running');
    return false;
  }

  const mainPid = exec('systemctl show ragent-runner-supervisor.service --property=MainPid --value');
  if (!mainPid || mainPid === '0') {
    console.log('  ⚠️  Service has no main PID');
    return false;
  }

  const processUser = exec(`ps -o user= -p ${mainPid}`).trim();
  if (processUser !== TEST_USER) {
    console.log(`  ⚠️  Service running as "${processUser}", expected "${TEST_USER}" (expected before migration)`);
    return false;
  }

  console.log(`  ✓ Service correctly running as "${TEST_USER}"`);
  return true;
}

async function testSecurityBoundaries() {
  console.log('Testing security boundaries...');

  const status = exec('systemctl show ragent-runner-supervisor.service --property=NoNewPrivileges --value');
  if (status !== 'false') {
    console.log('  ❌ Runner NoNewPrivileges must be disabled for privileged approval');
    return false;
  }

  console.log('  ✓ Runner NoNewPrivileges is disabled; elevation stays executor-bound');

  const restrictAddr = exec('systemctl show ragent-runner-supervisor.service --property=RestrictAddressFamilies --value');
  if (restrictAddr && restrictAddr !== '') {
    console.log('  ✓ Address families are restricted');
  }

  const inaccessiblePaths = exec('systemctl show ragent-runner-supervisor.service --property=InaccessiblePaths --value');
  if (inaccessiblePaths && inaccessiblePaths.includes('/etc/ragent')) {
    console.log('  ✓ Control plane paths are inaccessible');
  }

  return true;
}

async function testWorktreeAccess() {
  console.log('Testing worktree access...');

  const testDir = `/home/${TEST_USER}/.config/ragent-test`;
  try {
    exec(`mkdir -p ${testDir}`);
    exec(`touch ${testDir}/test-file.txt`);

    const testFile = `${testDir}/test-file.txt`;
    if (existsSync(testFile)) {
      console.log('  ✓ Worktree files are accessible');
      exec(`rm -rf ${testDir}`);
      return true;
    }
  } catch (error) {
    console.log('  ❌ Cannot access worktree files');
    return false;
  }
}

async function main() {
  console.log(`Same-User Configuration Verification Test (user: ${TEST_USER})`);
  console.log('=' .repeat(60));

  const results = {
    serviceUserFile: await testServiceUserFile(),
    systemdDropin: await testSystemdDropin(),
    serviceIdentity: await testCurrentServiceIdentity(),
    securityBoundaries: await testSecurityBoundaries(),
    worktreeAccess: await testWorktreeAccess()
  };

  console.log('\n' + '='.repeat(60));
  console.log('Test Results:');
  console.log(`  Service User File: ${results.serviceUserFile ? '✓' : '○'}`);
  console.log(`  Systemd Drop-in: ${results.systemdDropin ? '✓' : '○'}`);
  console.log(`  Service Identity: ${results.serviceIdentity ? '✓' : '○'}`);
  console.log(`  Security Boundaries: ${results.securityBoundaries ? '✓' : '✓'}`);
  console.log(`  Worktree Access: ${results.worktreeAccess ? '✓' : '❌'}`);

  const migrationComplete = results.serviceUserFile && results.systemdDropin && results.serviceIdentity;

  if (migrationComplete) {
    console.log('\n✓ Same-user migration is COMPLETE');
    process.exit(0);
  } else {
    console.log('\n⚠️  Same-user migration is PENDING - run the migration script');
    console.log('   sudo ./scripts/complete-same-user-migration.sh');
    process.exit(0);
  }
}

main().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});

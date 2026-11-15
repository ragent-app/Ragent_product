#!/usr/bin/env node
import { spawn } from 'child_process';

const [, , ...args] = process.argv;

if (args.length === 0) {
  console.error('Usage: node scripts/run-with-clean-instance-env.mjs <command> [args...]');
  process.exit(1);
}

const env = { ...process.env };
delete env.RAGENT_INSTANCE_ROOT;
delete env.RAGENT_CONFIG_DIR;
delete env.RAGENT_MEMORY_DIR;
delete env.RAGENT_WORK_ROOT_DIR;
delete env.RAGENT_RUN_SPOOL_DIR;
delete env.RAGENT_PROVIDER_HOMES_DIR;
delete env.RAGENT_PROJECT_ROOT;
delete env.RAGENT_USER_SHELL_ENV_B64;
delete env.RAGENT_RUNNER_SUPERVISOR_SOCKET;
delete env.RAGENT_RUNNER_SUPERVISOR_REQUIRED;
delete env.RAGENT_RUNNER_LIFECYCLE_SOCKET;
delete env.RAGENT_RUNNER_LIFECYCLE_REQUIRED;
delete env.RAGENT_RUNNER_LAUNCH_MODE;
delete env.RAGENT_RUNNER_UNIT_NAME;
delete env.RAGENT_RUNNER_UNIT_SCOPE;
if (!Object.prototype.hasOwnProperty.call(env, 'RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER')) {
  env.RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
}

// npm is installed as a command shim on Windows; resolve its JavaScript entry
// point without enabling a shell for arbitrary arguments.
const npmExecPath = process.env.npm_execpath;
const useNpmEntry = process.platform === 'win32' && args[0] === 'npm' && Boolean(npmExecPath);
const command = useNpmEntry ? process.execPath : args[0];
const commandArgs = useNpmEntry ? [npmExecPath, ...args.slice(1)] : args.slice(1);
const child = spawn(command, commandArgs, {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error.message || String(error));
  process.exit(1);
});

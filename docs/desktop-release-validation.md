# Desktop release validation

Use this checklist for each candidate source commit and each supported
OS/architecture. Record the package name and SHA-256, exact commit, toolchain
versions, operating-system version, test environment and results. An unsigned
or ad-hoc-signed candidate must be identified as such. A simulated provider,
virtual display or WSL result must not be described as a real model call,
physical desktop result or native macOS result.

## Installation and lifecycle

- Install on a clean supported system as a normal user following the package
  instructions. Verify first launch, initial credentials, service health,
  manager startup, logs and a reboot or login restart.
- Verify a second launch, a service crash and restart, a port conflict, offline
  startup and recovery. Confirm failures are visible and an unrelated process
  is never stopped or treated as the Ragent service.
- Upgrade from the previous distributed version. Verify configuration,
  credentials, sessions and workspaces are preserved; exercise the documented
  recovery or rollback procedure after an interrupted upgrade.
- Uninstall while idle and while a run is active. Verify services stop as
  documented, ordinary removal preserves data, and an explicitly requested
  purge removes the documented data only.

## Functions and security

- Use the manager and workbench to create a project and session, read and edit
  files, run, stop and resume tasks, and inspect history after a restart.
- For each advertised Harness, verify install or discovery, version, sign-in,
  a real task, streaming output, cancellation and a disconnected provider.
  Record any provider account, service or usage dependency.
- Exercise manual approval, denial, timeouts and every advertised automated
  risk mode. Check workspace boundaries, symlinks, long paths, distinct local
  OS users, privileged operations and process cleanup. Validate the actual
  sandbox and execution identity rather than relying on configuration alone.
- Verify password and account sessions, visitor scope, local and tunneled
  access, credential file permissions and the absence of secrets in logs and
  package contents. Document the local loopback trust model.
- With an authorized test account and physical Android device, verify account
  binding, pairing, connection, session interaction, disconnect/reconnect,
  network changes and the supported relay/direct paths. Offline crypto or ADB
  fixtures are useful evidence but do not replace this end-to-end check.

## Packaging and release

- Rebuild from the recorded commit with pinned inputs. Check architecture,
  dependency notices, source identity and SHA-256 of each artifact. Verify any
  asset-specific update marker against the actual release asset digest.
- On macOS, verify the Developer ID signature, notarization result, stapled
  ticket and Gatekeeper behavior on a clean supported Mac. Confirm the app,
  embedded manager and bundled providers launch after signing and after moving
  the app to Applications.
- Confirm the release owner has reviewed applicable third-party preinstallation
  terms, including Claude Code authentication and billing conditions. Never
  bundle production credentials or personal data.
- Publish only the supported platform/architecture combinations that passed
  their gates. State unresolved limitations, signing status, exact source,
  install and removal instructions, and update/rollback behavior in release
  notes. Keep the previous verified release available for recovery.

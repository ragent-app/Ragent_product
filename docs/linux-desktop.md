# Linux desktop candidate

The Debian package is being prepared for Ubuntu 24.04 x86-64. It includes the
local service, desktop manager, Node runtime, P2P host and the pinned Codex and
Claude runtimes. Availability and validation of a particular package are stated
in its release notes; a source build alone is not a published release.

## Install and first use

On a supported system with systemd, install a verified package with
`sudo apt install ./agentoc_<version>_amd64.deb`, then open **Ragent** from the
applications menu. The manager connects to the service on `127.0.0.1:7690`.
The package starts its system services during installation and after reboot.
It does not require a separately installed Node runtime.

On an interactive installation, the installer can ask for an owner username
and password. A non-interactive installation generates a password instead and
stores it in `/etc/agentoc/initial-credentials`, readable only by root. An
administrator can read it with `sudo cat /etc/agentoc/initial-credentials`.
After recording it and changing the password in Settings, remove the file with
`sudo rm /etc/agentoc/initial-credentials`. An existing installation's
credentials are retained on upgrade.

Local HTML navigation can automatically create an owner session. Loopback TCP
is shared by local OS users, so this mode treats other local users and programs
as trusted; use a dedicated user or host where that assumption holds. Remote
access requires its own authentication and must not expose the local service
without an appropriate access-control boundary.

The installer uses the invoking sudo user as the service user when it can
establish that identity; otherwise it uses the `agentoc` system account. Runs
have the configured service user's ordinary file access. Check
`/etc/agentoc/service-user` before relying on access to an existing workspace.
The systemd runner currently refuses accounts that belong to restricted
system groups such as `sudo` or `docker`: systemd automatically inherits
those memberships even when they are omitted from supplementary group settings.
Configure an unprivileged runner account under the administrator's control;
set `AGENTOC_RUNNER_SAME_USER=0`, `AGENTOC_RUNNER_USER` and
`AGENTOC_RUNNER_GROUP` in `/etc/agentoc/agentoc.env`, then restart the lifecycle
broker and service. Its workspace access must be set up separately.
Transparent safe group removal for same-user runs remains to be implemented
and validated.

## Optional runner sandbox

When `AGENTOC_RUN_SANDBOX=1` is configured, Runs require the root-owned system
binary at `/usr/bin/bwrap` and safe ownership and permissions on its parent
directories. A missing or untrusted binary refuses the Run instead of silently
running without the requested isolation. Without this option, the product does
not claim that this bubblewrap boundary is active.

Read-only Runs require this sandbox regardless of the optional setting. Their
host filesystem, including the runner home, is mounted read-only. Codex and
Claude receive a private temporary home seeded from selected managed provider
files; changes there do not persist. Native OAuth credentials are refused for
this mode to avoid consuming or rotating shared refresh tokens from a copy.
Other providers and configurations may still be incompatible. This is a
filesystem boundary, not a complete network or inter-process isolation claim;
real provider compatibility and remaining security boundaries require separate
acceptance.

## Maintain and remove

- `systemctl status agentoc.service` shows the service state.
- `journalctl -u agentoc.service` shows the service log.
- `sudo apt remove agentoc` removes the package and keeps user state.
- `sudo apt purge agentoc` removes the host's local configuration, data, run
  state and logs. State for a separately deployed Accounts service under
  `/var/lib/agentoc/accounts` is retained.

Removal stops scheduled and already-running storage cleanup, the service,
activation sockets, brokers and detached Runs. If
systemd cannot confirm that a component has stopped, package removal fails;
inspect the relevant unit with `systemctl status` and its journal, resolve the
failure, then retry the removal.

An update should use a newer Debian package version. The desktop update check
offers the matching Linux x86-64 release asset when one is published; it does
not install the update automatically. Back up data before an upgrade and read
the release notes for migration and rollback limits.

## Build a candidate

Use a clean committed checkout, Node 24, the Go version declared in `p2p/go.mod`,
the Debian packaging tools, a C compiler and the native architecture. Set
`AGENTOC_PACKAGE_VERSION` to the intended three-part public version,
`AGENTOC_DEB_OUTPUT_DIR` to the output directory, and `AGENTOC_NODE_CACHE_DIR`
to an existing writable cache directory before running `bash scripts/build-deb.sh`.
The builder records the full source commit and rejects a dirty checkout.
For an archive build without a second checkout or worktree, set
`AGENTOC_SOURCE_GIT_DIR` to a bare Git object store and
`AGENTOC_SOURCE_COMMIT` to its full expected HEAD commit. Invoke the build and
staging scripts from exact copies of that commit. The builder checks those
scripts against Git, stages the desktop allowlist from committed objects, and
rechecks the staged files before publishing the package. A commit marker in an
archive alone is not sufficient proof of the archive's contents. The object
store must contain all objects needed by the desktop payload and must not
depend on external alternate stores. Set `TMPDIR`, npm, Go and Electron caches
to the intended build storage before starting. The package must still pass native
installation, upgrade, security and device-connection acceptance before release.
Use the [desktop release validation checklist](desktop-release-validation.md)
to record the candidate's evidence and remaining limitations.
An offline Claude Code binary override also requires its SHA-256 and its
license file (`AGENTOC_CLAUDE_BINARY_SHA256` and
`AGENTOC_CLAUDE_LICENSE_SOURCE`). Release owners must review the applicable
[Claude Code preinstallation terms](https://code.claude.com/docs/en/legal-and-compliance),
including end-user authentication and billing conditions, before distribution.

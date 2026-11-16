# Linux desktop

Linux package candidates target Ubuntu 22.04, 24.04 and 26.04 and Debian 12
and 13 on amd64 and arm64, plus RHEL 9 x86-64 for RPM. These are targets,
not a declaration that every combination has passed release acceptance. See
the [Linux acceptance criteria](linux-release-acceptance.md) and the release
notes for the status of each package and operating system. The package includes the
local service, desktop manager, Node runtime, P2P host and the pinned Codex and
Claude runtimes. Availability and validation of a particular package are stated
in its release notes; a source build alone is not a published release.

## Install and first use

On a supported system with systemd, install a verified package with
`sudo apt install ./ragent_<version>_amd64.deb`, then open **Ragent** from the
applications menu. The manager connects to the service on `127.0.0.1:7690`.
The package starts its system services during installation and after reboot.
It does not require a separately installed Node runtime.

For an RPM candidate on an EL9 system, use
`sudo dnf install ./Ragent-<version>-rhel9-x86_64.rpm`. Consult the
[Linux acceptance record](linux-release-acceptance.md) and release notes for
the exact tested distribution; a Rocky Linux result does not establish RHEL
compatibility. RPM auto-update is not enabled for Rocky Linux.
On RPM systems, the apt-based privileged package-install adapter and remote
instance bootstrap are unavailable. The local service remains available.

On an interactive installation, the installer can ask for an owner username
and password. A non-interactive installation generates a password instead and
stores it in `/etc/ragent/initial-credentials`, readable only by root. An
administrator can read it with `sudo cat /etc/ragent/initial-credentials`.
After recording it and changing the password in Settings, remove the file with
`sudo rm /etc/ragent/initial-credentials`. An existing installation's
credentials are retained on upgrade.

Local HTML navigation can automatically create an owner session. Loopback TCP
is shared by local OS users, so this mode treats other local users and programs
as trusted; use a dedicated user or host where that assumption holds. Remote
access requires its own authentication and must not expose the local service
without an appropriate access-control boundary.

The installer uses the invoking sudo user as the service user when it can
establish that identity; otherwise it uses the `ragent` system account. Runs
have the configured service user's ordinary file access. Check
`/etc/ragent/service-user` before relying on access to an existing workspace.
By default, the systemd launcher removes restricted supplementary groups such
as `sudo` and `docker` before starting a same-user Run. It uses the trusted
`/usr/bin/setpriv` and verifies numeric group IDs as well as names to catch
aliases. If the executable or group identities cannot be verified, the Run is
refused. This preserves ordinary access granted directly to the service user;
access that depends on a removed group is unavailable to the Run.
For a separate unprivileged runner, set `RAGENT_RUNNER_SAME_USER=0`,
`RAGENT_RUNNER_USER` and `RAGENT_RUNNER_GROUP` in the root-controlled
environment, then restart the lifecycle broker and service. Run publication
files and capability tokens use file ACLs for the designated runner; older
versions of those files are repaired on launch.

Ragent does not automatically change workspace ACLs or create temporary
workspace groups. A separate runner needs access provisioned explicitly by an
administrator. For a separate-UID Run, the workspace root must be traversable;
the execution directory must be readable and traversable for a read-only Run,
and readable, writable and traversable for other Runs. These directory checks
do not establish access to every file inside the workspace. Existing temporary
workspace-access records and groups from older builds are retained for manual review; do not delete a group or remove
numeric ACL entries until their identity, active users, and original permissions
have been established. Automatic restoration cannot safely reconstruct a prior
ACL mask or default ACL from those records.

Codex can read the project's existing `.codex` configuration according to its
own project-trust rules and the runner's filesystem permissions. Only run it in
projects whose configuration you trust, and review any requested permissions
before authorizing them. Ragent does not hide or modify that project directory;
read-only and other restricted modes still apply their own access rules.

A same-user Run has the service user's UID, while a separately configured
runner has its own UID. Neither choice by itself guarantees isolation from
other processes or files. The systemd restrictions and optional runner sandbox
have distinct boundaries; use the required isolation and authorization for the
work being performed.

Before upgrading or restarting an older lifecycle broker and its workspace
helper, confirm that no Runs or workspace ACL cleanup processes are still
active; wait for them to finish before replacing or restarting those components.
A process that already loaded the older helper can still execute its old
cleanup logic after files are replaced. Preserve legacy records, groups, and
user data for review; the new helper does not automatically alter them.

If a Codex launch reports `CODEX_BROKER_STATE_UNCERTAIN`, first inspect active
Runs, the broker process and the socket's actual owner. Do not kill a process or
remove a socket merely because the probe timed out. Once an administrator has
confirmed that no active Run or broker holds the endpoint and established its
ownership, handle that specific stale endpoint in a controlled way before
retrying.
A separate-UID Linux Run cannot use the shared Codex OAuth broker: Ragent
refuses that path because the broker's process identity cannot be verified as
the runner. Configure a supported execution path for the chosen identity;
historical successful Runs do not establish current compatibility.
The packaged `RAGENT_RUNNER_DROP_GROUPS=auto` setting uses this path for
same-user Runs; a separate runner uses the systemd group-membership check.
Setting it to `0` retains that check for all Runs, so an account in a restricted
group is refused. Setting it to `1` explicitly uses group dropping for both
configurations. On one Ubuntu 24.04 x86-64 host, a real same-user Codex request
completed and a process-identity probe confirmed restricted groups were absent.
Broader host, security and release acceptance are still outstanding.

The privileged executor records one-shot approvals in
`/var/log/ragent-privileged/audit.jsonl` before execution. If that file is
unreadable, malformed, incomplete, linked or writable by other users, the
executor refuses to start; if a required record cannot be persisted, it
refuses that operation. An administrator should investigate and restore a
trusted audit history before retrying. Deleting or replacing the audit file
loses replay history; do not treat an empty replacement as a repair. These
checks depend on the audit directory and its contents remaining protected from
unauthorized deletion or replacement by the host administrator.

## Optional runner sandbox

When `RAGENT_RUN_SANDBOX=1` is configured, Runs require the root-owned system
binary at `/usr/bin/bwrap` and safe ownership and permissions on its parent
directories. A missing or untrusted binary refuses the Run instead of silently
running without the requested isolation. Without this option, the product does
not claim that this bubblewrap boundary is active.

Read-only Runs require this sandbox regardless of the optional setting. Their
host filesystem, including the runner home, is mounted read-only. Codex and
Claude receive a private temporary home seeded from selected managed provider
files; changes there do not persist. Native OAuth credentials are refused for
this mode to avoid consuming or rotating shared refresh tokens from a copy.
On Linux, Codex provider-native read-only execution is currently unavailable:
Ragent refuses it when the provider-reported policy cannot prove the required
process isolation. Other providers and configurations may also be incompatible.
The sandbox is a filesystem boundary, not a complete network or inter-process
isolation claim; real provider compatibility and remaining security boundaries
require separate acceptance.

## Maintain and remove

- `systemctl status ragent.service` shows the service state.
- `journalctl -u ragent.service` shows the service log.
- `sudo apt remove ragent` removes the package and keeps user state.
- `sudo apt purge ragent` removes the host's local configuration, data, run
  state and logs. State for a separately deployed Accounts service under
  `/var/lib/ragent/accounts` is retained.
- On RPM systems, `sudo dnf remove ragent` removes the package. On the tested
  Rocky 9 system it retained `/var/lib/ragent` and generated credentials, but
  removed the unmodified packaged `/etc/ragent/ragent.env`. A modified file
  was saved as `ragent.env.rpmsave`; after reinstalling, an administrator
  must merge the saved settings into the new file.

Removal stops scheduled and already-running storage cleanup, the service,
activation sockets, brokers and detached Runs. If
systemd cannot confirm that a component has stopped, package removal fails;
inspect the relevant unit with `systemctl status` and its journal, resolve the
failure, then retry the removal.

An update must use a newer internal Debian package version. Builds containing
the desktop updater can download and verify the matching release package and
launch installation after administrator authorization; the installer waits for
blocking tasks. Older builds without the updater require a manual upgrade first.
Read the release notes for migration and rollback limits.

## Build a candidate

Use a clean committed checkout, Node 24, the Go version declared in `p2p/go.mod`,
the Debian packaging tools, a C compiler and the native architecture. Set
`RAGENT_PACKAGE_VERSION` to the intended three-part public version,
`RAGENT_DEB_OUTPUT_DIR` to the output directory, and `RAGENT_NODE_CACHE_DIR`
to an existing writable cache directory before running `bash scripts/build-deb.sh`.
The builder records the full source commit and rejects a dirty checkout.
For an archive build without a second checkout or worktree, set
`RAGENT_SOURCE_GIT_DIR` to a bare Git object store and
`RAGENT_SOURCE_COMMIT` to its full expected HEAD commit. Invoke the build and
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
license file (`RAGENT_CLAUDE_BINARY_SHA256` and
`RAGENT_CLAUDE_LICENSE_SOURCE`). Release owners must review the applicable
[Claude Code preinstallation terms](https://code.claude.com/docs/en/legal-and-compliance),
including end-user authentication and billing conditions, before distribution.

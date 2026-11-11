# macOS desktop candidate

The macOS candidate targets Apple Silicon and macOS 13 or later. The app bundle
contains the local service, desktop manager, bundled Node runtime, P2P host and
provider launchers. A candidate built from source is not a released or verified
package; consult the corresponding release notes for actual support and tests.

The local service defaults to `127.0.0.1:7690`. Local HTML navigation can
automatically create an owner session. Loopback TCP is shared by local OS users,
so this mode treats other local users and programs as trusted. Remote access
requires its own authentication and an appropriate network boundary.

On first launch the app creates an owner password and stores it in the current
user's `~/.config/agentoc/owner-credentials.txt` with owner-only permissions.
After recording it and changing the password in Settings, delete that file.
The configuration directory and existing credentials are retained on upgrade.
Before replacing the app, stop its service and disable login startup if it is
enabled. Start the replacement, then re-enable login startup if needed. The
launcher compares the service's startup package version and source commit
with the installed bundle; if they differ or cannot be verified, it leaves the
service untouched and asks for a restart.

## Login startup

Login startup is opt-in. Stop an existing Ragent service first, then run
`/Applications/AgentoC.app/Contents/Resources/agentoc-login enable` in Terminal.
Use the same command with `status` to inspect it or `disable` to stop and
unregister it. The tool leaves configuration, credentials, workspaces and
logs in place. It will not overwrite a different LaunchAgent or unload another
job with the same label. Disable it before moving the app, then enable it from
the new location. A pre-existing manually installed job must be reviewed and
removed separately. A 0.0.18 test app built from commit `eff2bbe` passed isolated native
registration, service health, process termination and automatic recovery,
and unregistration with configuration retained. Actual logout/login and
upgrades still require acceptance using the final installed app.

## Approval limitation

The semantic approval compiler and permission target validator currently model
Linux and Windows, not macOS. Requests that depend on that authorization path
cannot be advertised as having Windows-equivalent approval support on macOS.
Complete a macOS-specific command and target resolver, executor integration and
native security acceptance before claiming those capabilities. Do not treat
the Linux resolver as a macOS security boundary without platform validation.

## Build and signing

Build on a clean committed Apple Silicon Mac with Node 24, the Go version in
`p2p/go.mod`, Xcode command-line tools and sufficient disk space. Set
`AGENTOC_PACKAGE_VERSION` to a three-part version, `AGENTOC_DMG_OUTPUT_DIR` to
the output directory, and `AGENTOC_NODE_CACHE_DIR` to a writable cache, then run
`bash scripts/build-dmg.sh`. Set temporary and dependency cache locations for
the build environment before starting. The builder records the full source
commit, rejects tracked changes and nonignored untracked files, and checks again before
notarization and before returning the artifact. An optional prebuilt P2P host requires
both `AGENTOC_P2P_HOST_BINARY` and `AGENTOC_P2P_HOST_SHA256`; the input digest
before app signing is recorded with the bundled runtime versions.

For a build without a second checkout or worktree, the same builder can read
from a bare Git object store containing the complete objects required by the
desktop payload. Provide an explicit output directory, set
`AGENTOC_SOURCE_GIT_DIR` to that bare store and `AGENTOC_SOURCE_COMMIT` to its
full expected HEAD commit. Invoke the builder and its staging scripts from a
bootstrap copy of those exact committed files, including the matching Node
license. The builder compares the bootstrap scripts with Git, stages the
allowlisted source from committed objects, and checks the staged file hashes
again before notarization and publishing the candidate. The object store must
not contain credentials or depend on missing, lazily fetched objects. This
mode does not require a Git checkout on the Mac.

Without a signing identity the build is ad-hoc signed and is suitable only for
controlled testing. For a direct-distribution candidate, set
`AGENTOC_MAC_SIGN_IDENTITY` to a Developer ID Application identity available
in the Mac keychain. To submit the signed DMG to Apple, also set
`AGENTOC_MAC_NOTARY_PROFILE` to a previously configured `notarytool` keychain
profile. The builder waits for acceptance, staples and validates the ticket,
and records a signing status and, when applicable, the notary result beside the
DMG. It fails if signing changes the bundled Claude Code binary. These paths
still require native build, launch, upgrade, Gatekeeper and device-connection
acceptance with the actual certificate before they can be treated as a release.
The candidate signer signs the Electron manager and its nested helpers,
then signs the bundled Node and P2P binaries and finally the outer app. It
preserves the upstream Claude binary. Native Developer ID signing and Apple
notarization still require acceptance on a Mac with the release credentials;
an ad-hoc signature does not establish distribution readiness.
See Apple's [distribution signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/).
Use the [desktop release validation checklist](desktop-release-validation.md)
to record the candidate's evidence and remaining limitations.

The package includes the upstream Claude Code license. Before distribution,
the release owner must review the applicable
[Claude Code preinstallation terms](https://code.claude.com/docs/en/legal-and-compliance),
including end-user authentication and billing conditions.

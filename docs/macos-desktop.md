# macOS desktop candidate

The macOS candidate targets Apple Silicon and macOS 13 or later. The app bundle
contains the local service, desktop manager, bundled Node runtime, P2P host and
provider launchers. A candidate built from source is not a released or verified
package; consult the corresponding release notes for actual support and tests.

The local service defaults to `127.0.0.1:7690`. Local HTML navigation can
automatically create an owner session. Loopback TCP is shared by local OS users,
so this mode treats other local users and programs as trusted. Remote access
requires its own authentication and an appropriate network boundary.

## Build and signing

Build on a clean committed Apple Silicon Mac with Node 24, the Go version in
`p2p/go.mod`, Xcode command-line tools and sufficient disk space. Set
`AGENTOC_PACKAGE_VERSION` to a three-part version, `AGENTOC_DMG_OUTPUT_DIR` to
the output directory, and `AGENTOC_NODE_CACHE_DIR` to a writable cache, then run
`bash scripts/build-dmg.sh`. Set temporary and dependency cache locations for
the build environment before starting. An optional prebuilt P2P host requires
both `AGENTOC_P2P_HOST_BINARY` and `AGENTOC_P2P_HOST_SHA256`; the input digest
before app signing is recorded with the bundled runtime versions.

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
Use the [desktop release validation checklist](desktop-release-validation.md)
to record the candidate's evidence and remaining limitations.

The package includes the upstream Claude Code license. Before distribution,
the release owner must review the applicable
[Claude Code preinstallation terms](https://code.claude.com/docs/en/legal-and-compliance),
including end-user authentication and billing conditions.

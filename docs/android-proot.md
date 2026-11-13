# Ragent on Android via Ubuntu PRoot (preview)

Development status, 2026-11-14: the account-link and remote-access code is implemented, but the final APK and PRoot archive have not yet been produced. Android core/auth and workbench compilation passed; final account-link, background operation and remote-device acceptance remain unverified. Builds are paused for insufficient G: disk space after automatic review rejected cleanup without a more specific reason. The Android build input is commit `b6f8b681b68176383b2ff7b875cfd2f109dd535a`; the final PRoot input must also include the subsequent provider-sync fix, with the exact source and builder commits recorded alongside the resulting archive.

This is a separate Linux ARM64 service archive for Ubuntu 24.04 running in Termux with proot-distro. It is not a Termux-native binary or a new APK. The first intended target is the SM-X730 with Android 17. The regular Android app provides the optional local connection. It contains no desktop, GNOME, X11 or Electron and uses neither root nor systemd, D-Bus or a graphical environment. The archive includes Node 24.12.0, npm/corepack, Codex 0.167.2 and Claude Code 2.1.310; Ubuntu supplies standard shell utilities. The bundled harnesses and actual tasks have not been validated across Android PRoot devices. It does not replace the existing Ubuntu workspace or GNOME installation.

In a trusted Ubuntu 24.04 ARM64 PRoot session, download the release archive and its SHA-256 file from the same trusted release, verify it before extraction, then install:

```sh
sha256sum -c Ragent-VERSION-android-proot-ubuntu24.04-arm64.tar.gz.sha256
tar -xzf Ragent-VERSION-android-proot-ubuntu24.04-arm64.tar.gz
cd Ragent-VERSION-android-proot-ubuntu24.04-arm64
./install.sh
export PATH="$HOME/.local/bin:$PATH"
ragent init
ragent start
ragent status
```

The archive must pass the checksum verification before extraction. `install.sh` reports an invalid `VERSION` or `RELEASE_ID` if package identity files are malformed; download a verified archive again if that occurs.

Open Termux and enter the Ubuntu session interactively with `proot-distro login ubuntu --shared-tmp --user handy`, then start Ragent there. The shared temporary directory enables the short private Unix socket used by the CLI; Ragent protects its own socket directory and socket with private permissions. This is the login configuration validated on the device. Keep that Ubuntu session running: exiting it can end its PRoot processes, and Android may suspend or terminate them. On a tested Samsung phone, Android froze PRoot and Node when Termux moved to the background, even with unrestricted battery use enabled for Termux. Keeping Termux visible in split screen restored service response on that phone. Continuous background availability remains unresolved; a wake lock has not been validated. After reopening Termux and Ubuntu, check `ragent status` and start it again if necessary. `ragent logs` follows the log and `ragent stop` requests a stop. To connect the regular Android app, export a pairing file to an absolute path in shared Downloads accessible to both Ubuntu and Android, for example `ragent export-pairing /path/to/shared/Download/ragent-pairing.json`, then select it using the app's system file picker. Set up Termux shared storage and use its actual mounted path. This file contains a bearer credential: protect it and remove the shared copy after import.

As an alternative interactive entry point, after installing Ragent in Ubuntu, open a separate Termux shell and copy the included launcher once (the path assumes the `ubuntu` container and `handy` user):

```sh
mkdir -p "$HOME/bin"
cp "$PREFIX/var/lib/proot-distro/containers/ubuntu/rootfs/home/handy/.local/share/ragent-proot/current/termux-ragent" "$HOME/bin/ragent-local"
chmod 700 "$HOME/bin/ragent-local"
"$HOME/bin/ragent-local"
```

The launcher starts an interactive Ubuntu session and calls `ragent start`; keep Termux visible. Repeat the copy after a package upgrade to use the updated launcher. Set `RAGENT_PROOT_DISTRO` and `RAGENT_PROOT_USER` when using other names. To request Termux's own wake lock before entering Ubuntu, start the launcher with `"$HOME/bin/ragent-local" --wake-lock`. A failed request stops the launcher with an error. It does not release the wake lock automatically, because that could release a lock already needed by another Termux task. When finished, use `termux-wake-unlock` only if no other work needs it. A wake lock does not guarantee Android will keep PRoot or the service running; its effect on the observed Samsung freezing remains unverified. The Ragent Android app cannot keep the separate Termux process alive merely by running its own foreground service.

The default local port is 17690. To choose another port, set `RAGENT_PROOT_PORT` when first running `ragent init`; the chosen port is stored in the private state directory and reused for both service startup and pairing export.

Codex and Claude are included for the normal approval mode. Codex `conservative-auto` workspace-write and read-only scope rely on kernel sandboxing and bwrap, which may be unavailable in PRoot; those operations fail rather than silently downgrade. The bundled ARM64 harnesses and real tasks remain unverified on the target device.

The package builder also includes a Linux ARM64 P2P host for the account-authorized remote connection work. Including this binary alone does not enable or prove remote access: the service must enforce the separate device authorization and lifecycle, and remote availability still depends on Android keeping Termux running. The local control service remains bound to loopback.

Program versions live in `~/.local/share/ragent-proot`, while configuration and data live in `~/.local/share/ragent-proot-data/config` and logs in `~/.local/state/ragent-proot`. To upgrade, first finish active tasks and stop Ragent, then restart Android. Enter Ubuntu manually with `proot-distro login ubuntu --shared-tmp --user handy`; do not use `ragent-local` yet, because it starts the service. Before any Ragent start on the new boot, verify and extract the new archive and run its `install.sh`. The installer checks the recorded boot identity and refuses when it cannot prove that the last managed start preceded this Android boot. If boot identity cannot be read, startup remains available and upgrades are blocked. The previous version is retained. Only start the service using `ragent start`: manually launching its Node process bypasses this safety check. Do not delete the data or state directories when replacing software.

Each release directory has an identity derived from a manifest of the complete packaged content, including the service, dependencies, bundled tools and management scripts. The public version and this internal identity serve different purposes.

For release builders: on native Ubuntu 24.04 ARM64, install Node 24, npm, Go 1.26 or newer, git, curl, tar, xz and Python 3, and set `RAGENT_PROOT_OUTPUT_DIR` and `RAGENT_PROOT_CACHE_DIR` to locations with sufficient space. Go module and build caches are kept under the package cache; the builder compiles the frozen P2P module for Linux ARM64 and includes its dependency licenses. The cache must contain the three pinned harness archives; the builder checks their fixed SHA-256 digests. An explicit `RAGENT_PROOT_CROSS_ASSEMBLY=1` enables cross-platform candidate assembly, with target-specific npm dependencies and native-binary architecture checks; it does not execute or validate ARM binaries. Set `RAGENT_PROOT_OFFLINE=1` to require pre-populated Node, npm and Go module caches. A separately prepared `RAGENT_PROOT_P2P_ARTIFACT` may be reused only with its source fingerprint, binary hash and Go version sidecars; assembly checks these against the frozen module.

For a release from a shared dirty checkout, export the small builder input from the reviewed commit and read runtime files from Git objects, never from the mixed working tree. For example, with `BUILD_INPUT` set to a new empty task directory and `REPO` to the repository:

```sh
REV=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" archive --format=tar "$REV" package.json packaging/proot docs/android-proot.md \
  scripts/stage-proot-snapshot.mjs scripts/stage-runtime-payload.mjs scripts/verify-runtime-payload.mjs \
  scripts/build-proot-release.sh scripts/build-proot-p2p-host.sh scripts/archive-proot.py \
  scripts/write-proot-identity.py scripts/stage-posix-node-toolchain.sh | tar -xf - -C "$BUILD_INPUT"
node "$BUILD_INPUT/scripts/stage-proot-snapshot.mjs" "$REPO" "$BUILD_INPUT/app" git-objects "$REV"
RAGENT_PROOT_SNAPSHOT="$BUILD_INPUT/app" bash "$BUILD_INPUT/scripts/build-proot-release.sh"
```

The source manifest records the commit, source mode, whether the surrounding checkout was dirty, and staged file hashes. `git-objects` mode reads the specified full commit SHA even when HEAD moves or unrelated working-tree files are dirty; a dirty **checkout-mode** snapshot is not a formal release. If builder scripts come from a different commit, record that commit separately. The builder verifies the official Node distribution checksum and produces an archive and SHA-256 file. Authenticate the release distribution separately: a checksum downloaded alongside an archive is not a signature. The distinct asset name is not a Linux desktop `.deb` update asset.

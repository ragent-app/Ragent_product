# Ragent

[中文说明](README.zh.md)

Ragent is an AI workbench that connects agent runtimes on a computer with a web
interface and an Android app. It is designed for working with agent sessions
across devices while the execution host remains under the user's control.

> **Early access:** the source is public for review. Windows packages and
> supported deployment configurations are still being verified.

Windows x64 early-access packages are available from [GitHub Releases](https://github.com/ragent-app/Ragent_product/releases/latest).
The installer is unsigned and Windows may display a warning. Review the release
notes for the package's exact source commit, validation results, and upgrade
limitations before installing. Replacing an installer at the same public version
does not trigger the version-based update notification.

## At a glance

- Run a work session on a computer and follow it from the web workbench or
  Android client, with streamed responses and session history. The Android app
  is in closed testing.
- Integrate agent runtimes, including Codex and Claude, through Harness and
  provider adapters; supported features and installed versions vary.
- Manage projects, files, runtime settings and approval requests on the host.
- Connect devices through pairing and optional account, signaling and relay
  services. The deployment, network path and account features determine which
  remote capabilities are available.

The local web interface is designed for local access. An operator exposing it
to other machines must provide appropriate access control at the network or
proxy boundary.

## What is in this repository

The source includes multi-Harness and model-provider adapters, session and
history handling, a web workbench, an Android client, and components for device
pairing and remote connectivity. Authentication and authorization, platform
support, and actual model availability depend on the selected deployment and
installed runtimes. See the release notes for the features verified in a given
version.

![Desktop manager showing Harness management](docs/media/windows-desktop-manager-v2.png)

*Desktop manager shown in a browser connected to a disposable local instance; no personal data is shown.*

<img src="docs/media/android-session.png" alt="Android app showing a completed example session" width="300">

*Android test build connected to a shared demonstration instance.*

## Explore the code

- `chat/` and `lib/`: session behavior, runtime integration and shared logic.
- `static/`: the web interface.
- `android/`: the Android client and shared Android modules.
- `p2p/`: connectivity components.
- `accounts/` and `infrastructure/turn-broker/`: account and TURN broker source.
- `tests/`: automated tests.
- `packaging/` and `native/`: platform integration and packaging sources.

The execution host runs agent runtimes and exposes session and management
capabilities. Web and Android clients connect to the host; remote connectivity
can involve account and relay services. The complete self-hosting requirements
and supported service configurations still need release verification.
See the [architecture overview](docs/architecture.md) for code entry points.
See [source and release boundaries](docs/source-and-release.md) for what is
included and what remains to be verified.
Linux candidate installation and build details are documented in
[the Linux desktop guide](docs/linux-desktop.md); macOS candidate and signing
details are in [the macOS desktop guide](docs/macos-desktop.md).

The current Windows host defaults to the project's hosted account and TURN
endpoints outside isolated test mode. Publishing their implementation does not
make the hosted service self-hostable through a documented Windows configuration;
that deployment path remains to be verified. Check the applicable service and
privacy terms before using hosted features.

## JavaScript workspace

Node.js 24 or newer is required. In the project root:

```sh
npm ci --ignore-scripts
node cli.js --help
```

To inspect a disposable local instance, run this from the project root:

```sh
node scripts/launch-test-instance.mjs --port 45678 --ttl 600
```

Open `http://127.0.0.1:45678/` while the command is running. The launcher
creates a temporary instance and stops it after ten minutes. This smoke path
uses isolated service endpoints and does not install a Harness or configure a
model provider. The instance health endpoint, home page and web bootstrap asset
have been checked on Windows; model execution, a clean-user installation workflow
and the complete test suite still need verification before release.

The Go P2P host source is in `p2p/` and declares Go 1.26. Its unit suite has
passed on Windows with `go test ./...` from that directory. Prebuilt host
executables are excluded from the source repository; packaging scripts build
them for their target platforms.

## Android contributor build

The contributor build uses a local debug key and does not include the production
Google services configuration. It is for development and cannot be used to
validate production Google sign-in or Firebase push. It is not a Play upload.
Its Android package is `com.agentoncloud.android.opensource`, so it can coexist
with the Play-installed app. Register this package and the contributor signing
certificate in your own Google project if you configure Google login.

Install the Android SDK and JDK required by the Gradle project, and configure
`ANDROID_HOME`. Create a **new local debug key** outside the repository; do not
commit it or share it. For example, with `keytool`:

```sh
keytool -genkeypair -keystore /path/to/contributor-debug.keystore \
  -storetype JKS -storepass android -keypass android -alias androiddebugkey \
  -dname 'CN=Ragent contributor debug' -keyalg RSA -keysize 2048 -validity 3650
```

Then, from `android/`, run the Gradle wrapper (on Windows use `gradlew.bat`):

```sh
./gradlew :app:assembleDebug -PagentocOpenSourceBuild=true \
  -PagentocDebugKeystorePath=/path/to/contributor-debug.keystore
```

This mode rejects release tasks. To configure Google-backed features, use your
own authorized Google project and signing configuration. The contributor mode
defaults to an intentionally invalid account endpoint and OAuth client. Supply
`-PagentocAccountsUrl=<your-account-service-url>` and
`-PagentocGoogleServerClientId=<your-web-oauth-client-id>` when testing against
your own services. The complete Google setup and full functional verification
are still being prepared.

## Licensing

Ragent's own published code is licensed under Apache-2.0; see
`LICENSE` and `NOTICE`. Third-party components retain their own licenses; see
`THIRD_PARTY_NOTICES.md`. The dependency and asset review is not yet complete.
See [CONTRIBUTING.md](CONTRIBUTING.md) for focused checks and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

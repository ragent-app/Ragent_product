# Android voice recognition and computer Whisper management

## Product behavior

Voice recognition is local to either the Android phone or the computer hosting
the selected Ragent session. It only fills the current chat draft. It never
sends a message automatically and never sends microphone audio to a cloud
speech service.

The phone route uses Android's on-device `SpeechRecognizer` with network
fallback disabled. The computer route records mono 16 kHz audio on the phone,
then sends a bounded WAV through the existing authenticated Ragent target
connection to that computer's loopback-only Whisper service. Only transcript
text returns to Android.

## User controls

Android has two places to control voice behavior:

1. **Settings → Voice recognition** controls Android on-device recognition
   independently, and lists every paired computer. For each computer it shows
   connection and Whisper status, offers **Install** when the computer is a
   supported Windows Ragent without Whisper, and offers an on/off switch after
   Whisper is installed. Stopping Whisper retains the installation.
2. **The chat's top-right three-dot menu → Voice processing device** chooses
   **Automatic**, **This phone**, or a paired computer. This choice is saved per
   chat and does not alter another chat's choice.

The computer status distinguishes offline, not installed, installing,
installed but stopped, starting, ready, and error. Unsupported computers do
not show the Windows installer action.

## Automatic routing

Each chat starts in **Automatic** mode. For every voice input, the app uses the
following order:

1. If the active session's computer is connected and its Whisper setting is
   enabled, keep that computer selected. If Whisper is still starting, Ragent
   waits for it to become ready to transcribe the captured audio; do not
   silently switch to another recognizer during startup.
2. If the session computer is offline, has no Whisper installation, or has
   Whisper turned off, use Android's on-device recognizer when it is enabled
   and available on the phone.
3. If neither route can run, leave the draft untouched and explain which
   device setting needs attention.

A manual phone/computer choice stays fixed for that chat. If the chosen device
is unavailable, show an error and let the user change the selection; do not
silently reroute. Changing sessions only recalculates Automatic mode.

## Windows Whisper installation and lifecycle

- A fresh Windows Ragent setup selects the Whisper runtime and multilingual
  base model by default. The user can clear the option to omit them. When
  included, a missing preference defaults to enabled, so Ragent starts the
  local recognizer and keeps its model available after service startup.
- Upgrade setup reflects whether Whisper is already installed. A saved
  `enabled: false` preference remains authoritative across upgrade and service
  restart; setup must not turn it back on. If the component is present and
  enabled, Ragent starts it. Users can also turn it off without uninstalling.
- On a supported Windows computer that lacks Whisper, Android's **Install**
  action starts a fixed Ragent operation. The phone sends no command, path,
  download URL, or installer arguments. The Windows service downloads only
  the pinned Whisper release and model, enforces byte limits and SHA-256
  checks, extracts an allowlist of runtime files, adds the required licenses,
  and writes a file manifest. It stages under the instance's protected Ragent
  configuration directory and atomically activates the new runtime. The
  running service identity already has access to that managed directory, so
  this operation does not rerun MSI or elevate an arbitrary process.
- Installation status is durable and polled by Android. An interrupted
  operation is reported as failed after Ragent restarts. A failed activation
  restores the previous runtime. A successful operation saves Whisper as
  enabled, starts it, and reports success after the recognizer is ready.
- Downloads happen on the Windows computer, not through the phone or an
  application cloud service. The Windows service must be able to reach the
  pinned release/model hosts (using the configured system proxy where set).

## API contract

The Android app reaches these routes through its existing authenticated,
target-bound Ragent connection:

- `GET /api/local-voice-settings` returns `installed`, `enabled`, `running`,
  `ready`, `installing`, and `installable`.
- `PATCH /api/local-voice-settings` accepts exactly
  `{ "enabled": boolean }` to start or stop an installed service.
- `POST /api/local-voice-install` accepts exactly `{}` and returns an
  operation ID for the fixed Windows Whisper install.
- `GET /api/local-voice-install/:operationId` reports `queued`,
  `downloading_runtime`, `downloading_model`, `extracting`, `activating`,
  `starting`, `succeeded`, or `failed`.
- `POST /api/local-voice-recognition` accepts bounded, validated WAV data and
  returns transcript text only when the local Whisper service is enabled.

The Android client does not transmit audio to the computer settings or
installation endpoints. Computer transcription is sent only to the selected
target; phone transcription remains on the phone. The computer recognizer
binds to loopback, and neither audio nor transcript is persisted by the
recognition API.

## Acceptance criteria

| Scenario | Expected result |
| --- | --- |
| Fresh Windows install accepts the default Whisper option | Runtime and model install; the service enables Whisper and reaches ready. |
| Fresh Windows install clears the Whisper option | Whisper does not run; Automatic uses phone-local recognition if enabled. |
| Upgrade has a previously saved Whisper-off setting | Upgrade and restart keep Whisper off. |
| Android opens Voice Settings with a paired Windows Ragent lacking Whisper | It shows Install and a clear installation state. |
| Owner starts installation from Android | Fixed verified payload installs on that Windows computer, starts by default, and reports ready. |
| Installation is interrupted or a hash/start check fails | Android gets a useful failure; incomplete staging is removed and an existing runtime is restored. |
| Session is hosted on a connected computer with Whisper enabled | Automatic selects that computer, waiting for readiness if needed. |
| Session computer is offline, lacks Whisper, or has it off | Automatic uses phone-local recognition if enabled and available. |
| User selects a device manually in the chat menu | That chat persists the selection and reports unavailable routes without silently switching. |
| A Mac or other unsupported computer has no Whisper | Android does not offer the Windows installer action. |
| Both routes are unavailable | No audio is sent and the draft is unchanged. |
| Recognition succeeds | Transcript enters the draft; it is sent only after the user taps Send. |

## Implementation and verification status

The current `main` worktree contains Android capture and local recognition,
separate phone/computer settings, per-chat routing, Windows default-on setup
behavior, and the fixed Windows install-operation path. Automated Node tests
cover pinned-download verification, failure rollback, duplicate requests,
owner authorization, and lifecycle defaults. Windows installer/service build
and signed-in Android-to-Windows end-to-end acceptance are still required
before calling the feature release-verified.

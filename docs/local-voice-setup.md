# Local voice recognition

Ragent supports two local recognition routes in Android: Android's on-device
speech recognizer and a paired Windows computer running Whisper. The Android
app selects the active session's enabled Whisper computer automatically, then
uses phone-local recognition when that computer has no enabled Whisper
service. Users can override the route for each chat from the chat's three-dot
menu. Transcripts are inserted into the draft; Ragent never sends them
automatically. Automatic mode stays local and never silently uploads audio.

Android also has an optional, explicit Accounts cloud recognition route. When
the user selects it, Ragent Accounts sends the recording to its configured
speech provider and returns only the transcript to the app. The cloud route is
not used as a fallback for local recognition. The app explains the audio
transfer and provider data policy before a cloud recording is made.

The Windows setup package selects the Whisper runtime and multilingual base
model by default. A fresh installation that includes Whisper starts the
recognition service automatically. Users can clear the option to omit the
runtime. On upgrades, the setup screen reflects whether the feature is
installed, and a saved recognition on/off setting remains authoritative across
upgrades and service restarts.

The computer owner can stop or start an installed Whisper service from Ragent
Settings or the paired Android app. Stopping the service keeps the runtime
installed and preserves the disabled setting across restarts. The setting is
stored per computer. Android also has a separate switch for phone-local
recognition.

On a fresh Windows install, setup places the verified Whisper runtime and
model with the Ragent installation. If Whisper is installed later from
Android, the Windows Ragent service downloads and verifies the same pinned
assets into its protected per-instance configuration directory, activates
them atomically, enables the service, and reports completion after it is
ready. The phone sends only a fixed install request; it does not send commands
or download payloads. Windows Ragent is the only platform that offers this
remote installation action.

For a managed Windows installation that needs model files on another local
volume, an administrator can set
`HKLM\Software\AgentoC\LocalVoiceSettings\RuntimeDirectory` to an absolute
local path before starting Ragent. The Whisper runtime, model, install staging,
and operation records use that directory and its sibling operation folder;
voice preferences remain in the per-instance configuration directory. Grant
write access only to the Ragent ControlPlane service identity, SYSTEM, and
Administrators because the service executes the installed runtime. Network
share paths and relative paths are rejected. Without this override, Ragent
uses the protected per-instance configuration directory.

For development or manually managed installations, set both absolute paths
before starting Ragent:

```sh
export AGENTOC_LOCAL_VOICE_EXECUTABLE="/absolute/path/to/whisper-server"
export AGENTOC_LOCAL_VOICE_MODEL="/absolute/path/to/ggml-base-q5_1.bin"
# Start the Ragent server using the normal procedure for your installation.
```

The process binds only to `127.0.0.1`. Ragent sends validated WAV audio to that
local endpoint and returns recognized text to the connected client. Browser or
Android microphone permissions and secure-context requirements still apply.

Android can independently enable or disable phone-local recognition and each
paired computer's Whisper service. Per-chat **Automatic** mode selects an
enabled Whisper service on the session computer, then falls back to the phone
when that computer is offline, lacks Whisper, or has Whisper stopped. A
per-chat device override is available from the chat's top-right menu. See
[android-voice-routing-plan.md](android-voice-routing-plan.md) for the complete
behavior and acceptance criteria.

Recognition language is selected independently from the app display language.
Ragent's bundled, pinned Whisper catalog contains 100 language codes. Whisper
can detect speech automatically or use an explicitly selected language on the
phone and on a compatible paired Windows computer. The Android system
recognizer is a separate provider: it can use the selected language only when
that phone's on-device recognition provider supports and has the language
pack installed. If it does not, install Ragent's multilingual Whisper model
for a consistent offline path. Catalog support does not promise equal model
accuracy for every language.

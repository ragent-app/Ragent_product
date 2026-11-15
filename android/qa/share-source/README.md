# Independent file-share source for Android QA

```text
Build this standalone QA application with the repository's Android Gradle wrapper
and the configured Android SDK. Install it together with the current Ragent app
and instrumentation APK on the explicitly selected test serial. Run
com.andysagent.ragent.CaptureFileShareActivityTest, then the existing share/graph
regressions. Use only the fixture's synthetic material; intake must not create a
submission operation or send work to a real PC. Preserve paired-target configuration.
```

This nested Gradle application is independent of the production app and its test
APK. Its package is `com.agentoncloud.android.sharefixture`, and its Kotlin runtime
is packaged in its own APK. The sender Activity and non-exported ContentProvider
therefore run under a distinct Android UID. A provider class inside instrumentation
alone would not prove cross-application URI permission transfer.

The sender supplies CSV and PNG fixtures through `ACTION_SEND` / `SEND_MULTIPLE`,
`EXTRA_STREAM` and ClipData. It passes read permission through the framework's
temporary grant. The receiver must deduplicate the repeated URI representations,
keep accompanying text/URLs and ignore forged caller, target, draft and auto-submit
extras. A sender UID extra is inspected only by the test, never trusted by app logic.

For an actual native Sharesheet run, start `ShareSourceFixtureActivity` with
`chooser=true`, optionally `names=first.csv,second.png` and `material=<text>`.
Both launch modes create an implicit share Intent from the fixture app's separate
UID and open Android's chooser; neither starts Ragent's private receive Activity
directly. The chooser mode accepts comma-separated `names`, while instrumentation
can pass Base64 names/text to preserve punctuation and whitespace. Select
`Ragent · Share`, then choose a workflow in its Router. The fixture never submits
a task. Instrumentation may override `mimeType` and add Base64 `htmlBase64` for
browser-like payloads; Android 8.0 requires plain `EXTRA_TEXT` whenever HTML is
also supplied.

The provider can report unknown size, lie about size, advertise an oversized body
or fail opening a selected fixture. The no-grant scenario deliberately omits the
grant flag. All files contain synthetic bytes; the provider opens only its listed
fixture filenames and does not read user files or connect to a server.

For camera-free live PC acceptance, the temporary-pairing driver accepts
`--mode files --file-bytes 400000`. The source adds a `fileBytes` query only to the
synthetic `first.csv` URI, preserving its header and first numeric row while
padding it to the exact requested length. This crosses the 256 KiB chunk boundary;
the Android assertion verifies the PC receipt's exact byte count and SHA-256. The
option is limited to 262145 through 5242880 bytes and is absent from normal QA runs.

The device test verifies import, caller-bound Room/private files, Activity
recreation, grant expiry, reopening without the source grant, per-file failure,
explicit removal and rejection of the app's own provider (including Android user
prefixes). The temporary grant and a copied resource are different lifetimes.

Use the parent wrapper with project directory `qa/share-source` from `android/`.
The nested project uses the same AGP/Kotlin baseline. Configure `ANDROID_HOME` or
`ANDROID_SDK_ROOT` for the existing SDK; local SDK paths, build outputs and Gradle
state are excluded from Git. This is test infrastructure, not a production SDK
sample or evidence of real PC/TURN/Gemini integration.

The optional `chooser=true` sender extra opens the native Android Sharesheet with
synthetic text through `Intent.createChooser`, without selecting a receiver. It
allows inspecting published Direct Share targets and their real click route. It
does not force a target to appear, assign its rank, alter the pairing directory,
or submit work. The original explicit file/grant fixtures remain the default.

## Independent selected-text source

`ProcessTextSourceActivity` starts the exported `ProcessTextActivity` with a real
`startActivityForResult` channel. Its EditText selects synthetic material between
`Before: ` and ` :After`; only `RESULT_OK` with replacement text changes that range.
`RESULT_CANCELED` preserves it. The fixture's private `selection-result.json` records
the test token, sender UID, returned code/text, resulting source text and extra keys.
Instrumentation reads only this synthetic file through `run-as` on the debug QA APK.

The `readOnly` option supplies the actual typed platform flag. Forged target/caller,
draft and auto-start extras accompany the material and must be ignored. Launch each
new source with `NEW_TASK | MULTIPLE_TASK`; plain `NEW_TASK` can reopen an older
source task without calling onCreate or launching the next request.

The `qa=true` option selects the debug-only `ProcessTextQaActivity`. Instrumentation
supplies an isolated real Owner RuntimeGraph, Room journal, coordinator and fixed
repositories; only remote PC carriers are replaced. The saved-task QA destination
uses that same journal, is not exported and carries no result channel. Cancellation
returns to the source before saved-task navigation; it must not be covered by an
immediately launched task viewer. Neither QA
Activity is present in release builds. An unconfigured harness cannot create work.
Use the production destination for public intake/Close/recreation tests; it needs no
test graph and must not submit to a real PC.

`nativeMenu=true` leaves a source EditText on screen; adding `readOnly=true` uses
an actual non-editable, selectable TextView. Android supplies the readonly flag
when a native menu target is clicked. Menu discovery, explicit
native Activity Result tests and real PC network execution are separate evidence.
Both views have a stable resource ID: API 35 TextView skips PROCESS_TEXT actions
when its ID is `View.NO_ID`. The source's package queries declare PROCESS_TEXT.
The root respects system insets; native long presses wait for launch animations
and refresh accessibility bounds before injecting coordinates. Menu clicks use
the clickable item ancestor, rather than its non-clickable title child.

Before the native notification test, grant POST_NOTIFICATIONS only on the chosen
test serial. Record its original state and restore it after the instrumentation
process has reported its terminal result. Revoking the permission during the test
can kill the target UID and prevent the test runner from delivering its report.

## Different-UID result receiver

`ResultReceiverFixtureActivity` accepts an explicit synthetic ACTION_SEND and
probes the production result URI from its own UID. It records the byte count,
SHA-256, MIME, DISPLAY_NAME/SIZE, write denial and sibling denial; it never saves
received result bytes. A custom RESULT_PROBE action with no grant checks negative
access and post-revocation opens without Android's ACTION_SEND grant migration.

The standalone `result-probe` provider exposes only these bounded synthetic
observations by randomly generated test probe ID, allowing instrumentation to
poll across UIDs and delete its exact observations. It exists only in this QA
APK; the production APK has no equivalent public status provider. The main app's
debug manifest declares this fixture authority for package visibility. Keep the
fixture Activity alive through each probe; task-based URI grants and explicit
sender revocation are separate behaviors. These tests prove local system output,
not actual PC execution or Gemini invocation.

The optional `grantDocument` fixture request grants the production test app an
exact read/write URI in the non-exported `result-document` provider. This proves
the owner adapter can write through a real different-UID provider and that an
opening failure preserves its private source. The `failDocument` variant refuses
opening. These are synthetic URI grants, not a real ACTION_CREATE_DOCUMENT user
selection, DocumentsUI picker, Activity Result, or crash recovery test.

The receiver also appears in the native Sharesheet as **Ragent Result Receiver QA**.
For native selections with no QA extras, it uses the UUID in the production ticket
URI as the observation ID; all read/hash/metadata/negative probes still run under
the fixture's distinct UID. `ResultOutputsNativeTest` drives the production owner
Activity and real Sharesheet/DocumentsUI using accessibility-tree actions, not a
substituted ActivityResultRegistry. It checks selection cancellation, system
rotation, exact Downloads bytes, local reopening and saved-draft navigation.
Each synthetic ASCII filename is verified before exact cleanup; unrelated files
and directories are never removed. Coverage and failures are kept in the ledger.

## Controlled document blocking and parent death

```text
Use the configured Android toolchain and one explicitly selected QA serial to
verify internal document-export isolation. Install matching production debug,
instrumentation and this independent fixture APK; run ResultShareProviderTest.
Then run scripts/verify-document-worker-parent-death.py with --adb, --serial and
--evidence. Preserve all failure logs and the same live handles when observation
times out. Verify source fingerprints, actual PIDs, copy leases and cold state;
do not substitute force-stop, Activity recreation or a synthetic orphan record
for killing only the actual parent process in the confirmed copy window.
```

The allowlisted `documentKind` modes are `ready`, `fail`, `block-open`, `block-write`,
`block-fsync` and `block-release`. The provider records the actual opening Binder
PID/UID and observed phase. Proxy callbacks can block actual write/fsync syscalls;
`onRelease` is asynchronous and does not by itself simulate a blocked caller close.
Only exact UUID scratch documents are writable. Their granted query returns small
synthetic observations; delete releases their latch and removes only that file.
The QA-only `delete` selection `revoke` revokes the exact grant without releasing
the blocked callback. Teardown restores that same scratch grant before release.
The receiver separately attempts a real foreign-UID bind to the non-exported
worker and records its rejection.

SIGKILL can leave a zombie group leader with a still-blocked FUSE thread. Tests
assert bounded caller cancellation, retained COPYING while the worker lease is
held, actual thread-group exit after provider release, unknown-result recovery
and no second external open. They never claim cancellation rolls back an already
delivered provider operation. The parent-death harness enables a 60-second test
window via `documentWorkerDeathWindow=true`; production keeps its 120-second
worker budget. Its marker contains only synthetic IDs, PIDs, bytes and digest,
not a persisted production destination URI. The cold half verifies the original
target/Session/request and unchanged READY source, then removes its exact fixtures.
It also verifies that the original document write grant remains denied. The
QA-only `result-probe/document/<UUID>` endpoint observes an existing synthetic
document's phase/PID/open count and releases that exact fixture for cleanup;
it returns no file contents and does not recreate document write authority.

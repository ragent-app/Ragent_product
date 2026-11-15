# Android App API core

Kotlin core for the Android App API. It is connected to the application runtime
graph and used by native sharing, selected text and computer shortcuts. The
application also declares an exported Binder service and caller-consent activity;
the Android SDK client lives under `android/sdk/android/`. Actual third-party
availability and device coverage depend on the build and release validation.

The contracts, capability registry, routing and grant policy share one engine.
`TaskCoordinator.prepare()` freezes caller-owned collections and chooses a
permitted target without creating any PC work. A repeat with the same operation
identity returns the original preparation; changing parameters conflicts.
`commit()` persists each creation/submission stage before its corresponding
remote effect and reuses the stored PC creation/message identities after a
lost response. The new repository methods do not enter legacy pending replay.

`TargetTaskAccess` is the application connection-lease seam. It must initialize,
authenticate and connect the specified target through the existing signed
bootstrap/TURN-first contract, return `RepositoryTaskTarget(instanceId,
fixedRepository)` and release its lease in `finally`. Switching repositories
are explicitly rejected. `AndroidRuntimeGraph` implements this seam with one
fixed controller, carrier and Room repository per instance. The UI forwarding
transport observes a selected delegate without owning or closing it. Bound
computer transports require a verified carrier for relative business requests
and never fall back to HTTP or WS after carrier loss. Absolute signed storage
upload URLs retain their separate credential rules.

`TargetConnectionLeases` implements shared per-target ownership for that
integration. UI owner-set updates do not close a carrier held by a finite API
call; the final release serializes teardown before reacquisition. Cancellation
releases a call, unpairing revokes a generation, and an older lease cannot close
a replacement generation. Failed owner-set acquisition rolls back newly
started resources. The runtime graph uses this pool for foreground selections,
automatic foreground targets and headless API calls. UI exit releases only the
UI owner set. Unpairing revokes the target and disposes its child scope/cache.
Initial configuration/credential migration gates API access; the legacy Room
file's target binding is persisted across first-target removal and configuration
reset. Endpoint-less controllers can fetch a fresh verified Accounts rendezvous
without selecting a different UI computer, and release TURN through the still-
open target carrier. Real Accounts/TURN/P2P verification remains a separate gate.
Bootstrap/Accounts authorization failures terminate network retry and report
authentication required. Supervisor shutdown clears its online state, and a
late connected notification cannot revive a closed bound carrier.

`VerifiedCaller` is trusted adapter context, never deserialized from an external
request. `GrantAuthorizer` supports capability/target/resource intersections,
expiry and revocation. The installed application's owner binding comes from
its trusted graph. The app supplies installed-caller identity verification,
caller consent UI and a Room-backed grant store. Exported Binder calls capture
and recheck the caller identity; consult tests and release notes for verified
coverage rather than treating source presence as proof of deployment readiness.

The graph reads a versioned `AppApiRoutingPreferences` snapshot from the existing
DataStore. Its sharing default and up to eight aliases per computer are separate
from UI selection. Removing a default preserves its missing identity rather than
silently choosing another computer. Aliases of an unpaired target are removed;
duplicate aliases across computers require disambiguation. Malformed/future
routing settings block headless routing while the UI directory stays available
for an explicit owner reset. The app includes a routing settings activity and
Compose screen. The SDK client and external capabilities should be evaluated
against the specific build and release notes.

The phone-wide `AppApiDatabase` is separate from per-target Room caches, uses
optimistic revisions and a unique preparation index, and opens under
`noBackupFilesDir`. Its version-1 schema is committed. Public operation receipts
omit original content, caller binding, preparation token and remote retry keys.

Cancellation stops an unsubmitted operation; it does not cancel a PC Run.
Expired unknown message submission is retained as `RESULT_UNKNOWN` and is
never resent beyond the deadline. `reconcile()` reads the target's retained
Run/queue acceptance evidence through `GET .../message-receipts/:requestId`,
rechecks caller authorization and pairing after connecting, and can confirm a
lost acknowledgement even after expiry. Missing evidence remains unknown;
an unsupported route never falls back to POST. A queued acceptance can later
gain a Run identity without another submission. Deferred WorkManager replay and
multi-target orchestration are subsequent deliveries.

`readResultExport()` saves a versioned complete-result manifest on the exact
operation. `streamResultExport()` uses that saved revision and holds one fixed
target lease for the whole transfer. Authorization uses the actual created
Session, rather than preparation's optional existing Session. Pairing/caller
grants are rechecked around each request and sink call. Protocol versions,
identities, resource bounds, offsets, EOF, canonical base64 and per-chunk/full
SHA-256 must agree. The client does not retry, retarget or close a carrier.
The sink must keep its bytes private until the verified receipt is returned;
stopping a download does not cancel a remote Run. The additive nullable manifest
remains compatible with older operation payloads, which default to null.

`PersistentResultOutputs` stores verified private copies in a separate no-backup
directory. Room v4 adds caller/operation/resource-bound output records and an
explicit v3-to-v4 migration. Every MiB checkpoint syncs the partial file and saves
its byte count/prefix SHA-256. Recovery discards unacknowledged crash tails and
validates the prefix before ranged continuation. A full checkpoint still requires
the PC's current EOF; it cannot become READY merely by having the expected size.
Only a verified COMMITTING marker can recover a rename interrupted before READY.
Local recovery, deletion and READY reads do not query or cancel remote work.
Existing verified copies may outlive PC snapshot expiry and disconnection, while
local caller/Session grants remain mandatory, including after each copied block.
Corrupted recovery becomes FAILED. Deletion uses persistent tombstones; quotas
reserve at most 256 MiB/64 live downloads without evicting completed reports.
OS locks use 256 permanent slots, avoiding an unlimited per-download lock-file
accumulation. Caller-scoped partial cleanup and internal orphan maintenance
preserve live references and lock inodes. Orphan maintenance is explicit, not a
scheduled background job. The private result root remains outside every provider.

`ResultDeliveryCache` stages a separate full-digest-verified copy in
`cache/result-shares/<ticket>/`, with atomic private versioned metadata in
`noBackupFilesDir/ragent-result-deliveries`. PENDING is never readable; READY
requires a valid source output and current local caller/Session grant on every
open. Tickets expire after one hour by default, within an independent
256 MiB/64-copy budget. Expiry, revoke and cleanup do not delete the source report.
Failed cleanup keeps a tombstone and its reservation; maintenance never deletes
unexpected directory contents. Permanent hashed lock slots serialize descriptor
opening/revocation across cache instances and processes without growing lock files.
`withSharedFile` is a trusted-adapter callback, not an external path or URI API.
`copy` verifies bytes and rechecks authorization/cancellation around every block.
The application's separate read-only provider and owner Android adapter map this
cache to temporary URI grants and selected-document streams. The owner workflow
and Compose page now expose explicit query/download/resume/delete/share/save and
ticket revocation. Actual device coverage is recorded in the implementation
ledger. Review the applicable tests and release notes for automatic cleanup,
blocking-provider handoff and SDK/IPC validation.

`PersistentResultOutputs.listForOperation` reads only this operation's caller-bound
rows and requires operation-read and output authorization; unrelated revoked
operations cannot poison an owner page. `ResultDeliveryCache.revokeForOutput`
invalidates only the caller's exact source copies, without deleting the private
source. Listing deliveries skips deleted sources but still reauthorizes them
before filtering, so grant revocation is not hidden as an empty successful list.

Validation: the core suite includes JVM coverage for result export and other
contracts. Focused graph/journal tests exercise result transfer and Room reopen;
consult the tests and release notes for a specific build's device coverage.
The suite covers fixed routing, caller isolation, revocation during connection, immutable inputs,
concurrent commit, response loss, restart, cancellation, expiry, database cold
reopen, stale revisions and preparation identity uniqueness.
Emulator graph tests additionally exercise the actual graph, Room storage,
fixed repositories and coordinator with only the remote PC carriers replaced:
headless submission, UI switch/stop during submission, Room/graph reopen and
receipt lookup, cancellation/unpairing, stable legacy-cache binding, and first
pairing after empty startup. Routing tests also reopen DataStore, preserve a
missing default, reject invalid edits, recover from unreadable settings, and
ensure the final unpair cannot restore obsolete legacy singleton keys. These
are not genuine PC or Gemini test evidence.
Three additional emulator tests exercise the real bound controller and Android
network monitor with a substituted bootstrap server: authorization failures,
missing device credentials, explicit refresh and cancellation/restart.

The current Android Gradle Plugin version is defined in
`android/gradle/libs.versions.toml`. Run the relevant lint and test tasks with the
current toolchain and record results for the exact build; earlier lint results
do not establish the status of this release.

`DocumentSaveJournal` adds private atomic versioned save-attempt records keyed by
delivery ticket. WAITING_SELECTION precedes the picker effect, COPYING precedes
any external truncation, and SAVED follows completed copy/close and authorization.
No destination URI or grant is retained. An OS lease protects live writes from
recovery; orphaned COPYING is marked INTERRUPTED without a writer call. Explicit
finished-history clearing does not delete actual files. Its separate metadata
store does not change Room v4. Device evidence is recorded in the ledger; crafted
orphan windows are not whole-process kill or blocking-provider proof.

The internal implementation ledger is not distributed with this source tree.
Consult the tests and release notes for the scope verified in a public release.

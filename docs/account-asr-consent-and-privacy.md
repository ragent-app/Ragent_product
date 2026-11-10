# Ragent ASR consent and privacy addendum

This addendum updates the canonical [central Accounts ASR plan](account-asr-service-plan.md), which retains the detailed quota, cost, rollout, and deployment design.

**Updated:** 2026-11-10

**State:** consent enforcement and the expanded v2 Android disclosure are deployed with Accounts migration 040. The provider key remains blank and cloud ASR stays disabled at the owner's direction. The public privacy notice was published on 2026-11-10. Oracle health/readiness and synthetic PostgreSQL quota/settlement verification passed; a real vendor call and signed-in account transcription remain pending.

## Product contract

Android records a short mono 16 kHz WAV and sends it only when the user explicitly chooses cloud recognition. Ragent Accounts authenticates the account, checks a current consent record, reserves that account's monthly allowance, forwards the recording to the configured provider, and returns text plus detected language. Android inserts the result into the composer draft; sending remains a separate user action.

Automatic routing stays local: use the selected paired computer with Whisper when available, otherwise Android's system recognizer. Cloud recognition is an explicit opt-in route. Cloud ASR is not a replacement for Windows Whisper or Android's local recognizer.

## Current architecture

~~~mermaid
sequenceDiagram
    participant Phone as Android app
    participant Accounts as Central Ragent Accounts
    participant DB as Accounts PostgreSQL
    participant ASR as ElevenLabs Scribe
    Phone->>Accounts: POST consent (account bearer, disclosure version)
    Accounts->>DB: append accepted/revoked event
    Phone->>Phone: record WAV only after acceptance
    Phone->>Accounts: POST WAV + idempotency key
    Accounts->>DB: verify current consent and reserve monthly usage
    Accounts->>ASR: forward audio; omit language to auto-detect
    ASR-->>Accounts: transcript and detected language
    Accounts->>DB: settle account usage and provider cost
    Accounts-->>Phone: text, detected language, duration
    Phone->>Phone: add transcript to draft; never auto-send
~~~

The provider key stays in the central service environment. Android, Windows, per-user files, and the database never receive it. Accounts uses the existing account bearer/device identity and PostgreSQL database; it does not introduce another account system or database.

The existing usage ledger is keyed by account and billing month. It records duration, request count, reservation and settlement state, provider/model and price version, audio hash, and provider cost. It does not persist the WAV or transcript as database columns. The server holds a successful response in process memory for up to five minutes to serve an idempotent retry; that brief cache is disclosed to the user. Successful and failed request metadata is normally deleted after 90 days. Requests whose provider outcome cannot be confirmed are not automatically removed after 90 days and can remain until the account is deleted.

## API and persistence

The implemented contract is:

- POST /v1/owner-auth/account/asr/consent with action=accept and the exact disclosure policy version, or action=revoke. Requests are account-authenticated, rate-limited, and never cached.
- GET /v1/owner-auth/account/asr/usage reports the current account/month quota and the latest consent state. It remains useful while the provider is disabled.
- POST /v1/owner-auth/account/asr/transcriptions accepts bounded audio/wav bytes and an idempotency key. A current accepted consent for the disclosure version is required before any provider call, including a cached-result replay.

Migration 039_account_asr_consent creates an append-only consent event ledger. It stores only account and device identifiers, disclosure version, accepted/revoked action and timestamp, and retains each event for five years. It has no foreign key, so account deletion cannot silently erase evidence of the user's choice. Migration 040 permits both v1 and v2 evidence records; Accounts only treats an acceptance of the current v2 disclosure as valid, so a prior v1 acceptance requires fresh consent. The account-deletion receipt names this minimal retained evidence. A bounded maintenance job deletes events after their retention deadline.

The exact disclosure version is part of the server and Android protocol. A changed recipient, purpose, retention promise, or material policy change must use a new version and require fresh consent.

## Android behavior

The voice-device picker can show cloud availability and remaining allowance. Choosing cloud fetches the latest account state. If there is no current acceptance, Android presents a localized prominent disclosure with Allow and continue and Not now; recording does not start until the server confirms acceptance. A revoke action is available from the voice-device picker. Declining or revoking returns a cloud-selected session to automatic/local routing. If the server state is unknown, stale, or unreachable, cloud recording fails closed.

The v2 disclosure is localized in English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It explains the audio recipient, Ragent's brief in-memory retry cache, account-linked usage/request records retained up to 90 days (longer for unresolved provider outcomes), five-year consent evidence, the provider's potential retention and service-improvement use under its terms/settings, and draft-only result handling.

## Security, privacy, and store-review gates

1. Keep AGENTOC_ACCOUNTS_ASR_ENABLED=0 and leave ELEVENLABS_API_KEY unset until the owner obtains a key and confirms the actual provider account's terms, data-use preference, and retention settings. The current adapter explicitly sends `enable_logging=true`; the owner must set and verify any training/data-use opt-out available for that account.
2. Before provider traffic is enabled, publish a matching privacy-policy update. It must explain recording upload, Ragent Accounts and ElevenLabs roles, provider retention/settings, usage records, and the five-year minimal consent evidence retained after account deletion. A draft is kept at docs/account-asr-public-disclosure-draft.md; it has not been published.
3. Reconcile the Play Console Data safety form and prominent disclosure with the final provider contract. Use [the Data Safety owner-review worksheet](account-asr-play-data-safety-review.md); do not carry forward a “not shared” answer unless the actual ElevenLabs agreement and account settings support it or another documented Play exception applies.
4. Do not claim zero retention unless the provider account is eligible for it and the actual request is verified. The ElevenLabs API retains/logs content in standard mode and its applicable terms may allow service-improvement use; the owner's key is currently absent, so there has been no live provider test.
5. Keep request logs free of audio, transcript, bearer credential, and API key. Preserve account-scoped quotas and provider-cost reporting in Accounts only.

## Release and acceptance sequence

1. Run Accounts unit/HTTP tests for invalid consent version, no-consent denial, acceptance, revocation, cache replay after revocation, usage accounting, migration readiness, and retention pruning.
2. Build Android debug and run core-auth tests plus the seven-locale disclosure test. Run the instrumented test on a physical device to verify the prompt, decline, accept, revoke, local routes, and cloud route behavior.
3. Apply migrations 039 and 040 to the Oracle Accounts database, then deploy the matching Accounts binary with provider disabled. Verify /healthz, /readyz, authenticated usage/consent policy version, rejected unauthenticated requests, and that audio returns unavailable without any provider call.
4. Once an API key exists, store it only in Oracle /etc/agentoc/accounts.env; do not put it in source, chat, build artifacts, or the Android app. Keep ASR disabled until the owner explicitly enables it after reviewing provider retention and the updated public disclosures.
5. With owner approval to enable it, make one short real transcription with explicit consent, verify auto language detection, verify account usage increments, verify revoke blocks the next request, and confirm the API key and transcript are absent from logs and durable database rows.

## Current acceptance status

| Area | Status |
|---|---|
| Central Accounts service and monthly account usage ledger | Deployed on Oracle at release `0.0.1+asr-settlement.20261110.05d444e`; migrations 038–040 applied |
| Provider secret and feature gate | Key absent and feature flag off by owner instruction |
| Consent ledger and enforce-before-forward gate | Implemented; migration 040 applied and matching Accounts release active on Oracle |
| Android explicit consent, decline, revoke, and localized disclosure | Implemented; debug build, unit tests, and seven-locale device test passed |
| Public privacy-policy and Play Console alignment | Draft prepared; public changes not published |
| Real ElevenLabs transcription and cost measurement | Cannot be performed until a key is configured securely |

## Latest deployment and verification — 2026-11-10

`npm run test:owner-auth`, the ASR unit test, and the Accounts independent release-packaging test passed on Windows. The Android debug/unit tests and the connected MTN-AN80 `VoiceLocalizationTest` passed earlier; the device test covered English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It verifies localized disclosure copy, not provider transcription.

Oracle currently runs `agentoc-accounts-0.0.1+asr-settlement.20261110.05d444e-arm64`, built from committed source revision `05d444e80d450857907e750e854bce4dceb70c27`; archive SHA-256 is `8fbe8af52f24f529500af237e571ae9ce8f1f1796d270b577855172b67b222fc`. The prior immutable release remains available for rollback. Public health/readiness both return 200, readiness reports `speechRecognition: unconfigured`, and an invalid usage credential returns 401. The key is absent and the feature flag is off.

From the real Windows 11 Pro host (Build 22631), the same public HTTPS endpoints returned health/ready 200, invalid usage 401, and disabled transcription 503 `asr_unavailable`. This confirms the desktop's network path to Oracle and the fail-closed disabled state; it does not claim a valid account or a provider transcription.

An isolated PostgreSQL scratch-database test verified v1/v2 consent storage, shared cross-device monthly quota under concurrent reservations, the two-operation cap, and successful settlement from reserved to used time. The scratch database used synthetic IDs and was dropped after the test. This uncovered a date parsing bug in settlement; the query now explicitly reads SQL date text, and the deployed code passed the PostgreSQL smoke test after the fix. It does not claim a valid signed-in Ragent account or provider call.

The public privacy notice is published. The Play Console Data Safety form still needs owner review/update against the actual provider account terms before enablement. The real ElevenLabs transcription, provider cost measurement, and signed-in Android round trip remain pending until a key is available and securely provisioned.

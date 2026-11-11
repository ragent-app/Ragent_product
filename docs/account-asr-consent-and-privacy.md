# Ragent ASR consent and privacy addendum

This addendum updates the canonical [central Accounts ASR plan](account-asr-service-plan.md), which retains the detailed quota, cost, rollout, and deployment design.

**Updated:** 2026-11-12

**State (2026-11-12):** the provider is OpenAI `gpt-transcribe`; consent uses `account-asr-openai-transcription-v3` and migration 042 allows the policy. The central service readiness check reports speech recognition ready. The public notice was corrected for cloud-only voice in static release `ragent-asr-cloud-only-20261111-02e91c66`, page SHA-256 `02e91c66698a167bf5d31816a7ac36faeeed8aa7ac3ab3190c39bd60a2afffe2`. Check live settings rather than relying on this snapshot.

## Product contract

Android records a short mono 16 kHz WAV and sends it only when the user explicitly chooses cloud recognition. Ragent Accounts authenticates the account, checks a current consent record, reserves that account's monthly allowance, forwards the recording to the configured provider, and returns text plus detected language. Android inserts the result into the composer draft; sending remains a separate user action.

The current Android product uses cloud recognition only. The earlier phone-local and paired-computer Whisper routes are retired; declining or revoking consent makes voice recognition unavailable.

## Current architecture

~~~mermaid
sequenceDiagram
    participant Phone as Android app
    participant Accounts as Central Ragent Accounts
    participant DB as Accounts PostgreSQL
    participant ASR as OpenAI GPT-Transcribe
    Phone->>Accounts: POST consent (account bearer, disclosure version)
    Accounts->>DB: append accepted/revoked event
    Phone->>Phone: record WAV only after acceptance
    Phone->>Accounts: POST WAV + idempotency key
    Accounts->>DB: verify current consent and reserve monthly usage
Accounts->>ASR: POST completed WAV; omit language hint for auto-detection
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

Migration 039_account_asr_consent creates an append-only consent event ledger. It stores only account and device identifiers, disclosure version, accepted/revoked action and timestamp, and retains each event for five years. It has no foreign key, so account deletion cannot silently erase evidence of the user's choice. Migration 042 permits v1, v2, and OpenAI v3 evidence records; Accounts only treats an acceptance of the current v3 disclosure as valid, so every prior acceptance requires fresh consent. The account-deletion receipt names this minimal retained evidence. A bounded maintenance job deletes events after their retention deadline.

The exact disclosure version is part of the server and Android protocol. A changed recipient, purpose, retention promise, or material policy change must use a new version and require fresh consent.

## Android behavior

Voice settings show cloud availability, remaining allowance, and consent controls. If there is no current acceptance, Android presents a localized prominent disclosure with Allow and continue and Not now; recording does not start until the server confirms acceptance. A revoke action is available in voice settings. Declining or revoking disables voice recognition. If the server state is unknown, stale, or unreachable, recording fails closed.

The v3 disclosure is localized in English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It explains the OpenAI audio-transcription recipient, Ragent's brief in-memory retry cache, account-linked usage/request records retained up to 90 days (longer for unresolved provider outcomes), five-year consent evidence, OpenAI's API data-use statement and applicable account controls, and draft-only result handling.

## Security, privacy, and store-review gates

1. Keep the provider key in the protected server environment and confirm the actual API organization's data controls and terms. OpenAI states API data is not used to train or improve models unless the API customer explicitly opts in; confirm that the intended API project has not opted in.
2. The updated privacy notice is published at <https://support.agentoncloud.com/privacy/>. Verify it remains accurate before enabling provider traffic, especially the actual OpenAI API project settings and the disclosed Ragent retention periods. See [the published notice record](account-asr-public-disclosure-draft.md).
3. Reconcile the Play Console Data safety form with the OpenAI data flow. Use [the Data Safety owner-review worksheet](account-asr-play-data-safety-review.md); do not submit unreviewed sharing/collection answers.
4. Do not claim a retention configuration beyond what the actual OpenAI API project and applicable terms establish. A live provider test does not establish the provider account's retention or training settings.
5. Keep request logs free of audio, transcript, bearer credential, and API key. Preserve account-scoped quotas and provider-cost reporting in Accounts only.

## Release and acceptance sequence

1. Run Accounts unit/HTTP tests for invalid consent version, no-consent denial, acceptance, revocation, cache replay after revocation, usage accounting, migration readiness, and retention pruning.
2. Build Android debug and run core-auth tests plus the seven-locale disclosure test. Run the instrumented test on a physical device to verify the prompt, decline, accept, revoke, cloud recording, and draft behavior.
3. Verify the deployed Accounts migrations and `/healthz`, `/readyz`, authenticated usage/consent policy version, and rejected unauthenticated requests.
4. Store the provider key only in the protected Oracle configuration; do not put it in source, chat, build artifacts, or the Android app. Review actual provider retention settings and public disclosures.
5. With explicit data-processing consent, make a short real transcription, verify auto language detection and account usage, verify revoke blocks the next request, and confirm the API key and transcript are absent from logs and durable database rows.

## Acceptance snapshot (2026-11-12)

| Area | Status |
|---|---|
| Central Accounts service and monthly account usage ledger | Deployed on Oracle at release `0.0.1+openai-transcription.20261111.93f1c54`; migrations 038–042 applied |
| Provider secret and feature gate | Central readiness reports speech recognition ready; inspect the management panel for current settings |
| Consent ledger and enforce-before-forward gate | Implemented; migration 042 is active and the OpenAI v3 consent policy is deployed on Oracle |
| Android explicit consent, decline, revoke, and localized disclosure | Implemented; debug build, unit tests, and seven-locale device test passed |
| Public privacy-policy and Play Console alignment | OpenAI privacy notice published; Play Console Data Safety still needs owner review against actual provider terms |
| OpenAI transcription and cost measurement | Synthetic speech passed against the real provider and an isolated PostgreSQL usage ledger; the full signed-in Android recording-to-draft flow still needs verification |

## Historical deployment and verification — 2026-11-10

`npm run test:owner-auth`, the ASR unit test, and the Accounts independent release-packaging test passed on Windows. The Android debug/unit tests and the connected MTN-AN80 `VoiceLocalizationTest` passed earlier; the device test covered English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It verifies localized disclosure copy, not provider transcription.

Oracle now runs `agentoc-accounts-0.0.1+asr-reconciliation.20261110.d2cc946-arm64`, built from committed source revision `d2cc946c2730fd61ce5a4dc01e1fdbece0089932`; archive SHA-256 is `3c39ee49423e6a3dbde933e86602b7ef1a64f3f24a3e7ff1dc26f5e636027feb`. The prior immutable settlement release remains available for rollback. Migration 041 is applied. Public health/readiness both return 200, readiness reports `speechRecognition: unconfigured`, and an invalid usage credential returns 401. The key is empty and the feature flag is off.

From the real Windows 11 Pro host (Build 22631), public readiness returned 200 with `speechRecognition: unconfigured`, invalid usage returned 401, and disabled transcription returned 503 `asr_unavailable`. This confirms the desktop's network path to Oracle and the fail-closed disabled state; it does not claim a valid account or a provider transcription.

An isolated PostgreSQL scratch-database test verified v1/v2 consent storage, shared cross-device monthly quota under concurrent reservations, the two-operation cap, and successful settlement from reserved to used time. A separate disposable-schema test exercised migration 041, both reconciliation outcomes, idempotent repeat resolution, quota/cost accounting, and account-deletion cascade; it dropped the schema afterward. These tests do not claim a valid signed-in Ragent account or provider call.

At this historical 2026-11-10 checkpoint, the public notice still named ElevenLabs. It was replaced on 2026-11-11; see the deployment record below. The Play Console Data Safety form still needs owner review/update against the actual API project settings. The real OpenAI transcription, provider cost measurement, and signed-in Android round trip remain pending until a key is available and securely provisioned.

## OpenAI provider switch — 2026-11-11

The central adapter now calls `POST /v1/audio/transcriptions` with `gpt-transcribe`, sends no language hint, uses server-side `OPENAI_API_KEY`, and attaches the opaque Ragent idempotency request ID as `X-Client-Request-Id` for support correlation. The provider price estimate is versioned at $0.0045/minute. The Android disclosure and server consent policy both use v3, so an old ElevenLabs acceptance cannot authorize an OpenAI upload. Migration 042 preserves prior v1/v2 events while allowing the new version. The feature remains disabled because the API key has intentionally not been requested or provisioned.

The public privacy notice was updated on 2026-11-11 in static release `ragent-asr-openai-privacy-20261111-88334c8`; the published page SHA-256 is `88334c8b94c43073dfedb41bbc797319f3abf2ca1a80a1100dcdd9b887ac430a`. Only `site/privacy/index.html` changed. The previous release `ragent-asr-privacy-20261110-7b9da59` and receipt backup `/var/www/agentoc-support/deployment.json.before-openai-asr-privacy-20261111` remain available for rollback. Public HTTPS verification returned 200 and confirmed the OpenAI recipient, disabled status, and removal of the old ElevenLabs wording; Caddy configuration and process were unchanged.

Oracle now runs `agentoc-accounts-0.0.1+openai-transcription.20261111.93f1c54-arm64`, built from source revision `93f1c54a82f20a28356f588998389d2c8c3c4946`; archive SHA-256 is `939ccb0fd575b5ac52ac1315c7f2a79af3441d17bcd152a0e89b5ee653c1eefe`. Migration 042 was applied before the atomic switch. The previous `d2cc946` release is retained for rollback. Runtime payload verification passed (2,443 files, no findings). HTTPS health/readiness returned 200, readiness reports `speechRecognition: unconfigured`, invalid usage credentials return 401, and a disabled transcription request returns 503 `asr_unavailable`. The API key remains empty and `AGENTOC_ACCOUNTS_ASR_ENABLED` remains off. No OpenAI call was made. The Android unit tests and physical-device seven-locale disclosure test passed; Accounts ASR, reconciliation, release packaging, and server test suites passed on this source revision.

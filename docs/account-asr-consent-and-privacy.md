# Ragent ASR consent and privacy addendum

This addendum updates the canonical [central Accounts ASR plan](account-asr-service-plan.md), which retains the detailed quota, cost, rollout, and deployment design.

**Updated:** 2026-11-10

**State (2026-11-11):** provider selection is OpenAI `gpt-transcribe`; consent now uses `account-asr-openai-transcription-v3` and requires fresh acceptance after the recipient change. Accounts migration 042 allows the new policy version. The public privacy notice now names OpenAI (static release `ragent-asr-openai-privacy-20261111-88334c8`, page SHA-256 `88334c8b94c43073dfedb41bbc797319f3abf2ca1a80a1100dcdd9b887ac430a`). The API key remains absent and cloud ASR stays disabled.

## Product contract

Android records a short mono 16 kHz WAV and sends it only when the user explicitly chooses cloud recognition. Ragent Accounts authenticates the account, checks a current consent record, reserves that account's monthly allowance, forwards the recording to the configured provider, and returns text plus detected language. Android inserts the result into the composer draft; sending remains a separate user action.

Automatic routing stays local: use the selected paired computer with Whisper when available, otherwise Android's system recognizer. Cloud recognition is an explicit opt-in route. Cloud ASR is not a replacement for Windows Whisper or Android's local recognizer.

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

The voice-device picker can show cloud availability and remaining allowance. Choosing cloud fetches the latest account state. If there is no current acceptance, Android presents a localized prominent disclosure with Allow and continue and Not now; recording does not start until the server confirms acceptance. A revoke action is available from the voice-device picker. Declining or revoking returns a cloud-selected session to automatic/local routing. If the server state is unknown, stale, or unreachable, cloud recording fails closed.

The v3 disclosure is localized in English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It explains the OpenAI audio-transcription recipient, Ragent's brief in-memory retry cache, account-linked usage/request records retained up to 90 days (longer for unresolved provider outcomes), five-year consent evidence, OpenAI's API data-use statement and applicable account controls, and draft-only result handling.

## Security, privacy, and store-review gates

1. Keep `AGENTOC_ACCOUNTS_ASR_ENABLED=0` and leave `OPENAI_API_KEY` unset until the owner obtains a key and confirms the actual API organization's data controls and terms. OpenAI states API data is not used to train or improve models unless the API customer explicitly opts in; confirm that the intended API project has not opted in.
2. The updated privacy notice is published at <https://support.agentoncloud.com/privacy/>. Verify it remains accurate before enabling provider traffic, especially the actual OpenAI API project settings and the disclosed Ragent retention periods. See [the published notice record](account-asr-public-disclosure-draft.md).
3. Reconcile the Play Console Data safety form with the OpenAI data flow. Use [the Data Safety owner-review worksheet](account-asr-play-data-safety-review.md); do not submit unreviewed sharing/collection answers.
4. Do not claim a retention configuration beyond what the actual OpenAI API project and applicable terms establish. The owner's key is absent, so no live provider test or account-setting verification has occurred.
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
| Central Accounts service and monthly account usage ledger | Deployed on Oracle at release `0.0.1+asr-reconciliation.20261110.d2cc946`; migrations 038–041 applied |
| Provider secret and feature gate | Key absent and feature flag off by owner instruction |
| Consent ledger and enforce-before-forward gate | Implemented; migration 040 applied and matching Accounts release active on Oracle |
| Android explicit consent, decline, revoke, and localized disclosure | Implemented; debug build, unit tests, and seven-locale device test passed |
| Public privacy-policy and Play Console alignment | OpenAI privacy notice published; Play Console Data Safety still needs owner review against actual provider terms |
| OpenAI transcription and cost measurement | Cannot be performed until an API key is configured securely |

## Latest deployment and verification — 2026-11-10

`npm run test:owner-auth`, the ASR unit test, and the Accounts independent release-packaging test passed on Windows. The Android debug/unit tests and the connected MTN-AN80 `VoiceLocalizationTest` passed earlier; the device test covered English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It verifies localized disclosure copy, not provider transcription.

Oracle now runs `agentoc-accounts-0.0.1+asr-reconciliation.20261110.d2cc946-arm64`, built from committed source revision `d2cc946c2730fd61ce5a4dc01e1fdbece0089932`; archive SHA-256 is `3c39ee49423e6a3dbde933e86602b7ef1a64f3f24a3e7ff1dc26f5e636027feb`. The prior immutable settlement release remains available for rollback. Migration 041 is applied. Public health/readiness both return 200, readiness reports `speechRecognition: unconfigured`, and an invalid usage credential returns 401. The key is empty and the feature flag is off.

From the real Windows 11 Pro host (Build 22631), public readiness returned 200 with `speechRecognition: unconfigured`, invalid usage returned 401, and disabled transcription returned 503 `asr_unavailable`. This confirms the desktop's network path to Oracle and the fail-closed disabled state; it does not claim a valid account or a provider transcription.

An isolated PostgreSQL scratch-database test verified v1/v2 consent storage, shared cross-device monthly quota under concurrent reservations, the two-operation cap, and successful settlement from reserved to used time. A separate disposable-schema test exercised migration 041, both reconciliation outcomes, idempotent repeat resolution, quota/cost accounting, and account-deletion cascade; it dropped the schema afterward. These tests do not claim a valid signed-in Ragent account or provider call.

At this historical 2026-11-10 checkpoint, the public notice still named ElevenLabs. It was replaced on 2026-11-11; see the deployment record below. The Play Console Data Safety form still needs owner review/update against the actual API project settings. The real OpenAI transcription, provider cost measurement, and signed-in Android round trip remain pending until a key is available and securely provisioned.

## OpenAI provider switch — 2026-11-11

The central adapter now calls `POST /v1/audio/transcriptions` with `gpt-transcribe`, sends no language hint, uses server-side `OPENAI_API_KEY`, and attaches the opaque Ragent idempotency request ID as `X-Client-Request-Id` for support correlation. The provider price estimate is versioned at $0.0045/minute. The Android disclosure and server consent policy both use v3, so an old ElevenLabs acceptance cannot authorize an OpenAI upload. Migration 042 preserves prior v1/v2 events while allowing the new version. The feature remains disabled because the API key has intentionally not been requested or provisioned.

The public privacy notice was updated on 2026-11-11 in static release `ragent-asr-openai-privacy-20261111-88334c8`; the published page SHA-256 is `88334c8b94c43073dfedb41bbc797319f3abf2ca1a80a1100dcdd9b887ac430a`. Only `site/privacy/index.html` changed. The previous release `ragent-asr-privacy-20261110-7b9da59` and receipt backup `/var/www/agentoc-support/deployment.json.before-openai-asr-privacy-20261111` remain available for rollback. Public HTTPS verification returned 200 and confirmed the OpenAI recipient, disabled status, and removal of the old ElevenLabs wording; Caddy configuration and process were unchanged.

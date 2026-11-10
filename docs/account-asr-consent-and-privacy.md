# Ragent ASR consent and privacy addendum

This addendum updates the canonical [central Accounts ASR plan](account-asr-service-plan.md), which retains the detailed quota, cost, rollout, and deployment design.

**Updated:** 2026-11-10
**State:** consent enforcement and Android disclosure are implemented and deployed to Oracle. The provider remains disabled because the owner has not obtained an ElevenLabs API key.

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

The existing usage ledger is keyed by account and billing month. It records duration, request count, reservation and settlement state, provider/model and price version, audio hash, and provider cost. It does not persist the WAV or transcript as database columns. The server holds a successful response in process memory for up to five minutes to serve an idempotent retry; that brief cache is disclosed to the user.

## API and persistence

The implemented contract is:

- POST /v1/owner-auth/account/asr/consent with action=accept and the exact disclosure policy version, or action=revoke. Requests are account-authenticated, rate-limited, and never cached.
- GET /v1/owner-auth/account/asr/usage reports the current account/month quota and the latest consent state. It remains useful while the provider is disabled.
- POST /v1/owner-auth/account/asr/transcriptions accepts bounded audio/wav bytes and an idempotency key. A current accepted consent for the disclosure version is required before any provider call, including a cached-result replay.

Migration 039_account_asr_consent creates an append-only consent event ledger. It stores only the random account/device identifiers, disclosure version, accepted/revoked action and timestamp, and retains each event for five years. It has no foreign key, so account deletion cannot silently erase evidence of the user's choice. The account-deletion receipt names this minimal retained evidence. A bounded maintenance job deletes events after their retention deadline.

The exact disclosure version is part of the server and Android protocol. A changed recipient, purpose, retention promise, or material policy change must use a new version and require fresh consent.

## Android behavior

The voice-device picker can show cloud availability and remaining allowance. Choosing cloud fetches the latest account state. If there is no current acceptance, Android presents a localized prominent disclosure with Allow and continue and Not now; recording does not start until the server confirms acceptance. A revoke action is available from the voice-device picker. Declining or revoking returns a cloud-selected session to automatic/local routing. If the server state is unknown, stale, or unreachable, cloud recording fails closed.

The disclosure is localized in English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. It explains the audio recipient, processing purpose, vendor retention uncertainty, Ragent's brief in-memory retry cache, five-year consent evidence, and draft-only result handling.

## Security, privacy, and store-review gates

1. Keep AGENTOC_ACCOUNTS_ASR_ENABLED=0 and leave ELEVENLABS_API_KEY unset until the owner obtains a key and confirms the provider account's applicable data-retention settings.
2. Before provider traffic is enabled, publish a matching privacy-policy update. It must explain recording upload, Ragent Accounts and ElevenLabs roles, provider retention/settings, usage records, and the five-year minimal consent evidence retained after account deletion. A draft is kept at docs/account-asr-public-disclosure-draft.md; it has not been published.
3. Reconcile the Play Console Data safety form and prominent disclosure with the final provider contract. The existing form marks voice recordings as collected and not shared. Keep that answer only if the final ElevenLabs arrangement qualifies as processing by a service provider on Ragent's behalf; otherwise correct it before release.
4. Do not claim zero retention unless the provider account is entitled to it and the actual request is verified. The ElevenLabs API may retain content under its standard settings; the owner's key is currently absent, so there has been no live provider test.
5. Keep request logs free of audio, transcript, bearer credential, and API key. Preserve account-scoped quotas and provider-cost reporting in Accounts only.

## Release and acceptance sequence

1. Run Accounts unit/HTTP tests for invalid consent version, no-consent denial, acceptance, revocation, cache replay after revocation, usage accounting, migration readiness, and retention pruning.
2. Build Android debug and run core-auth tests plus the seven-locale disclosure test. Run the instrumented test on a physical device to verify the prompt, decline, accept, revoke, local routes, and cloud route behavior.
3. Apply migration 039 to the Oracle Accounts database, then deploy the matching Accounts binary with provider disabled. Verify /healthz, /readyz, authenticated usage/consent, rejected unauthenticated requests, and that audio returns unavailable without any provider call.
4. Once an API key exists, store it only in Oracle /etc/agentoc/accounts.env; do not put it in source, chat, build artifacts, or the Android app. Keep ASR disabled until the owner explicitly enables it after reviewing provider retention and the updated public disclosures.
5. With owner approval to enable it, make one short real transcription with explicit consent, verify auto language detection, verify account usage increments, verify revoke blocks the next request, and confirm the API key and transcript are absent from logs and durable database rows.

## Current acceptance status

| Area | Status |
|---|---|
| Central Accounts service and monthly account usage ledger | Implemented and deployed previously; Oracle health/ready checks passed |
| Provider secret and feature gate | Correctly absent/off; owner has not applied for a key |
| Consent ledger and enforce-before-forward gate | Implemented; migration 039 applied and matching Accounts release active on Oracle |
| Android explicit consent, decline, revoke, and localized disclosure | Implemented; debug build, unit tests, and seven-locale device test passed |
| Public privacy-policy and Play Console alignment | Draft prepared; public changes not published |
| Real ElevenLabs transcription and cost measurement | Cannot be performed until a key is configured securely |

## Verification follow-up — 2026-11-10

The Windows `npm run test:owner-auth` suite passed, including the ASR service and Accounts route tests and all four owner-auth Playwright checks. Android debug assembly and relevant unit tests passed, including `AccountSessionManagerTest` and the Workbench tests. On the connected MTN-AN80, `VoiceLocalizationTest` passed both cases across English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. This device check verifies the localized disclosure copy; it is not a real provider transcription test.

Migration 039 was applied before switching to `agentoc-accounts-0.0.1+asr-consent.20261110.29f924d-arm64`. The service is active, HTTPS health and readiness return 200, readiness reports `speechRecognition: unconfigured`, invalid usage and consent credentials return 401, and transcription returns 503 `asr_unavailable`. The previous immutable release remains available for rollback. The provider flag is off and its key is absent. Real provider transcription and valid-account usage settlement, public privacy-policy publication, and Play Console updates remain separate launch gates.

# Central Accounts speech recognition

## Decision and scope

Run cloud speech recognition inside the existing central Ragent Accounts service. The Android app sends audio directly to Accounts over the account service's HTTPS endpoint; Accounts authenticates the Ragent account, applies its quota, calls the configured speech provider with a server-only key, records usage, and returns text to Android. This adds no client-side provider secret, local forwarding daemon, separate ASR database, or new server product.

The existing Android and paired-computer routes remain local. Automatic voice routing continues to prefer the session computer's enabled Whisper service and then the phone's system recognizer. It never chooses cloud recognition by itself. Cloud recognition is a separate per-chat choice that requires the user to select it and see the upload disclosure first. Every successful route writes to the draft; it never sends the chat message.

## Request path

1. Android records mono 16 kHz PCM16 WAV from the phone microphone, for 0.5–20 seconds and no more than 1 MiB.
2. Android sends the raw WAV bytes to `POST /v1/owner-auth/account/asr/transcriptions` at the configured central Accounts base URL. It includes the existing RAC bearer credential and a per-recording `Idempotency-Key`.
3. Accounts validates the credential against the account directory, device status, and current Free/Plus/Pro entitlement. It reserves monthly account minutes transactionally in the central PostgreSQL database before contacting the provider.
4. Accounts forwards audio to ElevenLabs Scribe v2 without a language code, so language detection is automatic and independent of Android's UI language. The ElevenLabs key stays in `/etc/agentoc/accounts.env` on the Accounts host.
5. Accounts settles the usage ledger and returns `{ contractVersion, requestId, text, languageCode, durationMs }`. Android validates the response and puts only `text` into the current draft.

`GET /v1/owner-auth/account/asr/usage` returns the signed-in account's current period, plan, cap, used/reserved/remaining milliseconds, and request count. It does not return provider cost to a customer. The database keeps an estimated provider cost for internal reconciliation.

## Quota and accounting

Quota is shared across all devices on one Ragent account, not per phone. Initial monthly caps are Free 15 minutes, Plus 120 minutes, and Pro 600 minutes. Operators can change them with `AGENTOC_ACCOUNTS_ASR_FREE_MINUTES`, `...PLUS_MINUTES`, and `...PRO_MINUTES`. These are usage caps, not customer ASR charges. At the provider's currently listed $0.22 per audio hour, the approximate maximum provider cost at those caps is $0.055, $0.44, and $2.20 per account per month, before tax, plan changes, or invoice-specific terms. Recheck vendor pricing before launch.

The database migration adds `account_asr_usage` for account-period totals and `account_asr_requests` for idempotency and request-state metadata. It records duration, byte count, a content digest, device, provider/model and price/policy versions, latency, language, state, and estimated provider cost. Audio and transcript text are not written to PostgreSQL, files, or audit events. Ragent keeps a bounded in-memory transcript result for five minutes only to answer a same-process idempotent replay. Successful/failed request metadata is pruned after 90 days; monthly totals stay until account deletion, and the existing account deletion cleanup removes both tables' rows.

Reservations are serialized by locking the account-period aggregate before locking a request. A confirmed success moves reserved minutes to used minutes; a definite pre-processing failure releases the reservation. A timeout or other uncertain provider result is never submitted again under the same key, and its minutes remain reserved until operational reconciliation. Estimated cost aggregates cover confirmed successful calls; uncertain provider charges must be reconciled against the provider invoice.

## Privacy and provider boundary

Selecting the cloud route sends microphone audio to Ragent Accounts and ElevenLabs. Ragent does not persist audio or transcript text. The vendor's own retention and processing terms still apply: ElevenLabs documents request logging as enabled by default, and its zero-retention request mode is limited to eligible Enterprise customers. Do not enable zero-retention mode unless the provider account is entitled to it. Before public enablement, make the provider transfer and applicable retention visible in the Android flow, privacy policy, and Google Play Data Safety declarations. Users who do not accept that transfer can keep using local phone/computer recognition.

The endpoint rejects non-WAV or unsupported WAV input, limits audio size and duration, rate-limits requests, limits each account to two concurrent operations, reserves account minutes before provider work, uses a 30-second provider timeout, and gives Android a 60-second overall request budget so it can receive the provider result. It rejects provider redirects, bounds provider response size, and never writes audio or transcript into service logs. The API is disabled unless both `AGENTOC_ACCOUNTS_ASR_ENABLED=1` and `ELEVENLABS_API_KEY` are present. Keep the key only in the protected Accounts host environment file; never put it in the Android or Windows package, source control, command line, or logs.

## User-visible behavior

- **Automatic**: local routing only; session computer Whisper first, then phone-local recognition. No cloud fallback.
- **This phone**: phone-local recognition only; no network fallback.
- **Paired computer**: Whisper on the selected computer only.
- **Accounts cloud**: explicitly uploads the current recording to central Accounts. The route shows availability and remaining monthly minutes. Quota exhaustion, account authentication errors, or service downtime do not switch routes silently.
- **Uncertain result**: do not automatically replay the recording. Tell the user the result is unknown and minutes may remain reserved; show current usage so the user can decide whether to make another recording.

The client currently presents cloud availability and remaining minutes in the voice-device picker. Cloud selection is stored using the existing voice-choice preference. The result continues through the existing composer draft callback.

## Deployment and rollout

1. Build the independent ARM64 Accounts release from the committed source. This is the central Accounts artifact, not an Ubuntu Ragent client build. Keep build output, temporary files, and caches on G:.
2. Keep the current Accounts release available. Copy the new immutable release under `/opt/agentoc-accounts/releases` and verify the source revision and archive checksum.
3. Apply additive migration `038_account_asr_usage` with the protected Accounts environment file. Do not run the destructive down migration as part of rollback.
4. Atomically switch `/opt/agentoc-accounts/current`, restart `agentoc-accounts`, and check `/healthz`, `/readyz`, route prefix handling, and invalid-credential rejection. Keep the feature flag off while the provider key is absent.
5. After privacy text/Data Safety review and secure provider-key provisioning, enable the feature, verify usage for a signed-in account, and run a real, short multilingual utterance from Android. Confirm the audio reaches only Accounts and the provider, the text returns only to the draft, usage increments once, and no transcript appears in database rows or logs.
6. Monitor provider spend and request outcomes. Roll back application code by pointing `current` to the previous immutable release; leave the additive tables in place. Disable the flag immediately if usage, privacy, or provider behavior is wrong.

## Acceptance checks

- Valid RAC on a live Android account can read only that account's usage; invalid, expired, revoked, or missing credentials are rejected.
- Two devices on one account share the same monthly limit; parallel reservations cannot exceed the cap.
- Replaying one request with identical audio never calls the provider twice; a different audio body with the same key returns conflict.
- Invalid WAV, unsupported sample format, over 20-second audio, and over 1 MiB are rejected before the provider call.
- Known rejection releases quota; a timeout/ambiguous provider response is marked unknown, keeps quota reserved, and cannot be replayed under the same request ID.
- An explicit cloud transcription detects a non-phone UI language, returns a transcript, fills only the draft, and increments account usage once.
- Local routes and automatic routing still work with the Accounts feature disabled or the provider unavailable.
- Account deletion removes request and aggregate rows. No server or provider key is present in client packages or source.

## Current implementation status

As of 2026-11-10, the implementation is committed on `main` at `80faa595b77d8a74708a77e71196aa2634242266`. The Accounts release `agentoc-accounts-0.0.1+asr.20261110.80faa59-arm64` is deployed on Oracle, migration `038_account_asr_usage` is applied, and `agentoc-accounts` is active. Public `/healthz` and `/readyz` checks returned 200 with `status: ready`; the latter reports `speechRecognition: unconfigured`. A usage request with an invalid bearer credential returned 401. The invalid-credential check confirms the deployed route rejects unauthenticated access; it does not substitute for a valid-account check.

The feature remains disabled because `ELEVENLABS_API_KEY` is not provisioned and `AGENTOC_ACCOUNTS_ASR_ENABLED` is not enabled. The Android client and server code are present, but there has been no live provider transcription from a signed-in Android account. Before enabling the feature, securely provision the provider key, review the Android upload disclosure and privacy policy, complete the Google Play Data Safety review, then run the multilingual account-level acceptance checks above. Until those gates pass, local phone and paired-computer recognition remain the available routes.

The Windows workspace passed `npm run test:owner-auth`, the Accounts release-packaging checks, and Android debug unit tests for `app`, `workbench`, `auth`, and `network`. The provider call, valid-RAC usage display, usage settlement, and end-to-end Android cloud transcription still require the provider key and a signed-in Android account.

Follow-up verification on 2026-11-10: `npm run test:owner-auth` passed on Windows, including the Accounts ASR/server and owner-auth tests plus all four owner-auth Playwright checks. On Oracle, the running service returned 200 for `/accounts/healthz` and `/accounts/readyz`; readiness reported `speechRecognition: unconfigured`. An invalid bearer credential returned 401 from the account usage route, and a transcription request returned 503 `asr_unavailable`. The same health, readiness, authentication, and disabled-transcription checks passed through the configured public host `https://agentoc.andyscodexagent.cyou/accounts`, with the hostname and TLS SNI preserved while pinning the Oracle address. The provider key remains intentionally absent and the feature flag remains off, as requested; no live provider call or valid-account usage settlement has been performed.

The Oracle database was checked directly in `agentoc_accounts_runtime`: migration `038_account_asr_usage` is recorded as applied at `2026-11-10 08:53:43 UTC`, and both `public.account_asr_usage` and `public.account_asr_requests` exist. This confirms the ASR tables are in the RAC runtime database used for usage and request accounting. Accounts `/readyz` now also returns 503 when enabled speech recognition is unavailable because the schema is missing, and it rechecks the ASR store when that feature is ready; a regression test covers the missing-schema case.

The current public privacy notice at `https://support.agentoncloud.com/privacy/` was checked on 2026-11-10. It describes selected model providers generally but does not specifically disclose optional voice uploads to Ragent Accounts and ElevenLabs, provider-side retention, or ASR usage metadata retention. The Android cloud-route disclosure now states that audio goes to both services, Ragent does not persist audio/transcript content, ElevenLabs may retain it under its data policy, and the result goes only to the draft; this copy is localized for English, Simplified Chinese, Traditional Chinese, Japanese, Korean, French, and Spanish. The public notice and the Play Console Data safety declaration still need owner review/update before enabling or releasing cloud ASR. Google Play classifies user voice recordings under Audio files; whether this transfer qualifies for a consent or service-provider exception must be checked against the current form requirements rather than assumed. See [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) and [ElevenLabs Zero Retention Mode documentation](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode).

The updated Android disclosure passed `VoiceLocalizationTest` on the connected MTN-AN80 (Android 16): both localization tests passed across all seven supported UI locales. The test-only `.opensource` target and instrumentation packages were then removed; the installed `com.agentoncloud.android` app remained installed.

Proposed public-notice copy for owner review, not yet published: “When you choose cloud speech recognition and start a recording, the app sends that recording to Ragent Accounts, which forwards it to ElevenLabs Scribe v2 for transcription. Ragent does not persist the audio or transcript; a transcript may remain temporarily in service memory for up to five minutes to handle an idempotent retry. Ragent stores account-linked usage and request metadata, such as recording duration, device, language, request status and timing, to enforce usage limits and reconcile service costs. Successful and failed request records are purged after 90 days. If a provider outcome is uncertain, the request metadata and reserved minutes remain until the charge is operationally reconciled or the account is deleted. Monthly usage totals remain until account deletion. ElevenLabs API logging is enabled by default in this integration, so the provider may retain audio and transcript data under its own privacy and retention terms; see [ElevenLabs’ Privacy Policy](https://elevenlabs.io/privacy-policy). The transcript is added to your draft and is not sent automatically. Automatic and local recognition routes do not upload audio to Ragent Accounts or ElevenLabs.”

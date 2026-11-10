# Draft Google Play Data safety review for optional cloud ASR

This is an owner-review worksheet, not a completed Play Console declaration or legal determination. The declaration must match the provider account, signed contract, actual data flows, and every currently distributed version of the app.

## Current ASR data flow

- The user explicitly selects cloud recognition and starts a recording. Android sends a WAV recording to Ragent Accounts over HTTPS.
- Accounts authenticates the Ragent account, checks consent and quota, and forwards the audio to ElevenLabs Scribe v2 over HTTPS. The provider request contains the audio and model/options, not the RAC bearer token or Ragent account/device IDs.
- Ragent returns the transcript to the phone and temporarily caches the transcript in process memory for up to five minutes for an idempotent retry. It does not persist audio or transcript content in the Accounts database.
- Accounts stores account-linked request metadata (including a SHA-256 audio digest, duration, byte count, device ID, state, language, timing and estimated provider cost) for normal terminal requests up to 90 days. An uncertain provider outcome remains until reconciled or account deletion. Monthly usage totals remain until account deletion.
- Consent accept/revoke evidence stores account/device IDs, disclosure version, action and time for five years, including after account deletion.
- Current standard ElevenLabs API calls explicitly set `enable_logging=true`. Its current non-EEA terms permit use of submitted content to improve services/develop products and provide an account-level training/data-use opt-out. The owner must verify which terms and settings apply to the actual account before enabling ASR. Do not claim Zero Retention unless the account is eligible and the request uses the required setting.

## Candidate form entries to verify in Play Console

| Data type | Candidate collection answer | Purpose to assess | Important handling detail |
| --- | --- | --- | --- |
| Audio files → Voice or sound recordings | Collected; optional because users can keep using local recognition and choose whether to upload | App functionality: transcribe the user-selected recording | It leaves the phone and is forwarded from Accounts to ElevenLabs. Provider retention/data-use setting determines whether it is also “shared.” |
| Personal info → User IDs | Account IDs are present in persistent Accounts request and consent records; confirm whether already covered by the existing form | App functionality, account management, security/quota enforcement | Random account IDs are still account-linked identifiers. |
| Device or other identifiers | Device ID is present in persistent request and consent records; confirm the current form taxonomy | App functionality and security/quota enforcement | The provider request does not receive the Ragent device ID. |
| App activity → Other actions, or the closest applicable category | Assess for account-linked transcription request/usage metadata | App functionality and fraud prevention/security | This metadata persists for up to 90 days, with an exception for unresolved outcomes. |
| Messages → Other in-app messages, or user-generated content | Assess whether the returned transcription should be listed separately from its audio source | App functionality | The transcript is cached only in server memory for up to five minutes and is not stored in the Ragent database. Include ephemeral processing in the form response even if it is not shown in the store listing. |

For the “shared” questions, do not carry forward a “not shared” answer without reviewing the actual ElevenLabs agreement and account data-use setting. Google Play excludes some transfers to service providers and user-initiated transfers from “sharing”; those exceptions do not eliminate the separate collection questions. If ElevenLabs can use content for its own service improvement under the applicable account terms, treat the provider as a potential independent recipient unless the owner confirms a binding service-provider arrangement or another applicable exception.

## Required owner checks before submitting

1. Inspect the current form for the Ragent Android package in Play Console. Data Safety is package-level and describes the sum of relevant practices across active distributed versions; update it before releasing cloud-ASR behavior.
2. Confirm the final ElevenLabs account type, applicable regional/API terms, DPA or service-provider role, logging/retention configuration, and whether content is used for model/service improvement. Save evidence of any opt-out setting.
3. Decide whether the transcript's short idempotency cache meets Google Play's “ephemeral processing” criteria. It is in memory and bounded to five minutes, but it exists after the initial response to handle retries; do not omit it without documenting the determination.
4. Reconcile the selected data types, purposes, optional/required status, sharing answers, encryption-in-transit answer, and deletion answers with the published privacy policy and the localized in-app consent v2.
5. Only submit the form after the owner confirms the declarations. Google Play places responsibility for their accuracy on the app publisher.

## Primary sources checked 2026-11-10

- [Google Play Data safety requirements](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) — Audio files include voice/sound recordings; off-device transfer is collection; ephemeral processing still belongs in the form response; service-provider and user-initiated transfer exceptions relate to sharing; the publisher is responsible for accuracy.
- [Google Play prominent disclosure guidance](https://support.google.com/googleplay/android-developer/answer/11150561?hl=en) — the in-app disclosure supplements the privacy policy and Data safety form and should explain the data, purpose, third-party transfer, and consent/decline path.
- [ElevenLabs Scribe API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) — logging defaults to enabled; `enable_logging=false` invokes Zero Retention and is limited to eligible Enterprise customers; omitting `language_code` enables automatic detection.
- [ElevenLabs Zero Retention documentation](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode) — standard retention is enabled by default, and Zero Retention is only available to selected Enterprise customers.
- [ElevenLabs Terms of Service](https://elevenlabs.io/terms-of-use) — current non-EEA terms allow content use to improve services/develop products and provide an account-level opt-out. Verify the actual account's applicable terms before relying on this summary.

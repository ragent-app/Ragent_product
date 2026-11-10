# Google Play Data Safety owner-review worksheet for optional cloud ASR

This is an owner-review worksheet, not a completed Play Console declaration or legal determination. The declaration must match the provider account, signed contract, actual data flows, and every currently distributed version of the app.

**Current status (2026-11-10):** the public privacy notice is published at `https://support.agentoncloud.com/privacy/`. The provider key is absent and cloud ASR is disabled; no vendor transcription is currently forwarded by Ragent Accounts. The Play Console declaration remains unsubmitted and requires owner review against the actual provider account terms before feature activation.

## Current ASR data flow

- The user explicitly selects cloud recognition and starts a recording. Android sends a WAV recording to Ragent Accounts over HTTPS.
- Accounts authenticates the Ragent account, checks consent and quota, and forwards the audio to ElevenLabs Scribe v2 over HTTPS. The provider request contains the audio and model/options, not the RAC bearer token or Ragent account/device IDs.
- Ragent returns the transcript to the phone and temporarily caches the transcript in process memory for up to five minutes for an idempotent retry. It does not persist audio or transcript content in the Accounts database.
- Accounts stores account-linked request metadata (including a SHA-256 audio digest, duration, byte count, device ID, state, language, timing and estimated provider cost) for normal terminal requests up to 90 days. An uncertain provider outcome remains until reconciled or account deletion. Monthly usage totals remain until account deletion.
- Consent accept/revoke evidence stores account/device IDs, disclosure version, action and time for five years, including after account deletion.
- Current standard ElevenLabs API calls explicitly set `enable_logging=true`; the provider documents request history/retention as enabled by default. Current non-EEA terms grant a content license to provide and improve services and develop products. The current Privacy Policy says inputs/outputs can be used for service improvement and AI model research/development. The account's `Terms and Privacy > Data use` menu offers a training opt-out, but the published policy says it affects use after the opt-out and does not reverse prior use. The owner must verify the actual account's applicable regional/API terms, DPA, and effective setting before enabling ASR. Do not claim Zero Retention unless the account is eligible and each request uses the required setting.

## Candidate form entries to verify in Play Console

| Data type | Candidate collection answer | Purpose to assess | Important handling detail |
| --- | --- | --- | --- |
| Audio files → Voice or sound recordings | Collected; optional because users can keep using local recognition and choose whether to upload | App functionality: transcribe the user-selected recording | It leaves the phone and is forwarded from Accounts to ElevenLabs. With standard logging enabled, do not describe this audio as ephemeral. Provider terms, the explicit upload flow, and Play's sharing exceptions must be evaluated separately. |
| Personal info → User IDs | Account IDs are present in persistent Accounts request and consent records; confirm whether already covered by the existing form | App functionality, account management, security/quota enforcement | Account IDs are account-linked identifiers even when pseudonymous. |
| Device or other identifiers | Device ID is present in persistent request and consent records; confirm the current form taxonomy | App functionality and security/quota enforcement | The provider request does not receive the Ragent device ID. |
| App activity → Other actions, or the closest applicable category | Assess for account-linked transcription request/usage metadata | App functionality and fraud prevention/security | Successful and failed request metadata is normally retained for 90 days; uncertain outcomes have no automatic expiry and can remain until account deletion. |
| Messages → Other in-app messages, or user-generated content | Assess whether the returned transcription should be listed separately from its audio source | App functionality | The transcript is cached only in server memory for up to five minutes and is not stored in the Ragent database. Include ephemeral processing in the form response even if it is not shown in the store listing. |

For the sharing questions, do not infer the answer from the collection answer. Google Play defines sharing to include server-to-server transfers and lists separate exceptions for service-provider processing and transfers prompted by a user action or prominent disclosure and consent. The Android cloud flow is user-initiated and names ElevenLabs, but the publisher must confirm it meets current policy and document the basis for its answer. The service-provider exception may not apply if ElevenLabs uses content for its own service improvement or model development. A sharing exception does not remove collection obligations.

## Required owner checks before submitting

1. Inspect the current form for the Ragent Android package in Play Console. Data Safety is package-level and describes the sum of relevant practices across active distributed versions; update it before releasing cloud-ASR behavior.
2. Confirm the final ElevenLabs account type, applicable regional/API terms, DPA or service-provider role, logging/retention configuration, and whether content is used for model/service improvement. Save evidence of any opt-out setting and its effective date; the current policy says training opt-out is prospective.
3. Decide whether the transcript idempotency cache meets Google Play's ephemeral-processing criteria. It remains in memory for up to five minutes after the first response to support retries; document the determination. Do not describe provider-side audio/transcript retention as ephemeral in standard logging mode.
4. Reconcile the selected data types, purposes, optional/required status, sharing answers, encryption-in-transit answer, and deletion answers with the published privacy policy and the localized in-app consent v2.
5. Only submit the form after the owner confirms the declarations. Google Play places responsibility for their accuracy on the app publisher.

## Primary sources checked 2026-11-10

- [Google Play Data safety requirements](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) — Audio files include voice/sound recordings; off-device transfer is collection; ephemeral processing still belongs in the form response; service-provider and user-initiated transfer exceptions relate to sharing; the publisher is responsible for accuracy.
- [Google Play prominent disclosure guidance](https://support.google.com/googleplay/android-developer/answer/11150561?hl=en) — the in-app disclosure supplements the privacy policy and Data safety form and should explain the data, purpose, third-party transfer, and consent/decline path.
- [ElevenLabs Scribe API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) — logging defaults to enabled; `enable_logging=false` invokes Zero Retention and is limited to eligible Enterprise customers; omitting `language_code` enables automatic detection.
- [ElevenLabs Zero Retention documentation](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode) — standard retention is enabled by default, and Zero Retention is only available to selected Enterprise customers.
- [ElevenLabs Terms of Service](https://elevenlabs.io/terms-of-use) — current non-EEA terms grant a license to use content to improve services and develop products; the Data use opt-out is prospective and does not undo prior use. Verify the actual account's applicable terms before relying on this summary.
- [ElevenLabs Privacy Policy](https://elevenlabs.io/privacy-policy) — updated 2026-10-09; describes use of inputs/outputs to improve services and research/develop AI models, plus the account training opt-out.
- [ElevenLabs Data Processing Addendum](https://elevenlabs.io/dpa) — review the actual order/account terms to determine whether the processor role and any overriding commitments apply.

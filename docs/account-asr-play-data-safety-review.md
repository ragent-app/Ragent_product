# Google Play Data Safety review for central Accounts speech recognition

## Current OpenAI transcription data flow

- The user explicitly chooses cloud recognition and starts a recording. Android sends a WAV recording to Ragent Accounts over HTTPS.
- Accounts authenticates the Ragent account, checks current consent and monthly quota, then forwards the audio to OpenAI's `POST /v1/audio/transcriptions` endpoint using `gpt-transcribe`. The request contains the audio, model and an opaque request-correlation ID; it does not contain the RAC bearer token or Ragent account/device IDs.
- Ragent returns the transcript to the phone and temporarily caches it in process memory for up to five minutes for an idempotent retry. It does not persist audio or transcript content in the Accounts database.
- Accounts stores account-linked request metadata (including a SHA-256 audio digest, duration, byte count, device ID, state, language, timing and estimated provider cost) for normal terminal requests up to 90 days. An uncertain provider outcome remains until reconciled or account deletion. Monthly usage totals remain until account deletion.
- Consent accept/revoke evidence stores account/device IDs, disclosure version, action and time for five years, including after account deletion.
- OpenAI states that API data is not used to train or improve models unless the API customer explicitly opts in. Its endpoint table currently lists `/v1/audio/transcriptions` as having no application-state retention and no abuse-monitoring retention, and as eligible for Zero Data Retention; the same page describes a general default of up to 30-day abuse-monitoring logs for API use. Confirm which controls apply to the actual API project and terms before activation, and do not promise a retention setting beyond what that account establishes.

## Candidate form entries to verify in Play Console

| Data type | Candidate collection answer | Purpose to assess | Important handling detail |
| --- | --- | --- | --- |
| Audio files → Voice or sound recordings | Collected; optional because users can keep using local recognition and choose whether to upload | App functionality: transcribe the user-selected recording | It leaves the phone and is forwarded from Accounts to OpenAI. The transfer is user-initiated and disclosed before capture. Evaluate the sharing answer independently. |
| Personal info → User IDs | Account IDs are present in persistent Accounts request and consent records; confirm whether already covered by the existing form | App functionality, account management, security/quota enforcement | Account IDs are account-linked identifiers even when pseudonymous. |
| Device or other identifiers | Device ID is present in persistent request and consent records; confirm the current form taxonomy | App functionality and security/quota enforcement | The provider request does not receive the Ragent device ID. |
| App activity → Other actions, or the closest applicable category | Assess for account-linked transcription request/usage metadata | App functionality and fraud prevention/security | Successful and failed request metadata is normally retained for 90 days; uncertain outcomes have no automatic expiry and can remain until account deletion. |
| Messages → Other in-app messages, or user-generated content | Assess whether the returned transcription should be listed separately from its audio source | App functionality | The transcript is cached only in server memory for up to five minutes and is not stored in the Ragent database. Include ephemeral processing in the form response even if it is not shown in the store listing. |

For the sharing questions, do not infer the answer from the collection answer. Google Play defines sharing to include server-to-server transfers and lists separate exceptions for service-provider processing and transfers prompted by a user action or prominent disclosure and consent. The Android cloud flow is user-initiated and names OpenAI, but the publisher must confirm it meets current policy and document the basis for the answer. A sharing exception does not remove collection obligations.

## Account and data deletion pathway

ASR request metadata and usage aggregates are removed with account deletion. Minimal consent evidence is intentionally retained for up to five years and is included in the deletion receipt. Provider-side deletion requests, if any are needed under the actual account terms, must be handled through the applicable provider controls.

## Required owner checks before submitting

1. Inspect the current form for the Ragent Android package in Play Console. Data Safety is package-level and describes the sum of relevant practices across active distributed versions; update it before releasing cloud-ASR behavior.
2. Confirm the OpenAI API organization's applicable terms, project data-control setting, whether the customer explicitly opted in to training/data sharing, and any retention controls in effect. Keep evidence of the account settings and review date.
3. Decide whether the transcript idempotency cache meets Google Play's ephemeral-processing criteria. It remains in memory for up to five minutes after the first response to support retries; document the determination.
4. Reconcile the selected data types, purposes, optional/required status, sharing answers, encryption-in-transit answer, and deletion answers with the published OpenAI privacy policy and localized in-app consent v3.
5. Only submit the form after the owner confirms the declarations. Google Play places responsibility for their accuracy on the app publisher.

## Evidence and references

- [Google Play Data safety requirements](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) — Audio files include voice/sound recordings; off-device transfer is collection; ephemeral processing still belongs in the form response; service-provider and user-initiated transfer exceptions relate to sharing; the publisher is responsible for accuracy.
- [Google Play prominent disclosure guidance](https://support.google.com/googleplay/android-developer/answer/11150561?hl=en) — the in-app disclosure supplements the privacy policy and Data Safety form and should explain the data, purpose, third-party transfer, and consent/decline path.
- [Google Play account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en) — deletion requests must cover relevant service-provider copies where applicable.
- [OpenAI file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) — use the Transcriptions API with `gpt-transcribe` for completed recordings and omit optional language hints for automatic language handling.
- [OpenAI GPT-Transcribe model and pricing](https://developers.openai.com/api/docs/models/gpt-transcribe) — current model description and per-minute rate.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) — data-use statement, endpoint retention table, and project-level controls.

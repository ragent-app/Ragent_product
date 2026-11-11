# ASR privacy disclosure and publication record

**Previous notice:** <https://support.agentoncloud.com/privacy/> was updated on 2026-11-10 with ElevenLabs-specific wording. Its static release was `ragent-asr-privacy-20261110-7b9da59`; the page SHA-256 was `35e6906236025c84e1ab0c2d45f8f858ea5aa200e82fd8ee764a12bf6f3e1c19`.

**Current published notice:** Updated 2026-11-11 in static release `ragent-asr-openai-privacy-20261111-88334c8`; the page SHA-256 is `88334c8b94c43073dfedb41bbc797319f3abf2ca1a80a1100dcdd9b887ac430a`. The deployment changed only the privacy page. Caddy was not changed or reloaded, and the previous static release and deployment receipt remain available for rollback.

**Current provider:** OpenAI Transcription API (`gpt-transcribe`). The API key is intentionally absent and `AGENTOC_ACCOUNTS_ASR_ENABLED` remains off. No request is currently forwarded by Ragent Accounts. The public page now names OpenAI; the API key, provider-account settings, and Play Console Data Safety owner review remain release gates.

## Published public notice wording

### Optional cloud speech recognition

Cloud speech recognition is an optional feature and is currently disabled on Ragent Accounts. If it becomes available and you choose it, the Android app sends your recording to Ragent Accounts. Accounts checks your Ragent account, consent and monthly usage limit, then forwards the recording to OpenAI's Audio Transcriptions API (`gpt-transcribe`) and returns the transcription in its original language. The transcript is added to your draft only; it is not sent as a message automatically. No request is currently forwarded to OpenAI by Ragent Accounts.

Ragent does not store the recording or transcript in its database. To support a safe retry, a transcript may remain in Ragent Accounts server memory for up to five minutes. Ragent stores account-linked usage and request information such as device ID, recording duration and size, an audio hash, request status, detected language, timing and estimated provider cost. Normal completed or failed request records are deleted after 90 days. Requests whose provider outcome cannot be confirmed are not automatically removed after 90 days and can remain until the account is deleted. Monthly usage totals remain until account deletion. A minimal record of consent (account and device identifiers, disclosure version, action and time) is kept for up to five years, including after account deletion.

OpenAI states that data sent to its API is not used to train or improve its models unless the API customer explicitly opts in. OpenAI's API data controls and the applicable API account/project settings and terms govern provider processing. See [OpenAI's API data controls](https://developers.openai.com/api/docs/guides/your-data) and [OpenAI's Services Agreement](https://openai.com/policies/services-agreement/).

Cloud recognition is separate from phone and computer recognition. You can decline or revoke cloud consent and continue using the local routes; audio from those local routes is not sent to Ragent Accounts or OpenAI.

## User-facing prominent disclosure

Before the first cloud recording, show a localized notice explaining that the recording leaves the phone and is sent through Ragent Accounts to OpenAI for transcription; that OpenAI states API data is not used to train or improve its models unless the API customer opts in; that Ragent keeps account-linked usage/request metadata for 90 days (uncertain provider outcomes may remain until account deletion) and minimal consent evidence for up to five years; and that the recording is processed under OpenAI's API data controls and applicable terms. Provide separate Allow and continue and Not now choices. Do not start the microphone or upload audio until the user accepts and Accounts confirms that the current disclosure version is recorded. The v3 copy is localized across all seven supported locales; run the physical-device localization test before the release.

## Provider sources checked

- [OpenAI file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) — completed WAV transcription via `/v1/audio/transcriptions` and `gpt-transcribe`.
- [OpenAI GPT-Transcribe model page](https://developers.openai.com/api/docs/models/gpt-transcribe) — current model description and price.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) — model-training statement, endpoint retention table and project controls.

# ASR privacy disclosure and publication record

**Previous notice:** <https://support.agentoncloud.com/privacy/> was updated on 2026-11-10 with ElevenLabs-specific wording. Its static release was `ragent-asr-privacy-20261110-7b9da59`; the page SHA-256 was `35e6906236025c84e1ab0c2d45f8f858ea5aa200e82fd8ee764a12bf6f3e1c19`.

**Current published notice:** Updated in static release `ragent-asr-cloud-only-20261111-02e91c66`; the source page SHA-256 is `02e91c66698a167bf5d31816a7ac36faeeed8aa7ac3ab3190c39bd60a2afffe2`. The content-only deployment corrected the cloud availability and local-route statements; Caddy was not changed or reloaded. The prior release and deployment receipt remain available for rollback.

**Current provider:** OpenAI Transcription API (`gpt-transcribe`). The central readiness check reports speech recognition ready. Provider-account settings and Play Console Data Safety declarations must still be reviewed against the actual service configuration and distributed app versions.

## Published public notice wording

### Optional cloud speech recognition

Cloud speech recognition is optional. If you choose to use it, the Android app sends your recording to Ragent Accounts. Accounts checks your Ragent account, consent and monthly usage limit, then forwards the recording to OpenAI's Audio Transcriptions API (`gpt-transcribe`) to transcribe it in its spoken language. The transcript is added to your draft only; it is not sent as a message automatically.

Ragent does not store the recording or transcript in its database. To support a safe retry, a transcript may remain in Ragent Accounts server memory for up to five minutes. Ragent stores account-linked usage and request information such as device ID, recording duration and size, an audio hash, request status, detected language, timing and estimated provider cost. Normal completed or failed request records are deleted after 90 days. Requests whose provider outcome cannot be confirmed are not automatically removed after 90 days and can remain until the account is deleted. Monthly usage totals remain until account deletion. A minimal record of consent (account and device identifiers, disclosure version, action and time) is kept for up to five years, including after account deletion.

OpenAI states that data sent to its API is not used to train or improve its models unless the API customer explicitly opts in. OpenAI's API data controls and the applicable API account/project settings and terms govern provider processing. See [OpenAI's API data controls](https://developers.openai.com/api/docs/guides/your-data) and [OpenAI's Services Agreement](https://openai.com/policies/services-agreement/).

You can decline or revoke consent at any time. Cloud speech recognition is unavailable without your consent; other Ragent features remain available.

## User-facing prominent disclosure

Before the first cloud recording, show a localized notice explaining that the recording leaves the phone and is sent through Ragent Accounts to OpenAI for transcription; that OpenAI states API data is not used to train or improve its models unless the API customer opts in; that Ragent keeps account-linked usage/request metadata for 90 days (uncertain provider outcomes may remain until account deletion) and minimal consent evidence for up to five years; and that the recording is processed under OpenAI's API data controls and applicable terms. Provide separate Allow and continue and Not now choices. Do not start the microphone or upload audio until the user accepts and Accounts confirms that the current disclosure version is recorded. The v3 copy is localized across all seven supported locales; run the physical-device localization test before the release.

## Provider sources checked

- [OpenAI file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) — completed WAV transcription via `/v1/audio/transcriptions` and `gpt-transcribe`.
- [OpenAI GPT-Transcribe model page](https://developers.openai.com/api/docs/models/gpt-transcribe) — current model description and price.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) — model-training statement, endpoint retention table and project controls.

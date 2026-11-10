# ASR privacy disclosure and publication record

**Public notice:** published at <https://support.agentoncloud.com/privacy/> on 2026-11-10. The static release is `ragent-asr-privacy-20261110-7b9da59`; the published page SHA-256 is `35e6906236025c84e1ab0c2d45f8f858ea5aa200e82fd8ee764a12bf6f3e1c19`.

The central ElevenLabs key is still absent and `AGENTOC_ACCOUNTS_ASR_ENABLED` remains off at the owner's direction. No request is currently forwarded by Ragent Accounts. Before activation, verify the provider account's actual terms and retention settings, complete the Google Play Data Safety review, and run a signed-in Android provider transcription.

## Published public notice wording

### Optional cloud speech recognition

Cloud speech recognition is an optional feature and is currently disabled on Ragent Accounts. If it becomes available and you choose it, the Android app sends your recording to Ragent Accounts, which checks your Ragent account, consent and monthly usage limit, then forwards it to ElevenLabs Scribe v2 to return text and detect its language. The transcript is added to your draft only; it is not sent as a message automatically. No request is currently forwarded to ElevenLabs by Ragent Accounts.

Ragent does not store the recording or transcript in its database. To support a safe retry, a transcript may remain in Ragent Accounts server memory for up to five minutes. Ragent stores account-linked usage and request information such as device ID, recording duration and size, an audio hash, request status, detected language, timing and estimated provider cost. Normal completed or failed request records are deleted after 90 days. Requests whose provider outcome cannot be confirmed are not automatically removed after 90 days and can remain until the account is deleted. Monthly usage totals remain until account deletion. A minimal record of consent (account and device identifiers, disclosure version, action and time) is kept for up to five years, including after account deletion.

Ragent sends provider requests with logging enabled; it does not request zero-retention processing. ElevenLabs published terms and privacy notice say submitted input and output may be used to improve its services and develop AI models. Its account settings describe an opt-out from future training use; the applicable region, contract and account settings determine the actual handling. Read the [ElevenLabs Terms of Service](https://elevenlabs.io/terms-of-use) and [Privacy Policy](https://elevenlabs.io/privacy-policy) for details.

Cloud recognition is separate from phone and computer recognition. You can decline or revoke cloud consent and continue using the local routes; audio from those local routes is not sent to Ragent Accounts or ElevenLabs.

## User-facing prominent disclosure

Before the first cloud recording, show a localized notice explaining that the recording leaves the phone, is sent through Ragent Accounts to ElevenLabs for transcription and language detection, that Ragent keeps account-linked usage/request metadata for 90 days (uncertain provider outcomes may remain until account deletion) and minimal consent evidence for up to five years, and that ElevenLabs may retain the content or use it to improve services under the applicable provider terms/settings. Provide separate Allow and continue and Not now choices. Do not start the microphone or upload audio until the user accepts and Accounts confirms that the current disclosure version is recorded. The v2 copy was reviewed on the connected Android device across all seven supported locales.

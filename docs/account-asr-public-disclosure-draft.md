# Draft privacy-policy text: optional cloud speech recognition

This is a proposed public-policy addition, not a published policy change. Confirm it against the final ElevenLabs account terms, data-processing agreement, configured logging/retention, and applicable legal requirements before publication.

## Optional cloud speech recognition

If you choose cloud speech recognition, the Ragent app records the audio you request on your device and sends that recording to Ragent Accounts. Ragent Accounts authenticates your Ragent account, applies account-level usage limits, and forwards the audio to ElevenLabs to produce a transcript and detect its language. The transcript is returned to the app and inserted only into your message draft; it is not sent automatically.

Ragent does not store the recording or transcript in its database. To support retries, the transcript may be held briefly in Ragent Accounts server memory, for up to five minutes. Ragent stores account-linked usage and request metadata, including the device, audio duration, request outcome, timing, detected language, and a hash of the submitted audio, for service operation and usage accounting. Successful and failed request metadata is normally deleted after 90 days; unresolved provider outcomes remain until reconciled or the account is deleted. Monthly usage totals remain until account deletion. The audio and transcript are processed by ElevenLabs under the terms and data-retention settings applicable to the configured provider account. Those settings must be confirmed before Ragent enables this feature.

When you accept the cloud-recognition disclosure, Ragent retains a minimal record of that choice—your random Ragent account and device identifiers, the disclosure version, whether you accepted or revoked it, and the event time—for up to five years. This record may remain after account deletion to document the consent history. It does not contain the recording or transcript.

Cloud speech recognition is optional. You may decline or revoke consent in the app. Declining or revoking prevents future cloud transcription requests; it does not affect Android's on-device speech recognition or a paired computer's local Whisper service. You may continue to use the app without cloud speech recognition.

## User-facing prominent disclosure

Before the first cloud recording, show a localized notice explaining that the recording leaves the phone, is sent through Ragent Accounts to ElevenLabs for transcription and language detection, may be retained by ElevenLabs under the provider account's terms/settings, and that Ragent retains only minimal consent evidence for up to five years. Provide separate Allow and continue and Not now choices. Do not start the microphone or upload audio until the user accepts and Accounts confirms that the current disclosure version is recorded.

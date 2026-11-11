# Cloud speech recognition

Ragent Android uses the central Accounts speech service for voice input. The app records audio only after the account holder accepts the current disclosure. Accounts checks the account and available quota, forwards the recording to OpenAI Transcription, and returns text to the draft. Sending the message is a separate action. Speech language is detected automatically and is independent of the phone's display language.

The voice settings page shows cloud availability and remaining allowance, and lets the user grant or revoke consent. If the account is signed out, consent is absent, the quota is exhausted, or the service is unavailable, speech recognition cannot proceed; the app does not silently switch to another provider. Other chat functions remain available.

Windows Ragent does not install, start, manage, or use Whisper in the current version. Android does not offer phone-local or paired-computer speech recognition, language selection, or a recognition-device picker. Older clients calling retired local-voice endpoints receive a retirement response and must be updated.

On Windows upgrades, only recognized, unmodified files from the previously bundled Whisper release are retired transactionally; rollback restores them. Modified, unrecognized, or externally located files are preserved. Keep the old installer release available until a normal upgrade and rollback have been verified for the target environment.

For the account API, data handling, consent, and retention details, see [the ASR privacy addendum](account-asr-consent-and-privacy.md) and [the operations guide](account-asr-operations.md). The earlier [Android routing plan](android-voice-routing-plan.md) is retained as historical context and is superseded by this cloud-only behavior.
# Central Accounts service

The Accounts API is released independently from the Windows/local-control-plane package. Build the versioned archive with `scripts/build-accounts-release.sh`; the archive contains the Accounts runtime payload, its pinned Node runtime, this systemd unit, and release metadata.

The production unit runs as `agentoc-accounts`, reads `/etc/agentoc/accounts.env`, and serves the app from `/opt/agentoc-accounts/current`. Keep releases immutable under `/opt/agentoc-accounts/releases`, switch `current` atomically, and keep the previous release available for rollback. Do not install the central service under `/opt/agentoc`.

Apply database migrations using the account service environment file before enabling a release that uses them:

```sh
set -a
. /etc/agentoc/accounts.env
set +a
cd /opt/agentoc-accounts/current/app
/opt/agentoc-accounts/current/runtime/node scripts/accounts-migrate.mjs
```

The migration runner uses `AGENTOC_ACCOUNTS_DATABASE_URL`; keep that value in the protected environment file and never print it in command output or logs. After switching the release, verify `/healthz`, `/readyz`, and the account routes through the configured HTTPS base URL.

## Optional cloud speech recognition

Cloud speech recognition is disabled unless both of these protected settings are present:

```ini
AGENTOC_ACCOUNTS_ASR_ENABLED=0
OPENAI_API_KEY=
```

Add the OpenAI API key only to `/etc/agentoc/accounts.env`, set `AGENTOC_ACCOUNTS_ASR_ENABLED=1` after migration 042 has been applied and privacy/store disclosures reviewed, then restart the service. Never put the provider key in Windows/Android packages, source control, command arguments, or logs. Accounts calls `POST https://api.openai.com/v1/audio/transcriptions` with model `gpt-transcribe` and no language hint, so spoken language is detected automatically. OpenAI states API data is not used to train or improve models unless the API customer explicitly opts in; review the [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) and the actual API organization/project settings before enabling traffic.

The Android client sends a raw `audio/wav` body to the authenticated Accounts endpoint. The accepted recording is mono PCM16 at 16 kHz, 0.5–20 seconds, and at most 1 MiB. Android allows up to 60 seconds for the complete call and the provider timeout is 30 seconds; confirm the HTTPS reverse proxy accepts at least 1 MiB request bodies and allows a 60-second upstream request before enabling the client route. The usage endpoint remains available after migration even while ASR is disabled or the provider key is absent; it reports `available=false` in that state.

Monthly included speech minutes can be adjusted without a source change:

```ini
AGENTOC_ACCOUNTS_ASR_FREE_MINUTES=15
AGENTOC_ACCOUNTS_ASR_PLUS_MINUTES=120
AGENTOC_ACCOUNTS_ASR_PRO_MINUTES=600
```

The service records duration, request state, provider/model/price/policy versions, latency, and estimated provider cost in PostgreSQL. The customer usage endpoint returns minutes and request count, not Ragent's provider cost. The service does not persist audio or transcripts. A transcription result is cached in process memory for up to five minutes only to serve an idempotent retry; after a process restart the same request will not be sent to the provider again. Abandoned reservations are released after two minutes. Processing requests with uncertain outcomes are marked `unknown` after two minutes; their quota reservation remains until an operator can confirm the provider outcome. Use [the ASR reconciliation runbook](../../docs/account-asr-operations.md); never retry an unknown request or clear it with ad hoc SQL. Completed request and reconciliation metadata is pruned after 90 days; monthly aggregates remain until account deletion. For a confirmed processed call whose transcript was lost, reconciliation releases customer minutes and records a versioned internal provider-cost estimate.

The current plan caps (Free 15 min, Plus 120 min, Pro 600 min) are usage limits, not customer billing amounts. Provider cost is an estimate for operations and must be reconciled with the vendor invoice; set provider-side spend alerts/limits where available and keep the Accounts feature flag as the emergency off switch. The in-app disclosure names Ragent Accounts and OpenAI and points out the API data-use statement. Review the actual API account controls and update the product privacy notice and Google Play Data Safety declarations before enabling this for users.

The ASR migration is additive. Roll back application code by switching `current` to the prior immutable release; leave the ASR tables in place unless a separately reviewed data-retention operation explicitly removes them.

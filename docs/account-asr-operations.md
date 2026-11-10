# Central Accounts ASR operations

## Resolving an uncertain provider outcome

An ASR request can become `unknown` when Accounts cannot tell whether ElevenLabs accepted or completed a synchronous transcription. The user is not charged ASR minutes while the outcome is unknown; the reserved minutes remain unavailable until the request is safely reconciled. The request is never sent again under the same idempotency key.

The current synchronous ElevenLabs adapter does not receive a transcription ID when its HTTP request times out. It does not send a Ragent request ID to ElevenLabs either. The [synchronous API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) documents a direct transcript response; the [webhook flow](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/webhooks) separately provides a provider request ID and metadata for correlation. Therefore timestamps or audio digests alone are not enough to clear a synchronous request. If the provider request log cannot identify one matching call with a definitive outcome, leave the row `unknown` and keep the reservation. Do not infer that it was unprocessed from the absence of a transcript in Ragent.

Run the tool from a secured Oracle administrator shell that can read the root-only environment file. The PostgreSQL URL uses the restricted Accounts database role; before starting the tool, remove every other setting from the shell environment so the ElevenLabs key and signing configuration are not inherited by the CLI. The command reads `AGENTOC_ACCOUNTS_DATABASE_URL` from the environment and never accepts a database URL on the command line:

```sh
set -a
. /etc/agentoc/accounts.env
set +a
asr_db_url=$AGENTOC_ACCOUNTS_DATABASE_URL
for asr_env_name in $(compgen -e); do
  case "$asr_env_name" in PATH|HOME|LANG|LC_*) ;; *) unset "$asr_env_name" ;; esac
done
export AGENTOC_ACCOUNTS_DATABASE_URL="$asr_db_url"
unset asr_db_url
cd /opt/agentoc-accounts/current/app
/opt/agentoc-accounts/current/runtime/node accounts/asr-reconcile.mjs list --limit 100
unset AGENTOC_ACCOUNTS_DATABASE_URL
```

The output includes account/request IDs, duration, provider/model, price version, state, error code, and timestamps. It excludes the audio digest, audio, transcript, provider key, and account credential. Restrict the terminal and any retained output to authorized Accounts operators.

For one request, first preview a proposed outcome:

```sh
/opt/agentoc-accounts/current/runtime/node accounts/asr-reconcile.mjs preview \
  --account-id ACCOUNT_ID --request-id REQUEST_ID \
  --outcome provider_not_processed
```

Allowed outcomes:

- `provider_not_processed`: use only when the provider request log or provider support confirms that this exact request was rejected before processing and did not incur a provider charge. Accounts releases the reserved user minutes and records no provider cost.
- `provider_processed_result_lost`: use when the provider confirms processing/charge but the transcript never reached the user. Accounts releases the reserved user minutes because no draft result was delivered. It records the versioned internal cost estimate in the provider-cost aggregate, not as customer usage. This outcome does not preserve or reconstruct a transcript.

If the evidence does not distinguish these outcomes, stop at the preview and leave the request unresolved. After review, use a ticket or provider-log reference, an operator ID, and a short reason. `resolve` stays read-only unless `--apply` is present:

```sh
/opt/agentoc-accounts/current/runtime/node accounts/asr-reconcile.mjs resolve \
  --account-id ACCOUNT_ID --request-id REQUEST_ID \
  --outcome provider_not_processed \
  --operator-id OPERATOR_ID --evidence-ref SUPPORT_OR_PROVIDER_REFERENCE \
  --reason 'Provider request log confirms rejection before processing' \
  --apply
```

The write locks the account-period usage row before the request row, checks the exact reservation and state again, then atomically marks the request failed, releases reserved minutes, adjusts the internal provider-cost estimate when applicable, and writes a one-time reconciliation record. Repeating the command does not release quota twice. The operator/evidence/reason record contains no audio or transcript and follows the request's 90-day terminal-metadata retention; account deletion cascades it with the request.

After a successful resolution, verify the user's reserved/remaining minutes through the normal account usage view and confirm the reconciliation record is present. Never edit ASR tables manually or enable cloud ASR as part of reconciliation. Keep `AGENTOC_ACCOUNTS_ASR_ENABLED=0` and the provider key absent until the separate provider-account and store-review gates are complete.

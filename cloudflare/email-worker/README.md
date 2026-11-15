# Ragent Cloudflare Email Worker

Minimal Cloudflare edge for a mailbox such as `agent@example.com`.

This directory contains a Worker implementation and an example configuration.
The example uses placeholder addresses and URLs. Configure your own Cloudflare
account, verified sender domain, mailbox bridge and secrets before deployment.
The `deploy.sh` script performs an actual deployment and uploads secrets; do not
use production credentials for a local source-code check.

Flow:

`Internet -> Cloudflare Email Routing -> Email Worker(email) -> local mailbox bridge -> local agent-mail-worker -> Ragent -> completion target -> Email Worker(fetch) -> Cloudflare send_email`

## Design goal

- Keep Cloudflare thin: inbound forwarding + outbound send only
- Keep business logic local: allowlist, review, automation, session creation, reply generation
- Avoid SMTP setup and provider-specific workflow lock-in

## Runtime responsibilities

1. receive inbound mail from Cloudflare Email Routing
2. forward the raw message to the local mailbox bridge webhook
3. accept authenticated `POST /api/send-email` requests from Ragent completion targets
4. send replies through Cloudflare `send_email`
5. allow the primary mailbox sender and same-domain instance aliases such as `trial1@example.com`

## Required config

Configured in `wrangler.example.jsonc` and then copied locally to `wrangler.jsonc`:

- unrestricted `send_email` binding such as `{ "name": "EMAIL" }`
- `MAILBOX_FROM`
- `MAILBOX_BRIDGE_URL`

Do not set `destination_address` or `allowed_destination_addresses` unless you intentionally want to restrict outbound recipients further. An unrestricted binding allows sending to any Email Routing destination address verified on this Cloudflare account; it does not bypass Cloudflare's verified-destination requirement.

If Ragent also needs to reach arbitrary external recipients, configure a local outbound provider in `~/.config/ragent/agent-mailbox/outbound.json` such as `resend_api` for a custom-domain sender or `apple_mail` for local fallback testing; Cloudflare's platform-level verified-destination rule itself cannot be disabled.

See [Cloudflare's send binding documentation](https://developers.cloudflare.com/email-service/configuration/send-bindings/) for current restrictions and prerequisites.

Configured as secrets during deploy:

- `OUTBOUND_API_TOKEN`
- `MAILBOX_BRIDGE_TOKEN`

## Deploy

```bash
cd cloudflare/email-worker
cp wrangler.example.jsonc wrangler.jsonc
./deploy.sh
```

The deploy script reads the local mailbox config, uploads the needed secrets, and deploys the Worker with Wrangler.

## Endpoints

- `GET /healthz` — lightweight health check
- `POST /api/send-email` — authenticated outbound sender used by Ragent completion targets

# Ragent admin console

Owner-only operational console for the central Oracle services. The UI is built from the MIT-licensed Tabler CSS template and served locally by the Node service; it does not load assets from a third-party CDN.

## Access boundary

- Cloudflare Access protects `ops.agentoncloud.com` with a single-email allow policy and independent TOTP MFA.
- The application independently verifies the signed Cloudflare Access JWT, issuer, audience, expiry, and exact owner email. An origin request without a valid signed JWT is denied.
- The web process runs as `agentoc-admin`, listens only on loopback, cannot write service configuration, and has read-only access to backup files.
- A separate root helper accepts only a fixed allowlist over a Unix socket and checks the connecting process UID. It can write four specific credential types, update the Accounts ASR flag, rotate the Accounts database application password, inspect fixed read-only SQL summaries, apply the packaged Accounts migrations, create/download/restore PostgreSQL backups, and restart a fixed set of services. It cannot run arbitrary shell commands or SQL.
- Passwords and provider keys are never returned by API responses or written to logs. Configuration files remain root-only or service-user-only as required by the services. Audit entries contain actor, action, target, and outcome only.

## Managed settings and services

- Accounts API health, account totals, ASR request totals, TURN lease counts, and FCM queue counts.
- OpenAI Transcription API key and cloud ASR enable/disable. Enabling requires the applied OpenAI consent migration and an explicit in-page acknowledgement of provider data controls/privacy disclosure.
- Active FCM service account JSON.
- Cloudflare TURN shared secret and TURN broker token.
- Accounts database application-role password rotation, schema/migration status, approximate table sizes, PostgreSQL backups, and confirmed restore with an automatic safety backup.
- Restart for Accounts, TURN broker, signaling, and tunnel services.

Database views use aggregate queries and PostgreSQL row estimates; they do not expose account emails, device identifiers, audio, transcripts, raw database rows, or arbitrary SQL execution. Backup files are protected by Unix file permissions and the owner-only access boundary; backups are not encrypted at rest by this release.

## Install layout

Install an immutable release under `/opt/agentoc-admin/releases/<release-id>` and atomically point `/opt/agentoc-admin/current` at it. The release must contain:

```text
helper.py
server.mjs
public/index.html
public/admin.css
public/admin.js
public/tabler.min.css
public/tabler.LICENSE
```

Create the system group and user `agentoc-admin`, then create the directories:

```text
/var/lib/agentoc-admin             root:agentoc-admin 0750
/var/lib/agentoc-admin/backups    root:agentoc-admin 0750
/var/log/agentoc-admin            root:root 0700
```

Install the two systemd units into `/etc/systemd/system/`. `/etc/agentoc/admin-console.env` contains only the owner email, Cloudflare Access auth domain, and application audience ID; it is not a provider-secret file. Set it to mode `0644`, enable both services, and verify that `agentoc-admin-console` listens only on `127.0.0.1:7722`.

The Accounts PostgreSQL container must be named `agentoc-pg`, database `agentoc_accounts_runtime`, and expose the local superuser role `agentoc_accounts` only over the container's internal Unix socket. Those names are fixed in the helper and are never received from the browser.

## Cloudflare and Caddy

Create a proxied A record `ops.agentoncloud.com` to the Oracle origin. Create a separate self-hosted Access app for that exact hostname, allow only `iamandyusuk@gmail.com`, restrict the app to the One-time PIN identity provider, use a short session, and require TOTP independent MFA for every Access session. Copy the app audience identifier and organization's auth domain to `/etc/agentoc/admin-console.env`.

Add only this host route to Caddy after installing and starting the console:

```caddyfile
ops.agentoncloud.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7722
}
```

Validate Caddy before reload. Test both Cloudflare Access redirection without credentials and a direct-origin request without a signed Access JWT; both must be denied. A valid owner session must pass the page and `/api/overview` checks.

## Rollback

Stop and disable the console units, remove only its `ops.agentoncloud.com` Access app and DNS record if desired, and remove its dedicated Caddy host block. Existing Accounts, TURN, FCM, and database services/configuration are separate and must remain untouched. Keep the Accounts database snapshots until the owner has verified the console.

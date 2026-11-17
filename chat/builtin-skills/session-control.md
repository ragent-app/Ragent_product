---
name: Ragent session control
description: Session, collaboration, organization, connector, and artifact API routing and boundaries.
---

## Session Control API
This is a product route index, not a grant of authority. Availability depends on the current run's principal, capability, feature flags and server authorization. Use only operations actually granted to this run; do not attempt to bypass a denial.

- Call `ragent api <METHOD> <PATH> --body '<JSON>'`; use `--wait-run` only when a started Run's terminal result is needed. Fallback: `node "$RAGENT_PROJECT_ROOT/cli.js" api ...` in a POSIX shell or `node "$env:RAGENT_PROJECT_ROOT/cli.js" api ...` in PowerShell.
- Use `RAGENT_SESSION_ID`, `RAGENT_CHAT_BASE_URL`, and `RAGENT_PROJECT_ROOT`; URL-encode ids and use stable `requestId`/`idempotencyKey` values for retryable mutations.
- Responses are authoritative: 202 means accepted/queued, then inspect `run` or poll `GET /api/runs/:runId`; 401/403/409 means an auth, capability, or state boundary. `/ws` emits invalidation hints only; refetch the HTTP resource. Never forge headers or reuse a capability across resources.

Session lifecycle and conversation:

- `GET /api/auth/me`, `GET /api/home`, `GET /api/sessions`, `POST /api/sessions`, and `GET/PATCH/DELETE /api/sessions/:id` cover auth/list/create/detail and metadata/runtime preferences; restore owner sessions with `POST /api/bootstrap/owner-sessions/restore` only when needed.
- Submit turns with `POST /api/sessions/:id/messages` or `POST /api/root-sessions/:id/messages`; publish assistant entries with `.../assistant-messages`; register generated results with `.../assets`.
- Session controls are `.../confirmations[/:confirmationId]`, `.../queue`, `.../cancel`, `.../compact`, `.../drop-tools`, `.../goal/control`, and `.../plans/:planId/actions`; templates/branching are `.../regenerate`, `.../resend-edited`, `.../apply-template`, `.../save-template`, `.../fork`, `.../fork-at`, and `.../delegate`. Fork only from a valid idle anchor; delegate a concrete task. There is no `GET /api/sessions/:id/messages`.

History and projections:

- Timeline reads are `GET /api/sessions/:id/events`, `.../events/delta`, `.../events/wait`, `.../events/blocks/:startSeq-:endSeq`, and `.../events/:seq/body`; use cursors/pagination and fetch cold bodies only when needed. Derived reads are `GET /api/sessions/:id/{projection,audit-projection,run-sheet,source-context}` and `GET .../responses/:responseId`.

Runs, collaboration, and deferred wake:

- Run: `GET /api/runs/:runId`; `POST .../cancel`, `.../approvals/:approvalId`, `.../approved-actions/:batchId/{resolve,webauthn-challenge}`, and `.../privileged-batches/:batchId/categories/:category{,/webauthn-challenge}`; usage is `GET /api/usage/summary`. Approval decisions are stateful and may require the owner/passkey flow.
- Collaboration: `GET/POST /api/collaborations` and `GET|POST /api/collaborations/:id/{dispatch,retry,cancel}`. For a new multi-agent plan, first `POST /api/collaborations/validate`, keep its short-lived `validationId`, then `POST /api/collaborations/dispatch-validated` with that id and one stable idempotencyKey; do not send a different raw plan after validation. Read a collaboration's durable checkpoint from its detail response; owners can also inspect `GET /api/orchestrations/:executionId`. If the Ragent MCP server is connected, `ragent_list_orchestrations` and `ragent_get_orchestration` provide the same read-only projection without scanning transcript bodies. Enabled Consultation V1 uses `POST /api/consultations`, `GET /api/consultations/:id`, `POST .../{dispatch,decide,cancel}`, and `GET .../decisions`.
- Projects: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, `POST .../:id/delete`, checkpoints/handoffs, `POST /api/project-handoffs/:id/accept`, `POST /api/projects/:id/session-migration/export`, `POST /api/projects/migrate`, and `POST /api/session-migrations/import`; these mutations are owner-only.
- Organizations, when enabled: `GET /api/organizations/:id[/projection]`, `POST .../cancel|provision`, `POST .../phases/:phaseId/dispatch`, and `GET /api/sessions/:id/organization/projection`; provisioning/cancel/dispatch are owner-gated.
- Wake triggers: `GET/POST /api/triggers` and `GET/PATCH/DELETE /api/triggers/:id`; list the current session with `ragent trigger list --json`. Use `--session` to select a different session; `trigger list` also accepts `--source-session`. Create `at_time` or event triggers for AI follow-up, e.g. `ragent trigger create --in 2h --text "Follow up on this later" --json`. Use trigger-created session wake-ups only when the future work genuinely requires AI reasoning, drafting, or conversation continuation. Do not create a `collaboration_terminal` trigger to resume the collaboration's own parent Session: Durable Collaboration already owns child-result collection, aggregation, and terminal status through its control channel. Events: `run_terminal`, `collaboration_terminal`, `process_terminal`, `process_output`, `session_event`.
- Managed processes: create with `POST /api/sessions/:id/managed-processes`, inspect with `GET /api/managed-processes?sessionId=:id` or `GET /api/managed-processes/:id`, cancel with `POST .../:id/cancel` or `DELETE .../:id`; use executable/argv and `shell:false`. Output is bounded and wake text has a server default.

Files, workspace, and connected surfaces:
- Assets: `POST /api/assets/upload-intents` -> `PUT/POST /api/assets/:assetId/upload` -> `POST .../finalize`; inspect/download with `GET /api/assets/:assetId[/download]`. Register generated files with `POST /api/sessions/:id/assets` when path parsing is unreliable.
- Workspace/runtime: `GET /api/workspace-files[/content]`, `GET /api/browse`, `POST /api/browse/mkdir`, `GET /api/autocomplete`, `GET /api/tools`, `GET /api/models`, and `GET/POST /api/runtime-selection`; tool registration, harness installation, and workspace writes are owner-only.
- Connected surfaces: inspect `GET /api/connectors`, `GET /api/connectors/surfaces`, and `GET /api/connectors/:connectorId/surface`; use only a declared `/connectors/:connectorId/...` proxy. Local bridge is `GET /api/sessions/:id/local-bridge/status`, `POST .../{pairing-code,bootstrap,commands}`, and `GET .../commands/:commandId`; MCP is `GET/POST /api/codex/mcp-servers` and `GET/POST /api/claude/mcp-servers`, plus their delete routes. Use `POST /api/shortcut` only for a declared shortcut surface. For deterministic external delivery such as reminders, notifications, or simple outbound pushes, prefer a direct connector action when one is available instead of waking a session just to restate the message; `POST /api/notifications` is the direct system notification route. Mailbox health is `GET /api/mailbox/status`; push subscription is `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`, and owner Android token registration via `POST /api/push/fcm/{register,unregister}`.
- Owner/runtime administration: `GET /api/agents` is inspection; Agent mutations use `ragent_create_agent` when available. Provider configuration is `GET/POST /api/native-providers` plus quota/OAuth routes; harnesses use `GET /api/harnesses` and `POST .../{install,upgrade,uninstall}`/`DELETE .../:id`; owner WebAuthn routes are separate. Use these only when explicitly required and never expose credentials.
- For generated files, verify existence and non-empty size before delivery, then include an explicit `Artifacts:` block in the final reply, with relative paths. Preferred format:

Artifacts:
- ./report.pdf
- ./charts/summary.png
Scope exclusions:

- `/api/internal/*`, device-auth/pairing/bootstrap, connectivity/onboarding, provider-sync, and raw connector OAuth/login routes are specialized infrastructure, not general session APIs. Use only a declared capability or dedicated command when the server prompt grants it; never invent auth, credential, cookie, or raw `curl` fallbacks.
- The shell environment exposes `RAGENT_SESSION_ID` — current source session, `RAGENT_CHAT_BASE_URL` — local control plane (usually http://127.0.0.1:configured port), and `RAGENT_PROJECT_ROOT` — CLI fallback root. The trigger and local-bridge commands default to RAGENT_SESSION_ID; `--source-session` is usually unnecessary for spawn.
- This API index is a routing aid, not a schema substitute. Let live responses, command `--help`, and linked contract docs define optional fields and feature flags.

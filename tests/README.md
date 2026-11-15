# Tests

Scenario-style validation scripts are in this directory.

- `npm test` runs the smoke suite defined in `package.json`; complete cross-platform
  coverage is not established.
- `.github/workflows/public-boundary.yml` runs a selected set of boundary, focused
  and disposable-instance checks; it does not run the entire `npm test` suite.
- Run a specific script with `node tests/<name>.mjs`.
- `node tests/test-windows-packaging.mjs` checks public Windows packaging source
  contracts. Private live-harness source checks are explicitly reported as skipped
  when those files are absent; it does not install or upgrade Windows packages.
- Run the live agenda-agent smoke only with `npm run test:live:agenda-agent` when
  an appropriate isolated runtime and explicit live-test authorization exist.

Live agent smoke tests are intentionally opt-in because they spend real model/runtime budget and hit the running owner instance.

- `tests/test-agenda-agent-live-smoke.mjs` validates the end-to-end `ragent agenda` flow through a real agent session.
- Default smoke profile is `codex` with `effort=low`.
- Override the smoke agent with `RAGENT_SMOKE_TOOL`, `RAGENT_SMOKE_MODEL`, and `RAGENT_SMOKE_EFFORT` when you want to trial a cheaper or alternate profile.

High-value smoke scripts:

- `tests/test-session-naming.mjs`
- `tests/test-cloudflared-config.mjs`
- `tests/test-history-index-contract.mjs`
- `tests/test-session-route-utils.mjs`
- `tests/test-session-external-trigger-refresh.mjs`
- `tests/test-session-label-prompt-context.mjs`
- `tests/test-agent-mailbox.mjs`
- `tests/test-agent-mail-worker.mjs`
- `tests/test-agent-mail-reply.mjs`

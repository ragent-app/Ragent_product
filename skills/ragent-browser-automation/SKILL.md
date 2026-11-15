# Ragent Browser Automation

Use the `ragent-browser` MCP server for browser work. The Skill is guidance;
the MCP server owns the browser context and Ragent owns the run, approval,
artifact, and recovery boundaries.

## Operating rules

- Start by using `ragent_browser_navigate` with an explicit `http` or `https`
  URL, then inspect the page with `ragent_browser_snapshot`.
- Use stable CSS selectors supplied by the page or task. Do not guess a
  destructive target from visible text when a stable selector is available.
- `click`, `fill`, `press`, `select_option`, and `download` always require the
  owner to approve the exact run-scoped action. Never work around a denied or
  expired confirmation.
- Treat login, MFA, CAPTCHA, payment, delete, submit, send, publish, export,
  and account-setting controls as high consequence actions. Explain the
  intended effect in the task response and wait for the Ragent confirmation.
- Never put passwords, cookies, tokens, page source, or hidden form values in a
  request description, event, log, or result summary. A filled value is sent
  only to the browser page after approval and is omitted from approval text.
- Prefer a screenshot for visual evidence and a download artifact for exported
  files. Return the artifact identity, path, size, and digest from the MCP
  result so Ragent can publish it through the normal Run result flow.
- After navigation, a download, or a failed action, take a fresh snapshot and
  verify the page state before retrying. Retrying an approved action requires
  the same exact selector and operation; a changed target requires a new
  confirmation.
- If the Run is cancelled, stop browser work. A later Run must use the durable
  session profile and re-check the current page before continuing.

## Recovery contract

The browser profile is bound to the Ragent Session, while the token is bound to
the current Run and turn. A resumed Run can reuse browser state only after the
server bootstrap creates a new valid binding. The browser MCP must fail closed
when the binding is missing, stale, or mismatched.

The MCP does not execute shell commands and does not decide approvals. Owner
confirmation is persisted in the Session event stream and is polled by the
run-scoped MCP before the browser action is performed.

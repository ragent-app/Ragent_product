# Approval context review

For eligible operations whose semantics remain uncertain after deterministic
checks, the runner requests an advisory review from the control plane. The
control plane uses the run's frozen provider profile and model. These calls
consume the same provider quota and incur the provider's normal charges. API
key profiles using Anthropic Messages, OpenAI Responses, or OpenAI Chat are
supported; OAuth and setup-token profiles currently return `unknown`.

The control plane keeps provider credentials out of the runner. The reviewer
receives the task and the exact operation, bounded to 32 KiB. Requests containing
common credential assignments or the selected provider key are not sent. This
filter is not a general secret detector. Tool descriptions are untrusted data.
Missing execution identity, target facts, integrity, additional permissions,
and deterministic hard denials cannot be supplied by a model answer.

Each review is bound to a run, turn, approval ID and request hash, with an
independent capability valid for at most 24 hours and rejected after the run
ends or is cancelled. The provider timeout defaults to 30 seconds; an operator
may set `RAGENT_APPROVAL_REVIEW_TIMEOUT_MS` to 5000–45000 milliseconds in the
control-plane environment. There is no automatic retry. The decision event
includes the review status, reason code, adapter and reported token usage.

MCP context requires a native connected server and matching tool invocation.
Codex also requires a unique matching tool schema in its native inventory.
Claude's `mcp_status` can omit schemas; in that case the connected server,
native tool name and exact `can_use_tool` input are supplied for review.
Neither tool annotations nor a server name alone authorize a call. Inventory
collection has a five-second startup bound; unavailable or ambiguous context
remains an owner decision, or is declined for unattended operation.

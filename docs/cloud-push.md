# Android notifications from computer instances

The computer's control service submits notification events to Accounts using
its existing instance identity. Accounts owns the Firebase service account;
the computer does not need that private key. The existing Accounts HTTPS
endpoint is public configuration, not a credential. Packaged Windows fixes the
endpoint in the service configuration; macOS and Linux packages supply it at
installation, and the proot launcher supplies its own endpoint.

The control service stores outgoing events in the instance configuration
directory and retries after a process restart. Approval intents refer to their
durable history event; completed runs use a run checkpoint. Events carry their
original occurrence and expiry times so a retry cannot revive an old alert.
An approval's request sequence identifies its generation while its original
approval ID remains available for navigation. If a response cannot be matched
to one unresolved request, the service logs that it could not safely identify
the notification to clear; it does not guess.
Accounts acceptance means the cloud accepted the event for processing; it is
not proof that Firebase delivered it or the phone displayed it. The former
local FCM registration file, if present, is left untouched.

The outbox requires writable instance configuration storage. A storage error is
logged without blocking approval history; notifications for an event whose
intent could not be saved are not guaranteed. The project's atomic writer
syncs the file before replacement but does not claim directory-entry durability
across sudden power loss. Android notifications also require an active account
binding, a registered phone and system notification permission.

The queue retains at most 2,048 pending events and up to 256 recent results for
seven days. A full queue or storage failure is reported, not silently treated
as delivery. The owner-only `GET /api/push/status` reports retained counts and
the latest transport or local storage result without notification content or
device credentials.

-- Preserve the exact workspace grant used when a one-use join grant is issued.
-- Replacing an access grant must never revive an older join authorization.
alter table account_join_grants add column if not exists workspace_grant_id text;
alter table account_join_grants add constraint account_join_grants_workspace_grant_id_check
  check (workspace_grant_id is null or workspace_grant_id ~ '^iag_[A-Za-z0-9_-]{16,128}$');

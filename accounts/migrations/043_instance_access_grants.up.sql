-- Independent, persistent workspace authorization. This does not replace or
-- alter the instance's sole owner binding. The target must verify both the
-- grant and the current binding before accepting a device.
create table if not exists instance_access_grants (
  grant_id text primary key,
  instance_id text not null,
  owner_account_id text not null references accounts(account_id) on delete cascade,
  account_id text not null references accounts(account_id) on delete cascade,
  binding_key_fingerprint text not null check (binding_key_fingerprint ~ '^[a-f0-9]{64}$'),
  binding_bound_at timestamptz not null,
  binding_history_fingerprint text not null check (binding_history_fingerprint ~ '^[a-f0-9]{64}$'),
  scope text not null check (scope = 'workspace'),
  created_at timestamptz not null,
  revoked_at timestamptz,
  check (owner_account_id <> account_id)
);
create unique index if not exists instance_access_grants_active_idx
  on instance_access_grants (instance_id, account_id) where revoked_at is null;
create index if not exists instance_access_grants_account_idx
  on instance_access_grants (account_id, instance_id) where revoked_at is null;

-- Existing authority revisions already serialize owner binding changes.
-- Include grants in the same final committed state so addition/revocation
-- invalidates assertions made under an earlier authorization generation.
create or replace function refresh_instance_authority_revision(target_instance text)
returns void language plpgsql set search_path from current as $$
declare
  final_binding jsonb;
  final_events jsonb;
  final_grants jsonb;
  final_state jsonb;
begin
  insert into instance_authority_revisions (instance_id, revision, authority_state)
    values (target_instance, 1, '{"version":0}'::jsonb) on conflict do nothing;
  perform 1 from instance_authority_revisions where instance_id = target_instance for update;
  select jsonb_build_object('accountId', account_id, 'keyFingerprint', instance_key_fingerprint,
    'boundAtEpoch', extract(epoch from bound_at), 'revokedAtEpoch', extract(epoch from revoked_at))
    into final_binding from instance_bindings where instance_id = target_instance;
  select jsonb_build_object('bind', count(*) filter (where action = 'bind'),
    'unbind', count(*) filter (where action = 'unbind'),
    'rollback', count(*) filter (where action = 'bind_rollback'))
    into final_events from binding_history where instance_id = target_instance;
  select coalesce(jsonb_agg(jsonb_build_object('grantId', grant_id, 'ownerAccountId', owner_account_id,
    'accountId', account_id, 'bindingKeyFingerprint', binding_key_fingerprint,
    'bindingBoundAtEpoch', extract(epoch from binding_bound_at), 'bindingHistoryFingerprint', binding_history_fingerprint,
    'scope', scope,
    'createdAtEpoch', extract(epoch from created_at), 'revokedAtEpoch', extract(epoch from revoked_at))
    order by grant_id), '[]'::jsonb) into final_grants
    from instance_access_grants where instance_id = target_instance;
  final_state := jsonb_build_object('version', 1, 'binding', final_binding, 'events', final_events);
  if jsonb_array_length(final_grants) > 0 then
    final_state := final_state || jsonb_build_object('grants', final_grants);
  end if;
  update instance_authority_revisions set
    revision = case when authority_state->>'version' = '0' then 1 else revision + 1 end,
    authority_state = final_state, updated_at = clock_timestamp()
  where instance_id = target_instance and authority_state is distinct from final_state;
end;
$$;

drop trigger if exists instance_authority_grant_changed on instance_access_grants;
create trigger instance_authority_grant_changed after insert or update or delete on instance_access_grants
  for each row execute function queue_instance_authority_revision();

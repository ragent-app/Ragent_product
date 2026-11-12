-- Refuse to discard authorization history during rollback.
do $$ begin
  if exists (select 1 from instance_access_grants) then
    raise exception 'Cannot remove persisted instance access grants';
  end if;
end $$;
drop trigger if exists instance_authority_grant_changed on instance_access_grants;
drop table if exists instance_access_grants;

create or replace function refresh_instance_authority_revision(target_instance text)
returns void language plpgsql set search_path from current as $$
declare
  final_binding jsonb;
  final_events jsonb;
  final_state jsonb;
begin
  -- Lock before taking the final-state snapshots. Even an independent SQL
  -- transaction cannot overwrite this state after waiting on an old snapshot.
  insert into instance_authority_revisions (instance_id, revision, authority_state)
    values (target_instance, 1, '{"version":0}'::jsonb)
    on conflict do nothing;
  perform 1 from instance_authority_revisions
    where instance_id = target_instance for update;
  select jsonb_build_object(
    'accountId', account_id,
    'keyFingerprint', instance_key_fingerprint,
    'boundAtEpoch', extract(epoch from bound_at),
    'revokedAtEpoch', extract(epoch from revoked_at)
  ) into final_binding from instance_bindings where instance_id = target_instance;
  select jsonb_build_object(
    'bind', count(*) filter (where action = 'bind'),
    'unbind', count(*) filter (where action = 'unbind'),
    'rollback', count(*) filter (where action = 'bind_rollback')
  ) into final_events from binding_history where instance_id = target_instance;
  final_state := jsonb_build_object('version', 1, 'binding', final_binding, 'events', final_events);
  update instance_authority_revisions set
    revision = case when authority_state->>'version' = '0' then 1 else revision + 1 end,
    authority_state = final_state,
    updated_at = clock_timestamp()
  where instance_id = target_instance and authority_state is distinct from final_state;
end;
$$;


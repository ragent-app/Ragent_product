-- An account deletion must invalidate any workspace authority immediately.
-- Existing snapshot writers may reinsert old rows, so prevent them from
-- reviving a grant after either account has acquired a durable deletion fence.
create or replace function guard_workspace_grant_deleted_account()
returns trigger language plpgsql set search_path from current as $$
declare fenced_at timestamptz; target_account text;
begin
  -- Serialize both sides with deletion-fence insertion, including concurrent
  -- direct SQL writers. Deterministic order avoids owner/member lock inversion.
  for target_account in select account_id from (values (NEW.account_id), (NEW.owner_account_id)) v(account_id) order by account_id loop
    perform pg_advisory_xact_lock(hashtextextended('ragent.workspace.account:' || target_account, 0));
  end loop;
  select min(requested_at) into fenced_at from account_deletion_fences
    where account_id in (NEW.account_id, NEW.owner_account_id);
  if fenced_at is not null and NEW.revoked_at is null then NEW.revoked_at := fenced_at; end if;
  return NEW;
end;
$$;
drop trigger if exists workspace_grant_deleted_account_guard on instance_access_grants;
create trigger workspace_grant_deleted_account_guard before insert or update on instance_access_grants
  for each row execute function guard_workspace_grant_deleted_account();

create or replace function revoke_workspace_grants_for_deleted_account()
returns trigger language plpgsql set search_path from current as $$
declare target_account text;
begin
  for target_account in
    select account_id from (select NEW.account_id as account_id union
      select account_id from instance_access_grants where account_id = NEW.account_id or owner_account_id = NEW.account_id union
      select owner_account_id from instance_access_grants where account_id = NEW.account_id or owner_account_id = NEW.account_id) affected
    order by account_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('ragent.workspace.account:' || target_account, 0));
  end loop;
  update instance_access_grants set revoked_at = NEW.requested_at
    where revoked_at is null and (account_id = NEW.account_id or owner_account_id = NEW.account_id);
  return null;
end;
$$;
drop trigger if exists workspace_grants_account_deletion on account_deletion_fences;
create trigger workspace_grants_account_deletion after insert on account_deletion_fences
  for each row execute function revoke_workspace_grants_for_deleted_account();

-- Reconcile fences that already existed before this migration.
update instance_access_grants g set revoked_at = f.requested_at
from (select g2.grant_id, min(f2.requested_at) as requested_at
  from instance_access_grants g2 join account_deletion_fences f2
    on f2.account_id in (g2.account_id, g2.owner_account_id)
  where g2.revoked_at is null group by g2.grant_id) f
where g.grant_id = f.grant_id and g.revoked_at is null;

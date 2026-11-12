do $$ begin
  if exists (select 1 from instance_access_grants) then
    raise exception 'Cannot remove workspace account deletion protection while grants remain';
  end if;
end $$;
drop trigger if exists workspace_grants_account_deletion on account_deletion_fences;
drop trigger if exists workspace_grant_deleted_account_guard on instance_access_grants;
drop function if exists revoke_workspace_grants_for_deleted_account();
drop function if exists guard_workspace_grant_deleted_account();

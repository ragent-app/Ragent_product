do $$ begin
  if exists (select 1 from account_join_grants where workspace_grant_id is not null) then
    raise exception 'Cannot remove workspace join identities while grants remain';
  end if;
end $$;
alter table account_join_grants drop constraint if exists account_join_grants_workspace_grant_id_check;
alter table account_join_grants drop column if exists workspace_grant_id;

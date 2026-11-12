do $$ begin
  if exists (select 1 from instance_access_grants) then
    raise exception 'Cannot remove instance grant replay protection';
  end if;
end $$;
drop index if exists instance_access_grants_request_idx;
alter table instance_access_grants drop column if exists request_id;

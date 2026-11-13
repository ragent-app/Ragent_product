-- Do not discard or silently downgrade an account's existing plan or leases.
do $$ begin
  if exists (select 1 from account_entitlements where plan = 'test')
     or exists (select 1 from account_connection_leases where plan = 'test') then
    raise exception 'ragent_test_plan_rollback_unsafe';
  end if;
end; $$;

alter table account_entitlements drop constraint if exists account_entitlements_plan_check;
alter table account_entitlements add constraint account_entitlements_plan_check
  check (plan in ('free', 'plus', 'pro'));

alter table account_connection_leases drop constraint if exists account_connection_leases_plan_check;
alter table account_connection_leases add constraint account_connection_leases_plan_check
  check (plan in ('free', 'plus', 'pro'));

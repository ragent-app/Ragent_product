-- The first-party Ragent account may use the unlimited test plan. Preserve
-- that plan in both persisted entitlements and active connection leases.
alter table account_entitlements drop constraint if exists account_entitlements_plan_check;
alter table account_entitlements add constraint account_entitlements_plan_check
  check (plan in ('free', 'plus', 'pro', 'test'));

alter table account_connection_leases drop constraint if exists account_connection_leases_plan_check;
alter table account_connection_leases add constraint account_connection_leases_plan_check
  check (plan in ('free', 'plus', 'pro', 'test'));

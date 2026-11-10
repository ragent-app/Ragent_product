create table if not exists account_asr_reconciliations (
  account_id text not null,
  request_id text not null,
  outcome text not null check (outcome in ('provider_not_processed','provider_processed_result_lost')),
  operator_id text not null check (length(operator_id) between 1 and 128),
  evidence_ref text not null check (length(evidence_ref) between 1 and 256),
  reason text not null check (length(reason) between 1 and 1000),
  prior_error_code text,
  provider_cost_microusd bigint check (provider_cost_microusd >= 0),
  provider_cost_source text check (provider_cost_source in ('internal_estimate')),
  created_at timestamptz not null default now(),
  primary key (account_id, request_id),
  foreign key (account_id, request_id)
    references account_asr_requests(account_id, request_id) on delete cascade,
  check ((outcome='provider_not_processed' and provider_cost_microusd is null and provider_cost_source is null)
    or (outcome='provider_processed_result_lost' and provider_cost_microusd is not null
      and provider_cost_source='internal_estimate'))
);

create index if not exists account_asr_reconciliations_created_idx
  on account_asr_reconciliations (created_at desc);
create index if not exists account_asr_requests_unknown_idx
  on account_asr_requests (updated_at asc, account_id asc, request_id asc)
  where state='unknown';

-- New ASR records must honor the account-deletion admission fence.
drop trigger if exists account_deletion_admission on account_asr_reconciliations;
create trigger account_deletion_admission before insert or update on account_asr_reconciliations
  for each row execute function guard_deleted_account_admission();

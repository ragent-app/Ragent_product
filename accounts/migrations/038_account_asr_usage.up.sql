create table if not exists account_asr_usage (
  account_id text not null references accounts(account_id) on delete cascade,
  period_start date not null,
  used_audio_ms bigint not null default 0 check (used_audio_ms >= 0),
  reserved_audio_ms bigint not null default 0 check (reserved_audio_ms >= 0),
  provider_cost_microusd bigint not null default 0 check (provider_cost_microusd >= 0),
  request_count bigint not null default 0 check (request_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, period_start)
);

create table if not exists account_asr_requests (
  account_id text not null,
  request_id text not null,
  device_id text not null,
  period_start date not null,
  state text not null check (state in ('reserved','processing','succeeded','failed','unknown')),
  audio_sha256 text not null check (audio_sha256 ~ '^[a-f0-9]{64}$'),
  audio_bytes integer not null check (audio_bytes > 0 and audio_bytes <= 1048576),
  audio_duration_ms integer not null check (audio_duration_ms between 500 and 20000),
  reserved_duration_ms integer not null default 0 check (reserved_duration_ms >= 0),
  billable_duration_ms integer check (billable_duration_ms >= 0),
  provider_name text not null default 'elevenlabs',
  model_id text not null default 'scribe_v2',
  price_version text not null,
  policy_version text not null,
  provider_cost_microusd bigint check (provider_cost_microusd >= 0),
  provider_latency_ms integer check (provider_latency_ms >= 0),
  language_code text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, request_id),
  foreign key (account_id, period_start)
    references account_asr_usage(account_id, period_start) on delete cascade
);

create index if not exists account_asr_requests_account_period_idx
  on account_asr_requests (account_id, period_start, created_at desc);
create index if not exists account_asr_requests_active_idx
  on account_asr_requests (account_id, state, updated_at)
  where state in ('reserved','processing');
create index if not exists account_asr_requests_stale_idx
  on account_asr_requests (updated_at)
  where state in ('reserved','processing');
create index if not exists account_asr_requests_terminal_retention_idx
  on account_asr_requests (updated_at)
  where state in ('succeeded','failed');

-- New post-deletion-fence tables must install the admission guard explicitly.
do $$
declare target text;
begin
  foreach target in array array['account_asr_usage','account_asr_requests'] loop
    execute format('drop trigger if exists account_deletion_admission on %I', target);
    execute format('create trigger account_deletion_admission before insert or update on %I for each row execute function guard_deleted_account_admission()', target);
  end loop;
end;
$$;

-- Minimal evidence that an account explicitly accepted or withdrew the
-- third-party voice-processing disclosure. These rows intentionally survive
-- account deletion and expire only after the five-year evidence window.
create table if not exists account_asr_consent_events (
  consent_event_id bigserial primary key,
  account_id text not null,
  device_id text not null,
  policy_version text not null check (policy_version = 'account-asr-third-party-processing-v1'),
  action text not null check (action in ('accepted','revoked')),
  occurred_at timestamptz not null default now(),
  retain_until timestamptz not null default (now() + interval '5 years')
);

create index if not exists account_asr_consent_events_latest_idx
  on account_asr_consent_events (account_id, consent_event_id desc);
create index if not exists account_asr_consent_events_retention_idx
  on account_asr_consent_events (retain_until);

do $$
begin
  if exists (
    select 1 from account_asr_consent_events
    where policy_version = 'account-asr-third-party-processing-v2'
  ) then
    raise exception 'Cannot roll back disclosure v2 while v2 consent events exist';
  end if;
end;
$$;

alter table account_asr_consent_events
  drop constraint if exists account_asr_consent_events_policy_version_check;

alter table account_asr_consent_events
  add constraint account_asr_consent_events_policy_version_check
  check (policy_version = 'account-asr-third-party-processing-v1');

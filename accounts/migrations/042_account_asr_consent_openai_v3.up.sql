alter table account_asr_consent_events
  drop constraint if exists account_asr_consent_events_policy_version_check;

alter table account_asr_consent_events
  add constraint account_asr_consent_events_policy_version_check
  check (policy_version in (
    'account-asr-third-party-processing-v1',
    'account-asr-third-party-processing-v2',
    'account-asr-openai-transcription-v3'
  ));

alter table account_asr_requests
  alter column provider_name set default 'openai',
  alter column model_id set default 'gpt-transcribe';

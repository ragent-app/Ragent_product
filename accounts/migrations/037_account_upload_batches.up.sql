alter table account_file_uploads
  add column if not exists quota_batch_id text;

update account_file_uploads
set quota_batch_id = request_id
where quota_batch_id is null;

create index if not exists account_file_uploads_batch_usage_idx
  on account_file_uploads (account_id, quota_batch_id, status, reserved_until);

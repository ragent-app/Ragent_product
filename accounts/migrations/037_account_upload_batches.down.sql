drop index if exists account_file_uploads_batch_usage_idx;
alter table account_file_uploads drop column if exists quota_batch_id;

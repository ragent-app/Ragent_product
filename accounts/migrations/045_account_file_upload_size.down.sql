-- Rollback fails transactionally if a larger reservation already exists;
-- it must never discard or truncate upload records to force the old limit.
alter table account_file_uploads drop constraint account_file_uploads_size_bytes_check;
alter table account_file_uploads add constraint account_file_uploads_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 1073741824);

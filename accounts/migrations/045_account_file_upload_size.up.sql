-- The account policy enforces each plan's file limits. Permit the test plan
-- to reserve sizes beyond 1 GiB while retaining exact JavaScript integers.
alter table account_file_uploads drop constraint account_file_uploads_size_bytes_check;
alter table account_file_uploads add constraint account_file_uploads_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 9007199254740991);

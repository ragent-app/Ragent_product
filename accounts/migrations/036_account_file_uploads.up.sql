-- Central, account-wide attachment quota reservations and cumulative usage.
create table if not exists account_file_uploads (
  account_id text not null references accounts(account_id) on delete cascade,
  request_id text not null,
  instance_id text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 1073741824),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('reserved', 'committed')),
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, request_id)
);

create index if not exists account_file_uploads_usage_idx
  on account_file_uploads (account_id, status, reserved_until);

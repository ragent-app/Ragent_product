create table account_push_registrations (
  registration_id text primary key,
  account_id text not null references accounts(account_id) on delete cascade,
  device_id text not null references account_devices(device_id) on delete cascade,
  revoke_hash text not null,
  token_ciphertext text not null,
  token_hash text not null,
  request_hash text not null,
  app_version text not null default '',
  enabled boolean not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index account_push_active_device on account_push_registrations(account_id, device_id) where revoked_at is null;
create table account_push_subscriptions (
  registration_id text not null references account_push_registrations(registration_id) on delete cascade,
  instance_id text not null references instance_bindings(instance_id) on delete cascade,
  primary key(registration_id, instance_id)
);
create table account_push_events (
  instance_id text not null references instance_bindings(instance_id) on delete cascade,
  account_id text not null references accounts(account_id) on delete cascade,
  kind text not null,
  event_id text not null,
  payload_hash text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key(instance_id, kind, event_id)
);
create table account_push_delivery_outbox (
  id bigint generated always as identity primary key,
  instance_id text not null,
  kind text not null,
  event_id text not null,
  registration_id text not null references account_push_registrations(registration_id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token text,
  lease_until timestamptz,
  last_error text,
  received_at timestamptz,
  posted_at timestamptz,
  suppressed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(instance_id, kind, event_id) references account_push_events(instance_id, kind, event_id) on delete cascade,
  unique(instance_id, kind, event_id, registration_id)
);
create index account_push_delivery_outbox_pending on account_push_delivery_outbox(next_attempt_at, id) where status in ('pending','retry','sending');
create table account_push_nonces (
  instance_id text not null references instance_bindings(instance_id) on delete cascade,
  nonce_hash text not null,
  expires_at timestamptz not null,
  primary key(instance_id, nonce_hash)
);
create index account_push_nonces_expiry on account_push_nonces(expires_at);

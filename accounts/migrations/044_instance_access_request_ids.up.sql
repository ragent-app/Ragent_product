-- Bind each issuance to one durable request so a signed issue request cannot
-- be replayed to revive an authorization after it has been revoked.
alter table instance_access_grants add column if not exists request_id text;
update instance_access_grants set request_id = 'legacy_' || grant_id where request_id is null;
alter table instance_access_grants alter column request_id set not null;
create unique index if not exists instance_access_grants_request_idx on instance_access_grants (request_id);

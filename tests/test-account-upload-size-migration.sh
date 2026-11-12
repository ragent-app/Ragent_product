#!/bin/bash
# Disposable no-network PostgreSQL verifies upgrade and non-destructive rollback.
set -Eeuo pipefail
root=${1:?directory containing migration SQL required}
name="ragent-upload-size-qa-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password=$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --network none --name "$name" -e POSTGRES_USER=qa -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=upload_fixture postgres:16-alpine >/dev/null
ready=0
for _ in {1..80}; do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -U qa -d upload_fixture; then ready=1; break; fi
  sleep .25
done
[[ $ready == 1 ]] || { echo 'PostgreSQL fixture failed to start' >&2; exit 1; }
psql=(docker exec -i "$name" psql -X -q -v ON_ERROR_STOP=1 -U qa -d upload_fixture)
printf '%s\n' "create table accounts (account_id text primary key); insert into accounts values ('acct_fixture');" | "${psql[@]}"
"${psql[@]}" < "$root/036_account_file_uploads.up.sql"
insert="insert into account_file_uploads(account_id,request_id,instance_id,size_bytes,sha256,status,created_at,updated_at) values ('acct_fixture','large','inst_fixture',2147483648,repeat('a',64),'reserved',now(),now());"
if printf '%s\n' "$insert" | "${psql[@]}" >/dev/null 2>&1; then echo 'old schema accepted oversized reservation' >&2; exit 1; fi
"${psql[@]}" --single-transaction < "$root/045_account_file_upload_size.up.sql"
printf '%s\n' "$insert" | "${psql[@]}"
if "${psql[@]}" --single-transaction < "$root/045_account_file_upload_size.down.sql" >/dev/null 2>&1; then echo 'rollback discarded or accepted oversized reservation' >&2; exit 1; fi
[[ $(printf '%s\n' "select count(*) from account_file_uploads where size_bytes=2147483648;" | "${psql[@]}" -At) == 1 ]]
printf '%s\n' 'delete from account_file_uploads;' | "${psql[@]}"
"${psql[@]}" --single-transaction < "$root/045_account_file_upload_size.down.sql"
if printf '%s\n' "$insert" | "${psql[@]}" >/dev/null 2>&1; then echo 'restored schema accepted oversized reservation' >&2; exit 1; fi
echo 'PASS upload size migration and non-destructive rollback'

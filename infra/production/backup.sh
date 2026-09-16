#!/bin/sh
set -eu
umask 077
exec 9>/srv/bio-v3/backups/.lock
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target=/srv/bio-v3/backups/$stamp
mkdir -p "$target"
docker compose --env-file /srv/bio-v3/shared/compose.env \
  -f /srv/bio-v3/current/infra/production/compose.yml \
  exec -T db pg_dump -U bio -d bio -Fc > "$target/database.dump.tmp"
mv "$target/database.dump.tmp" "$target/database.dump"
tar -czf "$target/agent.tar.gz.tmp" -C /srv/bio-v3/data agent
mv "$target/agent.tar.gz.tmp" "$target/agent.tar.gz"
date -u > "$target/complete"
# Keep local backups for 14 days. These do not protect against server loss.
find /srv/bio-v3/backups -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime +14 -exec rm -rf -- {} +

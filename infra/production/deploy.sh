#!/bin/bash
# Run on B: bash /srv/bio-v3/repository/infra/production/deploy.sh <full Git SHA>
set -Eeuo pipefail
umask 077
base=/srv/bio-v3
repo=$base/repository
sha=${1:?Pass the full 40-character Git commit SHA to deploy}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full Git commit SHA' >&2; exit 1; }
exec 9>"$base/shared/deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
[[ -z $(git -C "$repo" status --porcelain) ]] || { echo 'Repository checkout is dirty' >&2; exit 1; }
git -C "$repo" fetch --prune origin
git -C "$repo" merge-base --is-ancestor "$sha" origin/main
release=$base/releases/$sha
if [[ ! -d $release ]]; then
    git -C "$repo" worktree add --detach "$release" "$sha"
fi
[[ $(git -C "$release" rev-parse HEAD) == "$sha" ]]
[[ -z $(git -C "$release" status --porcelain --ignored) ]] || { echo 'Release checkout is dirty' >&2; exit 1; }
candidate=$base/shared/compose-$sha.env
sed "s/^BIO_RELEASE=.*/BIO_RELEASE=$sha/" "$base/shared/compose.env" > "$candidate"
compose=(docker compose --env-file "$candidate" -f "$release/infra/production/compose.yml")
"${compose[@]}" build api
# Test the exact image without production credentials or network access.
docker run --rm --network none --user root --workdir /app "bio-v3:$sha" \
    sh -c 'pnpm typecheck && pnpm test'
mkdir -p "$base/web/$sha"
chmod 755 "$base/web" "$base/web/$sha"
extract=bio-v3-extract-$sha
cleanup() { docker rm "$extract" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker create --name "$extract" "bio-v3:$sha" >/dev/null
docker cp "$extract:/app/apps/debug-console/dist/." "$base/web/$sha/"
printf '%s\n' "$sha" > "$base/web/$sha/REVISION"
chmod -R a+rX "$base/web/$sha"
cleanup
sudo -n /usr/local/sbin/bio-v3-backup
previous=$(readlink -f "$base/current")
previous_web=$(readlink -f "$base/web/current" || true)
cp "$base/shared/compose.env" "$base/shared/compose-before-deploy.env"
sudo -n cp /etc/nginx/sites-available/bio-v3 "$base/shared/nginx-before-deploy.conf"
rollback() {
    trap - ERR
    echo 'Deployment failed; restoring the previous application release.' >&2
    cp "$base/shared/compose-before-deploy.env" "$base/shared/compose.env"
    ln -sfn "$previous" "$base/current"
    if [[ -n $previous_web ]]; then ln -sfn "$previous_web" "$base/web/current"; fi
    sudo -n cp "$base/shared/nginx-before-deploy.conf" /etc/nginx/sites-available/bio-v3
    docker compose --env-file "$base/shared/compose.env" -f "$previous/infra/production/compose.yml" up -d --wait
    sudo -n nginx -t && sudo -n systemctl reload nginx
    exit 1
}
trap rollback ERR
"${compose[@]}" up -d --wait --wait-timeout 120
ln -sfn "$release" "$base/current"
ln -sfn "$base/web/$sha" "$base/web/current"
cp "$candidate" "$base/shared/compose.env"
python3 "$release/infra/production/render-nginx.py" > "$base/shared/nginx.conf"
sudo -n install -m 600 "$base/shared/nginx.conf" /etc/nginx/sites-available/bio-v3
sudo -n nginx -t
sudo -n systemctl reload nginx
curl --fail --silent --show-error http://127.0.0.1:3100/api/v1/health
sudo -n install -m 700 "$release/infra/production/backup.sh" /usr/local/sbin/bio-v3-backup
sudo -n install -m 644 "$release/infra/production/backup.cron" /etc/cron.d/bio-v3-backup
sudo -n install -m 755 "$release/infra/production/renew-nginx.sh" /etc/letsencrypt/renewal-hooks/deploy/bio-v3-nginx
bash "$release/infra/production/verify.sh"
trap - ERR
printf '\nDeployed Git commit %s\n' "$sha"

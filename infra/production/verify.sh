#!/bin/bash
set -euo pipefail
base=/srv/bio-v3
code=$(readlink -f "$base/current")
sha=$(git -C "$code" rev-parse HEAD)
[[ -z $(git -C "$code" status --porcelain --ignored) ]] || { echo 'Dirty deployed checkout' >&2; exit 1; }
git -C "$base/repository" merge-base --is-ancestor "$sha" origin/main
[[ $(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' bio-v3-api-1) == "$sha" ]]
[[ $(docker inspect -f '{{.Image}}' bio-v3-api-1) == $(docker image inspect -f '{{.Id}}' "bio-v3:$sha") ]]
[[ $(cat "$base/web/current/REVISION") == "$sha" ]]
python3 "$code/infra/production/render-nginx.py" | sudo -n cmp -s - /etc/nginx/sites-available/bio-v3
sudo -n cmp -s "$code/infra/production/backup.sh" /usr/local/sbin/bio-v3-backup
sudo -n cmp -s "$code/infra/production/backup.cron" /etc/cron.d/bio-v3-backup
sudo -n cmp -s "$code/infra/production/renew-nginx.sh" /etc/letsencrypt/renewal-hooks/deploy/bio-v3-nginx
[[ $(docker inspect -f '{{.State.Health.Status}}' bio-v3-api-1) == healthy ]]
[[ $(docker inspect -f '{{.State.Health.Status}}' bio-v3-db-1) == healthy ]]
printf 'Verified clean Git checkout, API image, web revision and installed configuration: %s\n' "$sha"

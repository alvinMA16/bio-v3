#!/bin/bash
# Verify a built image with no production credentials, volumes or external network.
set -Eeuo pipefail
image=${1:?Pass the built release image, e.g. bio-v3:<sha>}
prefix=bio-v3-check-$(date +%s)-$$
network=$prefix-network
database=$prefix-db
checks=$prefix-tests
cleanup() {
    docker rm -f "$checks" "$database" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Cached locally after the first run. Never force a fresh pull on every deployment.
docker image inspect postgres:17-alpine >/dev/null 2>&1 || docker pull postgres:17-alpine
docker network create --internal "$network" >/dev/null
docker run --detach --name "$database" --network "$network" --network-alias test-db \
    --memory 512m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,size=384m \
    -e POSTGRES_USER=bio_test -e POSTGRES_DB=bio_release_test \
    -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
ready=false
for ((attempt=0; attempt<30; attempt++)); do
    if docker exec "$database" pg_isready -h 127.0.0.1 -U bio_test -d bio_release_test >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 1
done
[[ $ready == true ]] || { echo 'Temporary release database did not become ready' >&2; exit 1; }
docker run --rm --name "$checks" --network "$network" --user root --workdir /app \
    --memory 2g --cpus 2 \
    -e AUTH_TEST_DATABASE_URL=postgresql://bio_test@test-db:5432/bio_release_test \
    -e MEMORY_TEST_DATABASE_URL=postgresql://bio_test@test-db:5432/bio_release_test \
    "$image" sh -c 'pnpm typecheck && pnpm test:release'
echo 'Isolated release image verification passed.'

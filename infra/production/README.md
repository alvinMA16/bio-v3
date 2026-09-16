# Git-based deployment on B

Repository: `https://github.com/alvinMA16/bio-v3.git`, branch `main`.
Server: `qs@neozeppelin.com`. Website: `https://app.storyofme.cn`.

## Related bio2 deployment (remembered server reference)

The existing **bio2 / biography-v2** service is on **`root@47.118.18.96`**
(`ssh root@47.118.18.96`), with Compose in `/root/alvin/biography-v2/deploy`. Its running backend is
`deploy-backend-1` and database is `deploy-db-1`. This is the reference deployment
for the working Aliyun SMS configuration. Use its actual runtime configuration;
the local biography-v2 `.env` contains placeholders and is not authoritative.
Never print credentials or copy unrelated service settings. The bio-v3 production
host remains `qs@neozeppelin.com`; do not deploy bio-v3 over the bio2 service.

Web Agent debugger: `https://app.storyofme.cn/internal/` (`/internal` redirects
to the trailing-slash URL). It uses the same origin's `/api/v1/` HTTP endpoints
and `/api/v1/voice` WebSocket, so conversations, materials and memory use the
real deployed backend. The existing root entry remains available. Both entries
require the same private-preview login and share the owner identity and data.

## Publish

Commit and push the desired changes first. A release must be an exact 40-character
commit SHA reachable from `origin/main`. Do not copy local source files to B.

```sh
# Local checkout: inspect changes, test, commit, then push.
pnpm typecheck
pnpm test
pnpm build
git push origin main
git rev-parse HEAD

# On B, update the clean control checkout, then deploy that exact SHA.
cd /srv/bio-v3/repository
git pull --ff-only origin main
bash infra/production/deploy.sh <full-commit-sha>
```

`deploy.sh` fetches Git, creates a clean detached worktree, builds an image tagged
and labeled with the SHA, and runs typechecks/tests inside that exact image without
production credentials. A startup probe also runs as the production user before
touching the live service. It extracts the web build outside the checkout, backs up
data, updates Docker Compose, waits for health, switches release links, renders
Nginx from the versioned template, and installs the versioned backup/renewal scripts.
A deployment lock prevents overlapping releases. Failures during activation attempt
to restore the previous application image, links, environment and Nginx config.

Updates restart the one API instance and interrupt active calls. Schedule releases
outside calls. Application rollback does not revert database migrations: review
schema compatibility before deploying an older commit. Backups are taken before
activation. There is no automatic deployment on push; invoke the script deliberately.

## Gemini network configuration

The application already supports Google's native Gemini API through Pi. Like A,
B can reach `https://generativelanguage.googleapis.com/v1beta` through the existing
host HTTP proxy at port 8118. Compose maps `host.docker.internal` to the Docker
host; Node 24 honors the proxy when `NODE_USE_ENV_PROXY=1` is set at startup.
Configure these private runtime values in `shared/production.env` when enabling it:

```dotenv
MODEL_PROVIDER=gemini
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_MODEL=<validated Agent-capable Gemini model>
GEMINI_API_KEY=<private key, never commit>
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://host.docker.internal:8118
NO_PROXY=localhost,127.0.0.1,::1,db,host.docker.internal,.aliyuncs.com,.deepseek.com,.bytedance.com,.volces.com
```

Do not replace the API base URL with the proxy URL. The proxy carries HTTPS
CONNECT tunnels; TLS still terminates at Google. Qwen, DeepSeek and voice provider
domains listed in `NO_PROXY` keep their direct route. Recreate the API container
after environment changes; a plain container restart retains its old environment.
Validate real streaming and tool calls before switching the default model.
For `gemini-3.8-flash`, the model adapter selects LOW thinking for both interactive
sessions and memory organization: this model rejects the MINIMAL level Pi sends
when thinking is off. Earlier Gemini Flash models retain their existing setting.

## Verify alignment

```sh
bash /srv/bio-v3/current/infra/production/verify.sh
git -C /srv/bio-v3/current status --short
git -C /srv/bio-v3/current rev-parse HEAD
```

Verification compares the clean Git checkout, container image ID/revision label,
web revision, rendered Nginx config, installed backup schedule/script and renewal
hook. It also checks API/database health. Source changes must be committed locally,
pushed and deployed; never edit an active server checkout or a running container.
Generated files and persistent data must not be placed in release worktrees.

## What belongs in Git

| Tracked in Git | Kept outside Git on B |
| --- | --- |
| Application code and assets | Model/voice keys, database password, owner token |
| Dockerfile and Compose config | Password hash and TLS certificates |
| Nginx template and renderer | Rendered Nginx config containing the private token |
| Deploy/verify/backup/renewal scripts | Database, uploads, logs, backups and build output |

Environment values can differ by environment; server code must match its deployed
commit. `production.env` is intentionally not copied from Git or baked into images.

## Server layout

- `/srv/bio-v3/repository`: clean Git control checkout tracking `main`.
- `/srv/bio-v3/releases/<sha>`: detached Git worktree for that release.
- `/srv/bio-v3/current`: active code worktree symlink.
- `/srv/bio-v3/web/<sha>` and `web/current`: generated static web output.
- `/srv/bio-v3/shared/production.env`: private API settings, mode 600.
- `/srv/bio-v3/shared/compose.env`: active image SHA and database password, mode 600.
- `/srv/bio-v3/data/agent`: persistent uploads, SDK files and traces.
- `/srv/bio-v3/data/postgres`: dedicated PostgreSQL 17 data.
- `/srv/bio-v3/backups`: 14 days of local nightly backups; copy off-server for disaster recovery.
- `/etc/nginx/sites-available/bio-v3`: rendered private HTTPS gateway.
- `/etc/nginx/bio-v3.htpasswd`: private preview login hash.

The original pre-Git release may remain as an inactive rollback snapshot; `current`
and the running image must reference a Git release after migration.

## Runtime and access

This is a single-owner private preview. Nginx Basic authentication protects static
files and every API route. After authentication, Nginx supplies the owner bearer
token to the API, including WebSocket upgrades. Do not expose port 3100 publicly or
remove gateway authentication: materials do not yet have multi-user isolation.
This deployment does not publish the WeChat mini program or import old product data.

The API uses Node 24, runs as the node user, and has a 1 GiB memory / 1.5 CPU limit.
PostgreSQL has a 512 MiB / 1 CPU limit. Only API localhost port 3100 is published.
The unused 100 GiB disk is not initialized by these scripts. Container logs rotate
at 3 × 10 MB. Certbot handles certificate renewal, followed by the tracked reload hook.

```sh
cd /srv/bio-v3/current
docker compose --env-file /srv/bio-v3/shared/compose.env -f infra/production/compose.yml ps
docker compose --env-file /srv/bio-v3/shared/compose.env -f infra/production/compose.yml logs --tail=100 api
sudo /usr/local/sbin/bio-v3-backup
```

Nightly backups copy files while the service is live; stop incoming writes for a
fully consistent cross-store snapshot. Local private credentials and test logs live
in ignored `.deploy-private/` and must never be committed.

## Phone account rollout

Phone accounts are available behind `AUTH_ENABLED=true`; see [accounts](../../docs/accounts.md)
for database, SMS sign/template, key and trusted-proxy configuration. In this mode the
Nginx renderer removes private-preview Basic Auth and forwards client Authorization
without substituting the owner token. With the flag absent/false, the existing private
preview remains unchanged. Existing owner records are not assigned to new phone
accounts automatically. Configure and verify real SMS before activating this switch.

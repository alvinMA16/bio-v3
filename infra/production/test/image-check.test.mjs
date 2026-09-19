import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const scenario of ['success', 'database-unavailable', 'tests-failed']) {
  test(`isolated image check cleans up after ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bio-image-check-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CHECK_LOG"
case "$1 $2" in
  'exec '*) [ "$SCENARIO" != database-unavailable ] ;;
  'run --rm') [ "$SCENARIO" != tests-failed ] ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    await writeFile(join(root, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const log = join(root, 'log');
    const result = spawnSync('bash', [fileURLToPath(new URL('../test-image.sh', import.meta.url)), 'bio-v3:fixture'], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CHECK_LOG: log, SCENARIO: scenario }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.match(lines[1], /^network create --internal bio-v3-check-/);
    const database = lines.find(line => line.startsWith('run --detach'));
    assert.match(database, /--tmpfs \/var\/lib\/postgresql\/data/);
    assert.doesNotMatch(database, /--publish|--volume|--env-file| -p | -v /);
    const checks = lines.find(line => line.startsWith('run --rm'));
    if (scenario === 'database-unavailable') assert.equal(checks, undefined);
    else {
      assert.match(checks, /AUTH_TEST_DATABASE_URL=postgresql:\/\/bio_test@test-db:5432\/bio_release_test/);
      assert.match(checks, /MEMORY_TEST_DATABASE_URL=postgresql:\/\/bio_test@test-db:5432\/bio_release_test/);
      assert.doesNotMatch(checks, /--env-file|--volume| -v /);
    }
    assert.match(lines.at(-2), /^rm -f bio-v3-check-\S+-tests bio-v3-check-\S+-db$/);
    assert.match(lines.at(-1), /^network rm bio-v3-check-\S+-network$/);
  });
}

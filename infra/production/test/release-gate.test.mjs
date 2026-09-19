import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'bio-release-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'infra/production'), { recursive: true });
  await mkdir(join(root, 'apps/api/test'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await copyFile(new URL('../test-release.mjs', import.meta.url), join(root, 'infra/production/test-release.mjs'));
  await writeFile(join(root, 'apps/api/test/check.test.mjs'), body);
  // These tests exercise the gate itself; application suites have their own execution.
  await writeFile(join(root, 'bin/pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GATE_COMMANDS"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GATE_COMMANDS: join(root, 'commands'),
    AUTH_TEST_DATABASE_URL: 'postgresql://fixture/test', MEMORY_TEST_DATABASE_URL: 'postgresql://fixture/test' };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [join(root, 'infra/production/test-release.mjs')], { env, encoding: 'utf8', timeout: 20000 });
  return { root, env, run };
}

test('release gate rejects either missing database setting before running tests', async t => {
  const f = await fixture(t, "throw new Error('must not execute');");
  for (const key of ['AUTH_TEST_DATABASE_URL', 'MEMORY_TEST_DATABASE_URL']) {
    const value = f.env[key]; delete f.env[key];
    const result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, new RegExp(`require ${key}`));
    assert.doesNotMatch(result.stdout, /must not execute/);
    f.env[key] = value;
  }
});

for (const [name, body, message] of [
  ['skipped coverage', "test('database scenario', { skip: true }, () => {});", /Incomplete release coverage/],
  ['todo coverage', "test('database scenario', { todo: true }, () => {});", /Incomplete release coverage/],
  ['test failure', "test('database scenario', () => { throw new Error('unavailable database'); });", /Release check failed/],
]) {
  test(`release gate rejects ${name}`, async t => {
    const f = await fixture(t, `import { test } from 'node:test';\n${body}`);
    const result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, message);
    await assert.rejects(readFile(join(f.root, 'commands')), { code: 'ENOENT' });
  });
}

test('release gate rejects an image with no API tests', async t => {
  const f = await fixture(t, '');
  await rm(join(f.root, 'apps/api/test/check.test.mjs'));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No API tests found/);
});

test('release gate allows complete coverage and then runs both clients', async t => {
  const f = await fixture(t, "import { test } from 'node:test'; test('database scenario', () => {});");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zero skipped API tests/);
  assert.equal(await readFile(join(f.root, 'commands'), 'utf8'), '--filter @bio/debug-console test\n--filter @bio/miniprogram test\ntest:deploy\n');
});

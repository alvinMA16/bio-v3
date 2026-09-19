// Run against the built release image. Database coverage is mandatory here;
// ordinary `pnpm test` remains available without PostgreSQL for quick local work.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const key of ['AUTH_TEST_DATABASE_URL', 'MEMORY_TEST_DATABASE_URL']) {
  if (!process.env[key]) {
    console.error(`Release checks require ${key}; use infra/production/test-image.sh with an isolated test database.`);
    process.exit(1);
  }
}

async function command(binary, args, checkCoverage = false) {
  const child = spawn(binary, args, { cwd: root, stdio: ['ignore', checkCoverage ? 'pipe' : 'inherit', 'inherit'] });
  let tests = 0, skipped, todo;
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (checkCoverage) {
    for await (const line of createInterface({ input: child.stdout })) {
      console.log(line);
      if (/^# tests \d+$/.test(line)) tests = Number(line.split(' ').at(-1));
      if (/^# skipped \d+$/.test(line)) skipped = Number(line.split(' ').at(-1));
      if (/^# todo \d+$/.test(line)) todo = Number(line.split(' ').at(-1));
    }
  }
  const { code, signal } = await completed;
  if (code !== 0) throw new Error(`Release check failed (${signal || code}): ${binary}`);
  if (checkCoverage && (!tests || skipped !== 0 || todo !== 0)) {
    throw new Error(`Incomplete release coverage: tests=${tests}, skipped=${skipped}, todo=${todo}`);
  }
}

try {
  const files = readdirSync(new URL('../../apps/api/test/', import.meta.url))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => `apps/api/test/${name}`);
  if (!files.length) throw new Error('No API tests found in release image');
  // API dist was compiled by the Docker build; exercise those exact artifacts.
  await command(process.execPath, ['--test', '--test-reporter=tap', ...files], true);
  await command('pnpm', ['--filter', '@bio/debug-console', 'test']);
  await command('pnpm', ['--filter', '@bio/miniprogram', 'test']);
  await command('pnpm', ['test:deploy']);
  console.log('Release checks passed: database tests executed, zero skipped API tests.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

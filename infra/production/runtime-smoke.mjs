// Start the exact image as its production user before replacing a live container.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const child = spawn(process.execPath, ['dist/main.js'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, HOST: '127.0.0.1', PORT: '3000', AGENT_DATA_DIR: '/tmp/bio-runtime-smoke' },
});
let exited = false;
child.once('exit', () => { exited = true; });
try {
  let healthy = false;
  // Allow cold starts under CPU pressure; ready services still pass immediately.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (exited) throw new Error('Production process exited before becoming healthy');
    try {
      const response = await fetch('http://127.0.0.1:3000/api/v1/health', { signal: AbortSignal.timeout(1000) });
      healthy = response.ok;
    } catch { /* The process may still be starting. */ }
    if (healthy) break;
    await delay(200);
  }
  if (!healthy) throw new Error('Production-user runtime health check failed');
  console.log('Production-user runtime health check passed');
} finally {
  if (!exited) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timeout);
  }
}

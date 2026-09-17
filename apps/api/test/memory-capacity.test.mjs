import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';
import { MemoryWorker } from '../dist/memory/memory-worker.js';
import { AgentService } from '../dist/agent/agent.service.js';

test('failed acquisition, snapshot and unlock release admission and discard uncertain locks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bio-capacity-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const failure of ['user', 'connect', 'lock', 'ownership', 'restore', 'snapshot', 'unlock', 'none']) {
    await t.test(failure, async () => {
      const memory = new MemoryService(new ConfigService());
      let fail = failure;
      const released = [];
      memory.pool = {
        async query() { if (fail === 'user') throw new Error('user failure'); return { rows: [] }; },
        async connect() {
          if (fail === 'connect') throw new Error('connect failure');
          return {
            async query(sql) {
              if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: fail !== 'lock' }] };
              if (sql.startsWith('SELECT *')) return { rows: fail === 'ownership' ? [] : [{ snapshot: {} }] };
              if (sql.startsWith('UPDATE') && fail === 'snapshot') throw new Error('snapshot failure');
              if (sql.includes('pg_advisory_unlock') && fail === 'unlock') throw new Error('unlock failure');
              return { rows: [] };
            },
            release(destroy) { released.push(destroy); },
          };
        },
      };
      const path = join(root, `${failure}.file`);
      if (failure === 'restore') await writeFile(path, 'not a directory');
      for (let index = 0; index < 12; index++) {
        const operation = async () => {
          const save = await memory.acquireSession('user', randomUUID(), randomUUID(), failure === 'restore' ? path : root);
          await Promise.all([save(), save()]);
        };
        if (failure === 'none') await operation();
        else await assert.rejects(operation(), error => error.getStatus?.() !== 503);
      }
      assert.equal(released.length, ['user', 'connect'].includes(failure) ? 0 : 12);
      assert.ok(released.every(destroy => destroy === (failure === 'unlock')));
      // All eight slots must be reusable after repeated failures.
      fail = 'none';
      const saves = await Promise.all(Array.from({ length: 8 }, () => memory.acquireSession('user', randomUUID(), randomUUID(), root)));
      await assert.rejects(memory.acquireSession('user', randomUUID(), randomUUID(), root), error => error.getStatus() === 503);
      await Promise.all(saves.map(save => save()));
    });
  }
});

test('worker destroys its connection when advisory unlock fails', async () => {
  const released = [];
  const worker = new MemoryWorker({
    async expireCalls() {},
    pool: {
      async query() { return { rows: [{ user_id: 'blocked-user' }] }; },
      async connect() {
        return {
          async query(sql) {
            if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
            if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
            return { rows: [{ status: 'failed' }] };
          },
          release(destroy) { released.push(destroy); },
        };
      },
    },
  }, new ConfigService());
  await assert.rejects(worker.tick(), /unlock failed/);
  assert.deepEqual(released, [true]);
});

test('Agent releases its database session even when SDK disposal throws', async () => {
  let held = false;
  let releaseCount = 0;
  const memory = {
    enabled: true,
    async acquireSession() {
      assert.equal(held, false);
      held = true;
      return async () => { held = false; releaseCount++; };
    },
    async archive() {},
  };
  const agent = new AgentService({
    async create() {
      return { subscribe() { return () => {}; }, async prompt() { throw new Error('model failed'); }, dispose() { throw new Error('dispose failed'); } };
    },
  }, { assertId() {}, conversationDirectory() { return '/unused'; }, appendTrace() {} }, new ConfigService(), memory);
  const input = { conversationId: randomUUID(), message: 'synthetic' };
  for (let index = 0; index < 2; index++) await assert.rejects(agent.run(input, undefined, undefined, { userId: 'user' }), /dispose failed/);
  assert.equal(held, false);
  assert.equal(releaseCount, 2);
});

test('PostgreSQL session saturation preserves archival capacity and rejects excess work', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL, timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bio-capacity-'));
  const user = `capacity-${randomUUID()}`;
  const memory = new MemoryService(new ConfigService({ MEMORY_DATABASE_URL: process.env.MEMORY_TEST_DATABASE_URL }));
  const releases = [];
  let worker;
  try {
    await memory.onModuleInit();
    // The production worker holds one connection while its model runs.
    worker = await memory.pool.connect();
    const attempts = Array.from({ length: 12 }, () => ({ id: randomUUID(), run: randomUUID() }));
    const outcomes = await Promise.allSettled(attempts.map(async attempt => {
      const started = performance.now();
      try {
        const release = await memory.acquireSession(user, attempt.id, attempt.run, join(root, attempt.id));
        releases.push(release);
        return { ...attempt, release };
      } catch (error) {
        assert.ok(performance.now() - started < 1000, 'overload must reject without waiting for the pool timeout');
        throw error;
      }
    }));
    const accepted = outcomes.filter(result => result.status === 'fulfilled');
    // Exercise real queries while all admitted model runs and the worker hold connections.
    const first = accepted[0].value;
    const message = randomUUID();
    await memory.archive({ userId: user }, first.id, first.run, message, 'user', '容量测试原文');
    assert.equal((await memory.source(user, message)).messages[0].text, '容量测试原文');
    assert.deepEqual(await memory.overview(user), { preferences: [], entries: [] });
    assert.deepEqual((await memory.search(user, '容量')).items, []);
    assert.equal(accepted.length, 8);
    for (const result of outcomes.filter(result => result.status === 'rejected')) assert.equal(result.reason.getStatus(), 503);
    assert.equal(memory.pool.waitingCount, 0);

    await writeFile(join(root, first.id, 'session.jsonl'), 'saved session');
    // Releasing twice must not return two admission slots or double-release a client.
    await Promise.all([first.release(), first.release()]);
    const restored = join(root, 'restored');
    const release = await memory.acquireSession(user, first.id, randomUUID(), restored);
    releases.push(release);
    assert.equal(await readFile(join(restored, 'session.jsonl'), 'utf8'), 'saved session');
    await assert.rejects(memory.acquireSession(user, randomUUID(), randomUUID(), join(root, 'excess')), error => error.getStatus() === 503);
    await Promise.all(releases.map(save => save()));

    // Exercise admission through the real AgentService, with slow synthetic models.
    // Rejected requests must neither invoke the model nor archive a user message.
    const ready = Promise.withResolvers();
    const turns = new Map();
    const agent = new AgentService({
      async create(conversationId) {
        let emit;
        const gate = Promise.withResolvers();
        return {
          subscribe(listener) { emit = listener; return () => {}; },
          async prompt() {
            turns.set(conversationId, gate);
            if (turns.size === 8) ready.resolve();
            await gate.promise;
            emit({ type: 'message_end', message: {
              role: 'assistant', model: 'deepseek-v4-flash', stopReason: 'stop', content: [{ type: 'text', text: '合成回复' }],
              usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 2 },
            } });
          },
          async abort() { gate.reject(new Error('cancelled')); },
          dispose() {},
        };
      },
    }, { assertId() {}, conversationDirectory(id) { return join(root, id); }, appendTrace() {} }, new ConfigService(), memory);
    const inputs = Array.from({ length: 12 }, () => ({ controller: new AbortController(), id: randomUUID() }));
    const pending = inputs.map(({ controller, id }) => agent.run({ conversationId: id, message: 'slow synthetic run' }, undefined, controller.signal, { userId: user })
      .then(value => ({ value }), error => ({ error })));
    try {
      await Promise.race([ready.promise, ...pending.slice(0, 8).map(promise => promise.then(result => { throw result.error ?? new Error('Model did not wait'); }))]);
      for (const rejected of await Promise.all(pending.slice(8))) {
        assert.equal(rejected.error.getStatus(), 503);
        assert.match(rejected.error.message, /服务繁忙/);
      }
      assert.equal(turns.size, 8);
      assert.equal((await memory.pool.query("SELECT count(*) FROM bio_memory_messages WHERE user_id=$1 AND role='user'", [user])).rows[0].count, '9');
      inputs[0].controller.abort();
      turns.get(inputs[1].id).reject(new Error('model failure'));
      for (const input of inputs.slice(2, 8)) turns.get(input.id).resolve();
      const completed = await Promise.all(pending);
      assert.match(completed[0].error.message, /cancelled/);
      assert.match(completed[1].error.message, /failed/);
      assert.equal(completed.filter(result => result.value).length, 6);
      assert.equal(memory.pool.waitingCount, 0);
      // Success, cancellation and model failure all return their admission slots.
      const next = await Promise.all(Array.from({ length: 8 }, async () => {
        const id = randomUUID();
        const save = await memory.acquireSession(user, id, randomUUID(), join(root, id));
        releases.push(save);
        return save;
      }));
      await Promise.all(next.map(save => save()));
    } finally {
      for (const { controller } of inputs) controller.abort();
      await Promise.all(pending);
    }
  } finally {
    await Promise.allSettled(releases.map(release => release()));
    worker?.release();
    try {
      await memory.pool.query('DELETE FROM bio_memory_messages WHERE user_id=$1', [user]);
      await memory.pool.query('DELETE FROM bio_memory_runs WHERE user_id=$1', [user]);
      await memory.pool.query('DELETE FROM bio_memory_sessions WHERE user_id=$1', [user]);
      await memory.pool.query('DELETE FROM bio_memory_users WHERE id=$1', [user]);
    } finally { await memory.onModuleDestroy(); await rm(root, { recursive: true, force: true }); }
  }
});

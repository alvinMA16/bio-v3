import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';
import { MemoryWorker } from '../dist/memory/memory-worker.js';
import { MemoryController } from '../dist/memory/memory.controller.js';

test('PostgreSQL memory scheduling isolates blocked users and preserves queue order', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL, timeout: 30000,
}, async t => {
  // A private schema prevents this worker from consuming other integration tests' jobs.
  const admin = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL });
  const schema = `scheduling_${randomUUID().replaceAll('-', '')}`;
  let memory;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.MEMORY_TEST_DATABASE_URL);
    url.searchParams.set('options', `${url.searchParams.get('options') || ''} -c search_path=${schema}`.trim());
    const config = new ConfigService({ MEMORY_DATABASE_URL: url.toString(), MEMORY_WORKER_ENABLED: 'false', MEMORY_AUTH_TOKENS: '{"test-token":"blocked-0"}' });
    memory = new MemoryService(config);
    await memory.onModuleInit();
    const worker = new MemoryWorker(memory, config);
    const organized = [];
    worker.organize = async (user, callId) => {
      organized.push({ user, callId });
      return { usage: [], callSummary: { summary: '合成测试通话', follow_ups: [] } };
    };
    async function reset() {
      await memory.pool.query('TRUNCATE bio_memory_users CASCADE');
      organized.length = 0;
    }
    async function enqueue(user, id, order, status = 'pending', delayed = false) {
      const conversation = await memory.beginCall(user, id, id);
      await memory.archive({ userId: user, callId: id }, conversation, randomUUID(), randomUUID(), 'user', '合成测试内容');
      await memory.disconnectCall(user, id, id, true);
      await memory.pool.query(`UPDATE bio_memory_jobs SET status=$2,
        created_at='2020-01-01'::timestamptz + $3*interval '1 second',
        available_at=now() + $4*interval '1 day' WHERE call_id=$1`, [id, status, order, delayed ? 1 : -1]);
    }
    async function state(id) {
      return (await memory.pool.query('SELECT status,attempts FROM bio_memory_jobs WHERE call_id=$1', [id])).rows[0];
    }

    await t.test('twenty failed heads do not starve the next user; authenticated retry unblocks only its owner', async () => {
      await reset();
      for (let i = 0; i < 20; i++) {
        await enqueue(`blocked-${i}`, `failed-${i}`, i * 2, 'failed');
        await enqueue(`blocked-${i}`, `later-${i}`, i * 2 + 1);
      }
      await enqueue('healthy', 'healthy', 100);
      await worker.tick();
      assert.deepEqual(organized, [{ user: 'healthy', callId: 'healthy' }]);
      assert.equal((await state('healthy')).status, 'done');
      for (let i = 0; i < 20; i++) {
        assert.deepEqual(await state(`failed-${i}`), { status: 'failed', attempts: 0 });
        assert.deepEqual(await state(`later-${i}`), { status: 'pending', attempts: 0 });
      }
      const controller = new MemoryController(memory);
      const request = { headers: { authorization: 'Bearer test-token' } };
      await assert.rejects(controller.retry('failed-1', request), /Failed job not found/);
      await controller.retry('failed-0', request);
      await worker.tick();
      await worker.tick();
      assert.deepEqual(organized.map(job => job.callId), ['healthy', 'failed-0', 'later-0']);
      assert.equal((await state('failed-1')).status, 'failed');
    });

    await t.test('heads waiting for retry do not occupy the candidate window or allow later jobs to overtake', async () => {
      await reset();
      for (let i = 0; i < 20; i++) {
        await enqueue(`delayed-${i}`, `wait-${i}`, i * 2, 'pending', true);
        await enqueue(`delayed-${i}`, `tail-${i}`, i * 2 + 1);
      }
      await enqueue('ready', 'ready', 100);
      await worker.tick();
      assert.deepEqual(organized.map(job => job.callId), ['ready']);
      assert.equal((await memory.pool.query("SELECT count(*)::int AS count FROM bio_memory_jobs WHERE call_id<>'ready' AND attempts<>0")).rows[0].count, 0);
    });

    await t.test('done heads are skipped and equal timestamps use call id order', async () => {
      await reset();
      await enqueue('ordered', '0-done', 0, 'done');
      await enqueue('ordered', 'b-second', 1);
      await enqueue('ordered', 'a-first', 1);
      await enqueue('other', 'c-other', 2);
      for (let i = 0; i < 4; i++) await worker.tick();
      assert.deepEqual(organized.map(job => job.callId), ['a-first', 'b-second', 'c-other']);
    });

    await t.test('backlog larger than the candidate window drains without overtaking', async () => {
      await reset();
      for (let i = 0; i < 23; i++) {
        await enqueue(`backlog-${i}`, `head-${i}`, i);
        await enqueue(`backlog-${i}`, `next-${i}`, 100 + i);
      }
      for (let i = 0; i < 46; i++) await worker.tick();
      assert.deepEqual(organized.map(job => job.callId), [
        ...Array.from({ length: 23 }, (_, i) => `head-${i}`),
        ...Array.from({ length: 23 }, (_, i) => `next-${i}`),
      ]);
      assert.equal((await memory.pool.query("SELECT count(*)::int AS count FROM bio_memory_jobs WHERE status<>'done'")).rows[0].count, 0);
    });

    await t.test('queue heads are rechecked under the user lock after candidate selection', async () => {
      await reset();
      await enqueue('changed', 'changed-head', 0);
      await enqueue('changed', 'changed-tail', 1);
      await enqueue('unchanged', 'unchanged', 2);
      const connect = memory.pool.connect;
      let changed = false;
      // Candidate selection uses the pool query; the worker then checks out a lock connection.
      memory.pool.connect = function (...args) {
        if (args.length || changed) return connect.apply(this, args);
        changed = true;
        return connect.call(this).then(async client => {
          await client.query("UPDATE bio_memory_jobs SET status='failed' WHERE call_id='changed-head'");
          return client;
        });
      };
      try { await worker.tick(); } finally { memory.pool.connect = connect; }
      assert.deepEqual(organized.map(job => job.callId), ['unchanged']);
      assert.deepEqual(await state('changed-tail'), { status: 'pending', attempts: 0 });
    });

    await t.test('active locks prevent duplicate work; abandoned running jobs resume before their successors', async () => {
      await reset();
      await enqueue('locked', 'running', 0, 'running');
      await enqueue('locked', 'successor', 1);
      await enqueue('unlocked', 'unlocked', 2);
      const lock = await memory.pool.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(hashtext($1))', ['memory-worker:locked']);
        await worker.tick();
        assert.deepEqual(organized.map(job => job.callId), ['unlocked']);
        assert.deepEqual(await state('running'), { status: 'running', attempts: 0 });
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', ['memory-worker:locked']);
        lock.release();
      }
      await worker.tick();
      await worker.tick();
      assert.deepEqual(organized.map(job => job.callId), ['unlocked', 'running', 'successor']);
    });
  } finally {
    await memory?.onModuleDestroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

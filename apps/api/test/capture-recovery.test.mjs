import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';
import { CaptureRecovery } from '../dist/voice/capture-recovery.js';
import { DurableAsr } from '../dist/voice/durable-asr.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('background recovery persists text, coordinates takeover and retains audio across failure/restart', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL });
  const schema = `recovery_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.MEMORY_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`);
  const memory = new MemoryService(new ConfigService({ MEMORY_DATABASE_URL: url.toString() }));
  await memory.onModuleInit();
  const events = []; let opens = 0, replays = 0, fail = false, gate, entered;
  const provider = { async open(_result, signal) {
    opens++; const values = [];
    return { write() {}, close() {}, async replay(pcm) {
      replays++; values.push(pcm[0]); entered?.resolve();
      if (gate) await gate.promise;
      signal.throwIfAborted(); if (fail) throw new Error('provider offline');
    }, async finish() { return values.join(','); } };
  } };
  const worker = new CaptureRecovery(memory.pool, provider, e => events.push(e));
  async function capture() {
    const user = randomUUID(), call = randomUUID();
    await memory.beginCall(user, call, 'first');
    const store = memory.captureStore(user, call, 'first'), saved = await store.load();
    return { user, call, store, id: saved.id };
  }
  try {
    await t.test('live calls are excluded; disconnected recordings are ready before any restore request', async () => {
      const c = await capture();
      await c.store.append(c.id, 1, new Uint8Array([1, 0])); await c.store.seal(c.id, 0, 1, '已保存的开头');
      await c.store.append(c.id, 2, new Uint8Array([2, 0]));
      assert.equal(await worker.runOnce(), false); assert.equal(opens, 0);
      await memory.disconnectCall(c.user, c.call, 'first', false);
      assert.equal(await worker.runOnce(), true);
      assert.equal(await c.store.text(c.id), '已保存的开头\n2');
      assert.equal((await memory.pool.query('SELECT count(*)::int AS n FROM bio_memory_messages WHERE user_id=$1', [c.user])).rows[0].n, 0, 'background work must not submit a message or invoke Agent');
      await memory.resumeCall(c.user, c.call, 'second');
      const before = replays;
      const durable = new DurableAsr(provider, memory.captureStore(c.user, c.call, 'second', c.id), () => {});
      const stream = await durable.open(() => {}, new AbortController().signal);
      assert.equal(replays, before, 'prepared text must not require audio replay on restore');
      assert.equal(await stream.finish(), '已保存的开头\n2'); stream.close(); await durable.settled();
    });
    await t.test('a user returning mid-task waits for that result; another worker cannot duplicate it', async () => {
      const c = await capture(); await c.store.append(c.id, 1, new Uint8Array([3, 0]));
      await memory.disconnectCall(c.user, c.call, 'first', false);
      gate = deferred(); entered = deferred();
      const work = worker.runOnce(); await entered.promise;
      const competitor = new CaptureRecovery(memory.pool, provider);
      assert.equal(await competitor.runOnce(), false);
      await memory.resumeCall(c.user, c.call, 'second');
      let loaded = false;
      const store = memory.captureStore(c.user, c.call, 'second', c.id);
      const load = store.load().then(value => { loaded = true; return value; });
      await new Promise(r => setTimeout(r, 30)); assert.equal(loaded, false);
      gate.resolve(); assert.equal(await work, true); gate = undefined; entered = undefined;
      const snapshot = await load;
      assert.equal(snapshot.frames.length, 0); assert.equal(snapshot.sequence, 1); assert.equal(snapshot.block, 1);
      assert.equal(await store.text(c.id), '3');
      assert.equal(await store.append(c.id, 1, new Uint8Array([3, 0])), false, 'lost ACK remains deduplicated after background sealing');
    });
    await t.test('failure preserves draft and audio; a fresh worker discovers the persisted task', async () => {
      const c = await capture(); await c.store.append(c.id, 1, new Uint8Array([4, 0])); await c.store.checkpoint(c.id, '未确认草稿');
      await memory.disconnectCall(c.user, c.call, 'first', false);
      fail = true; assert.equal(await worker.runOnce(), false);
      const row = (await memory.pool.query('SELECT draft,block FROM bio_voice_captures WHERE id=$1', [c.id])).rows[0];
      assert.deepEqual(row, { draft: '未确认草稿', block: 0 });
      assert.equal((await memory.pool.query('SELECT count(*)::int AS n FROM bio_voice_capture_audio WHERE capture_id=$1', [c.id])).rows[0].n, 1);
      fail = false; const restarted = new CaptureRecovery(memory.pool, provider);
      assert.equal(await restarted.runOnce(), true); assert.equal(await c.store.text(c.id), '4');
      assert.equal(await restarted.runOnce(), false, 'completed tasks are not transcribed again');
    });
    await t.test('long tails are checkpointed in bounded blocks without dropping later frames', async () => {
      const c = await capture();
      for (let i = 1; i <= 31; i++) { const pcm = new Uint8Array(32000); pcm[0] = i; await c.store.append(c.id, i, pcm); }
      // Simulate an API crash: no close event, just an abandoned heartbeat.
      await memory.pool.query("UPDATE bio_memory_calls SET touched_at=now()-interval '6 minutes' WHERE id=$1", [c.call]);
      const restarted = new CaptureRecovery(memory.pool, provider);
      assert.equal(await restarted.runOnce(), true);
      assert.deepEqual((await memory.pool.query('SELECT sequence FROM bio_voice_capture_audio WHERE capture_id=$1 ORDER BY sequence', [c.id])).rows, Array.from({length: 23}, (_, i) => ({sequence: i + 9})));
      assert.equal(await restarted.runOnce(), true);
      assert.equal(await restarted.runOnce(), true);
      assert.equal(await restarted.runOnce(), true);
      assert.equal(await c.store.text(c.id), [1,9,17,25].map(start => Array.from({length: Math.min(8, 32-start)}, (_, i) => start+i).join(',')).join('\n'));
      assert.equal(await restarted.runOnce(), false);
    });
    assert.ok(events.some(e => e.code === 'capture_recovery_retry'));
  } finally {
    gate?.resolve(); await worker.stop(); await memory.onModuleDestroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

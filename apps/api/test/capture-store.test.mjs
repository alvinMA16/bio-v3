import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';

test('PostgreSQL capture recovery: fencing, atomic block checkpoint, expired-call recovery and idempotent submission', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL });
  const schema = `capture_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.MEMORY_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`);
  const memory = new MemoryService(new ConfigService({ MEMORY_DATABASE_URL: url.toString() }));
  await memory.onModuleInit();
  const user = randomUUID(), other = randomUUID(), call = randomUUID();
  try {
    const conversation = await memory.beginCall(user, call, 'first');
    const store = memory.captureStore(user, call, 'first');
    const draft = await store.load();
    assert.equal(await store.append(draft.id, 1, new Uint8Array([1, 0])), true);
    assert.equal(await store.append(draft.id, 1, new Uint8Array([1, 0])), false);
    await assert.rejects(store.append(draft.id, 3, new Uint8Array([3, 0])), /gap/);
    await store.checkpoint(draft.id, '第一部分');
    await store.seal(draft.id, 0, 1, '第一部分。');
    await store.append(draft.id, 2, new Uint8Array([2, 0]));
    await store.checkpoint(draft.id, '后半段还没说完');
    await memory.disconnectCall(user, call, 'first', false);
    const independentCall = randomUUID();
    await memory.beginCall(user, independentCall, 'independent');
    const independent = await memory.captureStore(user, independentCall, 'independent').load();
    assert.notEqual(independent.id, draft.id, 'a new call must not implicitly adopt another call’s unfinished capture');
    assert.equal(independent.sequence, 0);
    const preserved = (await memory.pool.query('SELECT sequence,draft FROM bio_voice_captures WHERE id=$1', [draft.id])).rows[0];
    assert.equal(preserved.sequence, 2); assert.equal(preserved.draft, '后半段还没说完');
    await memory.resumeCall(user, call, 'second');
    await assert.rejects(store.append(draft.id, 3, new Uint8Array([3, 0])), /replaced/);
    const resumed = memory.captureStore(user, call, 'second', draft.id);
    const snapshot = await resumed.load();
    assert.equal(snapshot.sequence, 2); assert.equal(snapshot.text, '后半段还没说完');
    assert.deepEqual(snapshot.frames.map(f => [...f.pcm]), [[2, 0]]);
    assert.equal(await resumed.text(draft.id), '第一部分。');
    // A different account cannot claim or modify this capture.
    const otherCall = randomUUID(); await memory.beginCall(other, otherCall, 'other');
    const foreign = memory.captureStore(other, otherCall, 'other', draft.id);
    assert.notEqual((await foreign.load()).id, draft.id);
    await assert.rejects(foreign.append(draft.id, 3, new Uint8Array([3, 0])));
    // Expiry changes the call, but must not delete an unfinished story.
    await memory.disconnectCall(user, call, 'second', true);
    const next = await memory.resumeCall(user, call, 'third'); assert.notEqual(next.callId, call);
    const restored = memory.captureStore(user, next.callId, 'third', draft.id);
    assert.equal((await restored.load()).id, draft.id);
    await restored.seal(draft.id, 1, 2, '后半段。');
    const text = await restored.text(draft.id);
    const scope = { userId: user, callId: next.callId, captureId: draft.id };
    await memory.archive(scope, next.conversationId, randomUUID(), randomUUID(), 'user', text);
    await memory.archive(scope, next.conversationId, randomUUID(), randomUUID(), 'user', text);
    const rows = (await memory.pool.query('SELECT body FROM bio_memory_messages WHERE user_id=$1', [user])).rows;
    assert.deepEqual(rows, [{ body: '第一部分。\n后半段。' }]);
    assert.notEqual((await memory.captureStore(user, next.callId, 'third', draft.id).load()).id, draft.id);
    assert.ok(conversation);
  } finally {
    for (const owner of [user, other]) {
      await memory.pool.query('DELETE FROM bio_voice_captures WHERE user_id=$1', [owner]);
      await memory.pool.query('DELETE FROM bio_memory_messages WHERE user_id=$1', [owner]);
      await memory.pool.query('DELETE FROM bio_memory_jobs WHERE user_id=$1', [owner]);
      await memory.pool.query('DELETE FROM bio_memory_calls WHERE user_id=$1', [owner]);
      await memory.pool.query('DELETE FROM bio_memory_sessions WHERE user_id=$1', [owner]);
      await memory.pool.query('DELETE FROM bio_memory_users WHERE id=$1', [owner]);
    }
    await memory.onModuleDestroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

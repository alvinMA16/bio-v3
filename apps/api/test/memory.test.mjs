import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';
import { MemoryWorker } from '../dist/memory/memory-worker.js';
import { validateBatch } from '../dist/memory/memory-types.js';
import { createMemoryTools } from '../dist/memory/memory-tools.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { AgentService } from '../dist/agent/agent.service.js';

test('memory has exactly three detailed types; preferences live in a bounded overview', () => {
  const id = randomUUID();
  const good = { changes: [], overview: { preferences: [{ text: '保留口语', sources: [id] }], entries: [] } };
  validateBatch(good);
  assert.throws(() => validateBatch({ ...good, changes: [{ id, expectedVersion: 0, type: 'profile', title: '偏好', summary: '偏好', body: '正文', active: true, sources: [id] }] }));
  assert.throws(() => validateBatch({ ...good, overview: { preferences: Array.from({ length: 20 }, () => ({ text: '字'.repeat(200), sources: [id] })), entries: [] } }));
});

test('identity is server-bound and database memory has no implicit default user', () => {
  const config = new ConfigService({ MEMORY_DATABASE_URL: 'postgres://unused', MEMORY_AUTH_TOKENS: '{"token-a":"alice","token-b":"bob"}' });
  const memory = new MemoryService(config);
  assert.equal(memory.identity('Bearer token-a'), 'alice');
  assert.equal(memory.identity(undefined, 'bio-voice,bio-auth.token-b'), 'bob');
  assert.throws(() => memory.identity());
  assert.throws(() => memory.identity('Bearer alice'));
  return memory.onModuleDestroy();
});

test('PostgreSQL memory lifecycle, transactions, isolation and real Pi tools', { skip: !process.env.MEMORY_TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const prefix = randomUUID(); const user = `${prefix}-alice`; const other = `${prefix}-bob`;
  const directory = await mkdtemp(join(tmpdir(), 'bio-memory-test-'));
  const config = new ConfigService({ MEMORY_DATABASE_URL: process.env.MEMORY_TEST_DATABASE_URL, MEMORY_WORKER_ENABLED: 'false', AGENT_DATA_DIR: directory,
    MODEL_PROVIDER: 'openai-compatible', LLM_MODEL: 'mock-memory', LLM_API_KEY: 'test' });
  const memory = new MemoryService(config); await memory.onModuleInit();
  const call = `call-${prefix}`; const connection = randomUUID();
  const conversation = await memory.beginCall(user, call, connection);
  const scope = { userId: user, callId: call }; const message = randomUUID(); const memId = randomUUID();
  const run = randomUUID();
  let server;
  try {
    await t.test('new call pins overview and stores original without writing long-term memory', async () => {
      await memory.archive(scope, conversation, run, message, 'user', '请保留我的口语。父亲在一九九八年送我去车站。');
      assert.deepEqual(await memory.overview(user), { preferences: [], entries: [] });
      assert.equal((await memory.pool.query('SELECT * FROM bio_memory_jobs WHERE call_id=$1', [call])).rowCount, 0);
      assert.equal(await memory.beginCall(user, call, connection), conversation);
      await assert.rejects(memory.beginCall(other, call, 'other'));
      await assert.rejects(memory.beginCall(user, call, 'second-live-connection'));
    });
    await t.test('disconnect can resume; explicit hangup queues one durable job', async () => {
      await memory.disconnectCall(user, call, connection, false);
      assert.equal((await memory.pool.query('SELECT * FROM bio_memory_jobs WHERE call_id=$1', [call])).rowCount, 0);
      await memory.beginCall(user, call, 'reconnected');
      await memory.disconnectCall(user, call, connection, true); // stale connection cannot end resumed call
      assert.equal((await memory.pool.query('SELECT status FROM bio_memory_calls WHERE id=$1', [call])).rows[0].status, 'active');
      await memory.disconnectCall(user, call, 'reconnected', true);
      await memory.disconnectCall(user, call, 'reconnected', true);
      assert.equal((await memory.pool.query('SELECT * FROM bio_memory_jobs WHERE call_id=$1', [call])).rowCount, 1);
      await assert.rejects(memory.beginCall(user, call, 'later'));
    });
    const batch = { changes: [{ id: memId, expectedVersion: 0, type: 'story', title: '父亲送站', summary: '1998年父亲送站', body: '父亲在1998年送用户去车站。', active: true, sources: [message] }],
      overview: { preferences: [{ text: '整理时保留口语', sources: [message] }], entries: [{ memoryId: memId, summary: '父亲送站的经历' }] } };
    await t.test('atomic commit rejects hallucinated sources and invalid overview without partial writes', async () => {
      const c = await memory.pool.connect();
      try {
        await assert.rejects(memory.commit(c, user, call, 0, { ...batch, overview: { ...batch.overview, entries: [{ memoryId: randomUUID(), summary: '不存在' }] } }, {}));
        assert.equal((await memory.search(user, '父亲')).items.length, 0);
        await assert.rejects(memory.commit(c, user, call, 0, { ...batch, changes: [{ ...batch.changes[0], sources: [randomUUID()] }] }, {}));
        await memory.commit(c, user, call, 0, batch, {});
        await assert.rejects(memory.commit(c, user, call, 0, batch, {}));
      } finally { c.release(); }
    });
    await t.test('Chinese retrieval and original-source reads are bounded to the owner', async () => {
      assert.equal((await memory.search(user, '父亲')).items[0].id, memId);
      assert.equal((await memory.search(user, '%')).items.length, 0);
      assert.equal((await memory.search(other, '父亲')).items.length, 0);
      await assert.rejects(memory.read(other, memId));
      await assert.rejects(memory.source(other, message));
      await assert.rejects(memory.source(other, undefined, call));
      assert.equal((await memory.read(user, memId)).sources[0].source_ref, message);
      assert.match((await memory.source(user, message)).messages[0].text, /一九九八/);
      const tools = createMemoryTools(memory, user);
      assert.deepEqual(tools.map(t => t.name), ['search_memory', 'read_memory', 'read_source']);
      assert.equal(tools.some(t => /write|update/.test(t.name)), false);
    });
    await t.test('correction creates a new revision and leaves the original source available', async () => {
      const corrected = randomUUID();
      const correctionCall = `correction-${prefix}`; const correctionConversation = await memory.beginCall(user, correctionCall, 'correction');
      await memory.archive({ userId: user, callId: correctionCall }, correctionConversation, randomUUID(), corrected, 'user', '我说错了，是1999年。');
      await memory.disconnectCall(user, correctionCall, 'correction', true);
      const updated = structuredClone(batch); updated.changes[0].expectedVersion = 1;
      updated.changes[0].summary = '1999年父亲送站'; updated.changes[0].body = '用户明确纠正为1999年。'; updated.changes[0].sources.push(corrected);
      const c = await memory.pool.connect(); try { await memory.commit(c, user, correctionCall, 1, updated, {}); } finally { c.release(); }
      assert.equal((await memory.read(user, memId)).version, 2);
      assert.match((await memory.read(user, memId)).body, /1999/);
      assert.equal((await memory.pool.query('SELECT * FROM bio_memory_revisions WHERE memory_id=$1', [memId])).rowCount, 2);
      assert.match((await memory.source(user, message)).messages.find(m => m.source_ref === message).text, /一九九八/);
    });
    await t.test('SDK snapshots recover on another directory and reject concurrent or foreign ownership', async () => {
      const first = join(directory, 'first'); const second = join(directory, 'second');
      const release = await memory.acquireSession(user, conversation, randomUUID(), first);
      await writeFile(join(first, 'session.jsonl'), 'persisted-sdk-state');
      await assert.rejects(memory.acquireSession(user, conversation, randomUUID(), second));
      await release();
      await assert.rejects(memory.acquireSession(other, conversation, randomUUID(), second));
      const release2 = await memory.acquireSession(user, conversation, randomUUID(), second);
      assert.equal(await readFile(join(second, 'session.jsonl'), 'utf8'), 'persisted-sdk-state');
      await release2();
    });

    let mode = 'chat'; const requests = [];
    server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw); requests.push(input);
      const toolMessages = input.messages.filter(m => m.role === 'tool');
      let tool; let text = '我记得你喜欢保留口语。';
      if (mode === 'worker') {
        const initial = input.messages.find(m => m.role === 'user');
        const task = JSON.parse(typeof initial.content === 'string' ? initial.content : initial.content[0].text);
        if (!toolMessages.length) tool = { name: 'read_source', args: { callId: task.callId } };
        else if (toolMessages.length === 1) {
          const newSource = JSON.parse(toolMessages[0].content).messages.find(m => m.role === 'user').source_ref;
          tool = { name: 'propose_memory_batch', args: { noChange: false, batch: JSON.stringify({ changes: [{ id: task.unusedIds[0], expectedVersion: 0, type: 'interaction', title: '最近聊到父亲', summary: '聊了父亲', body: '本次用户聊到父亲。', active: true, sources: [newSource] }], overview: task.overview }) } };
        } else text = '候选已提交。';
      } else if (!toolMessages.length) tool = { name: 'read_memory', args: { memoryId: memId } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-memory', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: 'assistant' });
      if (tool) send({ tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
      else send({ content: text });
      send({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); config.set('LLM_BASE_URL', `http://127.0.0.1:${server.address().port}`);
    await t.test('real Pi chat loads preferences and tools, archives originals, and never organizes per turn', async () => {
      const newCall = `agent-${prefix}`; const conv = await memory.beginCall(user, newCall, 'agent');
      const storage = new AgentStorage(config); const factory = new PiSessionFactory(config, storage, {}, memory);
      const agent = new AgentService(factory, storage, config, memory);
      const result = await agent.run({ conversationId: conv, message: '我们继续聊父亲。' }, undefined, undefined, { userId: user, callId: newCall });
      assert.match(requests[0].messages[0].content, /整理时保留口语/);
      assert.ok(requests[0].tools.some(t => t.function.name === 'read_source'));
      assert.ok(!requests[0].tools.some(t => t.function.name === 'propose_memory_batch'));
      assert.ok(!result.message.content.includes(memId));
      assert.equal((await memory.pool.query('SELECT * FROM bio_memory_jobs WHERE call_id=$1', [newCall])).rowCount, 0);
      await memory.disconnectCall(user, newCall, 'agent', true);
    });
    await t.test('real Pi background worker reads the call then commits a validated proposal', async () => {
      mode = 'worker'; requests.length = 0;
      const worker = new MemoryWorker(memory, config);
      await worker.tick();
      const job = (await memory.pool.query('SELECT * FROM bio_memory_jobs WHERE call_id=$1', [`agent-${prefix}`])).rows[0];
      assert.equal(job.status, 'done');
      assert.equal((await memory.search(user, '最近聊到父亲', 'interaction')).items.length, 1);
      assert.ok(requests.length >= 3);
      await worker.tick();
      assert.equal((await memory.search(user, '最近聊到父亲', 'interaction')).items.length, 1);
    });
    await t.test('long source messages and call pages expose explicit continuation without losing text', async () => {
      const longCall = `long-${prefix}`; const conv = await memory.beginCall(user, longCall, 'long');
      const firstId = randomUUID(); const original = '甲'.repeat(4100) + '结尾';
      await memory.archive({ userId: user, callId: longCall }, conv, randomUUID(), firstId, 'user', original);
      for (let i = 0; i < 9; i++) await memory.archive({ userId: user, callId: longCall }, conv, randomUUID(), randomUUID(), 'user', `第${i}段`);
      const first = await memory.source(user, undefined, longCall);
      assert.equal(first.messages.length, 8); assert.equal(typeof first.nextAfter, 'number');
      assert.equal(first.messages[0].nextTextOffset, 4000);
      const tail = await memory.source(user, firstId, undefined, 0, 4000);
      const target = tail.messages.find(m => m.source_ref === firstId);
      assert.equal(first.messages[0].text + target.text, original); assert.equal(target.nextTextOffset, null);
      const next = await memory.source(user, undefined, longCall, first.nextAfter);
      assert.equal(next.messages.length, 2); assert.equal(next.nextAfter, null);
    });
    await t.test('failed organization preserves overview and enters bounded retry state', async () => {
      const failedCall = `failed-${prefix}`; const conv = await memory.beginCall(user, failedCall, 'failed');
      await memory.archive({ userId: user, callId: failedCall }, conv, randomUUID(), randomUUID(), 'user', '新内容');
      await memory.disconnectCall(user, failedCall, 'failed', true);
      const before = await memory.overview(user);
      const worker = new MemoryWorker(memory, config); worker.organize = async () => { throw new Error('simulated provider failure'); };
      await worker.tick();
      let job = (await memory.pool.query('SELECT status,attempts,error FROM bio_memory_jobs WHERE call_id=$1', [failedCall])).rows[0];
      assert.equal(job.status, 'pending'); assert.equal(job.attempts, 1);
      await memory.pool.query('UPDATE bio_memory_jobs SET attempts=2,available_at=now() WHERE call_id=$1', [failedCall]);
      await worker.tick(); job = (await memory.pool.query('SELECT status,attempts,error FROM bio_memory_jobs WHERE call_id=$1', [failedCall])).rows[0];
      assert.equal(job.status, 'failed'); assert.equal(job.attempts, 3);
      assert.deepEqual(await memory.overview(user), before); assert.ok(!job.error.includes('simulated'));
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    // This suite owns only its random users; never drop the database or unrelated data.
    const c = await memory.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM bio_memory_sources WHERE memory_id IN (SELECT id FROM bio_memories WHERE user_id=ANY($1))', [[user, other]]);
      await c.query('DELETE FROM bio_memory_revisions WHERE memory_id IN (SELECT id FROM bio_memories WHERE user_id=ANY($1))', [[user, other]]);
      for (const table of ['bio_memories', 'bio_memory_overview_revisions', 'bio_memory_jobs', 'bio_memory_messages', 'bio_memory_runs', 'bio_memory_calls', 'bio_memory_sessions']) await c.query(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [[user, other]]);
      await c.query('DELETE FROM bio_memory_users WHERE id=ANY($1)', [[user, other]]); await c.query('COMMIT');
    } finally { c.release(); await memory.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); }
  }
});

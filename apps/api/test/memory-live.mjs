// Opt-in paid-model acceptance check. Uses synthetic data and a dedicated test DB.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';
import { MemoryWorker } from '../dist/memory/memory-worker.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { AgentService } from '../dist/agent/agent.service.js';

assert.equal(process.env.MEMORY_LIVE_EVAL, 'true', 'Set MEMORY_LIVE_EVAL=true to opt in to paid model calls');
assert.ok(process.env.MEMORY_TEST_DATABASE_URL, 'A dedicated MEMORY_TEST_DATABASE_URL is required');
const directory = await mkdtemp(join(tmpdir(), 'bio-memory-eval-'));
const user = `memory-eval-${randomUUID()}`;
const config = new ConfigService({ ...process.env,
  MEMORY_DATABASE_URL: process.env.MEMORY_TEST_DATABASE_URL,
  MEMORY_WORKER_ENABLED: 'false', AGENT_DATA_DIR: directory,
});
const memory = new MemoryService(config);
const worker = new MemoryWorker(memory, config);
const storage = new AgentStorage(config);
const agent = new AgentService(new PiSessionFactory(config, storage, {}, memory), storage, config, memory);
let initialized = false;

async function begin() {
  const callId = randomUUID();
  return { callId, conversationId: await memory.beginCall(user, callId, 'eval') };
}

async function organize(call) {
  await memory.disconnectCall(user, call.callId, 'eval', true);
  const ids = (await memory.pool.query('SELECT id FROM bio_memory_messages WHERE user_id=$1 AND call_id=$2 ORDER BY ordinal', [user, call.callId])).rows.map(row => row.id);
  const before = (await memory.pool.query('SELECT version,overview FROM bio_memory_users WHERE id=$1', [user])).rows[0];
  // Target only this evaluation's call, never poll or process unrelated jobs.
  const proposal = await worker.organize(user, call.callId, before.overview, ids);
  console.log('Organization:', JSON.stringify({ changes: proposal.batch?.changes.length ?? 0, preferences: proposal.batch?.overview.preferences.length ?? 0, summary: proposal.callSummary.summary }));
  const client = await memory.pool.connect();
  try { await memory.commit(client, user, call.callId, before.version, proposal.batch, proposal.usage, proposal.callSummary); }
  finally { client.release(); }
}

async function say(call, message) {
  const result = await agent.run({ conversationId: call.conversationId, message }, undefined, undefined, { userId: user, callId: call.callId });
  const text = result.message.content;
  assert.ok(!text.includes(call.callId), 'Internal call ID leaked into speech');
  return text;
}

try {
  await memory.onModuleInit(); initialized = true;
  const first = await begin();
  await memory.archive({ userId: user, callId: first.callId }, first.conversationId, randomUUID(), randomUUID(), 'user',
    '我第一次参加工作是1998年，在南桥钟表厂做维修学徒，师傅叫林秋岚。请记住，我喜欢你叫我小舟，聊天时一次只问我一个问题。');
  await organize(first);
  assert.ok((await memory.search(user, '南桥')).items.length, 'Story was not persisted');
  assert.match(JSON.stringify(await memory.overview(user)), /小舟/, 'Explicit preference was lost');
  console.log('PASS: first call organized with story, preference and source references');

  const second = await begin();
  assert.notEqual(second.conversationId, first.conversationId);
  const recalled = await say(second, '我第一次工作是哪年、在哪儿、师傅叫什么？');
  assert.match(recalled, /1998|一九九八/);
  assert.match(recalled, /南桥/);
  assert.match(recalled, /林秋岚/);
  console.log('PASS: a new conversation recalls the first call');
  console.log('Synthetic recall:', recalled);
  await say(second, '纠正一下：第一次参加工作是1999年，之前1998年说错了；南桥钟表厂和师傅林秋岚没变。');
  await organize(second);

  const third = await begin();
  const corrected = await say(third, '按我最后纠正的说法，我第一次参加工作究竟是哪年？');
  assert.match(corrected, /1999|一九九九/);
  console.log('Synthetic corrected recall:', corrected);
  const sources = await memory.source(user, undefined, first.callId);
  assert.ok(sources.messages.some(message => message.role === 'user' && message.text.includes('1998')));
  const foreign = `unrelated-${randomUUID()}`;
  assert.deepEqual((await memory.search(foreign, '南桥')).items, []);
  await assert.rejects(memory.source(foreign, undefined, first.callId));
  console.log('PASS: correction recalled, original evidence retained, other user isolated');
  console.log('These synthetic checks do not establish general semantic accuracy.');
} finally {
  if (initialized) {
    const client = await memory.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['bio_memory_sources', 'bio_memory_revisions']) {
        await client.query(`DELETE FROM ${table} WHERE memory_id IN (SELECT id FROM bio_memories WHERE user_id=$1)`, [user]);
      }
      for (const table of ['bio_memories', 'bio_memory_overview_revisions', 'bio_memory_jobs', 'bio_memory_messages', 'bio_memory_runs', 'bio_memory_calls', 'bio_memory_sessions']) {
        await client.query(`DELETE FROM ${table} WHERE user_id=$1`, [user]);
      }
      await client.query('DELETE FROM bio_memory_users WHERE id=$1', [user]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); await memory.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); }
  } else {
    await memory.onModuleDestroy(); await rm(directory, { recursive: true, force: true });
  }
}

// Explicit local smoke test using the configured real model, isolated user and test database.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '../dist/memory/memory.service.js';
import { MemoryWorker } from '../dist/memory/memory-worker.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { AgentService } from '../dist/agent/agent.service.js';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
if (!process.env.LOCAL_VERIFY_DATABASE_URL) throw new Error('Set LOCAL_VERIFY_DATABASE_URL to an isolated test database.');
const directory = await mkdtemp(join(tmpdir(), 'bio-experience-'));
const user = `verify-${randomUUID()}`;
const config = new ConfigService({ ...process.env, MEMORY_DATABASE_URL: process.env.LOCAL_VERIFY_DATABASE_URL, AGENT_DATA_DIR: directory, MEMORY_WORKER_ENABLED: 'false' });
const memory = new MemoryService(config);
const worker = new MemoryWorker(memory, config);
try {
  await memory.onModuleInit();
  const storage = new AgentStorage(config);
  const agent = new AgentService(new PiSessionFactory(config, storage, {}, memory), storage, config, memory);
  const first = `call-${randomUUID()}`;
  const conversationId = await memory.beginCall(user, first, 'verify');
  const result = await agent.run({ conversationId, message: '我最近养了一盆薄荷，给它起名叫小青。请把这件事整理成一篇两段的短文，现在生成文稿，不要加我没有讲过的细节。' }, undefined, undefined, { userId: user, callId: first });
  assert.ok(result.events.some(event => event.type === 'tool.completed' && event.name === 'update_content' && !event.isError), 'Real model must write the document');
  assert.ok((await memory.manuscripts(user)).some(item => item.document.blocks.some(block => block.text.includes('小青'))));
  console.log('PASS real model created a persisted manuscript');
  await memory.disconnectCall(user, first, 'verify', true);
  const ids = (await memory.pool.query('SELECT id FROM bio_memory_messages WHERE user_id=$1 AND call_id=$2', [user, first])).rows.map(row => row.id);
  const proposal = await worker.organize(user, first, await memory.overview(user), ids);
  const client = await memory.pool.connect();
  try { await memory.commit(client, user, first, 0, proposal.batch, proposal.usage, proposal.callSummary); } finally { client.release(); }
  assert.equal((await memory.pool.query('SELECT status FROM bio_memory_jobs WHERE call_id=$1', [first])).rows[0].status, 'done');
  console.log('PASS real model organized call with validated sources');
  const second = `call-${randomUUID()}`;
  const next = await memory.beginCall(user, second, 'verify');
  const recalled = await agent.run({ conversationId: next, message: '你记得上次我给盆栽起了什么名字吗？' }, undefined, undefined, { userId: user, callId: second });
  assert.match(recalled.message.content, /小青/);
  console.log('PASS next call recalled the name without being told again');
} finally {
  await worker.onModuleDestroy();
  if (memory.pool) {
    const c = await memory.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM bio_memory_sources WHERE memory_id IN (SELECT id FROM bio_memories WHERE user_id=$1)', [user]);
      await c.query('DELETE FROM bio_memory_revisions WHERE memory_id IN (SELECT id FROM bio_memories WHERE user_id=$1)', [user]);
      for (const table of ['bio_memories', 'bio_memory_overview_revisions', 'bio_memory_jobs', 'bio_memory_messages', 'bio_memory_runs', 'bio_memory_calls', 'bio_memory_sessions']) await c.query(`DELETE FROM ${table} WHERE user_id=$1`, [user]);
      await c.query('DELETE FROM bio_memory_users WHERE id=$1', [user]);
      await c.query('COMMIT');
    } finally { c.release(); }
  }
  await memory.onModuleDestroy();
  await rm(directory, { recursive: true, force: true });
}

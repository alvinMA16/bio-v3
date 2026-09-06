import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AgentService } from '../dist/agent/agent.service.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { AgentController } from '../dist/agent/agent.controller.js';
import { ChatController } from '../dist/chat/chat.controller.js';
import { ChatService } from '../dist/chat/chat.service.js';

let root, mock, app, config, service, storage, factory, baseUrl;
const requests = [];
let onHeldRequest;

function sendCompletion(response, { text = '你好，我是 Bio。', tool } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) chunk({ tool_calls: [{ index: 0, id: 'call_panel', type: 'function', function: {
    name: 'show_panel', arguments: JSON.stringify({ panelId: 'draft', title: '文章草稿', content: '# 标题\n这是正文。' }),
  } }] });
  else chunk({ content: text });
  chunk({}, tool ? 'tool_calls' : 'stop');
  response.write(`data: ${JSON.stringify({ choices: [], usage: {
    prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 2 },
  } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'bio-pi-test-'));
  mock = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const last = payload.messages.at(-1);
    const lastText = typeof last?.content === 'string' ? last.content : last?.content?.map((part) => part.text ?? '').join('');
    if (lastText === 'HOLD') {
      onHeldRequest?.();
      return;
    }
    if (lastText === 'FAIL') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'mock provider failure', type: 'invalid_request_error' } }));
      return;
    }
    sendCompletion(response, {
      tool: lastText === 'SHOW_PANEL',
      text: payload.tools?.length ? '你好，我是 Bio。' : 'COMPACTED_MEMORY_MARKER',
    });
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  config = new ConfigService({
    AGENT_DATA_DIR: root, DEEPSEEK_API_KEY: 'local-test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
    DEEPSEEK_MODEL: 'deepseek-v4-flash', AGENT_TIMEOUT_MS: 20000,
  });
  const module = await Test.createTestingModule({
    controllers: [AgentController, ChatController],
    providers: [AgentService, AgentStorage, PiSessionFactory, ChatService, { provide: ConfigService, useValue: config }],
  }).compile();
  app = module.createNestApplication(new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  service = module.get(AgentService);
  storage = module.get(AgentStorage);
  factory = module.get(PiSessionFactory);
});

after(async () => {
  await app?.close();
  mock?.closeAllConnections();
  await new Promise((resolve) => mock?.close(resolve));
  await rm(root, { recursive: true, force: true });
});

async function post(path, body) {
  return fetch(`${baseUrl}/api/v1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('existing endpoint uses Pi, persists history and isolates conversations', async () => {
  const first = await post('chat/completions', { message: '记住当前暗号：星河', systemPrompt: 'TEST_PERSONA' });
  assert.equal(first.status, 201);
  const result = await first.json();
  assert.equal(result.message.content, '你好，我是 Bio。');
  assert.equal(result.usage.promptTokens, 12);
  assert.equal(result.usage.promptCacheHitTokens, 2);
  const request = requests.at(-1);
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ['show_panel']);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.ok(JSON.stringify(request.messages).includes('TEST_PERSONA'));
  assert.ok(!JSON.stringify(request.messages).includes('Compound Codex'));
  const second = await post('chat/completions', { message: '暗号是什么？', conversationId: result.conversationId });
  assert.equal(second.status, 201);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('星河'));
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('TEST_PERSONA'));
  await service.run({ message: '新会话' });
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes('星河'));
  const saved = await readFile(join(root, 'conversations', result.conversationId, 'session.jsonl'), 'utf8');
  assert.ok(saved.includes('星河'));
  assert.ok(!saved.includes('local-test-key'));
  const traceResponse = await fetch(`${baseUrl}/api/v1/agent/runs/${result.runId}/trace`);
  const trace = await traceResponse.json();
  assert.equal(trace.at(-1).type, 'run.completed');
  assert.deepEqual(trace.map((entry) => entry.sequence), trace.map((_, index) => index + 1));
});

test('real SDK tool loop emits panel events and counts all model calls', async () => {
  const result = await service.run({ message: 'SHOW_PANEL' });
  const panel = result.events.find((event) => event.type === 'panel.updated');
  assert.equal(panel.panel.content, '# 标题\n这是正文。');
  assert.ok(result.events.some((event) => event.type === 'tool.completed' && !event.isError));
  assert.equal(result.usage.totalTokens, 34);
  assert.ok(requests.at(-1).messages.some((message) => message.role === 'tool'));
  assert.ok(storage.readTrace(result.runId).some((entry) => entry.type === 'tool_execution_end'));
});

test('stream endpoint delivers product events and final compatible response', async () => {
  const response = await post('agent/runs/stream', { message: 'SHOW_PANEL' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const chunks = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(chunks[0].event.type, 'run.started');
  assert.ok(chunks.some((chunk) => chunk.event?.type === 'panel.updated'));
  assert.ok(chunks.some((chunk) => chunk.event?.type === 'speech.delta'));
  assert.equal(chunks.at(-1).kind, 'result');
});

test('concurrent requests are rejected; cancellation releases the conversation', async () => {
  const conversationId = randomUUID();
  const controller = new AbortController();
  const held = new Promise((resolve) => { onHeldRequest = resolve; });
  const emitted = [];
  const pending = service.run({ message: 'HOLD', conversationId }, (event) => emitted.push(event), controller.signal);
  const rejection = assert.rejects(pending, /cancelled/);
  await held;
  await assert.rejects(service.run({ message: 'another', conversationId }), /active run/);
  controller.abort();
  await rejection;
  assert.equal(emitted.at(-1).type, 'run.cancelled');
  const resumed = await service.run({ message: '继续', conversationId });
  assert.equal(resumed.events.at(-1).type, 'run.completed');
});

test('SDK compaction preserves original history and restores the compacted context', async () => {
  const conversationId = randomUUID();
  const session = await factory.create(conversationId, undefined, () => {});
  try {
    await session.prompt('请记住：今天我们讨论文章结构。'.repeat(100));
    await session.prompt('接下来讨论语气。'.repeat(30));
    session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 16 } });
    const result = await session.compact('保留用户目标和偏好');
    assert.ok(result.summary);
    assert.equal(session.settingsManager.getCompactionSettings().enabled, true);
  } finally {
    session.dispose();
  }
  const saved = await readFile(join(root, 'conversations', conversationId, 'session.jsonl'), 'utf8');
  assert.ok(saved.includes('今天我们讨论文章结构'));
  assert.ok(saved.includes('"type":"compaction"'));
  await service.run({ message: '继续讨论', conversationId });
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('COMPACTED_MEMORY_MARKER'));
});

test('invalid IDs, empty input, missing runs and provider errors are handled', async () => {
  assert.equal((await post('chat/completions', { message: 'hello', conversationId: '../../escape' })).status, 400);
  assert.equal((await post('chat/completions', { message: '   ' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/v1/agent/runs/${randomUUID()}/trace`)).status, 404);
  const emitted = [];
  await assert.rejects(service.run({ message: 'FAIL' }, (event) => emitted.push(event)), /failed/);
  assert.equal(emitted.at(-1).type, 'run.failed');
  assert.ok(!emitted.some((event) => event.type === 'run.completed'));
});

test('deadline cancels the model request and persists the terminal state', async () => {
  const shortConfig = new ConfigService({ AGENT_TIMEOUT_MS: 100 });
  const timedService = new AgentService(factory, storage, shortConfig);
  const emitted = [];
  await assert.rejects(timedService.run({ message: 'HOLD' }, (event) => emitted.push(event)), /timed out/);
  assert.equal(emitted.at(-1).type, 'run.cancelled');
  assert.equal(storage.readTrace(emitted[0].runId).at(-1).type, 'run.cancelled');
});

test('missing credentials fail with a trace ID instead of a successful response', async () => {
  const noKeyConfig = new ConfigService({ AGENT_DATA_DIR: root, DEEPSEEK_API_KEY: '' });
  const noKeyService = new AgentService(new PiSessionFactory(noKeyConfig, storage), storage, noKeyConfig);
  await assert.rejects(noKeyService.run({ message: 'hello' }), (error) => {
    const response = error.getResponse();
    assert.match(response.message, /DEEPSEEK_API_KEY/);
    assert.equal(storage.readTrace(response.runId).at(-1).type, 'run.failed');
    return true;
  });
});

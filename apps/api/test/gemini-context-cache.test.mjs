import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { GeminiContextCache } from '../dist/models/gemini-context-cache.js';
import { createContextExtension } from '../dist/agent/agent-context.js';
import 'reflect-metadata';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';

const model = { id: 'gemini-3.8-flash', api: 'google-generative-ai', provider: 'bio-gemini', baseUrl: 'https://example.test/v1beta' };
const runtime = version => ({ role: 'user', parts: [{ text: JSON.stringify({ type: 'bio_runtime_context', version }) }] });
const user = text => ({ role: 'user', parts: [{ text }] });
const request = (version = 1, extra = []) => ({ model: model.id, contents: [user('stable history'), ...extra, runtime(version)],
  config: { systemInstruction: 'fixed rules', tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'read_document' }] }], toolConfig: { includeServerSideToolInvocations: true }, temperature: 0.3 } });

function harness(t) {
  const calls = [], creates = [], deletes = [], records = [];
  let failCached = false, partialFailure = false, createFailure = false, holdCreate;
  const client = {
    models: { countTokens: async ({ contents }) => ({ totalTokens: JSON.stringify(contents).length }) },
    caches: {
      create: async p => {
        creates.push(structuredClone(p));
        if (holdCreate) await holdCreate;
        if (createFailure) throw Error('creation unavailable');
        return { name: `cachedContents/test-${creates.length}`, expireTime: new Date(Date.now() + 600000).toISOString(), usageMetadata: { totalTokenCount: 5000 } };
      },
      delete: async ({ name }) => { deletes.push(name); },
    },
  };
  const native = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const p = await options.onPayload(structuredClone(context.request), model); calls.push(p);
      const message = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: model.id, api: model.api, provider: model.provider, timestamp: 1,
        stopReason: 'stop', usage: { input: p.config.cachedContent ? 1000 : 6000, cacheRead: p.config.cachedContent ? 5000 : 0, output: 1, cacheWrite: 0, totalTokens: 6001 } };
      stream.push({ type: 'start', partial: message });
      if (!failCached || !p.config.cachedContent || partialFailure) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'OK', partial: message });
      if (failCached && p.config.cachedContent) stream.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: 'cached content not found' } });
      else stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    });
    return stream;
  };
  const manager = new GeminiContextCache(native, () => client);
  t.after(() => manager.close());
  const run = async (p = request(), scope = 'alice/conversation-1', options = {}) => {
    const stream = manager.stream(scope, (type, data) => records.push({ type, ...data }))(model, { request: p }, { apiKey: 'test-secret', ...options });
    const events = []; for await (const event of stream) events.push(event);
    await setImmediate();
    return { events, result: await stream.result() };
  };
  return { manager, run, calls, creates, deletes, records,
    fail: (partial = false) => { failCached = true; partialFailure = partial; },
    failCreate: () => { createFailure = true; }, hold: p => { holdCreate = p; } };
}

test('runtime is appended after tool results, refreshed once, and never mutates history', async () => {
  let handler;
  createContextExtension(() => '{"type":"bio_runtime_context","version":2}', true)({ on: (_, fn) => { handler = fn; } });
  const messages = [{ role: 'user', content: 'read', timestamp: 1 }, { role: 'toolResult', toolCallId: '1', content: [] }];
  const original = structuredClone(messages);
  const next = handler({ messages });
  assert.deepEqual(messages, original);
  assert.equal(next.messages.at(-1).customType, 'bio_runtime_context');
  assert.equal(next.messages.at(-2).role, 'toolResult');
  assert.equal(handler(next).messages.filter(m => m.customType === 'bio_runtime_context').length, 1);
});

test('cache expansion preserves history, tools, signatures and fresh runtime exactly', async t => {
  const h = harness(t); const first = request();
  first.contents[0].parts.push({ thoughtSignature: 'signature', functionResponse: { name: 'read_document', response: { text: 'saved text' } } });
  await h.run(first);
  assert.equal(h.creates.length, 1);
  assert.deepEqual(h.creates[0].config.contents, first.contents.slice(0, -1));
  const second = structuredClone(first); second.contents[1] = runtime(2);
  await h.run(second);
  const sent = h.calls.at(-1), cached = h.creates[0].config;
  assert.ok(sent.config.cachedContent);
  assert.deepEqual([...cached.contents, ...sent.contents], second.contents);
  for (const field of ['systemInstruction', 'tools', 'toolConfig']) { assert.equal(sent.config[field], undefined); assert.deepEqual(cached[field], second.config[field]); }
  assert.equal(sent.config.temperature, 0.3);
  assert.equal(second.config.cachedContent, undefined);
  assert.ok(!JSON.stringify(h.records).includes('test-secret'));
  assert.ok(!JSON.stringify(h.records).includes('cachedContents/'));
});

for (const field of ['history', 'system', 'tools', 'file']) test(`changed ${field} invalidates before reuse`, async t => {
  const h = harness(t); await h.run(); const next = request(2);
  if (field === 'history') next.contents[0] = user('compacted history');
  if (field === 'system') next.config.systemInstruction = 'new memory summary';
  if (field === 'tools') next.config.tools = [];
  if (field === 'file') next.contents[0].parts.push({ fileData: { fileUri: 'https://files.test/new', mimeType: 'application/pdf' } });
  await h.run(next);
  assert.equal(h.calls.at(-1).config.cachedContent, undefined);
  assert.equal(h.deletes.length, 1);
});

test('account, conversation, and credential boundaries never share cache IDs', async t => {
  const h = harness(t); await h.run();
  await h.run(request(), 'bob/conversation-1');
  await h.run(request(), 'alice/conversation-2');
  await h.run(request(), 'alice/conversation-1', { apiKey: 'rotated-secret' });
  assert.ok(h.calls.every(p => !p.config.cachedContent));
  assert.equal(h.creates.length, 4);
});

test('failed cache read falls back once with the complete input before emitting content', async t => {
  const h = harness(t); await h.run(); h.fail();
  const next = request(2); const result = await h.run(next);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.at(-1), next);
  assert.equal(result.result.stopReason, 'stop');
  assert.equal(result.events.filter(e => e.type === 'start').length, 1);
  assert.equal(result.events.filter(e => e.type === 'text_delta').length, 1);
  assert.equal(result.events.filter(e => e.type === 'error').length, 0);
  assert.ok(h.records.some(r => r.action === 'fallback'));
});

test('a failure after partial text never replays speech', async t => {
  const h = harness(t); await h.run(); h.fail(true);
  const result = await h.run(request(2));
  assert.equal(h.calls.length, 2);
  assert.equal(result.result.stopReason, 'error');
  assert.equal(result.events.filter(e => e.type === 'text_delta').length, 1);
});

test('cancelled cached requests do not retry', async t => {
  const h = harness(t); await h.run(); h.fail();
  await h.run(request(2), undefined, { signal: AbortSignal.abort() });
  assert.equal(h.calls.length, 2);
});

test('failed cache creation leaves generation usable and backs off', async t => {
  const h = harness(t); h.failCreate();
  assert.equal((await h.run()).result.stopReason, 'stop');
  assert.equal((await h.run(request(2))).result.stopReason, 'stop');
  assert.equal(h.creates.length, 1);
  assert.ok(h.calls.every(p => !p.config.cachedContent));
});

test('background preparation does not block replies; shutdown cleans up in-flight creation', async t => {
  const h = harness(t); let release;
  h.hold(new Promise(resolve => { release = resolve; }));
  const first = await h.run(); assert.equal(first.result.stopReason, 'stop');
  await h.run(request(2)); assert.equal(h.creates.length, 1);
  const closing = h.manager.close(); release(); await closing;
  assert.equal(h.deletes.length, 1);
});

test('small history growth reuses cache; substantial growth replaces it after generation', async t => {
  const h = harness(t); await h.run();
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 31000);
  await h.run(request(2, [user('small growth')]));
  assert.equal(h.creates.length, 1);
  await h.run(request(3, [user('large growth '.repeat(600))]));
  assert.equal(h.creates.length, 2);
  assert.equal(h.calls.at(-1).config.cachedContent, 'cachedContents/test-1');
  assert.deepEqual(h.deletes, ['cachedContents/test-1']);
});

test('expired cache falls back to full input and prepares a replacement', async t => {
  const h = harness(t); await h.run();
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 601000);
  await h.run(request(2));
  assert.equal(h.calls.at(-1).config.cachedContent, undefined);
  assert.equal(h.creates.length, 2);
  assert.ok(h.deletes.includes('cachedContents/test-1'));
});

test('requests without the runtime boundary are never shortened or cached', async t => {
  const h = harness(t); const p = request(); p.contents.pop();
  await h.run(p); await h.run(p);
  assert.equal(h.creates.length, 0);
  assert.deepEqual(h.calls, [p, p]);
});

for (const rejectCached of [false, true]) test(`real Pi/Google SDK cached tool loop with fallback=${rejectCached}`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bio-cache-sdk-'));
  const generations = [], caches = [], observations = [];
  let successful = 0, rejected = false, session, factory, ready;
  const prepared = new Promise(resolve => { ready = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'DELETE') { json({}); return; }
    if (req.url.endsWith(':countTokens')) { json({ totalTokens: 100 }); return; }
    if (req.url === '/v1beta/cachedContents') {
      caches.push(body); json({ name: 'cachedContents/sdk-test', expireTime: new Date(Date.now() + 600000).toISOString(), usageMetadata: { totalTokenCount: 5000 } }); return;
    }
    generations.push(body);
    if (body.cachedContent && rejectCached && !rejected) {
      rejected = true; res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Cached content expired' } })); return;
    }
    successful++;
    const parts = successful === 2 ? [{ functionCall: { name: 'read_document', args: {} } }] : [{ text: '收到。' }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 2, totalTokenCount: 6002, ...(body.cachedContent ? { cachedContentTokenCount: 5000 } : {}) } })}\n\n`);
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const config = new ConfigService({ GEMINI_API_KEY: 'sdk-test-key', GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1beta`, AGENT_DATA_DIR: root });
    factory = new PiSessionFactory(config, new AgentStorage(config), {});
    session = await factory.create(randomUUID(), undefined, () => {}, 'gemini', undefined, undefined, undefined, (type, data) => {
      observations.push({ type, ...data }); if (type === 'model.cache' && data.action === 'created') ready();
    });
    await session.prompt('第一轮'); await prepared;
    await session.prompt('请读取文稿');
    assert.equal(successful, 3);
    assert.equal(generations.length, rejectCached ? 4 : 3);
    assert.equal(generations[1].cachedContent, 'cachedContents/sdk-test');
    assert.equal(generations[1].systemInstruction, undefined);
    assert.equal(generations[1].tools, undefined);
    assert.ok(caches[0].tools.some(tool => tool.googleSearch));
    assert.ok(caches[0].tools.some(tool => tool.functionDeclarations?.some(fn => fn.name === 'read_document')));
    assert.equal(caches[0].toolConfig.includeServerSideToolInvocations, true);
    assert.ok(!JSON.stringify(caches[0].contents).includes('bio_runtime_context'));
    for (const p of generations) assert.ok(p.contents.at(-1).parts[0].text.startsWith('{"type":"bio_runtime_context"'));
    assert.ok(generations.at(-1).contents.some(c => c.parts.some(p => p.functionResponse?.name === 'read_document')));
    if (rejectCached) {
      assert.ok(generations[2].tools);
      assert.deepEqual(generations[2].contents, [...caches[0].contents, ...generations[1].contents]);
      assert.ok(observations.some(o => o.action === 'fallback'));
    }
    assert.equal(session.messages.at(-1).stopReason, 'stop');
    assert.ok(!session.messages.some(m => m.customType === 'bio_runtime_context'));
  } finally {
    session?.dispose(); await factory?.onModuleDestroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { createModelRuntime } from '../dist/models/model-provider.js';
import { CompleteChatDto } from '../dist/chat/dto/complete-chat.dto.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';

test('Gemini is accepted by request validation and requires its own key', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const dto = await pipe.transform({ message: '你好', provider: 'gemini' }, { type: 'body', metatype: CompleteChatDto });
  assert.equal(dto.provider, 'gemini');
  await assert.rejects(createModelRuntime(new ConfigService({ GEMINI_API_KEY: ' ' }), tmpdir(), 'gemini'), /GEMINI_API_KEY is not configured/);
});

for (const [modelId, thinkingLevel, searchEnabled] of [['gemini-3.8-flash', 'LOW', true], ['gemini-3-flash-preview', 'MINIMAL', true], ['gemini-3.8-flash', 'LOW', false]]) {
test(`${modelId} native streaming executes tools with search=${searchEnabled}`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bio-gemini-'));
  const requests = [];
  const mock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    const parts = requests.length === 1
      ? [{ functionCall: { name: 'get_content', args: {} } }]
      : [{ text: 'Gemini 已读取内容。' }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 } })}\n\n`);
  });
  let session;
  try {
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    const config = new ConfigService({ GEMINI_MODEL: modelId, ...(!searchEnabled ? { GEMINI_GOOGLE_SEARCH_ENABLED: 'false' } : {}), GEMINI_API_KEY: 'gemini-local-test-key', GEMINI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1beta`, AGENT_DATA_DIR: root });
    const factory = new PiSessionFactory(config, new AgentStorage(config), {});
    session = await factory.create(randomUUID(), '请使用工具读取内容。', () => {});
    await session.prompt('请读取内容');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, `/v1beta/models/${modelId}:streamGenerateContent?alt=sse`);
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, thinkingLevel);
    assert.equal(requests[0].headers['x-goog-api-key'], 'gemini-local-test-key');
    assert.ok(requests[0].body.systemInstruction);
    assert.ok(requests[0].body.tools[0].functionDeclarations.some(tool => tool.name === 'get_content'));
    for (const request of requests) {
      assert.equal(request.body.tools.filter(tool => tool.googleSearch).length, searchEnabled ? 1 : 0);
      assert.equal(request.body.toolConfig?.includeServerSideToolInvocations, searchEnabled ? true : undefined);
    }
    assert.ok(requests[1].body.contents.some(content => content.parts.some(part => part.functionResponse?.name === 'get_content')));
    const reply = session.messages.at(-1);
    assert.equal(reply.role, 'assistant');
    assert.ok(reply.content.some(part => part.text === 'Gemini 已读取内容。'));
    assert.equal(reply.usage.totalTokens, 17);
  } finally {
    session?.dispose();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
}

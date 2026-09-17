import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MaterialsService } from '../dist/materials/materials.service.js';
import { GeminiFiles } from '../dist/materials/gemini-files.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { geminiAttachmentContext } from '../dist/materials/gemini-attachment-context.js';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { materialHistoryContext } from '../dist/materials/material-history-context.js';

test('native files: original bytes, multi-turn references, restart, expiry, owner isolation, fail closed', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bio-native-files-'));
  const uploads = [], requests = []; let origin, serial = 0, fail = false, readDeleted;
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks);
    if (req.url === '/upload/v1beta/files') { res.writeHead(fail ? 503 : 200, { 'x-goog-upload-url': `${origin}/upload-content` }); res.end('{}'); return; }
    if (req.url === '/upload-content') {
      uploads.push(bytes); serial++;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ file: { name: `files/f${serial}`, uri: `${origin}/v1beta/files/f${serial}`, mimeType: req.headers['content-type'], state: 'ACTIVE', expirationTime: new Date(Date.now() + 48 * 3600000).toISOString() } })); return;
    }
    requests.push(JSON.parse(bytes.toString()));
    if (requests.at(-1).messages) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-files', choices: [{ index: 0, delta: { role: 'assistant', content: '可以继续聊已有的内容。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const parts = readDeleted ? [{ functionCall: { name: 'get_content', args: { attachmentId: readDeleted } } }]
      : requests.length === 1 ? [{ functionCall: { name: 'get_content', args: {} } }] : [{ text: '我看到这份资料。' }];
    readDeleted = undefined;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`);
  });
  let session;
  try {
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); origin = `http://127.0.0.1:${mock.address().port}`;
    const config = new ConfigService({ AGENT_DATA_DIR: root, GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `${origin}/v1beta` });
    const materials = new MaterialsService(config), storage = new AgentStorage(config), factory = new PiSessionFactory(config, storage, materials);
    const pdf = await readFile(new URL('./fixtures/letter.pdf', import.meta.url));
    const item = await materials.upload('letter.pdf', pdf, 'user-a');
    const conversation = randomUUID(); const scope = { userId: 'user-a' };
    session = await factory.create(conversation, undefined, () => {}, 'gemini', { materialIds: [item.id] }, scope);
    await session.prompt('聊聊附件'); await session.prompt('接着聊'); session.dispose();
    session = await factory.create(conversation, undefined, () => {}, 'gemini', undefined, scope); await session.prompt('重新打开后继续');
    assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], pdf);
    assert.equal(requests.length, 4);
    for (const request of requests) {
      const files = request.contents.flatMap(value => value.parts).filter(part => part.fileData);
      assert.equal(files.length, 1); assert.equal(files[0].fileData.mimeType, 'application/pdf'); assert.equal(files[0].fileData.fileUri, `${origin}/v1beta/files/f1`);
    }
    const entries = (await readFile(join(storage.conversationDirectory(conversation, 'user-a'), 'session.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(entry => entry.customType === 'bio_material_attachment').length, 1);
    assert.ok(!JSON.stringify(entries).includes('/v1beta/files/'), 'expiring credentials/references are not persisted in conversation');
    const files = new GeminiFiles(config, materials);
    await assert.rejects(files.get(item.id, 'user-b'), /资料不存在/);
    const cacheDir = join(materials.root, '.gemini-files', (await readdir(join(materials.root, '.gemini-files')))[0]);
    const cachePath = join(cacheDir, `${item.id}.json`); const cached = JSON.parse(await readFile(cachePath, 'utf8')); cached.expirationTime = new Date(0).toISOString(); await writeFile(cachePath, JSON.stringify(cached));
    await Promise.all([files.get(item.id, 'user-a'), files.get(item.id, 'user-a')]); assert.equal(uploads.length, 2);
    const handlers = {}; const attachment = await materials.attachment(item.id, 'user-a');
    geminiAttachmentContext(files, [{ materialId: item.id, attachmentId: attachment.id, title: attachment.title }], 'user-a')({ on: (name, handler) => { handlers[name] = handler; } });
    const restored = handlers.context({ messages: [{ role: 'user', content: 'compacted conversation', timestamp: 1 }] });
    const payload = { contents: [{ parts: [{ text: restored.messages[0].content }] }] };
    await handlers.before_provider_request({ payload }); assert.equal(payload.contents[0].parts[1].fileData.fileUri, `${origin}/v1beta/files/f2`);
    cached.expirationTime = new Date(0).toISOString(); await writeFile(cachePath, JSON.stringify(cached)); fail = true;
    const failure = { contents: [{ parts: [{ text: restored.messages[0].content }] }] };
    await assert.rejects(handlers.before_provider_request({ payload: failure }), /上传准备失败/); assert.deepEqual(failure.contents, []);
    fail = false;
    await materials.remove(item.id, 'user-a'); await assert.rejects(files.get(item.id, 'user-a'), error => error.getStatus() === 410);
    await assert.rejects(files.get(item.id, 'user-b'), error => error.getStatus() === 404);
    const tombstone = await materials.attachment(item.id, 'user-a');
    assert.equal(tombstone.title, item.title);
    assert.equal(tombstone.originalStatus, 'deleted');
    assert.equal(tombstone.text, undefined);

    // A deletion between context assembly and the provider call must not replay a cached URI.
    const raced = { contents: [{ parts: [{ text: restored.messages[0].content }] }] };
    await handlers.before_provider_request({ payload: raced });
    assert.ok(raced.contents[0].parts.every(part => !part.fileData));
    assert.match(JSON.stringify(raced), /原文件已删除/);

    // The already-open session can continue, including a fresh get_content tool read.
    readDeleted = attachment.id;
    const afterDelete = requests.length;
    await session.prompt('我们继续聊之前说过的事，也检查附件还能不能读取');
    for (const request of requests.slice(afterDelete)) {
      assert.ok(request.contents.flatMap(value => value.parts).every(part => !part.fileData));
      assert.match(JSON.stringify(request), /原文件已删除/);
    }
    const toolResult = requests.at(-1).contents.flatMap(value => value.parts).filter(part => part.functionResponse).at(-1)?.functionResponse;
    assert.match(JSON.stringify(toolResult), /原文件已删除/);
    assert.ok(!JSON.stringify(toolResult).includes('Grandma planted a tree'));
    assert.equal(uploads.length, 2, 'deleted originals are never uploaded again');
    session.dispose();

    // Restart with a stale selected ID: show the deleted current card, preserve history.
    const events = [];
    session = await factory.create(conversation, undefined, event => events.push(event), 'gemini', { materialIds: [item.id] }, scope);
    assert.equal(events.at(-1).panel.attachment.originalStatus, 'deleted');
    await session.prompt('继续聊天'); session.dispose();
    const history = (await readFile(join(storage.conversationDirectory(conversation, 'user-a'), 'session.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(history.filter(entry => entry.customType === 'bio_material_attachment'), entries.filter(entry => entry.customType === 'bio_material_attachment'));

    // Deleting a historical (non-current) attachment also permits plain conversation.
    new PanelWorkspace(storage.conversationDirectory(conversation, 'user-a')).setMode('conversation');
    session = await factory.create(conversation, undefined, () => {}, 'gemini', undefined, scope);
    await session.prompt('不用打开附件，继续聊'); session.dispose();

    config.set('LLM_API_KEY', 'test'); config.set('LLM_MODEL', 'mock-files'); config.set('LLM_BASE_URL', origin);
    session = await factory.create(conversation, undefined, () => {}, 'openai-compatible', undefined, scope);
    await session.prompt('换模型后继续聊');
    assert.match(JSON.stringify(requests.at(-1).messages), /原文件已删除/);
    assert.match(JSON.stringify(requests.at(-1).messages), /重新打开后继续/);
    session.dispose();

    // A new call can still carry a stale selected ID, without possessing old history.
    session = await factory.create(randomUUID(), undefined, () => {}, 'gemini', { materialIds: [item.id] }, scope);
    await session.prompt('继续聊');
    assert.ok(requests.at(-1).contents.flatMap(value => value.parts).every(part => !part.fileData));
    assert.match(JSON.stringify(requests.at(-1)), /原文件已删除/);
    session.dispose();

    const replacement = await materials.upload('new.txt', Buffer.from('这是新上传的资料'), 'user-a');
    session = await factory.create(conversation, undefined, () => {}, 'gemini', { materialIds: [replacement.id] }, scope);
    await session.prompt('这次看看新文件');
    assert.equal(requests.at(-1).contents.flatMap(value => value.parts).filter(part => part.fileData).length, 1);
    assert.equal(uploads.length, 3);
    await assert.rejects(factory.create(randomUUID(), undefined, () => {}, 'gemini', { materialIds: [replacement.id] }, { userId: 'user-b' }), /资料不存在/);
  } finally { session?.dispose(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('deleted image history is retained on disk but is not replayed as original pixels to another provider', async () => {
  const item = { attachmentId: 'image', materialId: randomUUID(), title: '旧照片', originalStatus: 'deleted' };
  const handlers = {};
  materialHistoryContext([item], async () => {})({ on: (name, handler) => { handlers[name] = handler; } });
  const original = { role: 'custom', customType: 'bio_material_attachment', details: { attachmentId: 'image' },
    content: [{ type: 'image', data: 'old-pixels', mimeType: 'image/png' }], timestamp: 1, display: false };
  const result = await handlers.context({ messages: [original, { role: 'assistant', content: [{ type: 'text', text: '以前我们聊过这张照片。' }] }] });
  assert.equal(original.content[0].data, 'old-pixels');
  assert.ok(!JSON.stringify(result.messages).includes('old-pixels'));
  assert.match(JSON.stringify(result.messages), /以前我们聊过这张照片/);
  assert.match(JSON.stringify(result.messages), /原文件已删除/);
});

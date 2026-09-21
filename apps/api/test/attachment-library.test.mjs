import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MaterialsService } from '../dist/materials/materials.service.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';

test('agent discovers an unselected library attachment, opens it and reads native content in the same run; foreign/deleted files stay inaccessible', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bio-library-'));
  const requests = [], events = []; let origin, attachmentId, action = 'open', step = 0;
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/upload/v1beta/files') { res.writeHead(200, { 'x-goog-upload-url': `${origin}/upload-content` }); res.end('{}'); return; }
    if (req.url === '/upload-content') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ file: { name: 'files/test', uri: `${origin}/file`, mimeType: 'text/plain', state: 'ACTIVE', expirationTime: new Date(Date.now() + 86400000).toISOString() } })); return; }
    const request = JSON.parse(Buffer.concat(chunks).toString()); requests.push(request);
    let parts;
    if (action === 'open') {
      parts = step === 0 ? [{ functionCall: { name: 'list_attachments', args: { query: '简历' } } }]
        : step === 1 ? [{ functionCall: { name: 'switch_mode', args: { mode: 'attachment_conversation', targetId: attachmentId } } }]
        : [{ text: '资料已打开。' }];
    } else parts = step === 0 ? [{ functionCall: { name: 'switch_mode', args: { mode: 'attachment_conversation', targetId: attachmentId } } }] : [{ text: '无法打开。' }];
    step++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`);
  });
  let session;
  try {
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); origin = `http://127.0.0.1:${mock.address().port}`;
    const config = new ConfigService({ AGENT_DATA_DIR: root, GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: `${origin}/v1beta` });
    const materials = new MaterialsService(config), storage = new AgentStorage(config), factory = new PiSessionFactory(config, storage, materials);
    const item = await materials.upload('我的简历.txt', Buffer.from('产品经理，负责产品设计。'), 'owner');
    const foreign = await materials.upload('他人的简历.txt', Buffer.from('不应可见'), 'other');
    attachmentId = (await materials.attachment(item.id, 'owner')).id;
    const conversationId = randomUUID();
    session = await factory.create(conversationId, undefined, event => events.push(event), 'gemini', undefined, { userId: 'owner' });
    await session.prompt('打开我的简历'); session.dispose();
    assert.equal(requests.length, 3);
    const listResponse = requests[1].contents.flatMap(c => c.parts).find(p => p.functionResponse);
    assert.ok(JSON.stringify(listResponse).includes(attachmentId));
    assert.ok(!JSON.stringify(listResponse).includes(foreign.id));
    assert.equal(requests[2].contents.flatMap(c => c.parts).filter(p => p.fileData).length, 1, 'newly loaded file reaches native provider immediately');
    assert.equal(events.filter(e => e.type === 'panel.state.updated').at(-1).panel.attachment.id, attachmentId);
    const persisted = new PanelWorkspace(storage.conversationDirectory(conversationId, 'owner'));
    assert.equal(persisted.state().mode, 'attachment');
    assert.equal(persisted.context().availableAttachments.length, 1);
    for (const kind of ['foreign', 'deleted']) {
      if (kind === 'foreign') attachmentId = (await materials.attachment(foreign.id, 'other')).id;
      else { attachmentId = (await materials.attachment(item.id, 'owner')).id; await materials.remove(item.id, 'owner'); }
      action = kind; step = 0; events.length = 0; requests.length = 0;
      const id = randomUUID();
      session = await factory.create(id, undefined, event => events.push(event), 'gemini', undefined, { userId: 'owner' });
      await session.prompt('打开附件'); session.dispose();
      assert.equal(new PanelWorkspace(storage.conversationDirectory(id, 'owner')).state().mode, 'conversation');
      assert.equal(requests.at(-1).contents.flatMap(c => c.parts).filter(p => p.fileData).length, 0);
    }
  } finally { session?.dispose(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

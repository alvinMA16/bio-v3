import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DocumentViewDto } from '../dist/chat/dto/complete-chat.dto.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { DocumentStore } from '../dist/agent/document-store.js';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { createPresentationTools } from '../dist/agent/presentation-tools.js';

for (const scenario of ['visible', 'wrong_target', 'old_request', 'old_version', 'interrupted', 'timeout', 'no_client', 'invalid_range', 'received', 'rendering', 'highlight_missing', 'highlight_visible']) {
  test(`focus confirmation: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'bio-navigation-'));
    try {
      const store = new DocumentStore(new AgentStorage(new ConfigService({ AGENT_DATA_DIR: root })));
      const workspace = new PanelWorkspace(root);
      const document = await store.edit('owner', randomUUID(), { documentId: 'story', expectedVersion: 0, title: '往事', operations: [
        { action: 'insert', block: { id: 'p1', kind: 'paragraph', text: '旧位置' } },
        { action: 'insert', block: { id: 'p2', kind: 'paragraph', text: '第五部分' } },
      ] });
      workspace.showDocument(document);
      workspace.acceptDocumentView({ documentId: 'story', version: 1, page: 1, visibleRanges: [{ blockId: 'p1', start: 0, end: 3 }] });
      const events = [];
      const runtime = scenario === 'no_client' ? undefined : { async waitForNavigation(target) {
        assert.equal(events.at(-1).type, 'panel.state.updated');
        assert.equal(workspace.context().screen.renderAcknowledged, false, 'old viewport must not acknowledge a new focus');
        if (scenario === 'timeout') return undefined;
        return { documentId: 'story', version: scenario === 'old_version' ? 2 : 1, page: 1, following: false,
          visibleRanges: [{ blockId: scenario === 'wrong_target' ? 'p1' : 'p2', start: 0, end: scenario === 'invalid_range' ? 100 : 3 }],
          navigation: { requestId: scenario === 'old_request' ? randomUUID() : target.requestId,
            status: ['received', 'rendering'].includes(scenario) ? scenario : scenario === 'interrupted' ? 'failed' : 'visible', ...(scenario === 'interrupted' ? { reason: 'user_interrupted' } : {}),
            ...(scenario.startsWith('highlight_') ? { highlight: scenario === 'highlight_visible' ? 'visible' : 'missing' } : {}),
            attempts: 1, scrollBefore: 0, scrollAfter: 50 } };
      } };
      const tool = createPresentationTools(workspace, e => events.push(e), undefined, { store, user: 'owner', conversationId: randomUUID() }, runtime).find(t => t.name === 'show_document');
      const response = await tool.execute('focus', { documentId: 'story', ...(scenario.startsWith('highlight_')
        ? { expectedVersion: 1, highlights: [{ blockId: 'p2', quote: '第五' }] } : { blockId: 'p2' }) })
        .then(value => ({ ...value, isError: false }), error => ({ content: [{ type: 'text', text: error.message }], isError: true }));
      const result = JSON.parse(response.content[0].text);
      const visible = ['visible', 'highlight_missing', 'highlight_visible'].includes(scenario);
      const confirmed = ['visible', 'highlight_visible'].includes(scenario);
      assert.equal(result.rendered, visible);
      assert.equal(response.isError, !confirmed);
      assert.equal(result.status, confirmed ? 'visible' : ['interrupted', 'wrong_target', 'highlight_missing'].includes(scenario) ? 'failed' : 'unconfirmed');
      assert.equal(workspace.context().screen.renderAcknowledged, visible);
      if (scenario === 'received') assert.equal(result.failureReason, 'reader_not_started');
      if (scenario === 'rendering') assert.equal(result.failureReason, 'reader_not_completed');
      if (scenario === 'highlight_missing') assert.equal(result.highlightRendered, false);
      assert.equal((await store.get('owner', 'story')).version, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('navigation receipt validation rejects unbounded diagnostics and unknown fields', async () => {
  const view = { documentId: 'story', version: 1, page: 1, navigation: { requestId: randomUUID(), status: 'visible', attempts: 1, scrollBefore: 0, scrollAfter: 25.5 } };
  assert.equal((await validate(plainToInstance(DocumentViewDto, view), { whitelist: true, forbidNonWhitelisted: true })).length, 0);
  for (const change of [{ attempts: 999 }, { scrollAfter: Infinity }, { status: 'success' }, { arbitrary: 'x' }, { targetTop: NaN }, { clientBuild: 'https://secret' }, { highlight: 'success' }]) {
    assert.ok((await validate(plainToInstance(DocumentViewDto, { ...view, navigation: { ...view.navigation, ...change } }), { whitelist: true, forbidNonWhitelisted: true })).length);
  }
});

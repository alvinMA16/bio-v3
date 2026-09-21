import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { documentTextSegments } from '@bio/contracts';
import { changedText, locateText } from '../dist/agent/document-highlight.js';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { DocumentStore } from '../dist/agent/document-store.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { createPresentationTools } from '../dist/agent/presentation-tools.js';
const doc = (text, version = 1) => ({ id: 'story', title: '回忆', version, blocks: [{ id: 'p1', kind: 'paragraph', text }] });

test('edits highlight only changed words, punctuation and Unicode characters', () => {
  for (const [before, after, expected] of [
    ['今天，我们去公园。', '今天，我们去花园！', ['花', '！']],
    ['今天去公园。', '今天，去公园。', ['，']],
    ['😀回家🙂', '😀回家😊', ['😊']],
    ['外婆的院子很大。', '外婆的院子。', []],
    ['甲乙甲乙', '甲丙甲乙', ['丙']],
  ]) {
    const highlight = changedText(doc(before), doc(after, 2));
    assert.deepEqual(highlight.ranges.map(range => after.slice(range.start, range.end)), expected);
    const segments = documentTextSegments(after, 'p1', highlight.ranges);
    assert.equal(segments.map(item => item.text).join(''), after);
    assert.deepEqual(segments.filter(item => item.highlighted).map(item => item.text), expected);
    for (const segment of segments) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(segment.text));
  }
  assert.equal(changedText(doc('外婆的院子很大。'), doc('外婆的院子。', 2)).deletions[0].text, '很大');
});

test('explicit focus rejects ambiguous or nonexistent quotes rather than widening selection', () => {
  const document = doc('花开了，花又落了。');
  assert.throws(() => locateText(document, { blockId: 'p1', quote: '花' }), /occurrence/);
  assert.deepEqual(locateText(document, { blockId: 'p1', quote: '花', occurrence: 2 }), { blockId: 'p1', start: 4, end: 5 });
  assert.throws(() => locateText(document, { blockId: 'p1', quote: '花儿' }), /不匹配/);
  assert.throws(() => locateText(document, { blockId: 'p1', quote: '花', occurrence: 3 }), /范围/);
});

test('focus works within the same narration chunk; edits and reloads keep precise temporary marks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bio-highlight-'));
  try {
    const storage = new AgentStorage(new ConfigService({ AGENT_DATA_DIR: root })), store = new DocumentStore(storage);
    const conversationId = randomUUID(), cwd = storage.conversationDirectory(conversationId), workspace = new PanelWorkspace(cwd);
    const tools = Object.fromEntries(createPresentationTools(workspace, () => {}, undefined, { store, conversationId }).map(t => [t.name, t]));
    await tools.edit_document.execute('1', { documentId: 'story', expectedVersion: 0, title: '回忆', operations: [{ action: 'insert', block: doc('花开了，花又落了。').blocks[0] }] });
    await assert.rejects(tools.show_document.execute('2', { documentId: 'story', expectedVersion: 1, highlights: [{ blockId: 'p1', quote: '花', occurrence: 2 }] }), /unconfirmed/);
    const state = workspace.state();
    assert.equal(state.documentView.page, 1); assert.equal(state.documentView.focus.start, 4);
    assert.equal(state.documentView.highlight.ranges[0].end, 5);
    const reopened = new PanelWorkspace(cwd); reopened.hydrateDocuments([await store.get(undefined, 'story')]);
    assert.deepEqual(reopened.state().documentView.highlight, state.documentView.highlight);
    await assert.rejects(tools.show_document.execute('3', { expectedVersion: 2, highlights: [{ blockId: 'p1', quote: '花' }] }), /版本/);
    assert.deepEqual(workspace.state(), state);
    await tools.edit_document.execute('4', { documentId: 'story', expectedVersion: 1, operations: [{ action: 'replace', targetId: 'p1', block: doc('花开了，花又落了！').blocks[0] }] });
    assert.deepEqual(workspace.state().documentView.highlight.ranges, [{ blockId: 'p1', start: 8, end: 9 }]);
    assert.equal(workspace.state().documentView.focus, undefined);
    assert.equal((await store.get(undefined, 'story')).highlight, undefined);
    await tools.show_document.execute('5', { clearHighlight: true });
    assert.equal(workspace.state().documentView.highlight, undefined);
    assert.equal((await store.get(undefined, 'story')).version, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

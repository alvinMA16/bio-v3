import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { documentPages } from '@bio/contracts';
import { DocumentStore, legacyDocumentId } from '../dist/agent/document-store.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { createPresentationTools } from '../dist/agent/presentation-tools.js';
import { MemoryService } from '../dist/memory/memory.service.js';

const paragraph = (id, text) => ({ id, text, kind: 'paragraph' });
const create = (id = 'story') => ({ documentId: id, expectedVersion: 0, title: '暑假', operations: [
  { action: 'insert', block: paragraph('p1', '甲'.repeat(500)) }, { action: 'insert', block: paragraph('p2', '外婆的院子。') },
  { action: 'insert', block: paragraph('p3', '乙'.repeat(500)) },
] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bio-documents-'));
  const storage = new AgentStorage(new ConfigService({ AGENT_DATA_DIR: root }));
  return { root, storage, store: new DocumentStore(storage), clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('reading pages preserve all characters, paragraph IDs and UTF-16 selection offsets', () => {
  const blocks = [paragraph('p1', '开头'), paragraph('p2', '😀'.repeat(1300)), paragraph('p3', '')];
  const document = { id: 'd', title: 't', version: 1, blocks };
  const pages = documentPages(document);
  for (const block of blocks) {
    const fragments = pages.flatMap(page => page.fragments).filter(fragment => fragment.blockId === block.id);
    assert.equal(fragments.map(fragment => fragment.text).join(''), block.text);
    for (const fragment of fragments) assert.equal(block.text.slice(fragment.start, fragment.end), fragment.text);
  }
  assert.ok(pages.every(page => page.fragments.reduce((n, fragment) => n + Array.from(fragment.text).length, 0) <= 600));
});

test('tools separate reading, editing, showing, restoring and playback cancellation', async () => {
  const f = fixture(), conversationId = randomUUID();
  try {
    const workspace = new PanelWorkspace(f.storage.conversationDirectory(conversationId));
    const events = [];
    let refuse = false;
    const tools = Object.fromEntries(createPresentationTools(workspace, event => events.push(event), undefined,
      { store: f.store, conversationId }, { beforeShow: async () => { if (refuse) throw new Error('cancelled'); } }).map(tool => [tool.name, tool]));
    assert.equal(tools.get_content, undefined); assert.equal(tools.update_content, undefined);
    await tools.edit_document.execute('1', create());
    assert.equal(workspace.scene(), 'conversation', 'creating does not change display');
    await tools.show_document.execute('2', { documentId: 'story', page: 1 });
    assert.equal(workspace.scene(), 'revision');
    const shown = workspace.state();
    await tools.read_document.execute('3', { documentId: 'story', page: 2 });
    assert.deepEqual(workspace.state(), shown, 'reading another page does not turn the page');
    await tools.show_document.execute('4', { navigation: 'next' });
    assert.equal(workspace.state().documentView.page, 2);
    assert.equal(workspace.state().document.version, 1, 'turning a page does not edit the document');
    refuse = true;
    await assert.rejects(tools.show_document.execute('5', { page: 1 }), /cancelled/);
    assert.equal(workspace.state().documentView.page, 2);
    refuse = false;
    await tools.edit_document.execute('6', { documentId: 'story', expectedVersion: 1, operations: [{ action: 'replace', targetId: 'p3', block: paragraph('p3', '修改后的末段') }] });
    assert.ok(workspace.context().screen.readingPage.fragments.some(fragment => fragment.blockId === 'p3'), 'editing keeps the anchored paragraph visible even when the document becomes shorter');
    await tools.restore_document.execute('7', { documentId: 'story', expectedVersion: 2, sourceVersion: 1 });
    assert.equal((await f.store.get(undefined, 'story')).version, 3);
    assert.equal((await f.store.history(undefined, 'story')).length, 3);
    assert.equal((await f.store.get(undefined, 'story')).blocks[2].text, '乙'.repeat(500));
    const failedState = workspace.state();
    await assert.rejects(tools.show_document.execute('8', { page: 999 }), /范围/);
    assert.deepEqual(workspace.state(), failedState);
    assert.equal(workspace.acceptDocumentView({ documentId: 'story', version: 1, page: 1 }), false, 'stale client views are ignored');
    assert.equal(workspace.acceptDocumentView({ documentId: 'foreign', version: 3, page: 1 }), false);
  } finally { f.clean(); }
});

async function verifyStore(store, user, other, conversationId) {
  const document = await store.edit(user, conversationId, create());
  assert.equal(document.schemaVersion, 1);
  await assert.rejects(store.get(other, document.id), /不存在/);
  await assert.rejects(store.history(other, document.id), /不存在/);
  await assert.rejects(store.edit(user, conversationId, { documentId: 'story', expectedVersion: 1, operations: [
    { action: 'replace', targetId: 'p2', block: paragraph('p2', '不应保存') }, { action: 'delete', targetId: 'missing' },
  ] }), /不存在/);
  assert.equal((await store.get(user, 'story')).version, 1);
  const modify = text => ({ documentId: 'story', expectedVersion: 1, operations: [{ action: 'replace', targetId: 'p2', block: paragraph('p2', text) }] });
  const results = await Promise.allSettled([store.edit(user, randomUUID(), modify('甲')), store.edit(user, randomUUID(), modify('乙'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.get(user, 'story')).version, 2);
  assert.deepEqual((await store.history(user, 'story')).map(item => item.document.version), [2, 1]);
  await store.restore(user, conversationId, 'story', 2, 1);
  assert.equal((await store.get(user, 'story')).blocks[1].text, '外婆的院子。');
  await assert.rejects(store.restore(user, conversationId, 'story', 2, 1), /冲突/);
}

test('local repository persists independent documents and rejects concurrent stale writes', async () => {
  const f = fixture();
  try {
    await verifyStore(f.store, 'alice', 'bob', randomUUID());
    assert.equal((await new DocumentStore(f.storage).get('alice', 'story')).version, 3);
  } finally { f.clean(); }
});

test('legacy drafts with the same ID import independently and never overwrite edits', async () => {
  const f = fixture();
  try {
    const conversations = [randomUUID(), randomUUID()];
    for (const id of conversations) { const workspace = new PanelWorkspace(f.storage.conversationDirectory(id)); workspace.switchMode('revision'); workspace.update(create('draft')); }
    await f.store.importLegacy();
    assert.equal((await f.store.list()).length, 2);
    const id = legacyDocumentId(conversations[0], 'draft');
    await f.store.edit(undefined, randomUUID(), { documentId: id, expectedVersion: 1, operations: [{ action: 'delete', targetId: 'p1' }] });
    await f.store.importLegacy();
    assert.equal((await f.store.get(undefined, id)).version, 2);
    assert.equal((await f.store.history(undefined, id)).length, 2);
  } finally { f.clean(); }
});

test('PostgreSQL migrations, atomic history, cross-session conflicts and ownership', { skip: !process.env.MEMORY_TEST_DATABASE_URL }, async () => {
  const f = fixture();
  const memory = new MemoryService(new ConfigService({ MEMORY_DATABASE_URL: process.env.MEMORY_TEST_DATABASE_URL }));
  const user = randomUUID(), other = randomUUID(), conversationId = randomUUID();
  try {
    await memory.onModuleInit(); await memory.onModuleInit();
    await memory.ensureUser(user); await memory.ensureUser(other);
    const store = new DocumentStore(f.storage, memory);
    await verifyStore(store, user, other, conversationId);
    await assert.rejects(store.list(), /identity/);
    const old = { ...create('legacy'), version: 1, blocks: [paragraph('p1', '原稿')] };
    old.id = old.documentId; delete old.documentId; delete old.expectedVersion; delete old.operations;
    await memory.pool.query('INSERT INTO bio_memory_sessions(id,user_id,snapshot) VALUES($1,$2,$3)', [conversationId, user, JSON.stringify({ 'panel.json': JSON.stringify({ documents: [old] }) })]);
    await Promise.all([store.importLegacy(user), store.importLegacy(user)]);
    const imported = legacyDocumentId(conversationId, 'legacy');
    assert.equal((await store.history(user, imported)).length, 1);
    await store.edit(user, randomUUID(), { documentId: imported, expectedVersion: 1, operations: [{ action: 'replace', targetId: 'p1', block: paragraph('p1', '新稿') }] });
    await store.importLegacy(user);
    assert.equal((await store.get(user, imported)).blocks[0].text, '新稿');
  } finally {
    await memory.pool.query('DELETE FROM bio_memory_sessions WHERE user_id=ANY($1)', [[user, other]]);
    await memory.pool.query('DELETE FROM bio_memory_users WHERE id=ANY($1)', [[user, other]]);
    await memory.onModuleDestroy(); f.clean();
  }
});

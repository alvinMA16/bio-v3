import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { createPresentationTools } from '../dist/agent/presentation-tools.js';
import { buildSystemPrompt, DEFAULT_PERSONA } from '../dist/agent/agent-context.js';

const paragraph = (id, text) => ({ id, text, kind: 'paragraph' });
test('update_content requires revision and changes content without changing mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lingli-modes-'));
  try {
    const workspace = new PanelWorkspace(cwd, [{ id: 'photo', kind: 'image', title: '照片', url: 'https://example.com/photo.png' }]);
    const events = [];
    const tools = createPresentationTools(workspace, event => events.push(event));
    const switchMode = tools.find(tool => tool.name === 'switch_mode');
    const update = tools.find(tool => tool.name === 'update_content');
    const input = { documentId: 'draft', title: '记录', expectedVersion: 0, operations: [
      { action: 'insert', block: paragraph('p1', '用户的原话') },
    ] };
    for (const mode of ['conversation', 'attachment_conversation']) {
      workspace.switchMode(mode, mode === 'attachment_conversation' ? 'photo' : undefined);
      const before = readFileSync(join(cwd, 'panel.json'), 'utf8');
      await assert.rejects(update.execute('update', input), /先调用 switch_mode/);
      assert.equal(readFileSync(join(cwd, 'panel.json'), 'utf8'), before);
      assert.equal(events.length, 0);
    }
    await switchMode.execute('switch', { mode: 'revision' });
    assert.equal(workspace.scene(), 'revision');
    assert.equal(workspace.state().document, undefined);
    assert.equal(new PanelWorkspace(cwd).scene(), 'revision');
    const beforeInvalid = workspace.context();
    await assert.rejects(switchMode.execute('invalid', { mode: 'revision', targetId: 'missing' }), /不存在/);
    assert.deepEqual(workspace.context(), beforeInvalid);
    await update.execute('update', input);
    assert.equal(workspace.scene(), 'revision');
    assert.equal(workspace.context().screen.targetId, 'draft');
    assert.equal(workspace.context().screen.documentVersion, 1);
    assert.deepEqual(events.map(event => event.panel.mode), ['editor', 'editor']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('local draft updates are atomic, version checked and retain unaffected blocks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lingli-panel-'));
  try {
    const workspace = new PanelWorkspace(cwd);
    workspace.switchMode('revision');
    workspace.update({ documentId: 'draft', title: '回忆', expectedVersion: 0, operations: [
      { action: 'insert', block: paragraph('p1', '第一段') }, { action: 'insert', block: paragraph('p2', '第二段') },
    ] });
    const unchanged = readFileSync(join(cwd, 'panel.json'), 'utf8');
    assert.throws(() => workspace.update({ documentId: 'draft', expectedVersion: 0, operations: [{ action: 'delete', targetId: 'p1' }] }), /版本冲突/);
    assert.throws(() => workspace.update({ documentId: 'draft', expectedVersion: 1, operations: [
      { action: 'replace', targetId: 'p1', block: paragraph('p1', '不能部分保存') },
      { action: 'delete', targetId: 'missing' },
    ] }), /不存在/);
    assert.equal(readFileSync(join(cwd, 'panel.json'), 'utf8'), unchanged);
    workspace.update({ documentId: 'draft', expectedVersion: 1, operations: [
      { action: 'replace', targetId: 'p1', block: paragraph('p1', '改写') },
      { action: 'insert', afterId: 'p1', block: paragraph('p3', '新增') },
    ] });
    assert.deepEqual(workspace.read('draft').blocks.map(item => item.text), ['改写', '新增', '第二段']);
    workspace.update({ documentId: 'draft', expectedVersion: 2, operations: [{ action: 'delete', targetId: 'p3' }] });
    workspace.setMode('conversation');
    const restored = new PanelWorkspace(cwd);
    assert.equal(restored.state().mode, 'conversation');
    assert.equal(restored.setMode('editor', 'draft').document.version, 3);
    assert.deepEqual(restored.read('draft', 'p2').blocks, [paragraph('p2', '第二段')]);
    assert.throws(() => restored.setMode('attachment', 'invented'), /附件不存在/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('aborted tools do not mutate state or emit success', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lingli-panel-'));
  try {
    const workspace = new PanelWorkspace(cwd);
    const events = [];
    const tools = createPresentationTools(workspace, event => events.push(event));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tools[0].execute('call', { mode: 'conversation' }, controller.signal));
    assert.equal(workspace.state().revision, 0);
    assert.equal(events.length, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('speech contract covers every ordinary response and fixes legacy persona names', () => {
  const prompt = buildSystemPrompt('你是 Bio。');
  assert.ok(DEFAULT_PERSONA.includes('令狸'));
  assert.ok(prompt.includes('旧名称以令狸为准'));
  assert.ok(prompt.includes('包括调用工具前后的说明'));
  assert.ok(prompt.includes('普通回复不使用 Markdown'));
  assert.ok(!prompt.includes('show_panel'));
});


test('model preview is bounded and full attachment data can be read without changing the original', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lingli-panel-'));
  try {
    const text = '文'.repeat(10000);
    const workspace = new PanelWorkspace(cwd, [{ id: 'source', kind: 'document', title: '原件', text }]);
    workspace.setMode('attachment', 'source');
    assert.equal(workspace.context().attachment.text.length, 6000);
    assert.equal(workspace.context().attachment.textTruncated, true);
    assert.equal(workspace.read(undefined, undefined, 'source').text, text);
    assert.throws(() => new PanelWorkspace(cwd, [{ id: 'source', kind: 'document', title: '原件', text: '偷偷修改' }]), /ID 已存在/);
    assert.equal(new PanelWorkspace(cwd).read(undefined, undefined, 'source').text, text);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

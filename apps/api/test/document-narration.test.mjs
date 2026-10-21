import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { createPresentationTools } from '../dist/agent/presentation-tools.js';
import { narrationChunks } from '../dist/agent/document-narration.js';
import { VoiceSession } from '../dist/voice/voice-session.js';

const document = { id: 'story', title: '测试', version: 1, blocks: [
  { id: 'p1', kind: 'paragraph', text: '一个早晨😀。'.repeat(100) },
  { id: 'p2', kind: 'paragraph', text: '第二段，与前段连续播放。'.repeat(30) },
] };
function setup(runtime, manuscript = document) {
  const dir = mkdtempSync(join(tmpdir(), 'bio-narration-'));
  const workspace = new PanelWorkspace(dir); workspace.showDocument(manuscript);
  const events = [];
  const store = { async get(user, id) { assert.equal(user, 'owner'); if (id !== 'story') throw Error('missing'); return structuredClone(manuscript); } };
  const tools = createPresentationTools(workspace, e => events.push(e), undefined, { store, user: 'owner', conversationId: 'test' }, runtime);
  return { dir, workspace, events, tools, tool: tools.find(t => t.name === 'narrate_document'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('narration slices preserve exact Unicode text and reject invalid offsets', () => {
  const chunks = narrationChunks(document);
  for (const block of document.blocks) assert.equal(chunks.filter(c => c.blockId === block.id).map(c => c.text).join(''), block.text);
  assert.ok(chunks.every(c => Array.from(c.text).length <= 180));
  assert.throws(() => narrationChunks(document, [{ blockId: 'p1', start: 5, end: 7 }]), /失效/);
});

test('tool persists only acknowledged cursor; resume replays unfinished chunk, no original text in result', async () => {
  let received, fail = true;
  const f = setup({ narrate: async (chunks, played) => {
    received = chunks;
    if (fail) { played(0); throw Error('interrupted'); }
    chunks.forEach((_, i) => played(i));
  } });
  try {
    await assert.rejects(f.tool.execute('read', { scope: 'all' }), /interrupted/);
    const original = received;
    assert.equal(new PanelWorkspace(f.dir).narration().next, 1);
    fail = false;
    const result = await f.tool.execute('resume', { scope: 'resume' });
    assert.deepEqual(received, original.slice(1));
    assert.equal(JSON.parse(result.content[0].text).status, 'completed');
    assert.ok(!JSON.stringify(result).includes('一个早晨'));
    assert.ok(!JSON.stringify(f.workspace.context(true).document).includes('一个早晨'));
    assert.equal(f.workspace.context().narration.completed, true);
    assert.equal(f.events.filter(e => e.panel.documentView.followRequest).length, 1, 'follow restored only at explicit restart');
    document.version++;
    await assert.rejects(f.tool.execute('stale', { scope: 'resume' }), /版本/);
    document.version--;
  } finally { f.clean(); }
});

test('visible selection merges overlaps, respects ordering and rejects unknown viewport or foreign document', async () => {
  let view, received;
  const f = setup({ getView: () => view, narrate: async (chunks, played) => { received = chunks; chunks.forEach((_, i) => played(i)); } });
  try {
    await assert.rejects(f.tool.execute('unknown', { scope: 'visible' }), /可见/);
    view = { documentId: 'story', version: 1, page: 1, following: false, visibleRanges: [
      { blockId: 'p2', start: 0, end: 3 }, { blockId: 'p1', start: 0, end: 8 }, { blockId: 'p1', start: 7, end: 10 },
    ] };
    await f.tool.execute('visible', { scope: 'visible' });
    assert.equal(received.map(c => c.text).join(''), document.blocks[0].text.slice(0, 10) + document.blocks[1].text.slice(0, 3));
    assert.ok(f.events.every(e => !e.panel.documentView.followRequest));
    await assert.rejects(f.tool.execute('foreign', { scope: 'all', documentId: 'foreign' }), /missing/);
    await assert.rejects(f.tool.execute('version', { scope: 'all', expectedVersion: 99 }), /版本/);
  } finally { f.clean(); }
});

const selectionDocument = { ...document, blocks: [
  { id: 'p1', kind: 'heading', text: '第一节' },
  { id: 'p2', kind: 'paragraph', text: '早晨😀。'.repeat(70) },
  { id: 'p3', kind: 'paragraph', text: '中午，一起去看湖边的风景。' },
  { id: 'p4', kind: 'paragraph', text: '晚上，我们回家。' },
] };
for (const [params, ids] of [
  [{ scope: 'range', startBlockId: 'p2' }, ['p2', 'p3', 'p4']],
  [{ scope: 'range', startBlockId: 'p1', endBlockId: 'p3' }, ['p1', 'p2', 'p3']],
  [{ scope: 'range', startBlockId: 'p2', endBlockId: 'p2' }, ['p2']],
  [{ scope: 'blocks', blockIds: ['p4', 'p2'] }, ['p2', 'p4']],
]) test(`one narration call selects the whole ${JSON.stringify(params)} range`, async () => {
  const calls = [];
  const f = setup({ narrate: async (chunks, played) => { calls.push(chunks); chunks.forEach((_, i) => played(i)); } }, selectionDocument);
  try {
    const result = await f.tool.execute('read', params);
    assert.equal(calls.length, 1);
    assert.deepEqual([...new Set(calls[0].map(c => c.blockId))], ids);
    assert.equal(calls[0].map(c => c.text).join(''), selectionDocument.blocks.filter(b => ids.includes(b.id)).map(b => b.text).join(''));
    assert.ok(calls[0].every(c => c.documentId === 'story' && c.version === 1));
    assert.equal(f.workspace.context().narration.completed, true);
    assert.equal(JSON.parse(result.content[0].text).status, 'completed');
    assert.ok(!JSON.stringify(result).includes('早晨'));
  } finally { f.clean(); }
});

test('invalid or mixed selectors fail before changing the checkpoint, screen or starting audio', async () => {
  let calls = 0;
  const f = setup({ narrate: async () => calls++ }, selectionDocument);
  const before = f.workspace.state();
  try {
    for (const params of [
      { scope: 'range' }, { scope: 'range', endBlockId: 'p3' },
      { scope: 'range', startBlockId: 'unknown' },
      { scope: 'range', startBlockId: 'p2', endBlockId: 'unknown' },
      { scope: 'range', startBlockId: 'p3', endBlockId: 'p2' },
      { scope: 'blocks' }, { scope: 'blocks', blockIds: [] },
      { scope: 'blocks', blockIds: ['p2', 'unknown'] },
      { scope: 'blocks', blockIds: ['p2', 'p2'] },
      { scope: 'all', startBlockId: 'p2' }, { scope: 'resume', endBlockId: 'p4' },
      { scope: 'range', startBlockId: 'p1', blockId: 'p1' },
      { scope: 'block', blockId: 'p2', blockIds: ['p2'] },
      { scope: 'range', startBlockId: 'p2', blockIds: ['p2'] },
      { scope: 'blocks', blockIds: ['p2'], expectedVersion: 99 },
    ]) {
      await assert.rejects(f.tool.execute('invalid', params), undefined, JSON.stringify(params));
      assert.deepEqual(f.workspace.state(), before);
      assert.equal(f.workspace.narration(), undefined);
    }
    assert.equal(calls, 0); assert.equal(f.events.length, 0);
  } finally { f.clean(); }
});

test('interrupted batch resumes its whole remaining selection, including later paragraphs but never unselected text', async () => {
  const calls = []; let interrupt = true;
  const f = setup({ narrate: async (chunks, played) => {
    calls.push(chunks); played(0);
    if (interrupt) throw Error('interrupted');
    chunks.forEach((_, i) => played(i));
  } }, selectionDocument);
  try {
    await assert.rejects(f.tool.execute('batch', { scope: 'blocks', blockIds: ['p2', 'p4'] }), /interrupted/);
    assert.equal(new PanelWorkspace(f.dir).narration().next, 1);
    interrupt = false;
    await f.tool.execute('resume', { scope: 'resume' });
    assert.deepEqual(calls[1], calls[0].slice(1));
    assert.ok(calls[1].some(c => c.blockId === 'p4'));
    assert.ok(calls[1].every(c => c.blockId !== 'p3'));
  } finally { f.clean(); }
});

test('one full-range tool call preloads the next paragraph and stays pending until the entire range is played', async () => {
  const events = [], spoken = []; let calls = 0, toolCalls = 0, finished = false;
  const f = setup(undefined, selectionDocument);
  const session = new VoiceSession({}, { async synthesize(text, signal, audio) { spoken.push(text); await audio(new Uint8Array(32000)); } },
    async (_input, emit, signal, _trigger, runtime) => {
      calls++;
      const tool = createPresentationTools(f.workspace, emit, undefined, {
        user: 'owner', conversationId: 'test', store: { async get() { return structuredClone(selectionDocument); } },
      }, runtime).find(t => t.name === 'narrate_document');
      toolCalls++; await tool.execute('read', { scope: 'range', startBlockId: 'p2' }, signal);
      finished = true; return { conversationId: 'test', message: { content: '' } };
    }, event => events.push(event));
  try {
    await session.listen('read', {}, true, true); await flush();
    const chunks = narrationChunks(selectionDocument, selectionDocument.blocks.slice(1).map(b => ({ blockId: b.id, start: 0, end: b.text.length })));
    assert.equal(spoken.join(''), chunks.map(c => c.text).join(''), 'all paragraphs prepared before the first playback ACK');
    assert.equal(finished, false);
    for (let index = 0; index < chunks.length; index++) {
      session.playback('read', (index + 1) * 16000);
      assert.equal(calls, 1); assert.equal(toolCalls, 1);
      if (index < chunks.length - 1) assert.equal(finished, false);
    }
    await session.settled(); assert.equal(finished, true);
    assert.equal(f.workspace.context().narration.completed, true);
    assert.deepEqual(events.filter(e => e.type === 'audio').map(e => e.narration), chunks.map(({ text, ...range }) => range));
  } finally { session.close(); f.clean(); }
});

test('ordinary show does not wait for previous audio; narration unavailable outside a voice runtime', async () => {
  const f = setup({ beforeShow: async () => { throw Error('must not wait'); } });
  try {
    await f.tools.find(t => t.name === 'show_document').execute('open', { documentId: 'story' });
    await assert.rejects(f.tool.execute('read', { scope: 'all' }), /语音通话/);
  } finally { f.clean(); }
});

const response = { conversationId: 'test', message: { content: '' } };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('voice prepares subsequent chunks before playback completes, advances only on ACK and keeps text outside model events', async () => {
  const chunks = narrationChunks(document).slice(0, 3), spoken = [], events = [], played = [];
  let returned = false;
  const session = new VoiceSession({}, { async synthesize(text, signal, audio) { spoken.push(text); await audio(new Uint8Array(32000)); } },
    async (_input, _emit, signal, _trigger, runtime) => { await runtime.narrate(chunks, i => played.push(i), signal); returned = true; return response; },
    e => events.push(e));
  try {
    await session.listen('read', {}, true, true);
    await flush();
    assert.deepEqual(spoken, chunks.map(c => c.text), 'all three seconds prepared before any playback ACK');
    assert.deepEqual(played, []); assert.equal(returned, false);
    session.playback('read', 16000); assert.deepEqual(played, [0]);
    session.playback('read', 48000);
    await session.settled();
    assert.deepEqual(played, [0, 1, 2]); assert.equal(returned, true);
    assert.ok(!events.some(e => e.type === 'agent' && e.event.type.startsWith('speech.')));
    assert.ok(events.some(e => e.type === 'done'));
    assert.deepEqual(events.filter(e => e.type === 'audio').map(e => e.narration), chunks.map(({ text, ...position }) => position));
  } finally { session.close(); }
});

test('interrupt cancels queued narration and ignores late playback receipts', async () => {
  const chunks = narrationChunks(document), played = [], events = [];
  let calls = 0;
  const session = new VoiceSession({}, { async synthesize(_text, signal, audio) {
    calls++; await audio(new Uint8Array(32000));
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); });
  } }, async (_i, _e, signal, _t, runtime) => { await runtime.narrate(chunks, i => played.push(i), signal); return response; }, e => events.push(e));
  await session.listen('read', {}, true, true); await flush();
  session.cancel('read'); await session.settled(); session.playback('read', 16000);
  assert.equal(calls, 1); assert.deepEqual(played, []);
  assert.ok(!events.some(e => e.type === 'error'));
});

test('partial synthesis failure cannot report successful narration or replay partial audio', async () => {
  const events = [], played = []; let calls = 0, completed = false;
  const session = new VoiceSession({}, { async synthesize(_text, _signal, audio) { calls++; await audio(new Uint8Array(32000)); throw Error('TTS stream incomplete'); } },
    async (_i, _e, signal, _t, runtime) => { await runtime.narrate(narrationChunks(document), i => played.push(i), signal); completed = true; return response; }, e => events.push(e));
  await session.listen('read', {}, true, true); await session.settled();
  assert.equal(completed, false); assert.equal(calls, 1); assert.deepEqual(played, []);
  assert.ok(events.some(e => e.type === 'error'));
});

test('narration rejects clients without playback acknowledgements before synthesis', async () => {
  let calls = 0;
  const session = new VoiceSession({}, { async synthesize() { calls++; } }, async (_i, _e, signal, _t, runtime) => {
    await assert.rejects(runtime.narrate(narrationChunks(document), () => {}, signal), /播放进度/); return response;
  }, () => {});
  await session.listen('read', {}, true, false); await session.settled(); assert.equal(calls, 0);
});

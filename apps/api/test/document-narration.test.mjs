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
function setup(runtime) {
  const dir = mkdtempSync(join(tmpdir(), 'bio-narration-'));
  const workspace = new PanelWorkspace(dir); workspace.showDocument(document);
  const events = [];
  const store = { async get(user, id) { assert.equal(user, 'owner'); if (id !== 'story') throw Error('missing'); return structuredClone(document); } };
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

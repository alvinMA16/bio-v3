import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpokenSegments } from '../dist/voice/spoken-segments.js';
import { VoiceSession } from '../dist/voice/voice-session.js';
import { PlaybackWindow } from '../dist/voice/playback-window.js';
import { DoubaoTts } from '../dist/voice/doubao-tts.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('cancellation preserves its source for the Agent and the client', async () => {
  let signal;
  const f = fixture({ run: async (_input, _emit, incoming) => { signal = incoming; return new Promise(resolve => incoming.addEventListener('abort', () => resolve(response), { once: true })); } });
  await f.session.listen('cancel-source', {});
  f.session.finish('cancel-source');
  await flush();
  f.session.close('page_hidden');
  await f.session.settled();
  assert.equal(signal.reason, 'page_hidden');
  assert.equal(f.events.find(event => event.type === 'cancelled').reason, 'page_hidden');
});
const response = { conversationId: 'conversation', message: { content: '好了。' } };
function fixture({ run, synthesize, text = '修改第二段' } = {}) {
  const events = [], spoken = [], inputs = [], asrCallbacks = [];
  let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const asr = { async open(callback) { asrCallbacks.push(callback); return { write() {}, close() {}, async finish() { return text; } }; } };
  const tts = { async synthesize(text, signal, audio) {
    spoken.push(text);
    if (synthesize) return synthesize(text, signal, audio);
    await audio(new Uint8Array([0, 0, 1, 0]));
  } };
  const runner = async (input, emit, signal, trigger, runtime) => {
    inputs.push(input);
    if (run) return run(input, emit, signal, trigger, runtime);
    emit({ type: 'speech.delta', messageId: 'before', delta: '我来改。' });
    emit({ type: 'speech.completed', messageId: 'before', text: '我来改。' });
    emit({ type: 'tool.started', name: 'update_content', toolCallId: 't' });
    emit({ type: 'panel.state.updated', panel: { mode: 'editor', revision: 1 } });
    emit({ type: 'speech.delta', messageId: 'after', delta: '改好了。' });
    emit({ type: 'speech.completed', messageId: 'after', text: '改好了。' });
    return response;
  };
  const session = new VoiceSession(asr, tts, runner, event => {
    events.push(event);
    if (event.type === 'done' || event.type === 'error') doneResolve(event);
  }, 2500);
  return { session, events, spoken, inputs, asrCallbacks, done };
}

test('speech segmentation isolates messages and avoids replaying completed snapshots', () => {
  const segments = new SpokenSegments();
  assert.deepEqual(segments.push('a', '先看'), []);
  assert.deepEqual(segments.push('a', '看。还有一句'), ['先看看。']);
  assert.deepEqual(segments.push('a', '先看看。还有一句', true), ['还有一句']);
  assert.deepEqual(segments.push('a', '先看看。还有一句', true), []);
  assert.deepEqual(segments.push('b', '第二条', true), ['第二条']);
  assert.throws(() => segments.push('a', '改变已播内容', true));
});

test('voice invokes Agent with context, forwards panel events, and speaks all utterances in order', async () => {
  const f = fixture();
  await f.session.listen('one', { conversationId: 'existing', provider: 'qwen', context: { scene: 'revision' } });
  f.session.finish('one');
  assert.equal((await f.done).type, 'done');
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0], { message: '修改第二段', conversationId: 'existing', provider: 'qwen', context: { scene: 'revision' } });
  assert.deepEqual(f.spoken, ['我来改。', '改好了。']);
  assert.ok(f.events.some(event => event.type === 'agent' && event.event.type === 'panel.state.updated'));
  assert.deepEqual(f.events.filter(event => event.type === 'audio').map(event => event.segmentId), [1, 2]);
  f.session.close();
});

test('opening speaks without ASR or a fabricated user transcript', async () => {
  const f = fixture({ run: async (input, emit, _signal, trigger) => {
    assert.equal(trigger, 'call_opening'); assert.equal(input.message, '');
    emit({ type: 'speech.completed', messageId: 'hello', text: '喂，我在呢。' });
    return response;
  } });
  await f.session.listen('opening', {}, true);
  assert.equal((await f.done).type, 'done');
  assert.equal(f.asrCallbacks.length, 0);
  assert.equal(f.events.some(event => event.type === 'transcript'), false);
  assert.deepEqual(f.spoken, ['喂，我在呢。']);
  await f.session.listen('user', {});
  assert.equal(f.asrCallbacks.length, 1);
  f.session.close();
});

test('interrupting an opening waits for cleanup and ignores its late audio', async () => {
  let lateAudio;
  const f = fixture({ synthesize: (_text, signal, audio) => new Promise(resolve => {
    lateAudio = audio; signal.addEventListener('abort', resolve, { once: true });
  }) });
  await f.session.listen('opening', {}, true); await flush();
  assert.ok(lateAudio);
  await f.session.listen('user', {});
  const count = f.events.length;
  lateAudio(new Uint8Array([0, 0])); await flush();
  assert.equal(f.events.length, count);
  assert.equal(f.asrCallbacks.length, 1);
  f.session.close();
});

test('interim ASR cannot end a turn; new speech resets the final stability window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.session.listen('one', {});
  f.asrCallbacks[0]({ text: '还没说完', final: false });
  t.mock.timers.tick(3000); await flush(); assert.equal(f.inputs.length, 0);
  f.asrCallbacks[0]({ text: '一句结束。', final: true });
  t.mock.timers.tick(2000);
  f.asrCallbacks[0]({ text: '一句结束。', final: false, speechStart: true });
  t.mock.timers.tick(3000); await flush(); assert.equal(f.inputs.length, 0);
  f.asrCallbacks[0]({ text: '都说完了。', final: true });
  t.mock.timers.tick(2500); await f.done;
  assert.equal(f.inputs.length, 1); f.session.close();
});

test('cancel stops old audio and ignores late ASR events', async () => {
  let lateAudio;
  const f = fixture({ synthesize: (_text, signal, audio) => new Promise(resolve => {
    lateAudio = audio; signal.addEventListener('abort', resolve, { once: true });
  }) });
  await f.session.listen('one', {}); f.session.finish('one'); await flush();
  assert.ok(lateAudio);
  f.session.cancel('one');
  const count = f.events.length;
  lateAudio(new Uint8Array([0, 0]));
  f.asrCallbacks[0]({ text: '旧识别', final: true });
  await flush();
  assert.equal(f.events.length, count); f.session.close();
});

test('empty ASR never invokes Agent; TTS failures preserve completed Agent result', async () => {
  const empty = fixture({ text: ' ' });
  await empty.session.listen('empty', {}); empty.session.finish('empty');
  assert.equal((await empty.done).stage, 'asr'); assert.equal(empty.inputs.length, 0); empty.session.close();
  const failed = fixture({ synthesize: async () => { throw new Error('vendor private details'); } });
  await failed.session.listen('failed', {}); failed.session.finish('failed');
  assert.equal((await failed.done).stage, 'tts');
  assert.ok(failed.events.some(event => event.type === 'result'));
  assert.ok(!JSON.stringify(failed.events).includes('vendor private details')); failed.session.close();
});

test('new turn waits for cancelled Agent cleanup before reusing the conversation', async () => {
  let release, started = false;
  const f = fixture({ run: async (_input, _emit, signal) => {
    started = true;
    await new Promise(resolve => { release = resolve; });
    signal.throwIfAborted();
    return response;
  } });
  await f.session.listen('first', { conversationId: 'same' }); f.session.finish('first'); await flush();
  assert.ok(started);
  const pending = f.session.listen('second', { conversationId: 'same' }); await flush();
  assert.equal(f.asrCallbacks.length, 1);
  release(); await pending;
  assert.equal(f.asrCallbacks.length, 2); f.session.close();
});


test('punctuation-only speech tails are not submitted to the TTS provider', () => {
  const segments = new SpokenSegments();
  assert.deepEqual(segments.push('quoted', '“你好。'), ['“你好。']);
  assert.deepEqual(segments.push('quoted', '“你好。”', true), []);
  assert.deepEqual(segments.push('dots', '……', true), []);
});

test('page changes while listening refresh this turn without accepting another material or stale turn', async () => {
  const f = fixture();
  await f.session.listen('page-turn', { context: { materialIds: ['owned'], attachmentView: { materialId: 'owned', page: 1 } } });
  f.session.updateAttachmentView('page-turn', { materialId: 'owned', page: 3 });
  f.session.updateAttachmentView('old-turn', { materialId: 'owned', page: 8 });
  f.session.updateAttachmentView('page-turn', { materialId: 'other', page: 9 });
  f.session.finish('page-turn');
  await f.done;
  assert.deepEqual(f.inputs[0].context.attachmentView, { materialId: 'owned', page: 3 });
  f.session.close();
});

test('playback credit waits for low water, ignores invalid/stale acknowledgements and aborts promptly', async () => {
  const window = new PlaybackWindow(true), abort = new AbortController();
  window.sent = 21 * 16000;
  let ready = false;
  const waiting = window.ready(abort.signal).then(() => { ready = true; });
  window.acknowledge(99 * 16000); window.acknowledge(-1); window.acknowledge(NaN);
  await flush(); assert.equal(ready, false);
  window.acknowledge(5 * 16000); await flush(); assert.equal(ready, false);
  window.acknowledge(13 * 16000); await waiting; assert.equal(window.played, 13 * 16000);
  window.acknowledge(2 * 16000); assert.equal(window.played, 13 * 16000);
  window.sent += 20 * 16000;
  const blocked = window.ready(abort.signal); abort.abort();
  await assert.rejects(blocked, /cancelled/);
});

test('five-minute reply stays bounded and resumes without repeating model calls or audio', async () => {
  let modelCalls = 0;
  const f = fixture({ run: async (_input, emit) => {
    modelCalls++;
    emit({ type: 'speech.completed', messageId: 'long', text: '一段完整的话。'.repeat(60) }); return response;
  }, synthesize: async (_text, _signal, emit) => { await emit(new Uint8Array(5 * 32000)); } });
  await f.session.listen('long', {}, true, true);
  for (let i = 0; i < 50; i++) await flush();
  const blockedCount = f.events.filter(e => e.type === 'audio').length;
  assert.equal(blockedCount, 20);
  await flush(); assert.equal(f.events.filter(e => e.type === 'audio').length, blockedCount);
  assert.equal(f.events.some(e => e.type === 'done'), false);
  let acknowledged = 0;
  for (let i = 0; i < 2000 && !f.events.some(e => e.type === 'done'); i++) {
    await flush();
    const audio = f.events.filter(e => e.type === 'audio');
    const sent = audio.at(-1)?.endSample ?? 0;
    assert.ok(sent - acknowledged <= 21 * 16000);
    if (sent) { f.session.playback('long', sent); acknowledged = sent; }
  }
  assert.equal((await f.done).type, 'done');
  assert.equal(modelCalls, 1);
  const chunks = f.events.filter(e => e.type === 'audio');
  assert.equal(chunks.length, 300);
  assert.equal(chunks.at(-1).endSample, 300 * 16000);
  assert.deepEqual(chunks.map(e => e.endSample), Array.from({ length: 300 }, (_, i) => (i + 1) * 16000));
  f.session.close();
});

test('client playback failure stops only speech; complete text and the next user turn survive', async () => {
  let release;
  const f = fixture({ run: async (_input, emit) => {
    emit({ type: 'speech.completed', messageId: 'reply', text: '较长的回复。' });
    await new Promise(resolve => { release = resolve; }); return response;
  }, synthesize: async (_text, _signal, emit) => { await emit(new Uint8Array(30 * 32000)); } });
  await f.session.listen('broken-audio', {}, true, true); await flush();
  f.session.stopPlayback('broken-audio', 'invalid_audio'); release();
  await f.done; await f.session.settled();
  assert.ok(f.events.some(e => e.type === 'result'));
  assert.ok(f.events.some(e => e.type === 'error' && e.recoverable));
  await f.session.listen('next', {}); assert.equal(f.asrCallbacks.length, 1);
  f.session.close();
});

test('a partial TTS stream is not retried and long punctuated segments stay bounded', async () => {
  let attempts = 0;
  const f = fixture({ synthesize: async (_text, _signal, emit) => {
    attempts++; await emit(new Uint8Array([0, 0])); throw new Error('provider failure');
  } });
  await f.session.listen('partial', {}, true); await f.done;
  assert.equal(attempts, 1); assert.equal(f.events.filter(e => e.type === 'audio').length, 1);
  f.session.close();
  const pieces = new SpokenSegments().push('long', '字'.repeat(330) + '。', true);
  assert.equal(pieces.join(''), '字'.repeat(330) + '。');
  assert.ok(pieces.every(text => text.length <= 100));
});

test('TTS waits for audio consumption credit and bounds chunks from a large provider frame', async t => {
  const data = Buffer.alloc(64000).toString('base64');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0, data }) + '\n' + JSON.stringify({ code: 20000000 }) + '\n'));
  const tts = new DoubaoTts({ appId: 'test', accessKey: 'test', resourceId: 'test', speaker: 'test' });
  let release, count = 0;
  const task = tts.synthesize('测试', new AbortController().signal, async pcm => {
    assert.equal(pcm.length, 32000); count++;
    if (count === 1) await new Promise(resolve => { release = resolve; });
  });
  await flush(); assert.equal(count, 1);
  release(); await task; assert.equal(count, 2);
});

test('missing playback acknowledgements time out without retaining a waiter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = new PlaybackWindow(true); window.sent = 20 * 16000;
  const failure = assert.rejects(window.ready(new AbortController().signal), /acknowledgement timeout/);
  t.mock.timers.tick(45000); await failure;
  window.acknowledge(window.sent); await window.ready(new AbortController().signal);
});

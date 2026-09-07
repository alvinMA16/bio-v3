import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpokenSegments } from '../dist/voice/spoken-segments.js';
import { VoiceSession } from '../dist/voice/voice-session.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const response = { conversationId: 'conversation', message: { content: '好了。' } };
function fixture({ run, synthesize, text = '修改第二段' } = {}) {
  const events = [], spoken = [], inputs = [], asrCallbacks = [];
  let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const asr = { async open(callback) { asrCallbacks.push(callback); return { write() {}, close() {}, async finish() { return text; } }; } };
  const tts = { async synthesize(text, signal, audio) {
    spoken.push(text);
    if (synthesize) return synthesize(text, signal, audio);
    audio(new Uint8Array([0, 0, 1, 0]));
  } };
  const runner = async (input, emit, signal) => {
    inputs.push(input);
    if (run) return run(input, emit, signal);
    emit({ type: 'speech.delta', messageId: 'before', delta: '我来改。' });
    emit({ type: 'speech.completed', messageId: 'before', text: '我来改。' });
    emit({ type: 'tool.started', name: 'update_panel_content', toolCallId: 't' });
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

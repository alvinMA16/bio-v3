import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/voice/browser-voice.ts', import.meta.url), 'utf8').replace("import workletUrl from './pcm-worklet.js?url&no-inline';", "const workletUrl = 'mock-worklet';");
const compiled = ts.transpileModule(source.replace("'../../../miniprogram/miniprogram/lib/fox-speech-signal'", JSON.stringify(new URL('../../miniprogram/miniprogram/lib/fox-speech-signal.ts', import.meta.url).href)), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { BrowserVoice } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('one phone call keeps its callId across turns and only explicit close sends hangup', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); f.sockets[0].onopen();
  f.client.interrupt();
  const listens = f.messages.map(JSON.parse).filter(m => m.type === 'listen');
  assert.equal(listens.length, 2); assert.equal(listens[0].callId, listens[1].callId);
  assert.notEqual(listens[0].turnId, listens[1].turnId);
  f.client.close(); f.client.close();
  assert.equal(f.messages.map(JSON.parse).filter(m => m.type === 'hangup').length, 1);
});

test('transport failure leaves call completion to the server grace period', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); f.sockets[0].onopen();
  f.sockets[0].onerror();
  assert.equal(f.messages.map(JSON.parse).filter(m => m.type === 'hangup').length, 0);
});

const timerContexts = new WeakSet();
function environment(t, pendingMic, moduleError, prepare) {
  if (!timerContexts.has(t)) { t.mock.timers.enable({ apis: ['setTimeout'] }); timerContexts.add(t); }
  const cache = new Map();
  const tones = [];
  const sockets = [], nodes = [], messages = [], events = [], starts = [], playback = [], captures = [], levels = [], gains = [];
  let stopped = 0, ended = 0, connected = 0;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  class Socket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0;
    constructor() { sockets.push(this); }
    send(value) { messages.push(value); }
    close() { this.readyState = 3; }
  }
  class Context {
    currentTime = 0; destination = {}; audioWorklet = { async addModule() { if (moduleError) throw moduleError; } };
    async resume() {} async close() {}
    createAnalyser() { return { amplitude: 0, connect(destination) { this.destination = destination; }, disconnect() {}, getFloatTimeDomainData(samples) { samples.fill(this.amplitude); } }; }
    createGain() { const node = { gain: { events: [], setValueAtTime(...args) { this.events.push(args); }, linearRampToValueAtTime(...args) { this.events.push(args); } }, connect() {}, disconnect() {} }; gains.push(node); return node; }
    createOscillator() { const tone = { frequency: {}, connect() {}, disconnect() {}, start() {}, stop() { this.stopped = true; } }; tones.push(tone); return tone; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_channels, length, rate) { return { getChannelData: () => new Float32Array(length), duration: length / rate }; }
    createBufferSource() { const node = { connect(destination) { node.destination = destination; }, disconnect() {}, start() {}, stop() { node.stopped = true; } }; nodes.push(node); return node; }
  }
  const globals = {
    navigator: { mediaDevices: { getUserMedia: () => pendingMic ?? Promise.resolve(stream) } },
    location: { href: 'http://localhost:5173', protocol: 'http:' },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    AudioContext: Context,
    AudioWorkletNode: class { constructor() { captures.push(this); } port = { postMessage() {} }; connect() {} disconnect() {} },
    WebSocket: Socket,
    sessionStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
  };
  const restore = [];
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const client = new BrowserVoice({ prepare, connected: () => connected++, request: () => ({}), start: id => starts.push(id), event: event => events.push(event),
    inputLevel: level => levels.push(level), playback: (...args) => playback.push(args), error: message => events.push({ type: 'local.error', message }), ended: () => ended++ });
  t.after(() => { client.close(); restore.forEach(fn => fn()); });
  return { client, cache, tones, sockets, nodes, captures, levels, gains, starts, messages, events, playback, stream, connected: () => connected, stopped: () => stopped, ended: () => ended };
}

test('interruption clears scheduled audio and rejects old turn callbacks', async t => {

  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const first = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: first, sampleRate: 16000, data: 'AAA=', text: '旧音频', segmentId: 1 }) });
  f.client.interrupt();
  assert.ok(f.nodes[0].stopped); assert.equal(f.starts.length, 2);
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: first, sampleRate: 16000, data: 'AAA=', text: '迟到音频', segmentId: 2 }) });
  t.mock.timers.tick(1000);
  assert.equal(f.nodes.length, 1);
  assert.equal(f.playback.filter(([playing]) => playing).length, 0);
  f.client.close(); assert.equal(f.stopped(), 1); assert.equal(f.ended(), 1);
});

test('next listening turn waits for actual playback drain, not server done', async t => {

  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  ws.onmessage({ data: JSON.stringify({ type: 'done', turnId: id }) });
  t.mock.timers.tick(300); assert.equal(f.starts.length, 1);
  f.nodes[0].onended(); t.mock.timers.tick(200);
  assert.equal(f.starts.length, 2);
});

test('closing while microphone permission is pending stops the late stream', async t => {
  let resolve;
  const pending = new Promise(value => { resolve = value; });
  const f = environment(t, pending);
  const starting = f.client.start(); await flush(); f.client.close();
  resolve(f.stream); await starting;
  assert.equal(f.stopped(), 1); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].readyState, 3);
});

test('muting releases the microphone while keeping queued reply audio playing', async t => {

  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '继续说完', segmentId: 1 }) });
  await f.client.setMicrophone(false);
  assert.equal(f.stopped(), 1);
  assert.equal(f.nodes[0].stopped, undefined);
  ws.onmessage({ data: JSON.stringify({ type: 'done', turnId: id }) });
  f.nodes[0].onended(); t.mock.timers.tick(1000);
  assert.equal(f.starts.length, 1);
  await f.client.setMicrophone(true);
  assert.equal(f.starts.length, 2);
});

test('muting an unsubmitted utterance cancels it and discards late recognition', async t => {
  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening', turnId: id }) });
  await f.client.setMicrophone(false);
  assert.ok(f.messages.some(value => typeof value === 'string' && JSON.parse(value).type === 'cancel'));
  const count = f.events.length;
  ws.onmessage({ data: JSON.stringify({ type: 'transcript', turnId: id, text: '不要提交' }) });
  assert.equal(f.events.length, count);
  assert.equal(f.stopped(), 1);
});

test('unmuting during playback does not start a new listening turn early', async t => {

  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '还没说完', segmentId: 1 }) });
  await f.client.setMicrophone(false); await f.client.setMicrophone(true);
  assert.equal(f.starts.length, 1);
  ws.onmessage({ data: JSON.stringify({ type: 'done', turnId: id }) });
  f.nodes[0].onended(); t.mock.timers.tick(200);
  assert.equal(f.starts.length, 2);
});

test('muting during permission prompt discards a late microphone stream', async t => {
  let resolve;
  const f = environment(t, new Promise(value => { resolve = value; }));
  const starting = f.client.start(); await flush();
  await f.client.setMicrophone(false); resolve(f.stream); await starting;
  f.sockets[0].onopen();
  assert.equal(f.stopped(), 1); assert.equal(f.starts.length, 0);
});


test('microphone meter reflects input PCM only and resets when listening pauses', async t => {
  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  const state = value => ws.onmessage({ data: JSON.stringify({ type: 'state', state: value, turnId: id }) });
  const frame = value => f.captures[0].port.onmessage({ data: new Int16Array(1600).fill(value).buffer });
  state('listening');
  frame(0); assert.equal(f.levels.at(-1), 0);
  frame(4000); assert.ok(f.levels.at(-1) > 0);
  state('agent'); assert.equal(f.levels.at(-1), 0);
  const count = f.levels.length;
  frame(12000); assert.equal(f.levels.length, count);
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '回复', segmentId: 1 }) });
  assert.equal(f.levels.length, count);
  state('listening'); frame(4000);
  await f.client.setMicrophone(false); assert.equal(f.levels.at(-1), 0);
  frame(12000); assert.equal(f.levels.at(-1), 0);
});


test('speaker mute silences current and future audio without stopping playback or microphone', async t => {

  const f = environment(t);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  const audio = segmentId => ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '你好', segmentId }) });
  audio(1);
  const analyser = f.nodes[0].destination;
  const output = analyser.destination;
  assert.equal(output.gain.value, 1);
  f.client.setSpeaker(false);
  assert.equal(output.gain.value, 0);
  assert.equal(f.stopped(), 0);
  assert.equal(f.nodes[0].stopped, undefined);
  audio(2);
  assert.equal(f.nodes[1].destination, analyser);
  f.client.setSpeaker(true);
  assert.equal(output.gain.value, 1);
});


test('worklet load failure shows a friendly error and releases microphone resources', async t => {
  t.mock.method(console, 'error', () => {});
  const f = environment(t, undefined, new Error("Unable to load a worklet's module."));
  await f.client.start(); t.mock.timers.tick(3000);
  assert.equal(f.events.find(event => event.type === 'local.error').message, '语音连接失败，请重试。');
  assert.equal(f.stopped(), 1);
  assert.equal(f.ended(), 1);
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].readyState, 3);
});

test('playback credits are sent only after audio ends, and stale audio never acknowledges a new turn', async t => {

  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1, endSample: 1 }) });
  const messages = () => f.messages.map(JSON.parse).filter(m => m.type === 'playback');
  assert.equal(messages().length, 0);
  f.nodes[0].onended(); assert.deepEqual(messages()[0], { type: 'playback', turnId: id, playedSamples: 1 });
  f.client.interrupt();
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '旧音频', segmentId: 2, endSample: 2 }) });
  assert.equal(messages().length, 1);
});

test('bad audio pauses speech while retaining complete text and keeping the call open', async t => {
 t.mock.method(console, 'error', () => {});
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AA==', text: '错误音频', segmentId: 1 }) });
  assert.equal(f.ended(), 0); assert.equal(ws.readyState, 1);
  assert.ok(f.messages.map(JSON.parse).some(m => m.type === 'playback.stop'));
  ws.onmessage({ data: JSON.stringify({ type: 'result', turnId: id, result: { conversationId: 'same', message: { content: '完整文字' } } }) });
  assert.ok(f.events.some(e => e.type === 'result' && e.result.message.content === '完整文字'));
  ws.onmessage({ data: JSON.stringify({ type: 'error', turnId: id, recoverable: true, stage: 'tts', message: '暂停' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'done', turnId: id }) });
  t.mock.timers.tick(200); assert.equal(f.starts.length, 2); assert.equal(f.ended(), 0);
});

test('network reconnect reuses confirmed call identity and ignores the old socket; hangup stops retries', async t => {

  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const old = f.sockets[0]; old.onopen();
  const first = f.messages.map(JSON.parse).find(m => m.type === 'listen');
  old.onmessage({ data: JSON.stringify({ type: 'connected', turnId: first.turnId, callId: first.callId, conversationId: 'conv', resumed: false }) });
  old.onclose({ code: 1006 });
  t.mock.timers.tick(1000); const next = f.sockets[1]; next.onopen();
  const resumed = f.messages.map(JSON.parse).filter(m => m.type === 'listen').at(-1);
  assert.equal(resumed.callId, first.callId); assert.equal(resumed.resume, true);
  assert.notEqual(resumed.turnId, first.turnId); assert.equal(resumed.request.conversationId, 'conv');
  const count = f.events.length;
  old.onmessage({ data: JSON.stringify({ type: 'transcript', turnId: first.turnId, text: '迟到的旧消息' }) });
  assert.equal(f.events.length, count);
  next.onclose({ code: 1006 }); f.client.close(); t.mock.timers.tick(20000);
  assert.equal(f.sockets.length, 2);
});

test('manual reconnect restores the cached call; another account and explicit hangup do not inherit it', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const first = f.messages.map(JSON.parse).find(m => m.type === 'listen');
  ws.onmessage({ data: JSON.stringify({ type: 'connected', turnId: first.turnId, callId: first.callId, conversationId: 'conv', resumed: false }) });
  f.client.close(false);
  const callbacks = { request: () => ({}), start() {}, event() {}, playback() {}, error() {}, ended() {} };
  const resumed = new BrowserVoice(callbacks); t.after(() => resumed.close());
  await resumed.start(); f.sockets[1].onopen();
  const same = f.messages.map(JSON.parse).filter(m => m.type === 'listen').at(-1);
  assert.equal(same.callId, first.callId); assert.equal(same.resume, true);
  const other = new BrowserVoice(callbacks, 'bio-voice-resume:another-account'); t.after(() => other.close());
  await other.start(); f.sockets[2].onopen();
  assert.notEqual(f.messages.map(JSON.parse).filter(m => m.type === 'listen').at(-1).callId, first.callId);
  resumed.close(); other.close(); assert.equal(f.cache.has('bio-voice-resume'), false);
});

test('recoverable recognition failure pauses microphone instead of looping and allows explicit retry', async t => {

  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen(); const turnId = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'error', turnId, stage: 'asr', recoverable: true, message: '识别暂时不可用' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'done', turnId }) });
  t.mock.timers.tick(2000); assert.equal(f.starts.length, 1); assert.equal(f.ended(), 0);
  await f.client.setMicrophone(true); assert.equal(f.starts.length, 2);
});


test('motion level follows accepted microphone PCM and clears when listening stops', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const turnId = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening', turnId }) });
  const pcm = value => f.captures[0].port.onmessage({ data: new Int16Array(320).fill(value).buffer });
  pcm(1000); const quiet = f.client.getMotionLevel();
  pcm(4000); assert.ok(f.client.getMotionLevel() > quiet * 3);
  pcm(0); assert.equal(f.client.getMotionLevel(), 0);
  pcm(4000); await f.client.setMicrophone(false); assert.equal(f.client.getMotionLevel(), 0);
});

test('motion samples playback as it sounds and clears on mute, interruption and close', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  const analyser = f.nodes[0].destination;
  assert.equal(f.client.getMotionLevel(), 0, 'queued silent audio does not animate');
  analyser.amplitude = .1; assert.ok(f.client.getMotionLevel() > .4);
  f.client.setSpeaker(false); assert.equal(f.client.getMotionLevel(), 0);
  f.client.setSpeaker(true); assert.ok(f.client.getMotionLevel() > .4);
  f.client.interrupt(); assert.equal(f.client.getMotionLevel(), 0);
  f.client.close(); assert.equal(f.client.getMotionLevel(), 0);
});


test('call connects only when listening is ready, once across subsequent turns', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  assert.equal(f.connected(), 0);
  const emit = (turnId, state) => ws.onmessage({ data: JSON.stringify({ type: 'state', turnId, state, elapsedMs: 0 }) });
  emit(f.starts[0], 'connecting'); assert.equal(f.connected(), 0);
  emit(f.starts[0], 'listening'); assert.equal(f.connected(), 1);
  f.client.interrupt();
  emit(f.starts[0], 'listening'); emit(f.starts[1], 'listening');
  assert.equal(f.connected(), 1);
});

test('cancel during dialing ignores late readiness', async t => {
  const f = environment(t); await f.client.start(); const ws = f.sockets[0]; ws.onopen();
  f.client.close();
  ws.onmessage({ data: JSON.stringify({ type: 'state', turnId: f.starts[0], state: 'listening', elapsedMs: 0 }) });
  t.mock.timers.tick(5000);
  assert.equal(f.connected(), 0);
});


test('server connects during UI preparation and cancellation prevents late playback', async t => {
  let ready; const preparation = new Promise(resolve => { ready = resolve; });
  const f = environment(t, undefined, undefined, () => preparation);
  const starting = f.client.start(); await flush();
  assert.equal(f.sockets.length, 1);
  f.sockets[0].onopen();
  f.sockets[0].onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  assert.equal(f.nodes.length, 0);
  f.client.close(); ready(); await starting; await flush(); t.mock.timers.tick(5000);
  assert.equal(f.nodes.length, 0); assert.equal(f.connected(), 0);
});

test('opening audio connects before playing even before the first listening state', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  assert.equal(f.connected(), 0);
  ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  assert.equal(f.connected(), 1);
  ws.onmessage({ data: JSON.stringify({ type: 'state', turnId: f.starts[0], state: 'listening', elapsedMs: 0 }) });
  assert.equal(f.connected(), 1);
});

test('exactly three scheduled rings hold early audio and listening until the dialing ends', async t => {
  for (const type of ['state', 'audio']) {
    const f = environment(t); await f.client.start();
    assert.deepEqual(f.tones.map(tone => tone.frequency.value), [440, 480]);
    assert.equal(f.gains[1].gain.events.length, 12);
    assert.deepEqual(f.gains[1].gain.events.filter((_, i) => i % 4 === 3).map(e => Math.round(e[1] * 1000)), [600, 1800, 3000]);
    f.sockets[0].onopen();
    f.sockets[0].onmessage({ data: JSON.stringify({ type, state: 'listening', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
    t.mock.timers.tick(2999);
    assert.equal(f.connected(), 0); assert.equal(f.nodes.length, 0);
    t.mock.timers.tick(1);
    assert.equal(f.connected(), 1); assert.ok(f.tones.every(tone => tone.stopped));
    const count = f.gains[1].gain.events.length;
    t.mock.timers.tick(5000); assert.equal(f.gains[1].gain.events.length, count);
    f.client.close();
  }
});
test('slow UI waits silently after three rings, then releases the buffered opening in order', async t => {
  let ready;
  const f = environment(t, undefined, undefined, () => new Promise(resolve => { ready = resolve; }));
  await f.client.start(); f.sockets[0].onopen();
  const emit = e => f.sockets[0].onmessage({ data: JSON.stringify({ turnId: f.starts[0], ...e }) });
  emit({ type: 'audio', sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 });
  emit({ type: 'done' });
  t.mock.timers.tick(6000);
  assert.ok(f.tones.every(tone => tone.stopped)); assert.equal(f.connected(), 0); assert.equal(f.nodes.length, 0);
  ready(); await flush();
  assert.equal(f.connected(), 1); assert.equal(f.nodes.length, 1);
  assert.deepEqual(f.events.map(e => e.type), ['audio', 'done']);
  assert.equal(f.starts.length, 1);
  f.nodes[0].onended(); t.mock.timers.tick(200); assert.equal(f.starts.length, 2);
});
test('UI failure during server preparation stops the call without playing queued audio', async t => {
  let reject;
  const f = environment(t, undefined, undefined, () => new Promise((_, r) => { reject = r; }));
  await f.client.start(); f.sockets[0].onopen();
  f.sockets[0].onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  reject(new Error('asset failure')); await flush(); t.mock.timers.tick(5000);
  assert.equal(f.ended(), 1); assert.equal(f.nodes.length, 0); assert.equal(f.connected(), 0);
  assert.ok(f.tones.every(tone => tone.stopped));
});
test('ringback stops on cancellation during permission and startup failure', async t => {
  const pending = new Promise(() => {});
  const f = environment(t, pending);
  void f.client.start(); await flush(); f.client.close();
  assert.equal(f.tones.length, 2);
  assert.ok(f.tones.every(tone => tone.stopped));
  const failed = environment(t, undefined, new Error('worklet failed'));
  await failed.client.start();
  assert.ok(failed.tones.every(tone => tone.stopped));
});

test('startup server failure stops all tones and discards the queued opening', async t => {
  const f = environment(t); await f.client.start(); f.sockets[0].onopen();
  const emit = event => f.sockets[0].onmessage({ data: JSON.stringify({ turnId: f.starts[0], ...event }) });
  emit({ type: 'audio', sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 });
  emit({ type: 'error', stage: 'tts', recoverable: true, message: '开场语音不可用' });
  t.mock.timers.tick(5000);
  assert.equal(f.ended(), 1); assert.equal(f.connected(), 0); assert.equal(f.nodes.length, 0);
  assert.ok(f.tones.every(tone => tone.stopped));
});
test('reconnecting during dialing discards audio from the replaced connection', async t => {
  const f = environment(t); await f.client.start(); const old = f.sockets[0]; old.onopen();
  old.onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '旧开场', segmentId: 1 }) });
  old.onerror(); t.mock.timers.tick(1000); f.sockets[1].onopen();
  f.sockets[1].onmessage({ data: JSON.stringify({ type: 'state', turnId: f.starts[1], state: 'listening' }) });
  t.mock.timers.tick(2000);
  assert.equal(f.connected(), 1); assert.equal(f.nodes.length, 0);
  assert.equal(f.tones.length, 2, 'reconnect does not restart the three rings');
});

test('opening starts while microphone permission is pending but playback waits for capture', async t => {
  let allow;
  const f = environment(t, new Promise(resolve => { allow = resolve; }));
  const starting = f.client.start(); await flush();
  assert.equal(f.sockets.length, 1);
  f.sockets[0].onopen();
  assert.equal(f.starts.length, 1);
  f.sockets[0].onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  t.mock.timers.tick(3000);
  assert.equal(f.connected(), 0); assert.equal(f.nodes.length, 0);
  allow(f.stream); await starting;
  assert.equal(f.connected(), 1); assert.equal(f.nodes.length, 1);
});
test('denying microphone permission discards the prepared opening and closes transport', async t => {
  let deny;
  const f = environment(t, new Promise((_, reject) => { deny = reject; }));
  t.mock.method(console, 'error', () => {});
  const starting = f.client.start(); await flush(); f.sockets[0].onopen();
  f.sockets[0].onmessage({ data: JSON.stringify({ type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 }) });
  deny(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); await starting; t.mock.timers.tick(4000);
  assert.equal(f.ended(), 1); assert.equal(f.connected(), 0); assert.equal(f.nodes.length, 0);
  assert.equal(f.sockets[0].readyState, 3);
});

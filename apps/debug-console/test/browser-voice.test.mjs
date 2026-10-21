import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/voice/browser-voice.ts', import.meta.url), 'utf8').replace("import workletUrl from './pcm-worklet.js?url&no-inline';", "const workletUrl = 'mock-worklet';");
const compiled = ts.transpileModule(source.replace("'@bio/contracts'", JSON.stringify(new URL('../../../packages/contracts/dist/index.js', import.meta.url).href)).replace("'../../../miniprogram/miniprogram/lib/capture-buffer'", JSON.stringify(new URL('../../miniprogram/miniprogram/lib/capture-buffer.ts', import.meta.url).href)).replace("'../../../miniprogram/miniprogram/lib/fox-speech-signal'", JSON.stringify(new URL('../../miniprogram/miniprogram/lib/fox-speech-signal.ts', import.meta.url).href)), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
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
  const visibility = new EventTarget();
  const recoveries = [], statuses = [], contexts = [];
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
    constructor() { contexts.push(this); }
    currentTime = 0; destination = {}; audioWorklet = { async addModule() { if (moduleError) throw moduleError; } };
    async resume() {} async close() {}
    createAnalyser() { return { amplitude: 0, connect(destination) { this.destination = destination; }, disconnect() {}, getFloatTimeDomainData(samples) { samples.fill(this.amplitude); } }; }
    createGain() { const node = { gain: { events: [], cancelAndHoldAtTime(...args) { this.events.push(args); }, setValueCurveAtTime(...args) { this.events.push(args); }, setValueAtTime(...args) { this.events.push(args); }, linearRampToValueAtTime(...args) { this.events.push(args); } }, connect() {}, disconnect() {} }; gains.push(node); return node; }
    createOscillator() { const tone = { frequency: {}, connect() {}, disconnect() {}, start() {}, stop() { this.stopped = true; } }; tones.push(tone); return tone; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_channels, length, rate) { return { getChannelData: () => new Float32Array(length), duration: length / rate }; }
    createBufferSource() { const node = { connect(destination) { node.destination = destination; }, disconnect() {}, start() {}, stop() { node.stopped = true; } }; nodes.push(node); return node; }
  }
  const globals = {
    navigator: { mediaDevices: { getUserMedia: () => pendingMic ?? Promise.resolve(stream) } },
    location: { href: 'http://localhost:5173', protocol: 'http:' },
    document: { hidden: false, querySelector: () => ({ src: 'http://localhost/assets/main-test.js' }), addEventListener: (...args) => visibility.addEventListener(...args), removeEventListener: (...args) => visibility.removeEventListener(...args), dispatchEvent: event => visibility.dispatchEvent(event) },
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
  const client = new BrowserVoice({ prepare, status: value => statuses.push(value), connected: () => connected++, request: () => ({}), start: id => starts.push(id), event: event => events.push(event),
    inputLevel: level => levels.push(level), playback: (...args) => playback.push(args), error: message => events.push({ type: 'local.error', message }), ended: until => { recoveries.push(until); ended++; } });
  t.after(() => { client.close(); restore.forEach(fn => fn()); });
  return { client, cache, recoveries, statuses, contexts, navigator: globals.navigator, document: globals.document, tones, sockets, nodes, captures, levels, gains, starts, messages, events, playback, stream, connected: () => connected, stopped: () => stopped, ended: () => ended };
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

test('three complete rings hold early audio and listening, with a smooth envelope', async t => {
  for (const type of ['state', 'audio']) {
    const f = environment(t); await f.client.start();
    assert.deepEqual(f.tones.map(tone => tone.frequency.value), [440, 480]);
    assert.equal(f.gains[1].gain.events.length, 3);
    assert.deepEqual(f.gains[1].gain.events.map(e => Math.round((e[1] + e[2]) * 1000)), [600, 1800, 3000]);
    const curve = f.gains[1].gain.events[0][0];
    assert.equal(curve[0], 0); assert.equal(curve.at(-1), 0);
    assert.ok(curve[80] > curve[100] && curve[100] > curve[119]);
    assert.ok(Math.max(...curve.slice(1).map((value, i) => Math.abs(value - curve[i]))) < .002);
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
test('slow UI keeps ringing, then releases the buffered opening in order', async t => {
  let ready;
  const f = environment(t, undefined, undefined, () => new Promise(resolve => { ready = resolve; }));
  await f.client.start(); f.sockets[0].onopen();
  const emit = e => f.sockets[0].onmessage({ data: JSON.stringify({ turnId: f.starts[0], ...e }) });
  emit({ type: 'audio', sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1 });
  emit({ type: 'done' });
  t.mock.timers.tick(3000);
  t.mock.timers.tick(600);
  assert.equal(f.gains[1].gain.events.length, 4);
  assert.ok(f.tones.every(tone => !tone.stopped)); assert.equal(f.connected(), 0); assert.equal(f.nodes.length, 0);
  ready(); await flush();
  assert.equal(f.connected(), 0, 'finish the extra ring before connecting');
  t.mock.timers.tick(600);
  assert.equal(f.connected(), 1); assert.equal(f.nodes.length, 1);
  assert.deepEqual(f.events.map(e => e.type), ['audio', 'done']);
  assert.equal(f.starts.length, 1);
  f.nodes[0].onended(); t.mock.timers.tick(200); assert.equal(f.starts.length, 2);
});
test('slow server adds fourth and fifth rings and connects in the next quiet gap', async t => {
  const f = environment(t); await f.client.start(); f.sockets[0].onopen();
  t.mock.timers.tick(3000);
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(600); t.mock.timers.tick(600); }
  assert.equal(f.gains[1].gain.events.length, 5);
  assert.equal(f.connected(), 0);
  f.sockets[0].onmessage({ data: JSON.stringify({ type: 'state', state: 'listening', turnId: f.starts[0] }) });
  assert.equal(f.connected(), 1);
  assert.equal(f.client.getDialPhase(), -1);
  const count = f.gains[1].gain.events.length;
  t.mock.timers.tick(2400);
  assert.equal(f.gains[1].gain.events.length, count);
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

test('a focus panel is acknowledged on the wire before the UI callback and never claims visibility', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const event = { type: 'agent', turnId: f.starts[0], event: { type: 'panel.state.updated', conversationId: 'conversation', panel: {
    mode: 'editor', documentView: { documentId: 'story', version: 3, page: 2, focus: { requestId: 'focus', blockId: 'b9', start: 0, end: 10 } },
  } } };
  ws.onmessage({ data: JSON.stringify(event) });
  const receipts = f.messages.map(JSON.parse).filter(m => m.type === 'document.view');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].view.navigation.status, 'received');
  assert.equal(receipts[0].view.navigation.clientBuild, 'main-test.js');
  assert.equal(receipts[0].turnId, f.starts[0]); assert.ok(f.events.some(e => e.type === 'agent'));
  ws.onmessage({ data: JSON.stringify({ ...event, turnId: 'stale' }) });
  assert.equal(f.messages.map(JSON.parse).filter(m => m.type === 'document.view').length, 1);
});


function wakeLockFixture(f) {
  const locks = [];
  f.navigator.wakeLock = { async request(type) {
    assert.equal(type, 'screen');
    const lock = new EventTarget(); lock.released = false; lock.releaseCount = 0;
    lock.release = async () => { lock.releaseCount++; lock.released = true; lock.dispatchEvent(new Event('release')); };
    locks.push(lock); return lock;
  } };
  return locks;
}

test('voice holds a screen wake lock and releases it once on explicit hangup', async t => {
  const f = environment(t); const locks = wakeLockFixture(f);
  await f.client.start(); await flush();
  assert.equal(locks.length, 1); assert.equal(locks[0].released, false);
  f.client.close(); f.client.close(); await flush();
  assert.equal(locks[0].releaseCount, 1);
  f.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(locks.length, 1, 'a finished call cannot reacquire wake lock');
});

test('wake lock refusal does not block microphone or socket', async t => {
  const f = environment(t);
  f.navigator.wakeLock = { async request() { throw new Error('Power saving'); } };
  await f.client.start(); await flush();
  assert.equal(f.sockets.length, 1); assert.equal(f.captures.length, 1); assert.equal(f.ended(), 0);
  f.client.close();
});

test('startup failure releases an acquired screen wake lock', async t => {
  const failed = environment(t, undefined, new Error('Worklet unavailable'));
  const locks = wakeLockFixture(failed); await failed.client.start(); await flush();
  assert.equal(failed.ended(), 1); assert.equal(locks[0].released, true);
});

test('late wake lock acquisition after hangup is immediately released', async t => {
  const f = environment(t); let resolve;
  const lock = { releaseCount: 0, async release() { this.releaseCount++; }, addEventListener() {} };
  f.navigator.wakeLock = { request: () => new Promise(done => { resolve = done; }) };
  await f.client.start(); f.client.close(); resolve(lock); await flush();
  assert.equal(lock.releaseCount, 1);
});

test('hidden page releases wake lock, offers five-minute recovery and a resumed call holds a new lock', async t => {
  const f = environment(t); const locks = wakeLockFixture(f);
  await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const first = f.messages.map(JSON.parse).find(m => m.type === 'listen');
  ws.onmessage({ data: JSON.stringify({ type: 'connected', turnId: first.turnId, callId: first.callId, conversationId: 'conv', resumed: false }) });
  const before = Date.now(); f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(locks[0].released, true); assert.equal(f.ended(), 1);
  assert.ok(f.recoveries[0] >= before + 300000 && f.recoveries[0] <= Date.now() + 300000);
  assert.ok(f.messages.map(JSON.parse).some(m => m.type === 'disconnect' && m.reason === 'page_hidden'));
  assert.ok(!f.messages.map(JSON.parse).some(m => m.type === 'hangup'));
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(locks.length, 1, 'resuming capture requires the user to continue the call');
  const resumed = new BrowserVoice({ request: () => ({}), start() {}, event() {}, playback() {}, error() {}, ended() {} });
  t.after(() => resumed.close()); await resumed.start(); f.sockets[1].onopen(); await flush();
  assert.equal(locks.length, 2); assert.equal(locks[1].released, false);
  const next = f.messages.map(JSON.parse).filter(m => m.type === 'listen').at(-1);
  assert.equal(next.callId, first.callId); assert.equal(next.resume, true);
});

test('a failed recovery attempt preserves its original deadline and expiry starts a new call', async t => {
  const f = environment(t); const until = Date.now() + 300000;
  f.cache.set('bio-voice-resume', JSON.stringify({ callId: 'interrupted-call', expiresAt: until }));
  const callbacks = { request: () => ({}), start() {}, event() {}, playback() {}, error() {}, ended() {} };
  const retry = new BrowserVoice(callbacks); t.after(() => retry.close());
  await retry.start(); f.sockets[0].onopen(); retry.close(false);
  assert.equal(JSON.parse(f.cache.get('bio-voice-resume')).expiresAt, until);
  f.cache.set('bio-voice-resume', JSON.stringify({ callId: 'interrupted-call', expiresAt: Date.now() - 1 }));
  const expired = new BrowserVoice(callbacks); t.after(() => expired.close());
  await expired.start(); f.sockets[1].onopen();
  const next = f.messages.map(JSON.parse).filter(m => m.type === 'listen').at(-1);
  assert.notEqual(next.callId, 'interrupted-call'); assert.equal(next.resume, false);
});

test('durable capture keeps offline frames, resends only missing sequences and survives a fresh client', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  let turnId = f.starts[0];
  const incoming = (socket, event) => socket.onmessage({ data: JSON.stringify({ turnId, ...event }) });
  incoming(ws, { type: 'connected', callId: 'call', conversationId: 'conversation', resumed: false });
  incoming(ws, { type: 'capture.ready', captureId: 'draft', sequence: 0 });
  incoming(ws, { type: 'state', state: 'listening' });
  const frame = () => f.captures[0].port.onmessage({ data: new Int16Array([100, 200]).buffer });
  frame(); incoming(ws, { type: 'capture.saved', captureId: 'draft', sequence: 1 });
  frame(); // server may have saved this; ACK lost
  frame(); // queued before transport loss
  ws.onerror(); frame(); // capture pauses while offline; the worklet's late frame is ignored
  t.mock.timers.tick(1000); const reconnected = f.sockets[1]; reconnected.onopen(); turnId = f.starts.at(-1);
  incoming(reconnected, { type: 'connected', callId: 'call', conversationId: 'conversation', resumed: true });
  incoming(reconnected, { type: 'capture.ready', captureId: 'draft', sequence: 2 });
  const before = f.messages.length;
  incoming(reconnected, { type: 'state', state: 'listening' });
  assert.deepEqual(f.messages.slice(before).map(JSON.parse).filter(m => m.type === 'capture.audio').map(m => m.sequence), [3]);
  f.client.close(false);
  const next = new BrowserVoice({ request: () => ({}), start() {}, event() {}, playback() {}, error() {}, ended() {} });
  t.after(() => next.close()); await next.start(); t.mock.timers.tick(3000); f.sockets[2].onopen();
  const listen = f.messages.map(JSON.parse).filter(m => m.type === 'listen').at(-1);
  assert.equal(listen.captureId, 'draft'); assert.equal(listen.callId, 'call');
  turnId = listen.turnId;
  incoming(f.sockets[2], { type: 'capture.ready', captureId: 'draft', sequence: 2 });
  const start = f.messages.length;
  incoming(f.sockets[2], { type: 'state', state: 'listening' });
  assert.deepEqual(f.messages.slice(start).map(JSON.parse).filter(m => m.type === 'capture.audio').map(m => m.sequence), [3]);
});

test('four seconds of backlog no longer bursts or opens microphone before all ACKs', async t => {
  const f=environment(t);await f.client.start();t.mock.timers.tick(3000);const ws=f.sockets[0];ws.onopen();
  let turnId=f.starts[0];const incoming=(socket,event)=>socket.onmessage({data:JSON.stringify({turnId,...event})});
  incoming(ws,{type:'connected',callId:'call',conversationId:'conversation',resumed:false});
  incoming(ws,{type:'capture.ready',captureId:'draft',sequence:0});incoming(ws,{type:'state',state:'listening'});
  // Congestion retains audio locally instead of disconnecting.
  ws.bufferedAmount=200000;
  const frame=()=>f.captures[0].port.onmessage({data:new Int16Array(1600).buffer});
  for(let i=0;i<40;i++)frame();assert.equal(f.ended(),0);
  ws.onerror();t.mock.timers.tick(1000);const next=f.sockets[1];next.onopen();turnId=f.starts.at(-1);
  incoming(next,{type:'connected',callId:'call',conversationId:'conversation',resumed:true});
  incoming(next,{type:'capture.ready',captureId:'draft',sequence:0});
  const before=f.messages.length;incoming(next,{type:'state',state:'listening'});
  assert.equal(f.client.listening,false);
  let audio=()=>f.messages.slice(before).map(JSON.parse).filter(m=>m.type==='capture.audio');
  assert.equal(audio().length,1);
  for(let i=0;i<40;i++) {incoming(next,{type:'capture.saved',captureId:'draft',sequence:i+1});t.mock.timers.tick(100);}
  assert.equal(audio().length,40);assert.equal(f.client.listening,true);assert.equal(f.ended(),0);
});

test('fresh call does not send the previous capture ID or resume call; parked audio survives', async t => {
  const f=environment(t);const old=f.client.captureBuffer;old.ready('old-draft',0);old.append('AAAA');
  f.cache.set('bio-voice-resume',JSON.stringify({callId:'old-call',expiresAt:Date.now()+300000}));
  f.client.close(false);
  const fresh=new BrowserVoice({request:()=>({}),start(){},event(){},playback(){},error(){},ended(){}},'bio-voice-resume','new');
  t.after(()=>fresh.close());await fresh.start();t.mock.timers.tick(3000);const ws=f.sockets.at(-1);ws.onopen();
  const listen=f.messages.map(JSON.parse).filter(m=>m.type==='listen').at(-1);
  assert.notEqual(listen.callId,'old-call');assert.equal(listen.resume,false);assert.equal(listen.captureId,undefined);
  assert.equal(fresh.captureBuffer.hasParked,true);assert.equal(f.cache.get('bio-voice-resume:audio:old-draft:1'),'AAAA');
});

test('handshake alone does not report readiness and recovery timeout preserves the capture', async t => {
  const f=environment(t);await f.client.start();t.mock.timers.tick(3000);const ws=f.sockets[0];ws.onopen();const turnId=f.starts[0];
  ws.onmessage({data:JSON.stringify({turnId,type:'connected',callId:'call',conversationId:'conversation',resumed:true})});
  assert.equal(f.connected(),0);assert.equal(f.client.listening,false);
  t.mock.timers.tick(120000);assert.equal(f.ended(),1);
  assert.ok(f.messages.map(JSON.parse).some(m=>m.type==='diagnostic'&&m.code==='recovery_timeout'));
});

test('server endpoint flushes the worklet and sends finish only after the last PCM ACK', async t => {
  const f=environment(t);await f.client.start();t.mock.timers.tick(3000);const ws=f.sockets[0];ws.onopen();
  const turnId=f.starts[0],incoming=event=>ws.onmessage({data:JSON.stringify({turnId,...event})});
  incoming({type:'capture.ready',captureId:'draft',sequence:0});incoming({type:'state',state:'listening'});
  f.captures[0].port.onmessage({data:new Int16Array(1600).buffer});
  incoming({type:'capture.finish'});
  // AudioWorklet delivers the last partial packet before confirming its flush.
  f.captures[0].port.onmessage({data:new Int16Array(300).buffer});
  f.captures[0].port.onmessage({data:{type:'flushed'}});
  assert.equal(f.messages.map(JSON.parse).some(m=>m.type==='finish'),false);
  incoming({type:'capture.saved',captureId:'draft',sequence:1});t.mock.timers.tick(100);
  assert.equal(f.messages.map(JSON.parse).filter(m=>m.type==='capture.audio').length,2);
  assert.equal(f.messages.map(JSON.parse).some(m=>m.type==='finish'),false);
  incoming({type:'capture.saved',captureId:'draft',sequence:2});
  assert.equal(f.messages.map(JSON.parse).filter(m=>m.type==='finish').length,1);
  assert.equal(f.client.listening,false);
});


test('recovery displays only the user-facing state throughout provider and upload preparation', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000);
  const ws = f.sockets[0]; ws.onopen(); const turnId = f.starts[0];
  const receive = event => ws.onmessage({ data: JSON.stringify({ turnId, ...event }) });
  receive({ type: 'connected', callId: 'saved-call', conversationId: 'conversation', resumed: true });
  assert.equal(f.statuses.at(-1), '正在恢复对话');
  receive({ type: 'capture.recovering', remainingMs: 24500, totalMs: 24500 });
  receive({ type: 'capture.recovering', remainingMs: 12000, totalMs: 24500 });
  assert.equal(f.statuses.at(-1), '正在恢复对话');
  assert.doesNotMatch(f.statuses.join(' '), /重放|补存|转写|上传|秒|段录音/);
  assert.equal(f.connected(), 0);
});

test('resumed task stops ringing before model speech and remains interruptible', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000);
  const ws=f.sockets[0]; ws.onopen(); const id=f.starts[0];
  const emit = event => ws.onmessage({data:JSON.stringify({turnId:id,elapsedMs:0,...event})});
  emit({type:'connected',callId:'resumed-call',conversationId:'conv',resumed:true});
  assert.equal(f.connected(),0);
  emit({type:'state',state:'agent'});
  assert.equal(f.connected(),1);
  assert.equal(f.statuses.at(-1),'正在继续刚才的任务');
  assert.equal(f.nodes.length,0,'no greeting audio required for readiness');
  f.client.interrupt();
  assert.ok(f.messages.map(JSON.parse).some(m=>m.type==='cancel' && m.turnId===id));
  emit({type:'state',state:'agent'});
  assert.equal(f.connected(),1,'stale state must not reconnect the call');
});

test('hiding after a long reply starts a fresh window instead of reusing the old cache deadline', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const turnId = f.starts[0];
  const emit = event => ws.onmessage({ data: JSON.stringify({ turnId, ...event }) });
  emit({ type: 'connected', callId: 'long-call', conversationId: 'conv', resumed: false });
  emit({ type: 'state', state: 'listening' });
  assert.ok(f.messages.map(JSON.parse).some(m => m.type === 'call.ready'));
  f.client.recoveryUntil = Date.now() - 1;
  const before = Date.now(); f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.ok(f.recoveries[0] >= before + 300000);
});

test('server remaining time calibrates recovery and handshake-only failures never renew it', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const before = Date.now();
  ws.onmessage({ data: JSON.stringify({ turnId: f.starts[0], type: 'connected', callId: 'retry-call', conversationId: 'conv', resumed: true, recoveryRemainingMs: 12000 }) });
  const deadline = JSON.parse(f.cache.get('bio-voice-resume')).expiresAt;
  assert.ok(deadline >= before + 12000 && deadline <= Date.now() + 12000);
  ws.onerror(); t.mock.timers.tick(1000); const retry = f.sockets[1]; retry.onopen();
  retry.onmessage({ data: JSON.stringify({ turnId: f.starts.at(-1), type: 'connected', callId: 'retry-call', conversationId: 'conv', resumed: true, recoveryRemainingMs: 9000 }) });
  f.client.close(false);
  assert.ok(f.recoveries[0] <= Date.now() + 9000);
  assert.ok(!f.messages.map(JSON.parse).some(m => m.type === 'call.ready'));
});

test('explicit hangup parks unfinished audio so a later call cannot silently resume it', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); f.sockets[0].onopen();
  f.client.captureBuffer.ready('unfinished', 0); f.client.captureBuffer.append('AAAA');
  f.client.close();
  assert.equal(f.client.captureBuffer.id, undefined); assert.equal(f.client.captureBuffer.hasParked, true);
  assert.equal(f.cache.has('bio-voice-resume'), false);
  assert.equal(f.cache.get('bio-voice-resume:audio:unfinished:1'), 'AAAA');
});


test('narration position follows the audio clock, never receipt or a suspended clock, and clears on interruption', async t => {
  const f = environment(t); await f.client.start(); t.mock.timers.tick(3000); const ws = f.sockets[0]; ws.onopen();
  const positions = []; f.document.addEventListener('bio:document-narration', event => positions.push(event.detail));
  const narration = { documentId: 'story', version: 2, blockId: 'p8', start: 180, end: 300 };
  const audio = { type: 'audio', turnId: f.starts[0], sampleRate: 16000, data: Buffer.alloc(32000).toString('base64'), text: '原文', segmentId: 1, narration };
  ws.onmessage({ data: JSON.stringify(audio) }); assert.deepEqual(positions, []);
  t.mock.timers.tick(40); assert.deepEqual(positions, [], 'suspended audio clock must not move the paper');
  f.contexts[0].currentTime = .04; t.mock.timers.tick(40); assert.deepEqual(positions, [narration]);
  ws.onmessage({ data: JSON.stringify({ ...audio, segmentId: 2, narration: { ...narration, blockId: 'p9' } }) });
  f.client.interrupt(); assert.equal(positions.at(-1), null);
  f.contexts[0].currentTime = 10; t.mock.timers.tick(2000);
  assert.equal(positions.filter(Boolean).length, 1, 'cancelled queued and stale audio cannot restore following');
});

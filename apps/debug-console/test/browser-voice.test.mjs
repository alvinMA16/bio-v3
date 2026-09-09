import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/voice/browser-voice.ts', import.meta.url), 'utf8').replace("import workletUrl from './pcm-worklet.js?url&no-inline';", "const workletUrl = 'mock-worklet';");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { BrowserVoice } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function environment(t, pendingMic, moduleError) {
  const sockets = [], nodes = [], messages = [], events = [], starts = [], playback = [], captures = [], levels = [], gains = [];
  let stopped = 0, ended = 0;
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
    createGain() { const node = { gain: {}, connect() {}, disconnect() {} }; gains.push(node); return node; }
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
  };
  const restore = [];
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const client = new BrowserVoice({ request: () => ({}), start: id => starts.push(id), event: event => events.push(event),
    inputLevel: level => levels.push(level), playback: (...args) => playback.push(args), error: message => events.push({ type: 'local.error', message }), ended: () => ended++ });
  t.after(() => { client.close(); restore.forEach(fn => fn()); });
  return { client, sockets, nodes, captures, levels, gains, starts, messages, events, playback, stream, stopped: () => stopped, ended: () => ended };
}

test('interruption clears scheduled audio and rejects old turn callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = environment(t);
  await f.client.start(); const ws = f.sockets[0]; ws.onopen();
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
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = environment(t);
  await f.client.start(); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
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
  assert.equal(f.stopped(), 1); assert.equal(f.sockets.length, 0);
});

test('muting releases the microphone while keeping queued reply audio playing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = environment(t);
  await f.client.start(); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
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
  await f.client.start(); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: 'listening', turnId: id }) });
  await f.client.setMicrophone(false);
  assert.ok(f.messages.some(value => typeof value === 'string' && JSON.parse(value).type === 'cancel'));
  const count = f.events.length;
  ws.onmessage({ data: JSON.stringify({ type: 'transcript', turnId: id, text: '不要提交' }) });
  assert.equal(f.events.length, count);
  assert.equal(f.stopped(), 1);
});

test('unmuting during playback does not start a new listening turn early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = environment(t);
  await f.client.start(); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
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
  await f.client.start(); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
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
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = environment(t);
  await f.client.start(); const ws = f.sockets[0]; ws.onopen(); const id = f.starts[0];
  const audio = segmentId => ws.onmessage({ data: JSON.stringify({ type: 'audio', turnId: id, sampleRate: 16000, data: 'AAA=', text: '你好', segmentId }) });
  audio(1);
  const output = f.nodes[0].destination;
  assert.equal(output.gain.value, 1);
  f.client.setSpeaker(false);
  assert.equal(output.gain.value, 0);
  assert.equal(f.stopped(), 0);
  assert.equal(f.nodes[0].stopped, undefined);
  audio(2);
  assert.equal(f.nodes[1].destination, output);
  f.client.setSpeaker(true);
  assert.equal(output.gain.value, 1);
});


test('worklet load failure shows a friendly error and releases microphone resources', async t => {
  t.mock.method(console, 'error', () => {});
  const f = environment(t, undefined, new Error("Unable to load a worklet's module."));
  await f.client.start();
  assert.equal(f.events.find(event => event.type === 'local.error').message, '语音连接失败，请重试。');
  assert.equal(f.stopped(), 1);
  assert.equal(f.ended(), 1);
  assert.equal(f.sockets.length, 0);
});

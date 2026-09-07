import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/voice/browser-voice.ts', import.meta.url), 'utf8').replace("import workletUrl from './pcm-worklet.js?url';", "const workletUrl = 'mock-worklet';");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { BrowserVoice } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function environment(t, pendingMic) {
  const sockets = [], nodes = [], messages = [], events = [], starts = [], playback = [];
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
    currentTime = 0; destination = {}; audioWorklet = { async addModule() {} };
    async resume() {} async close() {}
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_channels, length, rate) { return { getChannelData: () => new Float32Array(length), duration: length / rate }; }
    createBufferSource() { const node = { connect() {}, disconnect() {}, start() {}, stop() { node.stopped = true; } }; nodes.push(node); return node; }
  }
  const globals = {
    navigator: { mediaDevices: { getUserMedia: () => pendingMic ?? Promise.resolve(stream) } },
    location: { href: 'http://localhost:5173', protocol: 'http:' },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    AudioContext: Context,
    AudioWorkletNode: class { port = { postMessage() {} }; connect() {} disconnect() {} },
    WebSocket: Socket,
  };
  const restore = [];
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const client = new BrowserVoice({ request: () => ({}), start: id => starts.push(id), event: event => events.push(event),
    playback: (...args) => playback.push(args), error: message => events.push({ type: 'local.error', message }), ended: () => ended++ });
  t.after(() => { client.close(); restore.forEach(fn => fn()); });
  return { client, sockets, nodes, starts, messages, events, playback, stream, stopped: () => stopped, ended: () => ended };
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function setup(t) {
  const messages = [], sockets = [], nodes = [], events = [], cache = new Map();
  let ended = 0;
  const recorder = { onFrameRecorded() {}, onStop(fn) { this.stopped = fn; }, onError() {}, start() {}, stop() { this.stopped?.(); } };
  const exports = {};
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../miniprogram/lib/voice-client.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, Date, Math, Uint8Array, Int16Array, Float32Array, DataView,
    setTimeout, clearTimeout, console: { error() {} },
    require: () => ({ FoxSpeechSignal: class { reset() {} update() {} recognize() {} } }),
    wx: {
      getStorageSync: key => cache.get(key), setStorageSync: (key, value) => cache.set(key, value), removeStorageSync: key => cache.delete(key),
      authorize: ({ success }) => success(), getRecorderManager: () => recorder,
      base64ToArrayBuffer: data => Uint8Array.from(Buffer.from(data, 'base64')).buffer,
      createWebAudioContext: () => ({ currentTime: 0, destination: {}, resume() {}, close() {},
        createBuffer: (_, n) => ({ getChannelData: () => new Float32Array(n) }),
        createBufferSource() { const node = { connect() {}, disconnect() {}, start() {}, stop() {} }; nodes.push(node); return node; },
      }),
      connectSocket() {
        const socket = { onOpen(fn) { this.open = fn; }, onMessage(fn) { this.message = fn; }, onClose(fn) { this.closed = fn; },
          onError(fn) { this.error = fn; }, send({ data }) { messages.push(JSON.parse(data)); }, close() {} };
        sockets.push(socket); return socket;
      },
    },
  });
  const client = new exports.MiniVoiceClient('http://localhost/api/v1', {
    request: () => ({}), event: event => events.push(event), playback() {}, error() {}, ended() { ended++; },
  });
  t.after(() => client.close());
  return { client, messages, sockets, nodes, events, ended: () => ended };
}

test('mini player acknowledges consumed samples and isolates invalid audio from the call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(t); f.client.start(); await Promise.resolve(); const ws = f.sockets[0]; ws.open();
  const turnId = f.messages.find(m => m.type === 'listen').turnId;
  const send = event => ws.message({ data: JSON.stringify({ turnId, ...event }) });
  send({ type: 'audio', sampleRate: 16000, data: 'AAA=', text: '你好', segmentId: 1, endSample: 1 });
  assert.equal(f.messages.filter(m => m.type === 'playback').length, 0);
  f.nodes[0].onended(); assert.equal(f.messages.find(m => m.type === 'playback').playedSamples, 1);
  send({ type: 'audio', sampleRate: 16000, data: 'AA==', text: '错误', segmentId: 2 });
  assert.ok(f.messages.some(m => m.type === 'playback.stop')); assert.equal(f.ended(), 0);
  send({ type: 'result', result: { conversationId: 'same', message: { content: '完整文字' } } });
  send({ type: 'done' }); t.mock.timers.tick(300);
  assert.equal(f.messages.filter(m => m.type === 'listen').length, 2);
});

test('mini reconnect preserves call identity and explicit hangup cancels future reconnects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(t); f.client.start(); await Promise.resolve(); const first = f.sockets[0]; first.open();
  const listen = f.messages.find(m => m.type === 'listen');
  first.message({ data: JSON.stringify({ type: 'connected', turnId: listen.turnId, callId: listen.callId, conversationId: 'same', resumed: false }) });
  first.closed({ code: 1006 }); t.mock.timers.tick(1000); await Promise.resolve();
  f.sockets[1].open();
  const resumed = f.messages.filter(m => m.type === 'listen').at(-1);
  assert.equal(resumed.callId, listen.callId); assert.equal(resumed.resume, true);
  f.sockets[1].closed({ code: 1006 }); f.client.close();
  t.mock.timers.tick(20000); await Promise.resolve(); assert.equal(f.sockets.length, 2);
});

test('mini ASR failure stops recording, avoids retry loops and allows the interrupt button to retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(t); f.client.start(); await Promise.resolve(); const ws = f.sockets[0]; ws.open();
  const turnId = f.messages.find(m => m.type === 'listen').turnId;
  ws.message({ data: JSON.stringify({ type: 'state', state: 'listening', turnId }) }); await Promise.resolve();
  ws.message({ data: JSON.stringify({ type: 'error', stage: 'asr', recoverable: true, message: '识别失败', turnId }) });
  ws.message({ data: JSON.stringify({ type: 'done', turnId }) }); t.mock.timers.tick(2000);
  assert.equal(f.messages.filter(m => m.type === 'listen').length, 1);
  f.client.interrupt(); assert.equal(f.messages.filter(m => m.type === 'listen').length, 2);
});

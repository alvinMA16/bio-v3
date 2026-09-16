import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { VoiceGateway } from '../dist/voice/voice.gateway.js';
import { randomUUID } from 'node:crypto';

test('voice WebSocket accepts PCM, validates context, and passes the recognized turn into Agent', async t => {
  const server = createServer();
  const inputs = [], audio = [];
  const gateway = new VoiceGateway({ httpAdapter: { getHttpServer: () => server } }, new ConfigService({
    VOLCENGINE_ASR_APP_ID: 'fixture', VOLCENGINE_ASR_ACCESS_TOKEN: 'fixture', DOUBAO_TTS_APP_ID: 'fixture', DOUBAO_TTS_ACCESS_KEY: 'fixture',
  }), { async run(input, emit, _signal, _scope, trigger) {
    inputs.push({ ...input, trigger });
    emit({ type: 'speech.completed', messageId: 'reply', text: '你好。', conversationId: 'test' });
    return { conversationId: 'test', message: { content: '你好。' } };
  } });
  // Replace network boundaries only: the gateway validation and voice orchestrator stay real.
  gateway.asr = { async open() { return { write(pcm) { audio.push(pcm); }, close() {}, async finish() { return '讲个故事'; } }; } };
  gateway.tts = { async synthesize(_text, _signal, emit) { emit(new Uint8Array([0, 0])); } };
  gateway.onApplicationBootstrap();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { gateway.onApplicationShutdown(); await new Promise(resolve => server.close(resolve)); });
  const url = `ws://127.0.0.1:${server.address().port}/api/v1/voice`;
  const ws = new WebSocket(url);
  const events = [];
  const done = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); events.push(event);
      if (event.type === 'state' && event.state === 'listening') {
        ws.send(Buffer.from([0, 0, 1, 0])); ws.send(JSON.stringify({ type: 'finish', turnId: 'two' }));
      }
      if (event.type === 'done' && event.turnId === 'one') {
        assert.equal(audio.length, 0);
        ws.send(JSON.stringify({ type: 'listen', turnId: 'two', request: { context: { scene: 'revision' }, provider: 'qwen' } }));
      } else if (event.type === 'done') resolve();
    });
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'listen', turnId: 'one', request: { context: { scene: 'revision' }, provider: 'qwen' } }));
  await done;
  assert.equal(audio.length, 1);
  assert.equal(inputs[0].trigger, 'call_opening');
  assert.equal(inputs[1].message, '讲个故事'); assert.equal(inputs[1].context.scene, 'revision');
  assert.equal(inputs[1].trigger, undefined);
  assert.equal(inputs[0].conversationId, inputs[1].conversationId);
  assert.equal(events.filter(event => event.turnId === 'one' && event.type === 'transcript').length, 0);
  assert.ok(events.some(event => event.type === 'audio'));
  ws.close(); await once(ws, 'close');
  const bad = new WebSocket(url); await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'listen', turnId: 'bad', request: { context: { scene: 'invented' } } }));
  const [code] = await once(bad, 'close'); assert.equal(code, 1008); assert.equal(inputs.length, 2);
});

test('hangup waits for Agent cleanup and ends the server-owned call, not each turn', { timeout: 10000 }, async t => {
  const server = createServer(); const conv = randomUUID(); const order = [];
  let started, closed; const running = new Promise(resolve => { started = resolve; });
  const ended = new Promise(resolve => { closed = resolve; });
  const memory = {
    identity(auth) { assert.equal(auth, 'Bearer test'); return 'alice'; },
    async beginCall(user, call) { assert.equal(user, 'alice'); assert.equal(call, 'phone-one'); return conv; },
    async claimCallOpening() { return true; },
    async disconnectCall(user, call, _connection, explicit) { order.push('ended'); closed({ user, call, explicit }); },
  };
  const gateway = new VoiceGateway({ httpAdapter: { getHttpServer: () => server } }, new ConfigService({
    VOLCENGINE_ASR_APP_ID: 'fixture', VOLCENGINE_ASR_ACCESS_TOKEN: 'fixture', DOUBAO_TTS_APP_ID: 'fixture', DOUBAO_TTS_ACCESS_KEY: 'fixture',
  }), { async run(input, _emit, signal, scope) {
    assert.equal(input.conversationId, conv); assert.deepEqual(scope, { userId: 'alice', callId: 'phone-one' });
    started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 20)); order.push('agent-saved'); throw new Error('cancelled');
  } }, memory);
  gateway.asr = { async open() { return { write() {}, close() {}, async finish() { return '继续讲'; } }; } };
  gateway.tts = { async synthesize() {} }; gateway.onApplicationBootstrap();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { gateway.onApplicationShutdown(); await new Promise(resolve => server.close(resolve)); });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/v1/voice`, { headers: { Authorization: 'Bearer test' } });
  ws.on('message', raw => { const event = JSON.parse(raw.toString()); if (event.type === 'state' && event.state === 'listening') ws.send(JSON.stringify({ type: 'finish', turnId: 'one' })); });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'listen', turnId: 'one', callId: 'phone-one', request: { conversationId: randomUUID() } }));
  await running; assert.deepEqual(order, []);
  ws.send(JSON.stringify({ type: 'hangup', turnId: 'one' })); ws.close();
  assert.deepEqual(await ended, { user: 'alice', call: 'phone-one', explicit: true });
  assert.deepEqual(order, ['agent-saved', 'ended']);
});

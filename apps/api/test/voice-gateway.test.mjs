import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { VoiceGateway } from '../dist/voice/voice.gateway.js';

test('voice WebSocket accepts PCM, validates context, and passes the recognized turn into Agent', async t => {
  const server = createServer();
  const inputs = [], audio = [];
  const gateway = new VoiceGateway({ httpAdapter: { getHttpServer: () => server } }, new ConfigService({
    VOLCENGINE_ASR_APP_ID: 'fixture', VOLCENGINE_ASR_ACCESS_TOKEN: 'fixture', DOUBAO_TTS_APP_ID: 'fixture', DOUBAO_TTS_ACCESS_KEY: 'fixture',
  }), { async run(input, emit) {
    inputs.push(input);
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
        ws.send(Buffer.from([0, 0, 1, 0])); ws.send(JSON.stringify({ type: 'finish', turnId: 'one' }));
      }
      if (event.type === 'done') resolve();
    });
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'listen', turnId: 'one', request: { context: { scene: 'revision' }, provider: 'qwen' } }));
  await done;
  assert.equal(audio.length, 1);
  assert.equal(inputs[0].message, '讲个故事'); assert.equal(inputs[0].context.scene, 'revision');
  assert.ok(events.some(event => event.type === 'audio'));
  ws.close(); await once(ws, 'close');
  const bad = new WebSocket(url); await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'listen', turnId: 'bad', request: { context: { scene: 'invented' } } }));
  const [code] = await once(bad, 'close'); assert.equal(code, 1008); assert.equal(inputs.length, 1);
});

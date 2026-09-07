import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { VoiceClientMessage } from '@bio/contracts';
import { AgentService } from '../agent/agent.service.js';
import { CompleteChatDto } from '../chat/dto/complete-chat.dto.js';
import { VolcengineAsr } from './volcengine-asr.js';
import { DoubaoTts } from './doubao-tts.js';
import { VoiceSession } from './voice-session.js';

@Injectable()
export class VoiceGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private asr: VolcengineAsr;
  private tts: DoubaoTts;
  constructor(private adapter: HttpAdapterHost, private config: ConfigService, private agent: AgentService) {
    this.asr = new VolcengineAsr({ appId: config.get('VOLCENGINE_ASR_APP_ID', ''),
      accessToken: config.get('VOLCENGINE_ASR_ACCESS_TOKEN', ''), resourceId: config.get('VOLCENGINE_ASR_RESOURCE_ID', 'volc.seedasr.sauc.duration') });
    this.tts = new DoubaoTts({ appId: config.get('DOUBAO_TTS_APP_ID', ''), accessKey: config.get('DOUBAO_TTS_ACCESS_KEY', ''),
      resourceId: config.get('DOUBAO_TTS_RESOURCE_ID', 'seed-tts-2.0'), speaker: config.get('DOUBAO_TTS_SPEAKER', 'zh_female_kefunvsheng_uranus_bigtts') });
  }
  onApplicationBootstrap(): void {
    const server = this.adapter.httpAdapter.getHttpServer() as Server;
    server.on('upgrade', (request, socket, head) => {
      if (request.url?.split('?')[0] !== '/api/v1/voice') return;
      const origins = String(this.config.get('VOICE_ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173')).split(',');
      const origin = request.headers.origin;
      const sameHost = origin && (() => { try { return new URL(origin).host === request.headers.host; } catch { return false; } })();
      if ((origin && !sameHost && !origins.includes(origin)) || this.wss.clients.size >= 8) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      if (!this.config.get('VOLCENGINE_ASR_APP_ID') || !this.config.get('VOLCENGINE_ASR_ACCESS_TOKEN')
        || !this.config.get('DOUBAO_TTS_APP_ID') || !this.config.get('DOUBAO_TTS_ACCESS_KEY')) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => this.connect(ws));
    });
  }
  private connect(ws: WebSocket): void {
    const delay = Number(this.config.get('VOICE_ENDPOINT_MS', 2500));
    const session = new VoiceSession(this.asr, this.tts, (input, emit, signal) => this.agent.run(input, emit, signal), event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Slow connection'); return; }
      ws.send(JSON.stringify(event));
    }, Number.isFinite(delay) && delay >= 500 && delay <= 6000 ? delay : 2500);
    let validating = false;
    const idle = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20_000);
    let alive = true;
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); alive = false; }, 45_000);
    ws.on('pong', () => { alive = true; });
    ws.on('message', (raw, binary) => {
      if (binary) { session.audio(new Uint8Array(raw as Buffer)); return; }
      void (async () => {
        try {
          const message = JSON.parse(raw.toString()) as VoiceClientMessage;
          if (!message || typeof message.turnId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.turnId)) throw new Error('Invalid turn');
          if (message.type === 'listen') {
            if (validating) throw new Error('Concurrent initialization');
            validating = true;
            try {
              const dto = plainToInstance(CompleteChatDto, { ...message.request, message: '语音输入' });
              if ((await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length) throw new Error('Invalid context');
              const { message: _text, ...input } = dto;
              void session.listen(message.turnId, input).catch(() => ws.close(1011, 'Voice session failed'));
            } finally { validating = false; }
          } else if (message.type === 'finish') session.finish(message.turnId);
          else if (message.type === 'cancel') session.cancel(message.turnId);
          else throw new Error('Invalid message');
        } catch { ws.close(1008, 'Invalid voice request'); }
      })();
    });
    ws.on('error', () => session.close());
    ws.on('close', () => { clearInterval(idle); clearInterval(heartbeat); session.close(); });
  }
  onApplicationShutdown(): void { for (const ws of this.wss.clients) ws.terminate(); this.wss.close(); }
}

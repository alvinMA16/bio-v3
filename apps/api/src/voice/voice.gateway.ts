import { Injectable, Optional, Logger, OnApplicationBootstrap, OnApplicationShutdown, ConflictException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { VoiceClientMessage } from '@bio/contracts';
import { AgentService } from '../agent/agent.service.js';
import { AttachmentViewDto, DocumentViewDto, CompleteChatDto } from '../chat/dto/complete-chat.dto.js';
import { VolcengineAsr } from './volcengine-asr.js';
import { DoubaoTts } from './doubao-tts.js';
import { randomUUID } from 'node:crypto';
import { MemoryService } from '../memory/memory.service.js';
import { VoiceSession } from './voice-session.js';

@Injectable()
export class VoiceGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly logger = new Logger(VoiceGateway.name);
  private calls = new Map<string, { connection: string; stop: () => Promise<void> }>();
  private asr: VolcengineAsr;
  private tts: DoubaoTts;
  constructor(private adapter: HttpAdapterHost, private config: ConfigService, private agent: AgentService, @Optional() private memory?: MemoryService) {
    this.asr = new VolcengineAsr({ appId: config.get('VOLCENGINE_ASR_APP_ID', ''),
      accessToken: config.get('VOLCENGINE_ASR_ACCESS_TOKEN', ''), resourceId: config.get('VOLCENGINE_ASR_RESOURCE_ID', 'volc.seedasr.sauc.duration') });
    this.tts = new DoubaoTts({ appId: config.get('DOUBAO_TTS_APP_ID', ''), accessKey: config.get('DOUBAO_TTS_ACCESS_KEY', ''),
      resourceId: config.get('DOUBAO_TTS_RESOURCE_ID', 'seed-tts-2.0'), speaker: config.get('DOUBAO_TTS_SPEAKER', 'zh_female_kefunvsheng_uranus_bigtts') });
  }
  onApplicationBootstrap(): void {
    const server = this.adapter.httpAdapter.getHttpServer() as Server;
    server.on('upgrade', async (request, socket, head) => {
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
      let user: string | undefined;
      try { user = await this.memory?.resolveIdentity(request.headers.authorization, request.headers['sec-websocket-protocol']); }
      catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      if (socket.destroyed) return;
      if (this.wss.clients.size >= 8) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
      this.wss.handleUpgrade(request, socket, head, ws => {
        const authCheck = setInterval(() => {
          void this.memory?.resolveIdentity(request.headers.authorization, request.headers['sec-websocket-protocol'])
            .catch(() => ws.close(1008, 'Login expired'));
        }, 20000);
        ws.once('close', () => clearInterval(authCheck));
        this.connect(ws, user);
      });
    });
  }
  private connect(ws: WebSocket, user?: string): void {
    const connection = randomUUID();
    let callId: string | undefined;
    let conversationId: string | undefined;
    let initialized = false;
    let ended = false;
    let closing = false;
    let queue = Promise.resolve();
    let persistence = Promise.resolve();
    let finalized: Promise<void> | undefined;
    const delay = Number(this.config.get('VOICE_ENDPOINT_MS', 2500));
    const session = new VoiceSession(this.asr, this.tts, (input, emit, signal, trigger, runtime) => this.agent.run({ ...input, ...(conversationId ? { conversationId } : {}) }, emit, signal, user ? { userId: user, ...(callId ? { callId } : {}) } : undefined, trigger, runtime), event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Slow connection'); return; }
      ws.send(JSON.stringify(event));
    }, Number.isFinite(delay) && delay >= 500 && delay <= 6000 ? delay : 2500, {
      progress: data => {
        if (user && callId) {
          const id = callId;
          persistence = persistence.then(() => this.memory!.savePlayback(user!, id, connection, data))
            .catch(() => this.logger.warn('Voice playback persistence failed'));
        }
      },
      diagnostic: data => this.logger.warn(JSON.stringify({ type: 'voice.failure', callId, connection, ...data })),
    });
    let validating = false;
    const idle = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { ws.ping(); if (user && callId) void this.memory!.touchCall(user, callId, connection).catch(() => this.logger.warn('Call heartbeat persistence failed')); } }, 20_000);
    let alive = true;
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); alive = false; }, 45_000);
    const finalize = (): Promise<void> => finalized ??= queue.then(async () => {
      await session.settled(); await persistence;
      if (user && callId) {
        const key = JSON.stringify([user, callId]);
        try { await this.memory!.disconnectCall(user, callId, connection, ended); }
        finally { if (this.calls.get(key)?.connection === connection) this.calls.delete(key); }
      }
    });
    ws.on('pong', () => { alive = true; });
    ws.on('message', (raw, binary) => {
      if (binary) { session.audio(new Uint8Array(raw as Buffer)); return; }
      queue = queue.then(async () => {
        let validatedRequest = false;
        try {
          const message = JSON.parse(raw.toString()) as VoiceClientMessage;
          if (closing && message?.type !== 'hangup' && message?.type !== 'disconnect') return;
          if (!message || typeof message.turnId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.turnId)) throw new Error('Invalid turn');
          if (message.type === 'listen') {
            if ((message.resume !== undefined && typeof message.resume !== 'boolean')
              || (message.playbackFeedback !== undefined && typeof message.playbackFeedback !== 'boolean')
              || (message.callId !== undefined && (typeof message.callId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.callId)))) throw new Error('Invalid call options');
            if (validating) throw new Error('Concurrent initialization');
            validating = true;
            try {
              const dto = plainToInstance(CompleteChatDto, { ...message.request, message: '语音输入' });
              if ((await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length) throw new Error('Invalid context');
              validatedRequest = true;
              const { message: _text, ...input } = dto;
              let resumed = false;
              if (user && !callId) {
                const id = message.callId ?? randomUUID();
                if (message.resume) {
                  try {
                    // Authenticated takeover of this user's own call; drain old writes before restoring it.
                    await this.calls.get(JSON.stringify([user, id]))?.stop();
                    const restored = await this.memory!.resumeCall(user, id, connection);
                    conversationId = restored.conversationId; callId = restored.callId; resumed = restored.resumed;
                  } catch (error) {
                    if (!(error instanceof ConflictException)) throw error;
                    ws.send(JSON.stringify({ type: 'error', turnId: message.turnId, elapsedMs: 0, stage: 'transport',
                      code: 'CALL_BUSY', message: '上一连接正在结束，请稍后重连。', recoverable: true }));
                    return;
                  }
                } else {
                  conversationId = await this.memory!.beginCall(user, id, connection);
                  callId = id;
                }
              }
              else if (user && message.callId && message.callId !== callId) throw new Error('Cannot switch call');
              let opening = false;
              if (!initialized) {
                opening = user && callId ? await this.memory!.claimCallOpening(user, callId, connection) : true;
                conversationId ??= randomUUID();
                initialized = true;
                if (user && callId) this.calls.set(JSON.stringify([user, callId]), { connection, stop: () => {
                  closing = true; session.close('connection_replaced'); ws.close(1000, 'Connection replaced');
                  return finalize();
                } });
                ws.send(JSON.stringify({ type: 'connected', turnId: message.turnId, elapsedMs: 0,
                  callId: callId ?? message.callId ?? randomUUID(), conversationId, resumed }));
              }
              void session.listen(message.turnId, input, opening, message.playbackFeedback === true).catch(() => ws.close(1011, 'Voice session failed'));
            } finally { validating = false; }
          } else if (message.type === 'playback') {
            if (!Number.isSafeInteger(message.playedSamples) || message.playedSamples < 0) throw new Error('Invalid playback');
            session.playback(message.turnId, message.playedSamples);
          } else if (message.type === 'playback.stop') {
            const code = ['invalid_audio', 'audio_queue_limit', 'audio_context_failed', 'speaker_muted'].includes(message.code) ? message.code : 'playback_failed';
            session.stopPlayback(message.turnId, code);
          } else if (message.type === 'document.view') {
            const view = plainToInstance(DocumentViewDto, message.view);
            if (!view || (await validate(view, { whitelist: true, forbidNonWhitelisted: true })).length) throw new Error('Invalid document view');
            session.updateDocumentView(message.turnId, view);
          } else if (message.type === 'attachment.view') {
            const view = plainToInstance(AttachmentViewDto, message.view);
            if (!view || (await validate(view, { whitelist: true, forbidNonWhitelisted: true })).length) throw new Error('Invalid attachment view');
            session.updateAttachmentView(message.turnId, view);
          } else if (message.type === 'finish') session.finish(message.turnId);
          else if (message.type === 'cancel') session.cancel(message.turnId);
          else if (message.type === 'hangup') { ended = true; session.close('user_hangup'); ws.close(1000, 'Call ended'); }
          else if (message.type === 'disconnect' && ['page_hidden', 'client_error'].includes(message.reason)) {
            session.close(message.reason); ws.close(1000, message.reason);
          }
          else throw new Error('Invalid message');
        } catch {
          if (validatedRequest) { this.logger.warn('Voice initialization failed; connection may be retried'); ws.close(1011, 'Voice initialization failed'); }
          else ws.close(1008, 'Invalid voice request');
        }
      }).catch(() => ws.close(1011, 'Voice request failed'));
    });
    ws.on('error', () => session.close('transport_error'));
    ws.on('close', (_code, rawReason) => {
      const reason = rawReason.toString();
      closing = true; clearInterval(idle); clearInterval(heartbeat);
      session.close(['page_hidden', 'client_error', 'user_hangup'].includes(reason) ? reason : 'connection_closed');
      void finalize().catch(() => this.logger.error('Call close persistence failed; stale-call recovery will retry'));
    });
  }
  onApplicationShutdown(): void { for (const ws of this.wss.clients) ws.terminate(); this.wss.close(); }
}

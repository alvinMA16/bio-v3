import { Body, Controller, Optional, Get, Param, Post, Req, Res, NotFoundException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompleteChatDto } from '../chat/dto/complete-chat.dto.js';
import { AgentService } from './agent.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { AgentStorage } from './agent-storage.js';
import { DocumentStore, legacyDocumentId } from './document-store.js';

@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService, private readonly storage: AgentStorage, @Optional() private readonly memory?: MemoryService, @Optional() private readonly documents?: DocumentStore) {}

  private get documentStore() { return this.documents ?? new DocumentStore(this.storage, this.memory); }

  @Get('reading-preferences')
  async readingPreferences(@Req() request: FastifyRequest) {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    return { fontSize: this.storage.readingFontSize(user) };
  }

  @Get('manuscripts')
  async manuscripts(@Req() request: FastifyRequest) {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    await this.documentStore.importLegacy(user);
    const items = await this.documentStore.list(user);
    return items.map(({ conversationId, document }) => ({ conversationId, id: document.id, title: document.title, version: document.version }));
  }

  @Get('manuscripts/:conversationId/:documentId')
  async manuscript(@Param('conversationId') conversationId: string, @Param('documentId') documentId: string, @Req() request: FastifyRequest) {
    this.storage.assertId(conversationId);
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    await this.documentStore.importLegacy(user);
    const items = await this.documentStore.list(user);
    const item = items.find(item => item.conversationId === conversationId && (item.document.id === documentId || item.document.id === legacyDocumentId(conversationId, documentId)));
    if (!item) throw new NotFoundException('文稿不存在');
    return item.document;
  }

  @Get('documents/:documentId')
  async document(@Param('documentId') id: string, @Req() request: FastifyRequest) {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    await this.documentStore.importLegacy(user);
    return this.documentStore.get(user, id);
  }

  @Get('documents/:documentId/history')
  async history(@Param('documentId') id: string, @Req() request: FastifyRequest) {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    return this.documentStore.history(user, id);
  }

  @Get('runs/:runId/trace')
  async trace(@Param('runId') runId: string, @Req() request: FastifyRequest) {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    if (user) await this.memory!.assertRun(user, runId);
    return this.storage.readTrace(runId);
  }

  /** POST + NDJSON supports fetch streams and mini-program chunked requests. */
  @Post('runs/stream')
  async stream(@Body() body: CompleteChatDto, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort('connection_closed'); };
    reply.raw.on('close', disconnect);
    request.raw.on('aborted', disconnect);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
    });
    const send = (value: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(value)}\n`);
    };
    try {
      const result = await this.agent.run(body, (event) => send({ kind: 'event', event }), controller.signal, user ? { userId: user } : undefined);
      send({ kind: 'result', result });
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : 'Agent run failed' });
    } finally {
      reply.raw.off('close', disconnect);
      request.raw.off('aborted', disconnect);
      reply.raw.end();
    }
  }
}

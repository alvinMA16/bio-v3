import { Injectable } from '@nestjs/common';
import type { ChatCompletionResponse, ModelProvider } from '@bio/contracts';
import { AgentService } from '../agent/agent.service.js';

/** Compatibility endpoint for the existing mini-program and debugger. */
@Injectable()
export class ChatService {
  constructor(private readonly agent: AgentService) {}

  complete(message: string, conversationId?: string, systemPrompt?: string, signal?: AbortSignal, provider?: ModelProvider): Promise<ChatCompletionResponse> {
    return this.agent.run({
      message,
      ...(provider ? { provider } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    }, undefined, signal);
  }
}

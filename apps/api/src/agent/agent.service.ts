import { ConflictException, Injectable, Logger, RequestTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentEvent, AgentEventPayload, ChatCompletionRequest, ChatCompletionResponse, ModelTokenUsage } from '@bio/contracts';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { estimateModelCost } from '../chat/model-pricing.js';
import { AgentStorage } from './agent-storage.js';
import { PiSessionFactory } from './pi-session.factory.js';

@Injectable()
export class AgentService {
  private readonly active = new Set<string>();
  private readonly logger = new Logger(AgentService.name);

  constructor(private readonly factory: PiSessionFactory, private readonly storage: AgentStorage, private readonly config: ConfigService) {}

  async run(input: ChatCompletionRequest, onEvent?: (event: AgentEvent) => void, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const conversationId = input.conversationId ?? randomUUID();
    this.storage.assertId(conversationId);
    if (this.active.has(conversationId)) throw new ConflictException('This conversation already has an active run');
    this.active.add(conversationId);
    const runId = randomUUID();
    const events: AgentEvent[] = [];
    let sequence = 0;
    let messageId = randomUUID();
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let lastAssistant: AssistantMessage | undefined;
    let eventError: unknown;
    let timedOut = false;
    const usage: ModelTokenUsage = {
      promptTokens: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0,
      completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
    };
    const addUsage = (value: Usage) => {
      usage.promptCacheHitTokens += value.cacheRead;
      usage.promptCacheMissTokens += value.input + value.cacheWrite;
      usage.promptTokens += value.input + value.cacheRead + value.cacheWrite;
      usage.completionTokens += value.output;
      usage.totalTokens += value.totalTokens;
    };
    const trace = (source: 'product' | 'pi' | 'input', type: string, data: unknown) => {
      const metadata = { runId, conversationId, sequence: ++sequence, timestamp: new Date().toISOString() };
      this.storage.appendTrace({ ...metadata, source, type, data });
      return metadata;
    };
    const emit = (payload: AgentEventPayload) => {
      const event = { ...payload, ...trace('product', payload.type, payload) } as AgentEvent;
      events.push(event);
      onEvent?.(event);
    };
    const abort = () => { void session?.abort().catch(() => undefined); };
    const timeoutMs = Number(this.config.get('AGENT_TIMEOUT_MS', 120000));
    const timer = setTimeout(() => { timedOut = true; abort(); },
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      emit({ type: 'run.started' });
      trace('input', 'request', input);
      if (signal?.aborted) throw new Error('Run cancelled');
      session = await this.factory.create(conversationId, input.systemPrompt, emit, input.provider, input.context);
      if (signal?.aborted || timedOut) throw new Error('Run cancelled');
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        try {
          // Keep deltas without cumulative snapshots; terminal messages retain full content.
          if (event.type === 'message_update') {
            const update = event.assistantMessageEvent;
            trace('pi', event.type, 'delta' in update ? { type: update.type, delta: update.delta } : { type: update.type });
            if (update.type === 'text_delta') emit({ type: 'speech.delta', messageId, delta: update.delta });
            return;
          }
          trace('pi', event.type, event);
          switch (event.type) {
            case 'message_start':
              if (event.message.role === 'assistant') messageId = randomUUID();
              break;
            case 'message_end':
              if (event.message.role === 'assistant') {
                lastAssistant = event.message;
                addUsage(event.message.usage);
                const text = assistantText(event.message);
                if (text && event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted') {
                  emit({ type: 'speech.completed', messageId, text });
                }
              }
              break;
            case 'tool_execution_start':
              emit({ type: 'tool.started', toolCallId: event.toolCallId, name: event.toolName });
              break;
            case 'tool_execution_end':
              emit({ type: 'tool.completed', toolCallId: event.toolCallId, name: event.toolName, isError: event.isError });
              break;
            case 'compaction_start':
              emit({ type: 'context.compacting' });
              break;
            case 'compaction_end':
              if (event.result?.usage) addUsage(event.result.usage);
              if (event.result && !event.aborted) emit({ type: 'context.compacted' });
              break;
          }
        } catch (error) {
          eventError = error;
          abort();
        }
      });
      await session.prompt(input.message, { expandPromptTemplates: false });
      if (eventError) throw eventError;
      if (signal?.aborted || timedOut || lastAssistant?.stopReason === 'aborted') throw new Error('Run cancelled');
      if (!lastAssistant || lastAssistant.stopReason === 'error') throw new Error('Model completion failed');
      emit({ type: 'run.completed' });
      const rate = Number(this.config.get('USD_TO_CNY_RATE', 6.7829));
      return {
        conversationId, runId, events,
        message: { id: messageId, role: 'assistant', content: assistantText(lastAssistant), createdAt: new Date().toISOString() },
        finishReason: lastAssistant.stopReason === 'toolUse' ? 'tool_calls' : lastAssistant.stopReason,
        model: lastAssistant.model, usage,
        estimatedCost: estimateModelCost(lastAssistant.model, usage, Number.isFinite(rate) && rate > 0 ? rate : 6.7829),
      };
    } catch (error) {
      const cancelled = !eventError && (signal?.aborted || timedOut || lastAssistant?.stopReason === 'aborted');
      const message = timedOut ? 'Agent run timed out' : cancelled ? 'Agent run cancelled' : 'Agent run failed';
      try { emit(cancelled ? { type: 'run.cancelled' } : { type: 'run.failed', message }); }
      catch { this.logger.error(`Unable to persist terminal event for run ${runId}`); }
      if (error instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException({ message: error.message, runId, conversationId });
      }
      if (timedOut) throw new RequestTimeoutException({ message, runId, conversationId });
      throw new ServiceUnavailableException({ message, runId, conversationId });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      unsubscribe?.();
      try { session?.dispose(); }
      finally { this.active.delete(conversationId); }
    }
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

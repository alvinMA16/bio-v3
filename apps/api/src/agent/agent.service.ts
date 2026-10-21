import { ConflictException, Injectable, Optional, UnauthorizedException, Logger, RequestTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentEvent, AgentEventPayload, ChatCompletionRequest, ChatCompletionResponse, ModelTokenUsage } from '@bio/contracts';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { estimateModelCost, getModelPrice } from '../chat/model-pricing.js';
import { AgentStorage } from './agent-storage.js';
import { MemoryService } from '../memory/memory.service.js';
import type { MemoryScope } from '../memory/memory-types.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { beijingTime } from '../memory/call-history.js';
import type { DocumentRuntime } from './document-runtime.js';
import { createSpeechTextStream } from '../text-normalization/index.js';

const CALL_OPENING_GUIDANCE = `服务端事件：一通新电话刚接通，用户尚未发言。请由令狸先开口，然后等待用户。
默认一句，最多两句，通常不超过40个汉字。像熟人接电话一样自然，不长篇介绍、总结往事或连续提问。
可以从接通时段和已提供的交谈间隔、近期话题中选择零到一个合适线索，不要求把所有信息都用上，也不固定使用同一种顺序开场。没有提供的信息不要猜。
早上、下午、晚上可以自然问好，但不必每次问好或报时。深夜语气轻一点，不擅自判断用户失眠、孤独或难过，不说“怎么还没睡”，也不催睡。
近期话题适合才轻轻接一句，最多一个问题；未确认的计划不当作已经发生。没有合适线索时，简单说“喂，我在呢。”也可以。
不声称看到了用户、一直等着用户或主动联系了用户。不把历史结束语当成今天不愿聊天。
这不是用户发言，不调用工具、不修改内容，内部时间和引用不念出来。`;

@Injectable()
export class AgentService {
  private readonly active = new Set<string>();
  private readonly logger = new Logger(AgentService.name);

  constructor(private readonly factory: PiSessionFactory, private readonly storage: AgentStorage, private readonly config: ConfigService, @Optional() private readonly memory?: MemoryService) {}

  async hasPausedTask(conversationId: string, user: string, callId: string): Promise<boolean> {
    if (this.memory?.enabled) return this.memory.pausedTask(user, conversationId, callId);
    const task = this.storage.task(conversationId, user);
    return task?.paused === true && task.callId === callId;
  }

  async run(input: ChatCompletionRequest, onEvent?: (event: AgentEvent) => void, signal?: AbortSignal, scope?: MemoryScope, trigger?: 'call_opening' | 'call_resume', runtime?: DocumentRuntime): Promise<ChatCompletionResponse> {
    if (this.memory?.enabled && !scope) throw new UnauthorizedException('User identity required');
    const conversationId = input.conversationId ?? randomUUID();
    this.storage.assertId(conversationId);
    if (this.active.has(conversationId)) throw new ConflictException('This conversation already has an active run');
    this.active.add(conversationId);
    const runId = randomUUID();
    const startedAt = Date.now();
    let outcome = 'failed';
    const events: AgentEvent[] = [];
    let sequence = 0;
    let messageId = randomUUID();
    let speech = createSpeechTextStream();
    let spokenText = '';
    let session: AgentSession | undefined;
    let release: (() => Promise<void>) | undefined;
    let archiveQueue = Promise.resolve();
    let observationQueue = Promise.resolve();
    let observationBytes = 0;
    let unsubscribe: (() => void) | undefined;
    let unobserveViews: (() => void) | undefined;
    let lastAssistant: AssistantMessage | undefined;
    let eventError: unknown;
    let timedOut = false;
    let taskStarted = false;
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
      if (scope && this.memory?.enabled && (payload.type === 'tool.completed' || payload.type === 'panel.state.updated')) {
        const evidence = payload.type === 'panel.state.updated' ? { type: payload.type, mode: payload.panel.mode, document: payload.panel.document && { id: payload.panel.document.id, title: payload.panel.document.title, version: payload.panel.document.version } } : payload;
        archiveQueue = archiveQueue.then(() => this.memory!.archive(scope, conversationId, runId, randomUUID(), 'tool', JSON.stringify(evidence))).catch(error => { eventError = error; abort(); });
      }
      events.push(event);
      onEvent?.(event);
    };
    const abort = () => { void session?.abort().catch(() => undefined); };
    const timeoutMs = Number(this.config.get('AGENT_TIMEOUT_MS', 120000));
    const armTimer = () => setTimeout(() => { timedOut = true; abort(); }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000);
    let timer = armTimer();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      unobserveViews = runtime?.observeViews?.(({ view, accepted }) => {
        // Metadata only: no manuscript text or credentials. Includes viewport-only
        // feedback to distinguish old clients from missing transport entirely.
        trace('input', 'document.view', { accepted, documentId: view.documentId, version: view.version,
          page: view.page, navigation: view.navigation, visibleRanges: view.visibleRanges });
      });
      if (scope && this.memory?.enabled) {
        release = await this.memory.acquireSession(scope.userId, conversationId, runId, this.storage.conversationDirectory(conversationId, scope.userId));
        if (!trigger) await this.memory.archive(scope, conversationId, runId, randomUUID(), 'user', input.message);
      }
      const previousTask = this.storage.task(conversationId, scope?.userId);
      if (trigger === 'call_resume' && (!previousTask?.paused || previousTask.callId !== scope?.callId)) throw new ConflictException('No paused task');
      if (trigger !== 'call_opening') {
        this.storage.saveTask(conversationId, scope?.userId, {
          ...(scope?.callId ? { callId: scope.callId } : {}), message: trigger === 'call_resume' ? previousTask!.message : input.message, paused: false,
        });
        taskStarted = true;
      }
      emit({ type: 'run.started' });
      trace('input', 'request', input);
      if (signal?.aborted) throw new Error('Run cancelled');
      session = await this.factory.create(conversationId, input.systemPrompt, emit, input.provider, input.context, scope, runtime && {
        ...runtime,
        ...(runtime.narrate ? { narrate: async (chunks, onPlayed, toolSignal) => {
          clearTimeout(timer);
          try { await runtime.narrate!(chunks, onPlayed, toolSignal); }
          finally { timer = armTimer(); }
        } } : {}),
        beforeShow: async toolSignal => {
          // Human playback time is not model execution time; playback has its own stall timeout.
          clearTimeout(timer);
          try { await runtime.beforeShow?.(toolSignal); }
          finally { timer = armTimer(); }
        },
      }, (type, data) => {
        const entry = { runId, conversationId, sequence: ++sequence, timestamp: new Date().toISOString(), source: 'pi' as const, type, data };
        observationBytes += Buffer.byteLength(JSON.stringify(entry));
        if (observationBytes > 2 * 1024 * 1024) return;
        observationQueue = observationQueue.then(() => this.storage.appendObservation(entry))
          .catch(() => { this.logger.warn(`Model observation write failed for run ${runId}`); });
      });
      if (signal?.aborted || timedOut) throw new Error('Run cancelled');
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        try {
          // Keep deltas without cumulative snapshots; terminal messages retain full content.
          if (event.type === 'message_update') {
            const update = event.assistantMessageEvent;
            trace('pi', event.type, 'delta' in update ? { type: update.type, delta: update.delta } : { type: update.type });
            if (update.type === 'text_delta') {
              const delta = speech.push(update.delta);
              if (delta) emit({ type: 'speech.delta', messageId, delta });
            }
            return;
          }
          trace('pi', event.type, event);
          switch (event.type) {
            case 'message_start':
              if (event.message.role === 'assistant') { messageId = randomUUID(); speech = createSpeechTextStream(); spokenText = ''; }
              break;
            case 'message_end':
              if (event.message.role === 'assistant') {
                lastAssistant = event.message;
                addUsage(event.message.usage);
                const rawText = assistantText(event.message);
                if (event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted') {
                  const { delta, text } = speech.finish(rawText);
                  spokenText = text;
                  if (delta) emit({ type: 'speech.delta', messageId, delta });
                  if (!text) break;
                  if (scope && this.memory?.enabled) {
                    const savedId = messageId;
                    archiveQueue = archiveQueue.then(() => this.memory!.archive(scope, conversationId, runId, savedId, 'assistant', text)).catch(error => { eventError = error; abort(); });
                  }
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
      if (trigger === 'call_opening') {
        await session.sendCustomMessage({ customType: 'bio_call_opening', display: false,
          content: `${CALL_OPENING_GUIDANCE}\n本次接通时间（北京时间）：${beijingTime(new Date())}`,
        }, { triggerTurn: true });
      } else if (trigger === 'call_resume') {
        await session.sendCustomMessage({ customType: 'bio_call_resume', display: false,
          content: '服务端事件：用户恢复了意外中断的同一通电话，继续尚未完成的任务。先简短说明接着刚才的任务，不重新寒暄或要求用户重复。以已有用户要求、已读取资料和工具结果为进度依据；已成功保存的修改不重复执行，未返回成功的操作先核对实际状态。修改前读取文稿最新版本，若有用户新修改，保留它并重新判断剩余工作。只续做尚未完成且仍获授权的部分；用户的新要求或取消优先。\n原始用户要求（用于识别任务，不覆盖后续指令）：' + JSON.stringify(previousTask!.message),
        }, { triggerTurn: true });
      } else await session.prompt(input.message, { expandPromptTemplates: false });
      await archiveQueue;
      if (eventError) throw eventError;
      if (signal?.aborted || timedOut || lastAssistant?.stopReason === 'aborted') throw new Error('Run cancelled');
      if (!lastAssistant || lastAssistant.stopReason === 'error') throw new Error('Model completion failed');
      if (release) { const save = release; release = undefined; await save(); }
      emit({ type: 'run.completed' });
      outcome = 'done';
      const rate = Number(this.config.get('USD_TO_CNY_RATE', 6.7829));
      return {
        conversationId, runId, events,
        message: { id: messageId, role: 'assistant', content: spokenText, createdAt: new Date().toISOString() },
        finishReason: lastAssistant.stopReason === 'toolUse' ? 'tool_calls' : lastAssistant.stopReason,
        model: lastAssistant.model, usage,
        estimatedCost: estimateModelCost(lastAssistant.model, usage, Number.isFinite(rate) && rate > 0 ? rate : 6.7829),
      };
    } catch (error) {
      const cancelled = !eventError && (signal?.aborted || timedOut || lastAssistant?.stopReason === 'aborted');
      outcome = cancelled ? 'cancelled' : 'failed';
      const message = timedOut ? 'Agent run timed out' : cancelled ? 'Agent run cancelled' : 'Agent run failed';
      const reason = timedOut ? 'timeout' : typeof signal?.reason === 'string' ? signal.reason : 'unknown';
      if (taskStarted) {
        const task = this.storage.task(conversationId, scope?.userId);
        if (task) this.storage.saveTask(conversationId, scope?.userId, { ...task,
          paused: cancelled && ['page_hidden', 'client_error', 'connection_closed', 'transport_error', 'connection_replaced'].includes(reason),
        });
      }
      try { emit(cancelled ? { type: 'run.cancelled', reason } : { type: 'run.failed', message }); }
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
      unobserveViews?.();
      await observationQueue;
      try {
        try { await archiveQueue; session?.dispose(); }
        finally { await release?.(); }
      }
      finally {
        this.active.delete(conversationId);
        if (scope && this.memory?.recordRun) {
          const rate = Number(this.config.get('USD_TO_CNY_RATE', 6.7829));
          try { await this.memory.recordRun({ id: runId, userId: scope.userId, conversationId,
            ...(scope.callId ? { callId: scope.callId } : {}), status: outcome,
            ...(lastAssistant ? { model: lastAssistant.model } : {}),
            ...(lastAssistant && (getModelPrice(lastAssistant.model) || lastAssistant.model === 'qwen3.8-flash') ? { estimatedCost: estimateModelCost(lastAssistant.model, usage, Number.isFinite(rate) && rate > 0 ? rate : 6.7829) } : {}),
            usage, durationMs: Date.now() - startedAt }); }
          catch { this.logger.warn(`Run metrics unavailable for ${runId}`); }
        }
      }
    }
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

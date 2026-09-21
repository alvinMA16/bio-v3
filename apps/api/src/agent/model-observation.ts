import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

type Fingerprint = { hash: string; bytes: number };
type Snapshot = { id: string; at: number; model: Fingerprint; system: Fingerprint; tools: Fingerprint; config: Fingerprint; messages: Fingerprint[] };

/** Process-local, bounded baselines; never retain prompt text or credentials. */
export class ModelObservations {
  private readonly key = randomBytes(32);
  private readonly previous = new Map<string, Snapshot>();
  private fingerprint(value: unknown): Fingerprint {
    const text = JSON.stringify(value ?? null);
    return { hash: createHmac('sha256', this.key).update(text).digest('hex'), bytes: Buffer.byteLength(text) };
  }

  extension(scope: string, record: (type: string, data: unknown) => void): ExtensionFactory {
    return pi => {
      let active: { id: string; at: number; ordinal: number; firstDeltaMs?: number } | undefined;
      let ordinal = 0;
      // Observation must never fail the conversation, including when trace storage fails.
      const safe = (fn: () => void) => { try { fn(); } catch { /* best effort */ } };
      pi.on('before_provider_request', event => safe(() => {
        const payload = event.payload as { model?: string; contents?: unknown[]; config?: Record<string, unknown> };
        if (!Array.isArray(payload.contents)) return;
        if (payload.contents.length > 2048) {
          record('model.observation.skipped', { reason: 'message_limit', messageCount: payload.contents.length });
          this.previous.delete(scope);
          active = undefined;
          return;
        }
        const { systemInstruction, tools, ...config } = payload.config ?? {};
        const at = Date.now();
        const old = this.previous.get(scope);
        const prior = old && at - old.at < 24 * 60 * 60_000 ? old : undefined;
        const next: Snapshot = { id: randomUUID(), at, model: this.fingerprint(payload.model), system: this.fingerprint(systemInstruction),
          tools: this.fingerprint(tools), config: this.fingerprint(config), messages: payload.contents.map(m => this.fingerprint(m)) };
        let commonMessages = 0;
        if (prior) while (commonMessages < Math.min(prior.messages.length, next.messages.length)
          && prior.messages[commonMessages]!.hash === next.messages[commonMessages]!.hash) commonMessages++;
        const changed = prior ? (['model', 'system', 'tools', 'config'] as const).filter(k => prior[k].hash !== next[k].hash) : [];
        active = { id: next.id, at, ordinal: ++ordinal };
        this.previous.delete(scope);
        this.previous.set(scope, next);
        while (this.previous.size > 256) this.previous.delete(this.previous.keys().next().value!);
        record('model.request', { ...active, schemaVersion: 1, model: payload.model, deployment: process.env.BIO_COMMIT ?? null, capture: 'gemini_sdk_parameters',
          baseline: prior ? 'available' : 'unavailable', previousCallId: prior?.id, gapMs: prior ? at - prior.at : undefined,
          changed, commonMessages: prior ? commonMessages : null,
          commonMessageBytes: prior ? next.messages.slice(0, commonMessages).reduce((sum, m) => sum + m.bytes, 0) : null,
          firstChangedMessage: prior && commonMessages < prior.messages.length ? commonMessages + 1 : null,
          previousMessageCount: prior?.messages.length, fingerprints: next,
          note: 'Message prefix measured in serialized bytes, not tokens; config changes are reported separately. SDK-internal HTTP retries are not individually observable.' });
      }));
      pi.on('message_update', event => safe(() => {
        if (active && active.firstDeltaMs === undefined && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.assistantMessageEvent.type)) {
          active.firstDeltaMs = Date.now() - active.at;
        }
      }));
      pi.on('message_end', event => safe(() => {
        if (!active || event.message.role !== 'assistant') return;
        const call = active; active = undefined;
        const { usage, stopReason, model } = event.message;
        const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        record('model.response', { callId: call.id, ordinal: call.ordinal, model, stopReason,
          durationMs: Date.now() - call.at, firstDeltaMs: call.firstDeltaMs ?? null,
          inputTokens, cacheReadTokens: usage.cacheRead, cacheRatio: inputTokens > 0 ? usage.cacheRead / inputTokens : null,
          outputTokens: usage.output, usageSource: 'pi_normalized', rawCacheFieldPresence: 'unavailable' });
      }));
    };
  }
}

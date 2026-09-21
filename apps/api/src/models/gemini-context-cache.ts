import { createHash } from 'node:crypto';
import { GoogleGenAI, type Content, type GenerateContentParameters, type Tool } from '@google/genai';
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/google-generative-ai';

type Stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof streamSimple>;
type Observe = (type: string, data: unknown) => void;
type Client = Pick<GoogleGenAI, 'caches' | 'models'>;
type Prefix = { configHash: string; hashes: string[]; chars: number };
type Active = Prefix & { name: string; expires: number; contentTokens: number };
type Entry = { client: Client; active?: Active; pending?: Promise<void>; touched: number; retryAfter: number; disposed: boolean };
const TTL_SECONDS = 600;
const MIN_GROWTH_TOKENS = 2048;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const compatible = (cached: Prefix, next: Prefix) => cached.configHash === next.configHash
  && cached.hashes.length <= next.hashes.length && cached.hashes.every((h, i) => h === next.hashes[i]);

/** Process-local references only: no prompt bodies or cache IDs are persisted or logged. */
export class GeminiContextCache {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly sweep = setInterval(() => {
    for (const [key, entry] of this.entries) if (Date.now() - entry.touched > TTL_SECONDS * 1000) {
      this.entries.delete(key); void this.dispose(entry);
    }
  }, 30_000).unref();

  constructor(
    private readonly native: Stream = (model, context, options) => streamSimple(model as Model<'google-generative-ai'>, context, options),
    private readonly clientFactory = (apiKey: string, baseUrl: string): Client => new GoogleGenAI({
      apiKey, httpOptions: { baseUrl, apiVersion: '', timeout: 5000, retryOptions: { attempts: 1 } },
    }),
  ) {}

  stream(scope: string, observe?: Observe): Stream {
    const report = (data: unknown) => { try { observe?.('model.cache', data); } catch { /* tracing cannot break chat */ } };
    return (model, context, options) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        let full: GenerateContentParameters | undefined;
        let entry: Entry | undefined;
        let used: Active | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          let start: AssistantMessageEvent | undefined;
          let delivered = false;
          let retry = false;
          const upstream = this.native(model, context, { ...options, onPayload: async (payload, providerModel) => {
            const changed = await options?.onPayload?.(payload, providerModel);
            const request = (changed ?? payload) as GenerateContentParameters;
            full = request;
            if (attempt || this.closed || !options?.apiKey || !this.prefix(request)) return request;
            const baseUrl = model.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
            const key = hash([scope, baseUrl, options.apiKey, model.id]);
            entry = this.entries.get(key);
            if (!entry) {
              if (this.entries.size >= 128) {
                const oldest = this.entries.entries().next().value;
                if (oldest) { this.entries.delete(oldest[0]); void this.dispose(oldest[1]); }
              }
              entry = { client: this.clientFactory(options.apiKey, baseUrl), touched: Date.now(), retryAfter: 0, disposed: false };
              this.entries.set(key, entry);
            }
            entry.touched = Date.now();
            const active = entry.active;
            if (active && (active.expires <= Date.now() + 30_000 || !compatible(active, this.prefix(request)!))) {
              delete entry.active; void this.remove(entry, active);
              report({ action: 'invalidate' });
            }
            used = entry.active;
            if (!used) { report({ action: 'full_request', preparing: !!entry.pending }); return request; }
            const config = { ...request.config, cachedContent: used.name };
            delete config.systemInstruction; delete config.tools; delete config.toolConfig;
            report({ action: 'reuse', contentsCount: used.hashes.length });
            return { ...request, config, contents: (request.contents as Content[]).slice(used.hashes.length) };
          } });
          for await (const event of upstream) {
            if (event.type === 'start') { start = event; continue; }
            // Retry once with the full input only before any partial output escaped.
            if (event.type === 'error' && used && !attempt && !delivered && !options?.signal?.aborted && event.reason !== 'aborted') {
              if (entry) {
                if (entry.active === used) delete entry.active;
                entry.retryAfter = Date.now() + 60_000;
                void this.remove(entry, used);
              }
              used = undefined; retry = true; report({ action: 'fallback' }); break;
            }
            if (event.type === 'done' && full && entry && !options?.signal?.aborted) {
              this.prepare(entry, full, event.message.usage.input + event.message.usage.cacheRead, report);
            }
            if (start) { output.push(start); start = undefined; }
            output.push(event); delivered = true;
          }
          if (!retry) { output.end(); return; }
        }
      })().catch(() => {
        // Native Pi normally returns errors as events; keep unexpected failures terminal too.
        output.push({ type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: 'Gemini request failed',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
        output.end();
      });
      return output;
    };
  }

  private prefix(request: GenerateContentParameters): Prefix | undefined {
    if (!Array.isArray(request.contents) || request.config?.cachedContent) return;
    const contents = request.contents as Content[];
    // Only our request-scoped final runtime message establishes a cache boundary.
    if (!contents.at(-1)?.parts?.some(p => p.text?.startsWith('{"type":"bio_runtime_context"'))) return;
    const stable = contents.slice(0, -1);
    return { configHash: hash([request.model, request.config?.systemInstruction, request.config?.tools, request.config?.toolConfig]),
      hashes: stable.map(hash), chars: JSON.stringify(stable).length };
  }

  private prepare(entry: Entry, request: GenerateContentParameters, inputTokens: number, report: (data: unknown) => void): void {
    const prefix = this.prefix(request);
    if (!prefix || this.closed || entry.disposed || entry.pending || Date.now() < entry.retryAfter || inputTokens < 4096) return;
    const previous = entry.active;
    // Cheap growth gate before a background token-count request; exact tokens decide replacement.
    if (previous && prefix.chars - previous.chars < MIN_GROWTH_TOKENS) return;
    const contents = structuredClone((request.contents as Content[]).slice(0, -1));
    const config = structuredClone({
      ...(request.config?.systemInstruction !== undefined ? { systemInstruction: request.config.systemInstruction } : {}),
      // Pi supplies serialized Tool definitions, never SDK CallableTool instances.
      ...(request.config?.tools !== undefined ? { tools: request.config.tools as Tool[] } : {}),
      ...(request.config?.toolConfig !== undefined ? { toolConfig: request.config.toolConfig } : {}),
    });
    entry.retryAfter = Date.now() + 30_000;
    entry.pending = (async () => {
      try {
        const contentTokens = contents.length ? (await entry.client.models.countTokens({ model: request.model, contents })).totalTokens ?? 0 : 0;
        if (previous && contentTokens - previous.contentTokens < MIN_GROWTH_TOKENS) return;
        if (entry.disposed || this.closed) return;
        const cache = await entry.client.caches.create({ model: request.model, config: {
          ...config, ...(contents.length ? { contents } : {}), ttl: `${TTL_SECONDS}s`,
        } });
        const expires = Date.parse(cache.expireTime ?? '');
        if (!cache.name || !Number.isFinite(expires)) return;
        const next = { ...prefix, name: cache.name, expires, contentTokens };
        // Never resurrect an evicted entry or replace a different active cache.
        if (entry.disposed || this.closed || entry.active !== previous) { await this.remove(entry, next); return; }
        entry.active = next;
        report({ action: 'created', contentsCount: prefix.hashes.length, tokens: cache.usageMetadata?.totalTokenCount ?? null, ttlSeconds: TTL_SECONDS });
        if (previous) await this.remove(entry, previous);
      } catch { entry.retryAfter = Date.now() + 60_000; report({ action: 'prepare_failed' }); }
    })().finally(() => { delete entry.pending; });
  }

  private async remove(entry: Entry, cache: Active): Promise<void> {
    try { await entry.client.caches.delete({ name: cache.name }); } catch { /* TTL bounds remote retention if deletion fails. */ }
  }

  private async dispose(entry: Entry): Promise<void> {
    entry.disposed = true;
    const active = entry.active; delete entry.active;
    if (active) await this.remove(entry, active);
    await entry.pending;
  }

  async close(): Promise<void> {
    this.closed = true; clearInterval(this.sweep);
    await Promise.all([...this.entries.values()].map(entry => this.dispose(entry)));
    this.entries.clear();
  }
}

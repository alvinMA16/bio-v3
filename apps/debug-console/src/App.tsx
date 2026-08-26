import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '@bio/contracts';

type View = 'result' | 'inspector' | 'history';
type ApiStatus = 'checking' | 'online' | 'offline';

interface RunRecord {
  id: string;
  startedAt: string;
  durationMs: number;
  request: ChatCompletionRequest;
  response?: ChatCompletionResponse;
  error?: string;
}

const HISTORY_KEY = 'bio-agent-lab-history-v2';
const DEFAULT_SYSTEM_PROMPT = `你是 Bio Agent，一个清晰、可靠的对话式助手。
先理解用户目标，再给出具体且可执行的回答。
信息不足时，明确指出缺少什么。`;

function readHistory(): RunRecord[] {
  try {
    const value = localStorage.getItem(HISTORY_KEY);
    return value ? (JSON.parse(value) as RunRecord[]) : [];
  } catch {
    return [];
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatDuration(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCost(value: number): string {
  return `¥${value.toFixed(value < 0.01 ? 8 : 4)}`;
}

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [message, setMessage] = useState('请介绍一下你自己，并说明你能帮我做什么。');
  const [conversationId, setConversationId] = useState('');
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<View>('result');
  const [history, setHistory] = useState<RunRecord[]>(readHistory);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    () => readHistory()[0]?.id ?? null,
  );
  const abortRef = useRef<AbortController | null>(null);

  const selectedRun = useMemo(
    () => history.find((run) => run.id === selectedRunId) ?? history[0],
    [history, selectedRunId],
  );

  useEffect(() => {
    void fetch('/api/v1/health')
      .then((response) => setApiStatus(response.ok ? 'online' : 'offline'))
      .catch(() => setApiStatus('offline'));
  }, []);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
  }, [history]);

  async function runAgent(): Promise<void> {
    if (!message.trim() || running) return;

    const request: ChatCompletionRequest = {
      message: message.trim(),
      ...(conversationId.trim()
        ? { conversationId: conversationId.trim() }
        : {}),
      ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
    };
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setView('result');

    try {
      const response = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        const apiMessage =
          typeof payload === 'object' &&
          payload !== null &&
          'message' in payload &&
          typeof payload.message === 'string'
            ? payload.message
            : undefined;
        throw new Error(
          apiMessage ?? `请求失败（HTTP ${response.status}）`,
        );
      }

      const completion = payload as ChatCompletionResponse;
      const record: RunRecord = {
        id,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        request,
        response: completion,
      };
      setHistory((items) => [record, ...items].slice(0, 20));
      setSelectedRunId(id);
      setConversationId(completion.conversationId);
    } catch (error) {
      const record: RunRecord = {
        id,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        request,
        error:
          error instanceof DOMException && error.name === 'AbortError'
            ? '运行已取消'
            : error instanceof Error
              ? error.message
              : '未知错误',
      };
      setHistory((items) => [record, ...items].slice(0, 20));
      setSelectedRunId(id);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  function clearHistory(): void {
    setHistory([]);
    setSelectedRunId(null);
    localStorage.removeItem(HISTORY_KEY);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <div>
            <div className="brand-name">Bio Agent Lab</div>
            <div className="brand-caption">Prompt & runtime debugger</div>
          </div>
        </div>
        <div className={`api-status api-status--${apiStatus}`}>
          <span className="status-dot" />
          {apiStatus === 'online'
            ? 'API connected'
            : apiStatus === 'checking'
              ? 'Checking API'
              : 'API offline'}
        </div>
      </header>

      <main className="workspace">
        <aside className="control-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Configuration</span>
              <h1>New run</h1>
            </div>
            <span className="model-chip">V4 Flash</span>
          </div>

          <label className="field">
            <span className="field-label">
              System prompt <span>{systemPrompt.length}/10000</span>
            </span>
            <textarea
              className="textarea textarea--system"
              value={systemPrompt}
              maxLength={10000}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Conversation ID</span>
            <input
              className="input"
              value={conversationId}
              placeholder="自动创建"
              onChange={(event) => setConversationId(event.target.value)}
            />
          </label>

          <label className="field field--grow">
            <span className="field-label">
              User message <span>{message.length}/20000</span>
            </span>
            <textarea
              className="textarea textarea--message"
              value={message}
              maxLength={20000}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  void runAgent();
                }
              }}
            />
          </label>

          <div className="run-actions">
            {running ? (
              <button
                className="button button--stop"
                type="button"
                onClick={() => abortRef.current?.abort()}
              >
                <span className="stop-icon" /> Stop run
              </button>
            ) : (
              <button
                className="button button--run"
                type="button"
                disabled={!message.trim() || apiStatus === 'offline'}
                onClick={() => void runAgent()}
              >
                Run agent <span className="shortcut">⌘ ↵</span>
              </button>
            )}
          </div>
        </aside>

        <section className="result-panel">
          <nav className="tabs" aria-label="Run views">
            {(['result', 'inspector', 'history'] as const).map((item) => (
              <button
                className={`tab ${view === item ? 'tab--active' : ''}`}
                type="button"
                key={item}
                onClick={() => setView(item)}
              >
                {item === 'result'
                  ? 'Result'
                  : item === 'inspector'
                    ? 'Inspector'
                    : `History ${history.length ? `(${history.length})` : ''}`}
              </button>
            ))}
          </nav>

          <div className="view-content">
            {view === 'result' && (
              <ResultView run={selectedRun} running={running} />
            )}
            {view === 'inspector' && <InspectorView run={selectedRun} />}
            {view === 'history' && (
              <HistoryView
                history={history}
                selectedRunId={selectedRunId}
                onSelect={(id) => {
                  setSelectedRunId(id);
                  setView('result');
                }}
                onClear={clearHistory}
              />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function ResultView({
  run,
  running,
}: {
  run: RunRecord | undefined;
  running: boolean;
}) {
  if (running) {
    return (
      <div className="running-state">
        <div className="orb"><span /></div>
        <h2>Agent is thinking</h2>
        <p>等待 DeepSeek 返回完整结果…</p>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="empty-state">
        <div className="empty-glyph">⌁</div>
        <h2>Ready for a new run</h2>
        <p>配置提示词并运行 Agent，结果和调试信息会显示在这里。</p>
      </div>
    );
  }

  return (
    <div className="run-result">
      <div className="run-meta">
        <span className={`run-badge ${run.error ? 'run-badge--error' : ''}`}>
          {run.error ? 'Failed' : 'Completed'}
        </span>
        <span>{formatTime(run.startedAt)}</span>
        <span>{formatDuration(run.durationMs)}</span>
        {run.response?.model && <span>{run.response.model}</span>}
        {run.response?.finishReason && <span>{run.response.finishReason}</span>}
      </div>

      {run.error ? (
        <div className="error-card">
          <span className="error-mark">!</span>
          <div><strong>Run failed</strong><p>{run.error}</p></div>
        </div>
      ) : (
        <article className="answer-card">
          <div className="answer-label">Agent response</div>
          <div className="answer-content">{run.response?.message.content}</div>
        </article>
      )}

      {run.response && <UsageSummary response={run.response} />}

      <div className="timeline">
        <div className="timeline-heading">Run timeline</div>
        <div className="timeline-item timeline-item--done">
          <span className="timeline-dot" />
          <div><strong>Request prepared</strong><p>System prompt and user message assembled</p></div>
        </div>
        <div className={`timeline-item ${run.error ? 'timeline-item--error' : 'timeline-item--done'}`}>
          <span className="timeline-dot" />
          <div><strong>{run.response?.model ?? 'DeepSeek'} completion</strong><p>{formatDuration(run.durationMs)} total latency</p></div>
        </div>
      </div>
    </div>
  );
}

function UsageSummary({ response }: { response: ChatCompletionResponse }) {
  const { usage, estimatedCost } = response;

  return (
    <section className="usage-card">
      <div className="usage-heading">
        <div>
          <span className="eyebrow">Token usage</span>
          <strong>{response.model}</strong>
        </div>
        <div className="cost-total">
          <span>Estimated cost</span>
          <strong>{formatCost(estimatedCost.total)} CNY</strong>
        </div>
      </div>
      <div className="usage-grid">
        <div className="usage-metric"><span>Input</span><strong>{formatTokens(usage.promptTokens)}</strong></div>
        <div className="usage-metric"><span>Cache hit</span><strong>{formatTokens(usage.promptCacheHitTokens)}</strong></div>
        <div className="usage-metric"><span>Cache miss</span><strong>{formatTokens(usage.promptCacheMissTokens)}</strong></div>
        <div className="usage-metric"><span>Output</span><strong>{formatTokens(usage.completionTokens)}</strong></div>
        <div className="usage-metric"><span>Reasoning</span><strong>{formatTokens(usage.reasoningTokens)}</strong></div>
        <div className="usage-metric usage-metric--total"><span>Total</span><strong>{formatTokens(usage.totalTokens)}</strong></div>
      </div>
      <div className="cost-breakdown">
        <span>Cached input {formatCost(estimatedCost.cacheHitInput)}</span>
        <span>Uncached input {formatCost(estimatedCost.cacheMissInput)}</span>
        <span>Output {formatCost(estimatedCost.output)}</span>
        <span>1 USD = {estimatedCost.usdToCnyRate} CNY · estimated</span>
      </div>
    </section>
  );
}

function InspectorView({ run }: { run: RunRecord | undefined }) {
  if (!run) return <EmptyInspector />;

  return (
    <div className="inspector-grid">
      <section className="code-card">
        <div className="code-heading"><span>Request</span><code>POST /api/v1/chat/completions</code></div>
        <pre>{JSON.stringify(run.request, null, 2)}</pre>
      </section>
      <section className="code-card">
        <div className="code-heading"><span>{run.error ? 'Error' : 'Response'}</span><code>{formatDuration(run.durationMs)}</code></div>
        <pre>{JSON.stringify(run.error ? { error: run.error } : run.response, null, 2)}</pre>
      </section>
    </div>
  );
}

function EmptyInspector() {
  return <div className="empty-state"><div className="empty-glyph">{'{ }'}</div><h2>No payload yet</h2><p>运行一次 Agent 后可检查原始请求和响应。</p></div>;
}

function HistoryView({
  history,
  selectedRunId,
  onSelect,
  onClear,
}: {
  history: RunRecord[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  if (!history.length) return <div className="empty-state"><div className="empty-glyph">↺</div><h2>No run history</h2><p>最近 20 次运行会保存在当前浏览器中。</p></div>;

  return (
    <div className="history-view">
      <div className="history-toolbar"><div><h2>Local runs</h2><p>Stored in this browser</p></div><button type="button" onClick={onClear}>Clear all</button></div>
      <div className="history-list">
        {history.map((run) => (
          <button
            type="button"
            key={run.id}
            className={`history-row ${selectedRunId === run.id ? 'history-row--selected' : ''}`}
            onClick={() => onSelect(run.id)}
          >
            <span className={`history-status ${run.error ? 'history-status--error' : ''}`} />
            <span className="history-message">{run.request.message}</span>
            <span>{run.response ? formatCost(run.response.estimatedCost.total) : '—'}</span>
            <span>{formatDuration(run.durationMs)}</span>
            <span>{formatTime(run.startedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

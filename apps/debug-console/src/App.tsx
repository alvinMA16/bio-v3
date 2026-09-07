import { applyLiveEvent, emptyLiveRun, type LiveRun } from './live-run';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentScene,
  ModelProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  MarkdownPanel,
  AgentEvent,
  PanelState,
  PanelBlock,
} from '@bio/contracts';

type View = 'result' | 'inspector' | 'history';
type ProductView = 'agent' | 'animation';
type ApiStatus = 'checking' | 'online' | 'offline';

interface AnimationAsset {
  id: 'blink' | 'talk' | 'wave';
  name: string;
  description: string;
  src: string;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  fps: number;
  durationMs: number;
}

interface AnimationManifest {
  character: string;
  frameMode: 'three-layer';
  layers: {
    environment: { name: string; src: string };
    actorBoard: { name: string; kind: 'animated-sprite' };
    innerPanel: { name: string; src: string };
  };
  backgroundPolicy: string;
  animations: AnimationAsset[];
}

interface RunRecord {
  id: string;
  startedAt: string;
  durationMs: number;
  request: ChatCompletionRequest;
  response?: ChatCompletionResponse;
  error?: string;
  panel?: PanelState;
  live?: LiveRun;
}

const HISTORY_KEY = 'bio-agent-lab-history-v2';
const DEFAULT_SYSTEM_PROMPT = `你是令狸，一位自然亲切、可靠的人生故事记录伙伴。
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
  const [productView, setProductView] = useState<ProductView>('agent');
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [message, setMessage] = useState('请介绍一下你自己，并说明你能帮我做什么。');
  const [conversationId, setConversationId] = useState('');
  const [provider, setProvider] = useState<ModelProvider | ''>('');
  const [scene, setScene] = useState<AgentScene>('conversation');
  const [documentId, setDocumentId] = useState('');
  const [documentVersion, setDocumentVersion] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [attachmentId, setAttachmentId] = useState('');
  const [attachmentKind, setAttachmentKind] = useState<'image' | 'document'>('image');
  const [attachmentTitle, setAttachmentTitle] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [attachmentText, setAttachmentText] = useState('');
  const [live, setLive] = useState<LiveRun>(emptyLiveRun);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<View>('result');
  const [history, setHistory] = useState<RunRecord[]>(readHistory);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    () => readHistory()[0]?.id ?? null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);

  const selectedRun = useMemo(
    () => history.find((run) => run.id === selectedRunId) ?? history[0],
    [history, selectedRunId],
  );

  useEffect(() => {
    if (!running) return;
    resultRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const timer = window.setInterval(() => setElapsedMs(Math.round(performance.now() - startedRef.current)), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    void fetch('/api/v1/health')
      .then((response) => setApiStatus(response.ok ? 'online' : 'offline'))
      .catch(() => setApiStatus('offline'));
  }, []);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20))); }
    catch { /* Large panel histories may exceed browser storage; keep this session in memory. */ }
  }, [history]);

  async function runAgent(): Promise<void> {
    if (!message.trim() || running) return;

    const request: ChatCompletionRequest = {
      message: message.trim(),
      context: {
        scene,
        ...(attachmentId.trim() ? { attachments: [{
          id: attachmentId.trim(), kind: attachmentKind, title: attachmentTitle.trim(),
          ...(attachmentUrl.trim() ? { url: attachmentUrl.trim() } : {}),
          ...(attachmentText ? { text: attachmentText } : {}),
        }] } : {}),
        ...(documentId.trim() ? { workspace: {
          documentId: documentId.trim(), version: documentVersion,
          ...(selectedBlockId.trim() ? { selectedBlockId: selectedBlockId.trim() } : {}),
          excerpt,
        } } : {}),
      },
      ...(provider ? { provider } : {}),
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
    let currentLive = emptyLiveRun();
    setLive(currentLive);
    startedRef.current = started;
    setElapsedMs(0);
    setView('result');

    try {
      const response = await fetch('/api/v1/agent/runs/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
      if (!response.body) throw new Error('服务端未返回事件流');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completion: ChatCompletionResponse | undefined;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const item = JSON.parse(line) as { kind: string; event?: AgentEvent; result?: ChatCompletionResponse; message?: string };
        if (item.kind === 'error') throw new Error(item.message ?? '运行失败');
        if (item.event) {
          setConversationId(item.event.conversationId);
          currentLive = applyLiveEvent(currentLive, item.event, Math.round(performance.now() - started));
          setLive(currentLive);
        }
        if (item.kind === 'result') completion = item.result;
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) consume(line);
          if (done) { consume(buffer); break; }
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally { reader.releaseLock(); }
      if (!completion) throw new Error('事件流结束但没有最终结果');
      const record: RunRecord = {
        id,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        request,
        ...(currentLive.panel ? { panel: currentLive.panel } : {}),
        live: currentLive,
        response: completion,
      };
      setHistory((items) => [record, ...items].slice(0, 20));
      setSelectedRunId(id);
      setConversationId(completion.conversationId);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      currentLive = {
        ...currentLive, status: cancelled ? '客户端已停止接收' : '运行中断',
        steps: [...currentLive.steps, {
          sequence: (currentLive.steps.at(-1)?.sequence ?? 0) + 1,
          label: cancelled ? '客户端已停止接收，保留已收到的结果' : '运行中断，保留已收到的结果',
          elapsedMs: Math.round(performance.now() - started), failed: !cancelled,
        }],
      };
      const record: RunRecord = {
        id,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        request,
        ...(currentLive.panel ? { panel: currentLive.panel } : {}),
        live: currentLive,
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
            <div className="brand-name">令狸 Agent Lab</div>
            <div className="brand-caption">Prompt & runtime debugger</div>
          </div>
        </div>
        <nav className="product-nav" aria-label="Debugger sections">
          <button
            className={productView === 'agent' ? 'product-nav__item product-nav__item--active' : 'product-nav__item'}
            type="button"
            onClick={() => setProductView('agent')}
          >
            Agent 调试
          </button>
          <button
            className={productView === 'animation' ? 'product-nav__item product-nav__item--active' : 'product-nav__item'}
            type="button"
            onClick={() => setProductView('animation')}
          >
            动画检查
          </button>
        </nav>
        <div className={`api-status api-status--${apiStatus}`}>
          <span className="status-dot" />
          {apiStatus === 'online'
            ? 'API connected'
            : apiStatus === 'checking'
              ? 'Checking API'
              : 'API offline'}
        </div>
      </header>

      {productView === 'agent' ? <main className="workspace">
        <aside className="control-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Configuration</span>
              <h1>New run</h1>
            </div>
            <span className="model-chip">Model comparison</span>
          </div>

          <fieldset className="model-switcher" disabled={running} aria-describedby="model-switcher-hint">
            <legend>切换模型</legend>
            <div className="model-options">
              {([
                { value: 'qwen', label: '千问', detail: 'Qwen 3.8 Flash' },
                { value: 'deepseek', label: 'DeepSeek', detail: 'V4 Flash' },
                { value: '', label: '默认模型', detail: '使用服务端配置' },
                { value: 'openai-compatible', label: '自定义模型', detail: 'OpenAI 兼容服务' },
              ] as const).map((option) => (
                <label className="model-option" key={option.value}>
                  <input
                    type="radio"
                    name="model-provider"
                    value={option.value}
                    checked={provider === option.value}
                    onChange={() => {
                      setProvider(option.value);
                      setConversationId('');
                    }}
                  />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </label>
              ))}
            </div>
            <p id="model-switcher-hint">{running ? '运行中，结束后可切换模型。' : '切换后开始新会话，保留提示词和输入，方便对比。'}</p>
          </fieldset>

          <label className="field">
            <span className="field-label">
              核心身份设定 <span>{systemPrompt.length}/10000</span>
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

          <fieldset className="context-settings" disabled={running}>
            <legend>本轮动态上下文</legend>
            <label className="field">
              <span className="field-label">当前场景</span>
              <select className="input" value={scene} onChange={event => setScene(event.target.value as AgentScene)}>
                <option value="conversation">自然对话</option>
                <option value="interview">故事访谈</option>
                <option value="revision">共同编辑</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">文章 ID（留空表示无工作区）</span>
              <input className="input" value={documentId} maxLength={200} onChange={event => setDocumentId(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">文章版本</span>
              <input className="input" type="number" min={0} step={1} value={documentVersion}
                onChange={event => setDocumentVersion(Math.max(0, Math.floor(Number(event.target.value) || 0)))} />
            </label>
            <label className="field">
              <span className="field-label">选中段落 ID（可选）</span>
              <input className="input" value={selectedBlockId} maxLength={200} onChange={event => setSelectedBlockId(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">选区或相关正文 · {excerpt.length}/12000</span>
              <textarea className="textarea" value={excerpt} maxLength={12000} onChange={event => setExcerpt(event.target.value)} />
            </label>
            <small>每轮提交当前快照；放在历史之后、用户消息之前。这里只提供参考内容，不保存文章。</small>
          </fieldset>

          <fieldset className="context-settings" disabled={running}>
            <legend>提供附件（可选）</legend>
            <label className="field"><span className="field-label">附件 ID（不同内容使用不同 ID）</span>
              <input className="input" value={attachmentId} maxLength={64} onChange={e => setAttachmentId(e.target.value)} /></label>
            <label className="field"><span className="field-label">类型</span>
              <select className="input" value={attachmentKind} onChange={e => setAttachmentKind(e.target.value as 'image' | 'document')}>
                <option value="image">照片</option><option value="document">文档</option>
              </select></label>
            <label className="field"><span className="field-label">附件标题</span>
              <input className="input" value={attachmentTitle} maxLength={300} onChange={e => setAttachmentTitle(e.target.value)} /></label>
            <label className="field"><span className="field-label">HTTPS 地址（照片必填）</span>
              <input className="input" value={attachmentUrl} maxLength={2048} onChange={e => setAttachmentUrl(e.target.value)} /></label>
            <label className="field"><span className="field-label">文档文本（可选，最多 12000 字符）</span>
              <textarea className="textarea" value={attachmentText} maxLength={12000} onChange={e => setAttachmentText(e.target.value)} /></label>
            <small>附件原件只供查看；修改会创建独立草稿。当前照片仅展示，未接入图像理解。</small>
          </fieldset>

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

        <section className="result-panel" ref={resultRef}>
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
              <ResultView run={selectedRun} running={running} live={live} elapsedMs={elapsedMs}
                onSelectBlock={(panel, block) => {
                  if (!panel.document) return;
                  if (selectedRun?.response?.conversationId) setConversationId(selectedRun.response.conversationId);
                  setDocumentId(panel.document.id); setDocumentVersion(panel.document.version);
                  setSelectedBlockId(block.id); setExcerpt(block.text);
                }} />
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
      </main> : <AnimationLab />}
    </div>
  );
}

function AnimationLab() {
  const [manifest, setManifest] = useState<AnimationManifest | null>(null);
  const [loadError, setLoadError] = useState('');
  const [animationId, setAnimationId] = useState<AnimationAsset['id']>('blink');
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [onionSkin, setOnionSkin] = useState(false);
  const [looping, setLooping] = useState(false);
  const [visibleLayers, setVisibleLayers] = useState({
    environment: true,
    actorBoard: true,
    innerPanel: true,
  });

  const animation = manifest?.animations.find((item) => item.id === animationId);

  useEffect(() => {
    void fetch('/animations/fox-clerk/manifest.json')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<AnimationManifest>;
      })
      .then(setManifest)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : '动画清单加载失败');
      });
  }, []);

  useEffect(() => {
    setFrame(0);
  }, [animationId]);

  useEffect(() => {
    if (!playing || !animation) return;
    const timer = window.setInterval(() => {
      setFrame((value) => {
        if (value < animation.frameCount - 1) return value + 1;
        if (looping) return 0;
        setPlaying(false);
        return value;
      });
    }, 1000 / (animation.fps * speed));
    return () => window.clearInterval(timer);
  }, [animation, looping, playing, speed]);

  function step(delta: number): void {
    if (!animation) return;
    setPlaying(false);
    setFrame((value) => (value + delta + animation.frameCount) % animation.frameCount);
  }

  if (loadError) {
    return <main className="animation-workspace"><div className="empty-state"><div className="empty-glyph">!</div><h2>Animation assets unavailable</h2><p>{loadError}</p></div></main>;
  }

  if (!manifest || !animation) {
    return <main className="animation-workspace"><div className="running-state"><div className="orb"><span /></div><h2>Loading animation assets</h2></div></main>;
  }

  return (
    <main className="animation-workspace">
      <aside className="animation-sidebar">
        <span className="eyebrow">Character motion</span>
        <h1>动作素材</h1>
        <p className="animation-intro">固定镜头与场景，只检查狐狸角色的毛毡定格动作。</p>
        <div className="animation-list">
          {manifest.animations.map((item) => (
            <button
              className={animationId === item.id ? 'animation-item animation-item--active' : 'animation-item'}
              type="button"
              key={item.id}
              onClick={() => { setAnimationId(item.id); setPlaying(true); }}
            >
              <span>{item.name}</span>
              <small>{item.frameCount} 帧 · {(item.durationMs / 1000).toFixed(1)} 秒</small>
            </button>
          ))}
        </div>
        <div className="asset-note">
          <strong>场景锁定</strong>
          <p>{manifest.backgroundPolicy}</p>
        </div>
        <fieldset className="layer-controls">
          <legend>图层检查</legend>
          {([
            ['environment', manifest.layers.environment.name],
            ['actorBoard', manifest.layers.actorBoard.name],
            ['innerPanel', manifest.layers.innerPanel.name],
          ] as const).map(([id, name]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={visibleLayers[id]}
                onChange={(event) => setVisibleLayers((value) => ({ ...value, [id]: event.target.checked }))}
              />
              <span className={`layer-swatch layer-swatch--${id}`} />
              {name}
            </label>
          ))}
        </fieldset>
      </aside>

      <section className="animation-stage-panel">
        <div className="animation-toolbar">
          <div>
            <span className="eyebrow">Preview</span>
            <h2>{animation.name}</h2>
            <p className="animation-description">{animation.description}</p>
          </div>
          <div className="frame-counter">FRAME {String(frame + 1).padStart(2, '0')} / {animation.frameCount}</div>
        </div>

        <div className="animation-preview-wrap">
          <div className="animation-preview" style={{ aspectRatio: `${animation.frameWidth} / ${animation.frameHeight}` }}>
            {visibleLayers.environment && (
              <div className="sprite-frame sprite-frame--environment" style={{ backgroundImage: `url(${manifest.layers.environment.src})` }} />
            )}
            {visibleLayers.actorBoard && onionSkin && (
              <SpriteFrame
                animation={animation}
                frame={(frame - 1 + animation.frameCount) % animation.frameCount}
                className="sprite-frame sprite-frame--onion"
              />
            )}
            {visibleLayers.actorBoard && (
              <SpriteFrame animation={animation} frame={frame} className="sprite-frame sprite-frame--actor" />
            )}
            {visibleLayers.innerPanel && (
              <div className="sprite-frame sprite-frame--inner-panel" style={{ backgroundImage: `url(${manifest.layers.innerPanel.src})` }} />
            )}
            <div className="anchor anchor--head" title="Head anchor" />
            <div className="anchor anchor--desk" title="Desk anchor" />
          </div>
        </div>

        <div className="transport">
          <button type="button" onClick={() => step(-1)} aria-label="Previous frame">‹</button>
          <button className="transport__play" type="button" onClick={() => {
            if (!playing && frame === animation.frameCount - 1) setFrame(0);
            setPlaying((value) => !value);
          }}>{playing ? '暂停' : '播放'}</button>
          <button type="button" onClick={() => step(1)} aria-label="Next frame">›</button>
          <label className="toggle"><input type="checkbox" checked={onionSkin} onChange={(event) => setOnionSkin(event.target.checked)} />前后帧叠加</label>
          <label className="toggle"><input type="checkbox" checked={looping} onChange={(event) => setLooping(event.target.checked)} />循环播放</label>
          <label className="speed-control">速度
            <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={1.5}>1.5×</option>
              <option value={2}>2×</option>
            </select>
          </label>
        </div>

        <div className="frame-strip" aria-label="Frame selector">
          {Array.from({ length: animation.frameCount }, (_, index) => (
            <button
              className={frame === index ? 'frame-tick frame-tick--active' : 'frame-tick'}
              type="button"
              key={index}
              onClick={() => { setPlaying(false); setFrame(index); }}
              aria-label={`Frame ${index + 1}`}
            ><span /></button>
          ))}
        </div>
      </section>
    </main>
  );
}

function SpriteFrame({ animation, frame, className }: { animation: AnimationAsset; frame: number; className: string }) {
  const column = frame % animation.columns;
  const row = Math.floor(frame / animation.columns);
  const positionX = animation.columns === 1 ? 0 : (column / (animation.columns - 1)) * 100;
  const positionY = animation.rows === 1 ? 0 : (row / (animation.rows - 1)) * 100;
  return (
    <div
      className={className}
      style={{
        backgroundImage: `url(${animation.src})`,
        backgroundSize: `${animation.columns * 100}% ${animation.rows * 100}%`,
        backgroundPosition: `${positionX}% ${positionY}%`,
      }}
    />
  );
}

function ResultView({
  run,
  running, live, elapsedMs, onSelectBlock,
}: {
  run: RunRecord | undefined;
  running: boolean;
  live: LiveRun;
  elapsedMs: number;
  onSelectBlock: (panel: PanelState, block: PanelBlock) => void;
}) {
  if (running) {
    return <LiveWorkspace live={live} elapsedMs={elapsedMs} running />;
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

  const panels = new Map<string, MarkdownPanel>();
  for (const event of run.response?.events ?? []) {
    if (event.type === 'panel.updated') panels.set(event.panel.id, event.panel);
  }

  return (
    <div className="run-result">
      <div className="run-meta">
        <span className={`run-badge ${run.error ? 'run-badge--error' : ''}`}>
          {run.error === '运行已取消' ? 'Cancelled' : run.error ? 'Failed' : 'Completed'}
        </span>
        <span>{formatTime(run.startedAt)}</span>
        <span>{formatDuration(run.durationMs)}</span>
        {run.response?.model && <span>{run.response.model}</span>}
        {run.response?.finishReason && <span>{run.response.finishReason}</span>}
      </div>

      {run.error ? (
        <div className="error-card">
          <span className="error-mark">!</span>
          <div><strong>{run.error === '运行已取消' ? '已停止接收' : '运行失败'}</strong><p>{run.error}</p></div>
        </div>
      ) : !run.live?.messages.length ? (
        <article className="answer-card">
          <div className="answer-label">Agent response</div>
          <div className="answer-content">{run.response?.message.content}</div>
        </article>
      ) : null}

      {run.live ? <LiveWorkspace live={run.live} elapsedMs={run.durationMs} running={false} onSelectBlock={onSelectBlock} />
        : run.panel && <WorkspacePanel panel={run.panel} onSelectBlock={onSelectBlock} />}
      {run.response && <UsageSummary response={run.response} />}

      {Array.from(panels.values()).map((panel) => (
        <article className="answer-card work-panel" key={panel.id}>
          <div className="answer-label">工作面板 · {panel.title}</div>
          <div className="answer-content">{panel.content}</div>
        </article>
      ))}

      {run.response?.runId && (
        <p className="trace-link">
          <a href={`/api/v1/agent/runs/${run.response.runId}/trace`} target="_blank" rel="noreferrer">查看本次运行 Trace</a>
        </p>
      )}

      {!run.live && <div className="timeline">
        <div className="timeline-heading">Run timeline</div>
        <div className="timeline-item timeline-item--done">
          <span className="timeline-dot" />
          <div><strong>Request prepared</strong><p>System prompt and user message assembled</p></div>
        </div>
        <div className={`timeline-item ${run.error ? 'timeline-item--error' : 'timeline-item--done'}`}>
          <span className="timeline-dot" />
          <div><strong>{run.response?.model ?? 'DeepSeek'} completion</strong><p>{formatDuration(run.durationMs)} total latency</p></div>
        </div>
      </div>}
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

function WorkspacePanel({ panel, onSelectBlock }: {
  panel: PanelState;
  onSelectBlock?: (panel: PanelState, block: PanelBlock) => void;
}) {
  const modes = { conversation: '纯对话', attachment: '附件查看', editor: '共同编辑' };
  const safeUrl = panel.attachment?.url?.startsWith('https://') ? panel.attachment.url : undefined;
  return <article className="answer-card work-panel">
    <div className="answer-label">{modes[panel.mode]}</div>
    {panel.mode === 'conversation' && <p>当前没有打开的内容，已有草稿仍然保留。</p>}
    {panel.mode === 'attachment' && panel.attachment && <>
      <h3>{panel.attachment.title}</h3>
      {panel.attachment.kind === 'image' && safeUrl && <img className="panel-attachment-image" src={safeUrl} alt={panel.attachment.title} referrerPolicy="no-referrer" />}
      {panel.attachment.kind === 'document' && <>
        {panel.attachment.text && <div className="answer-content">{panel.attachment.text}</div>}
        {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer">打开文档原件</a>}
      </>}
    </>}
    {panel.mode === 'editor' && panel.document && <>
      <h3>{panel.document.title} <small>版本 {panel.document.version}</small></h3>
      {panel.document.blocks.map(block => <section className="panel-block" key={block.id}>
        {block.kind === 'heading' ? <h4>{block.text}</h4>
          : block.kind === 'list' ? <ul>{block.text.split('\n').map((text, index) => <li key={index}>{text}</li>)}</ul>
          : block.kind === 'quote' ? <blockquote>{block.text}</blockquote>
          : block.kind === 'code' ? <pre><code>{block.text}</code></pre>
          : <p>{block.text}</p>}
        {onSelectBlock && <button type="button" onClick={() => onSelectBlock(panel, block)}>选中这段继续讨论</button>}
      </section>)}
      {panel.lastChange && <details><summary>查看本次修改</summary>
        {panel.lastChange.before.map(block => <p className="panel-removed" key={`before-${block.id}`}>修改前：{block.text}</p>)}
        {panel.lastChange.after.map(block => <p className="panel-added" key={`after-${block.id}`}>修改后：{block.text}</p>)}
      </details>}
      <small>草稿保存在本地会话中，未修改附件原件。</small>
    </>}
  </article>;
}

function LiveWorkspace({ live, elapsedMs, running, onSelectBlock }: {
  live: LiveRun; elapsedMs: number; running: boolean;
  onSelectBlock?: (panel: PanelState, block: PanelBlock) => void;
}) {
  return <section className="live-workspace">
    <header className="live-status" role="status">
      <span className={running ? 'live-indicator live-indicator--active' : 'live-indicator'} />
      <strong>{running ? live.status : '本轮记录'}</strong>
      <span>{formatDuration(elapsedMs)}</span>
    </header>
    <div className="live-stage">
      <section className="live-dialogue" aria-label="令狸的实时回复">
        <div className="answer-label">令狸的回复</div>
        {live.messages.length ? live.messages.map(message => <div className="live-utterance" key={message.id}>
          <p>{message.text}</p>
          {running && !message.completed && <span className="live-writing">正在说…</span>}
          {!running && !message.completed && <span className="live-writing">回复未完成</span>}
        </div>) : <p className="live-placeholder">{running ? '等待令狸回应…' : '本轮没有生成普通回复。'}</p>}
      </section>
      <section className="live-panel" aria-label="实时工作面板">
        {live.panel ? <WorkspacePanel panel={live.panel} {...(onSelectBlock ? { onSelectBlock } : {})} />
          : <div className="live-placeholder">{running ? '正在读取当前面板…' : '未收到面板状态。'}</div>}
      </section>
    </div>
    <section className="live-timeline" aria-label="实时变化记录">
      <h3>变化记录 <small>从本轮开始计时</small></h3>
      <ol>{live.steps.map(step => <li key={step.sequence} className={step.failed ? 'live-step--failed' : ''}>
        <time>{formatDuration(step.elapsedMs)}</time><span>{step.label}</span>
      </li>)}</ol>
    </section>
  </section>;
}

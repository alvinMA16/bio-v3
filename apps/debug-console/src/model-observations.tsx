import { useEffect, useState } from 'react';

type Entry = { type: string; data: Record<string, any> };

export function ModelObservations({ runId }: { runId: string | undefined }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState('');
  const token = sessionStorage.getItem('bio-auth-token') ?? '';
  useEffect(() => {
    setEntries([]);
    if (!runId) { setStatus('运行结束后显示每次模型调用的记录。'); return; }
    const controller = new AbortController();
    setStatus('正在读取观测记录…');
    void fetch(`/api/v1/agent/runs/${encodeURIComponent(runId)}/trace`, {
      signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async response => {
      if (!response.ok) throw new Error('读取失败');
      const trace: Entry[] = await response.json();
      if (controller.signal.aborted) return;
      const observations = trace.filter(e => e.type === 'model.request' || e.type === 'model.response');
      setEntries(observations);
      setStatus(observations.length ? '' : '这次运行没有模型观测记录（旧记录或非 Gemini 调用）。');
    }).catch(() => { if (!controller.signal.aborted) setStatus('无法读取观测记录，请检查登录状态后重新打开。'); });
    return () => controller.abort();
  }, [runId, token]);
  return <section className="code-card">
    <div className="code-heading"><span>Gemini 请求与缓存观测</span></div>
    <p>{status || '每次模型调用单独记录，包含工具后的再次调用。前缀以消息为单位比较，不代表可缓存 token 数。'}</p>
    {entries.filter(e => e.type === 'model.request').map(({ data: request }) => {
      const response = entries.find(e => e.type === 'model.response' && e.data.callId === request.id)?.data;
      return <details key={request.id}>
        <summary>调用 {request.ordinal} · {response ? `缓存 ${response.cacheReadTokens} / ${response.inputTokens} tokens（${response.cacheRatio === null ? '未知' : (response.cacheRatio * 100).toFixed(2) + '%'}）` : '未收到终态用量'}</summary>
        <p>{request.baseline === 'available'
          ? `相同前缀 ${request.commonMessages} 条消息；首次变化位置：${request.firstChangedMessage ?? '仅追加或无变化'}；配置变化：${request.changed.join(', ') || '无'}`
          : '没有可比较的前次请求（新会话、重启或基线过期）。'}</p>
        <p>耗时 {response?.durationMs ?? '未知'} ms · 首个内容增量 {response?.firstDeltaMs ?? '未知'} ms。缓存用量来自 SDK；原始字段是否缺失不可判定。</p>
        <pre>{JSON.stringify({ request, response }, null, 2)}</pre>
      </details>;
    })}
  </section>;
}

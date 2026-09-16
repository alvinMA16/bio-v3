import { useState } from 'react';

/** Debug-only visibility into persisted memory; never part of speech or the phone scene. */
export function MemoryInspector({ busy, onIdentityChange }: { busy: boolean; onIdentityChange: () => void }) {
  const [token, setToken] = useState(() => sessionStorage.getItem('bio-auth-token') ?? '');
  const [data, setData] = useState<unknown>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true); setError('');
    try {
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
      const values = await Promise.all(['overview', 'jobs'].map(async path => {
        const response = await fetch(`/api/v1/memory/${path}`, { headers });
        if (!response.ok) throw new Error(response.status === 404 ? '服务端尚未启用数据库记忆。' : `读取失败（${response.status}），请检查身份和服务配置。`);
        return response.json();
      }));
      setData({ overview: values[0], jobs: values[1] });
    } catch (e) { setError(e instanceof Error ? e.message : '读取失败'); }
    finally { setLoading(false); }
  }
  return <details className="lab-settings">
    <summary>长期记忆 · 概要与整理状态</summary>
    {sessionStorage.getItem('bio-account-enabled') !== 'true' && <label className="field"><span>调试访问令牌（服务端配置开发用户时可留空）</span>
      <input className="input" type="password" autoComplete="off" value={token} disabled={busy || loading}
        onChange={e => { setToken(e.target.value); sessionStorage.setItem('bio-auth-token', e.target.value); setData(undefined); onIdentityChange(); }} />
    </label>}
    <p>挂断电话后后台整理；下次通话加载用户偏好、人物、故事及互动近况摘要。</p>
    <button disabled={busy || loading} onClick={() => void refresh()}>{loading ? '正在读取…' : '刷新记忆与任务'}</button>
    {error && <p role="alert">{error}</p>}
    {data !== undefined && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(data, null, 2)}</pre>}
  </details>;
}

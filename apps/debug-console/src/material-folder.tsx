import { useEffect, useState } from 'react';
import type { Material } from '@bio/contracts';
async function request<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/materials${path}`, init);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || '资料操作失败，请重试'); }
  return response.json();
}
export function MaterialFolder({ onChat, disabled }: { onChat: (item: Material) => void; disabled: boolean }) {
  const [items, setItems] = useState<Material[]>([]);
  const [selected, setSelected] = useState<Material | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function refresh() { setItems(await request<Material[]>()); }
  useEffect(() => { let active = true; request<Material[]>().then(value => { if (active) setItems(value); }).catch(e => { if (active) setError(String(e.message)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  function select(item: Material | null) { setSelected(item); setTitle(item?.title ?? ''); setDescription(item?.description ?? ''); setConfirmDelete(false); }
  async function act(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } }
  return <div className="material-folder" aria-busy={busy || loading}>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void act(refresh)}>重新加载</button></p>}
    {selected ? <>
      <button disabled={busy} onClick={() => select(null)}>← 全部资料</button>
      {selected.kind === 'image' && <img className="material-image" src={selected.url} alt={selected.title} />}
      <a href={selected.url} target="_blank" rel="noreferrer">查看原件 · {selected.filename}</a>
      <label>标题<input value={title} maxLength={300} disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
      <label>补充说明<textarea placeholder="照片里是谁？这份资料有什么故事？" value={description} maxLength={2000} disabled={busy} onChange={e => setDescription(e.target.value)} /></label>
      {selected.statusMessage && <p>{selected.statusMessage}</p>}
      {selected.text && <details><summary>查看提取内容</summary><pre>{selected.text}</pre></details>}
      <button disabled={busy || !title.trim()} onClick={() => void act(async () => { const item = await request<Material>(`/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description }) }); select(item); await refresh(); })}>保存修改</button>
      <button disabled={busy || disabled || title !== selected.title || description !== selected.description} onClick={() => onChat(selected)}>聊聊这份资料</button>
      {confirmDelete ? <div><p>删除后无法恢复原件，确定删除？</p><button disabled={busy} onClick={() => void act(async () => { await request(`/${selected.id}`, { method: 'DELETE' }); select(null); await refresh(); })}>确定删除</button><button disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div> : <button disabled={busy} onClick={() => setConfirmDelete(true)}>删除资料</button>}
    </> : <>
      <p>把照片、信件和生活片段留在这里。</p>
      <label className="material-upload">{busy ? '正在上传并整理…' : '＋ 添加资料'}<input type="file" disabled={busy || loading} accept=".jpg,.jpeg,.png,.webp,.pdf,.docx,.txt,.md" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        if (file.size > 20 * 1024 * 1024) { setError('文件不能超过 20 MB'); return; }
        void act(async () => { const body = new FormData(); body.append('file', file); const item = await request<Material>('', { method: 'POST', body }); await refresh(); select(item); });
      }} /></label>
      <small>照片 / PDF / DOCX / TXT / MD · 每份最多 20 MB</small>
      {loading ? <p>正在打开资料夹…</p> : !items.length && <p>还没有资料，放进第一份回忆吧。</p>}
      <div className="material-list">{items.map(item => <button key={item.id} disabled={busy} onClick={() => select(item)}>{item.kind === 'image' ? <img src={item.url} alt="" /> : <span className="material-icon">文</span>}<span><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleDateString()} · {Math.max(1, Math.round(item.size / 1024))} KB{item.status !== 'ready' ? ' · 待补充说明' : ''}</small></span><span>›</span></button>)}</div>
    </>}
  </div>;
}

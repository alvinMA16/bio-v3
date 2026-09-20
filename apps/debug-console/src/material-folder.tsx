import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Material, MaterialUploadResult } from '@bio/contracts';
import './material-folder.css';
import { uiAsset } from './ui-asset';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md';
const fileType = (name: string) => name.split('.').at(-1)?.toUpperCase() || '文件';
const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
async function request<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/materials${path}`, init);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || '资料操作失败，请重试'); }
  if (init?.method === 'DELETE') window.dispatchEvent(new CustomEvent('bio-material-deleted', { detail: path.slice(1) }));
  return response.json();
}

type Upload = { id: number; file: File; status: 'waiting' | 'uploading' | 'done' | 'failed'; error?: string | undefined; completedAt?: number | undefined; result?: MaterialUploadResult };
function Cover({ item, large = false }: { item: Material; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const image = item.kind === 'image';
  const src = item.thumbnailUrl || (image ? item.url : '');
  return <span className={`material-cover ${image ? 'material-cover--photo' : 'material-cover--paper'} ${large ? 'material-cover--large' : ''}`}>
    {src && !failed ? <img src={src} alt={image ? item.title : `${item.title}的首页`} loading="lazy" onError={() => setFailed(true)} /> : image ?
      <span className="material-cover-placeholder">照片暂不可预览</span> : <span className="material-paper-content" aria-hidden="true"><span className="material-paper-sprig"><i /><i /><i /><i /><i /></span><span className="material-paper-lines" /></span>}
    <span className="material-cover-caption"><span>{fileType(item.filename)}</span><span>{fileSize(item.size)}</span></span>
  </span>;
}

function PdfPreview({ item }: { item: Material }) {
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(item.pageCount ?? 0);
  const [image, setImage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const figure = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setImage('');
    figure.current?.closest('.material-preview-scroll')?.scrollTo({ top: 0 });
    request<{ image: string; pageCount: number }>(`/${item.id}/pages/${page}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setImage(result.image); setCount(result.pageCount); } })
      .catch(() => { if (!controller.signal.aborted) setError('这一页暂时未能加载'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [item.id, page, retry]);
  return <figure ref={figure} className="material-pdf-preview">

    <div className="material-pdf-stage">{loading ? <p className="material-pdf-status" role="status">正在展开第 {page} 页…</p> : error ? <div className="material-pdf-status" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></div> : <img src={image} alt={`${item.title}，第 ${page} 页`} />}</div>
    {count > 1 && <nav className="material-pdf-pager" aria-label="PDF 翻页">
      <button aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>‹</button>
      <span aria-live="polite">{page} / {count || '…'}</span>
      <button aria-label="下一页" disabled={!count || page >= count || loading} onClick={() => setPage(value => value + 1)}>›</button>
    </nav>}
  </figure>;
}

function FileCard({ item, index, disabled = false, onChoose, onActions }: { item: Material; index: number; disabled?: boolean; onChoose: (item: Material) => void; onActions: (item: Material) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  function cancel() { if (timer.current) clearTimeout(timer.current); timer.current = null; }
  useEffect(() => cancel, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  return <button type="button" className={`material-card material-card--${item.kind}`} style={{ animationDelay: `${Math.min(index, 7) * 28}ms` }} disabled={disabled} aria-label={`查看 ${item.title}`} aria-haspopup="dialog"
    onPointerDown={event => { cancel(); suppressClick.current = false; if (!event.isPrimary || event.button !== 0 || disabled) return; start.current = { x: event.clientX, y: event.clientY }; timer.current = setTimeout(() => { suppressClick.current = true; timer.current = null; onActions(item); }, 500); }}
    onPointerMove={event => { if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10) { cancel(); suppressClick.current = true; } }}
    onPointerUp={cancel} onPointerCancel={() => { cancel(); suppressClick.current = true; }} onPointerLeave={cancel}
    onContextMenu={event => { event.preventDefault(); cancel(); suppressClick.current = true; onActions(item); }}
    onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); onActions(item); } }}
    onClick={event => { if (suppressClick.current && event.detail !== 0) { event.preventDefault(); suppressClick.current = false; return; } onChoose(item); }}>
    <Cover item={item} /><span className="material-card-title" title={item.title}>{item.title}</span>{item.title !== item.filename && <span className="material-card-original">{item.filename}</span>}
  </button>;
}

function MaterialSearch({ items, loading, error, onBack, onChoose, onActions }: { onActions: (item: Material) => void; items: Material[]; loading: boolean; error: string; onBack: () => void; onChoose: (item: Material) => void }) {
  const [query, setQuery] = useState('');
  const [committed, setCommitted] = useState('');
  const [composing, setComposing] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const normalized = query.trim().toLowerCase();
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!normalized) { setCommitted(''); return; }
    if (composing || normalized === committed) return;
    timer.current = setTimeout(() => setCommitted(normalized), 1000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [normalized, composing, committed]);
  function submit() { if (composing) return; if (timer.current) clearTimeout(timer.current); setCommitted(normalized); }
  const results = committed ? items.filter(item => `${item.title} ${item.filename}`.toLowerCase().includes(committed)) : [];
  const pending = composing || normalized !== committed;
  return <section className="material-search-page" aria-label="搜索资料" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onBack(); } }}>
    <header className="material-search-header"><button type="button" className="search-page-back" aria-label="返回资料夹" onClick={onBack}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      <form onSubmit={event => { event.preventDefault(); submit(); }}><input ref={searchInput} autoFocus aria-label="搜索文件名" type="search" enterKeyHint="search" placeholder="搜索文件名" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); setQuery(event.currentTarget.value); }} />{query && <button className="search-clear" type="button" aria-label="清空搜索" onClick={() => { setQuery(''); setCommitted(''); searchInput.current?.focus(); }}><svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button>}</form>
    </header>
    <div className="material-search-results" aria-busy={pending || loading}>
      {error ? <p role="alert">{error}</p> : loading ? <p className="material-empty" role="status">正在加载资料…</p> : !normalized ? <p className="material-empty">输入文件名，查找照片或文档</p> : <>
        {pending && <p className="material-search-status" role="status">正在搜索…</p>}
        {!pending && !results.length && <p className="material-empty">没有找到匹配的资料</p>}
        <div className="material-grid" key={committed}>{results.map((item, index) => <FileCard key={item.id} item={item} index={index} onChoose={onChoose} onActions={onActions} />)}</div>
      </>}
    </div>
  </section>;
}

export function MaterialFolder({ onChat, disabled, searchOpen, onCloseSearch }: { onCloseSearch: () => void; searchOpen: boolean; onChat: (item: Material) => void; disabled: boolean }) {
  const [items, setItems] = useState<Material[]>([]);
  const [selected, setSelected] = useState<Material | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const query = '';
  const [filter, setFilter] = useState<'all' | 'image' | 'document'>('all');
  const [display, setDisplay] = useState({ filter: 'all', query: '' });
  const [leaving, setLeaving] = useState(false);
  const target = useRef({ filter: 'all', query: '' });
  useEffect(() => {
    if (target.current.filter === filter && target.current.query === query) return;
    target.current = { filter, query };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setLeaving(!reduced);
    const timer = window.setTimeout(() => {
      setDisplay({ filter, query });
      setLeaving(false);
    }, reduced ? 0 : 150);
    return () => window.clearTimeout(timer);
  }, [filter, query]);
  const [actions, setActions] = useState<{ item: Material; confirm: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  useEffect(() => {
    const completed = uploads.filter(entry => entry.completedAt !== undefined);
    if (!completed.length) return;
    const nextExpiry = Math.min(...completed.map(entry => entry.completedAt! + 2800));
    const timer = window.setTimeout(() => {
      setUploads(previous => previous.filter(entry => entry.completedAt === undefined || entry.completedAt + 2800 > Date.now()));
    }, Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [uploads]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const input = useRef<HTMLInputElement>(null), nextId = useRef(0), locked = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller;
    request<Material[]>('', { signal: controller.signal }).then(setItems).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function refresh() { const value = await request<Material[]>('', { signal: abort.current?.signal ?? null }); if (!abort.current?.signal.aborted) setItems(value); }
  function select(item: Material | null) { setSelected(item); setConfirmDelete(false); setError(''); setNotice(''); }
  async function act(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { if (!abort.current?.signal.aborted) setError(e instanceof Error ? e.message : '操作失败'); }
    finally { locked.current = false; if (!abort.current?.signal.aborted) { setBusy(false); setLoading(false); } }
  }
  async function uploadFiles(files: File[], retryId?: number) {
    if (!files.length || locked.current) return;
    const batch = files.slice(0, 20).map(file => ({ id: retryId ?? ++nextId.current, file, status: 'waiting' as const }));
    setUploads(previous => [...previous.filter(item => item.id !== retryId), ...batch]);
    await act(async () => {
      if (files.length > 20) setNotice('本次先上传前 20 份，其余文件请下一次添加。');
      for (const entry of batch) {
        if (abort.current?.signal.aborted) break;
        const update = (status: Upload['status'], message?: string) => setUploads(previous => previous.map(item => item.id === entry.id ? { ...item, status, error: message, completedAt: status === 'done' ? Date.now() : undefined } : item));
        try {
          if (!entry.file.size || entry.file.size > 20 * 1024 * 1024) throw new Error('文件不能为空，且不能超过 20 MB');
          if (!ACCEPT.split(',').includes('.' + fileType(entry.file.name).toLowerCase())) throw new Error('暂不支持这个文件类型');
          update('uploading');
          const body = new FormData(); body.append('file', entry.file);
          const item = await request<MaterialUploadResult>('', { method: 'POST', body, signal: abort.current?.signal ?? null });
          if (abort.current?.signal.aborted) break;
          setItems(previous => [item, ...previous.filter(value => value.id !== item.id)]); update('done');
          setUploads(previous => previous.map(value => value.id === entry.id ? { ...value, result: item, completedAt: item.uploadOutcome === 'created' ? value.completedAt : undefined } : value));
        } catch (e) { if (!abort.current?.signal.aborted) update('failed', e instanceof Error ? e.message : '上传失败，请重试'); }
      }
    });
  }
  const visible = items.filter(item => (display.filter === 'all' || item.kind === display.filter) && `${item.title} ${item.filename}`.toLowerCase().includes(display.query.trim().toLowerCase()));
  const openActions = (item: Material) => { if (!busy) { setError(''); setActions({ item, confirm: false }); } };
  const actionSheet = actions && <div className="material-actions" onClick={() => { if (!busy) setActions(null); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) setActions(null); }
    if (event.key === 'Tab') { const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><section role={actions.confirm ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={actions.confirm ? '确认删除资料' : '文件操作'} onClick={event => event.stopPropagation()}>
    <div className="material-actions-keepsake"><Cover key={actions.item.id} item={actions.item} /><p className="material-actions-title">{actions.item.title}</p></div>
    <div className="material-actions-menu">
    {error && <p role="alert">{error}</p>}
    {actions.confirm ? <><p className="material-actions-hint">删除后将无法查看原文件或重新读取其内容，已有对话记录仍会保留。</p><button autoFocus className="material-action-danger" disabled={busy} onClick={() => void act(async () => { const id = actions.item.id; await request(`/${id}`, { method: 'DELETE', signal: abort.current?.signal ?? null }); setItems(previous => previous.filter(item => item.id !== id)); setActions(null); setNotice('资料已删除'); })}>{busy ? '正在删除…' : '确认删除'}</button><button disabled={busy} onClick={() => setActions(null)}>保留资料</button></> : <><button autoFocus onClick={() => { select(actions.item); setActions(null); onCloseSearch(); }}>预览</button><button disabled={disabled || busy} onClick={() => { onChat(actions.item); setActions(null); }}>和令狸聊聊</button><button className="material-action-danger" onClick={() => setActions({ ...actions, confirm: true })}>删除</button><button className="material-action-cancel" onClick={() => setActions(null)}>取消</button></>}
    </div>
  </section></div>;
  if (searchOpen) return <div className="material-folder"><div inert={!!actions}><MaterialSearch items={items} loading={loading} error={error} onActions={openActions} onBack={onCloseSearch} onChoose={item => { select(item); onCloseSearch(); }} /></div>{actionSheet}</div>;
  return <div className="material-folder" aria-busy={busy || loading}>
    {!selected && error && <div className="material-feedback material-feedback--error" role="alert">{error} {!selected && <button disabled={busy} onClick={() => void act(refresh)}>重试加载</button>}</div>}
    {!selected && notice && <p className="material-feedback" role="status">{notice}</p>}
    {selected ? <section className="material-preview-page" aria-label={`预览 ${selected.title}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (confirmDelete) setConfirmDelete(false); else if (!busy) select(null); } }}>
      <header className="material-preview-header" inert={confirmDelete}><button type="button" autoFocus aria-label="返回资料夹" disabled={busy} onClick={() => { select(null); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button><h2 title={selected.title}>{selected.title}</h2><button type="button" className="material-preview-delete" aria-label="删除这份资料" disabled={busy} onClick={() => setConfirmDelete(true)}><img src={uiAsset("materials/delete.svg")} width="19" height="19" alt="" /></button></header>
      {error && <div className="material-feedback material-feedback--error" role="alert">{error}</div>}
      {notice && <p className="material-feedback" role="status">{notice}</p>}
      <div className={`material-preview-scroll ${selected.kind === 'image' || fileType(selected.filename) === 'PDF' ? 'material-preview-scroll--visual' : ''}`} inert={confirmDelete}>
      <div className={`material-preview-content material-preview-content--${selected.kind}`}>
        {selected.kind === 'image' ? <img src={selected.url} alt={selected.title} /> : fileType(selected.filename) === 'PDF' ? <PdfPreview key={selected.id} item={selected} /> : selected.text ? <article><small>文字预览</small><pre>{selected.text}</pre></article> : <div className="material-empty"><p>这份文档暂不支持页内预览</p><a href={selected.url} target="_blank" rel="noreferrer">打开原件</a></div>}
      </div>
      <div className="material-detail-meta"><span>{fileType(selected.filename)} · {fileSize(selected.size)}</span><a href={selected.url} target="_blank" rel="noreferrer">打开原件 ↗</a></div>

      </div>
      <div className="material-preview-footer" inert={confirmDelete}><button className="material-fox-chat" disabled={busy || disabled} onClick={() => onChat(selected)}><span>和令狸聊聊</span><span className="material-fox-portrait" aria-hidden="true"><img src={uiAsset('lingli-chat-wave.webp')} alt="" /></span></button></div>
      {confirmDelete && <div className="material-delete-shade"><div className="material-delete-confirm" role="alertdialog" aria-modal="true" aria-label="确认删除资料">{error && <p role="alert">{error}</p>}<p>确定删除「{selected.title}」？删除后将无法查看原文件或重新读取其内容，已有对话记录仍会保留。</p><button autoFocus className="material-danger" disabled={busy} onClick={() => void act(async () => { await request(`/${selected.id}`, { method: 'DELETE', signal: abort.current?.signal ?? null }); setItems(previous => previous.filter(item => item.id !== selected.id)); select(null); setNotice('资料已删除'); })}>确认删除</button><button disabled={busy} onClick={() => setConfirmDelete(false)}>保留资料</button></div></div>}
    </section> : <>
      <input ref={input} hidden type="file" multiple disabled={busy || loading} accept={ACCEPT} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void uploadFiles(files); }} />
      {!!uploads.length && <div className="material-upload-queue" aria-live="polite">{uploads.map(entry => <div key={entry.id} className={`material-upload-entry material-upload-entry--${entry.status === 'done' && entry.completedAt === undefined ? 'retained' : entry.status}`}><span className="material-upload-filename" title={entry.file.name}>{entry.file.name}</span><span>{entry.status === 'done' ? entry.result?.uploadOutcome === 'duplicate' ? '这份文件已经在资料夹里了' : entry.result?.uploadOutcome === 'renamed' ? `已有同名文件，已另存为「${entry.result.filename}」` : '已收好 ✓' : entry.status === 'uploading' ? '上传并整理中…' : entry.status === 'waiting' ? '等待上传' : '上传失败'}</span>{entry.result && entry.completedAt === undefined && <><button disabled={busy} onClick={() => select(entry.result!)}>打开资料</button><button onClick={() => setUploads(previous => previous.filter(value => value.id !== entry.id))}>知道了</button></>}{entry.error && <small>{entry.error}</small>}{entry.status === 'failed' && <button disabled={busy} onClick={() => void uploadFiles([entry.file], entry.id)}>重试</button>}</div>)}</div>}

      <div className={`material-results ${leaving ? 'is-leaving' : ''}`} aria-busy={leaving}>
      {loading ? <p className="material-empty" role="status">正在打开资料夹…</p> : !visible.length && <div className="material-empty"><span aria-hidden="true">▱</span><strong>{items.length ? '没有找到这份资料' : '从一张照片、一封信开始'}</strong><p>{items.length ? '换个文件名，或看看其他类型。' : '放进来，等你想起它的故事时，我们慢慢聊。'}</p></div>}
      <div className="material-grid" key={`${display.filter}-${display.query}`} inert={leaving || !!actions}>{visible.map((item, index) => <FileCard key={item.id} item={item} index={index} disabled={busy || leaving} onChoose={select} onActions={openActions} />)}</div>
      </div>
      <nav inert={!!actions} className="material-dock" aria-label="资料夹操作"><div className="material-filters" aria-label="资料类型" style={{ '--tab-index': ['all', 'image', 'document'].indexOf(filter) } as CSSProperties}><span className="material-glass-thumb" aria-hidden="true" />{(['all', 'image', 'document'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : value === 'image' ? '照片' : '文档'}</button>)}</div><button className="material-add" aria-label={busy ? '正在上传资料' : '添加资料'} title="添加资料" disabled={busy || loading} onClick={() => input.current?.click()}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button></nav>
    </>}
    {actionSheet}
  </div>;
}

import { useEffect, useState } from 'react';
import type { PanelDocument } from '@bio/contracts';
import { DocumentReader } from './document-reader';
import { uiAsset } from './ui-asset';
import './material-folder.css';
import './manuscript-folder.css';

type Entry = { conversationId: string; id: string; title: string; version: number };
export function ManuscriptFolder({ onChat, disabled = false }: { onChat?: ((document: PanelDocument) => void) | undefined; disabled?: boolean }) {
  const [items, setItems] = useState<Entry[]>([]);
  const [document, setDocument] = useState<PanelDocument>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Entry>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setDocument(undefined);
    const token = sessionStorage.getItem('bio-auth-token');
    const path = selected ? `/${encodeURIComponent(selected.conversationId)}/${encodeURIComponent(selected.id)}` : '';
    void fetch(`/api/v1/agent/manuscripts${path}`, { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async response => { if (!response.ok) throw new Error('暂时无法读取文稿，请重试。'); return response.json(); })
      .then(value => { if (!controller.signal.aborted) { if (selected) setDocument(value); else setItems(value); } })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected, attempt]);
  const status = <>
    {loading && <p className="material-empty" role="status">正在读取文稿…</p>}
    {error && <div className="material-empty" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
  </>;
  return <div className="material-folder manuscript-folder">
    {selected ? <section className="material-preview-page manuscript-preview" aria-label="文稿详情" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSelected(undefined); } }}>
      <header className="material-preview-header"><button type="button" autoFocus aria-label="返回文稿集" onClick={() => setSelected(undefined)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button><h2 title={selected.title}>{selected.title}</h2></header>
      <div className="material-preview-scroll">
        {status}
        {!loading && !error && document && <article className="manuscript-paper"><DocumentReader document={document} /></article>}
      </div>
      {!loading && !error && document && onChat && <footer className="material-preview-footer"><button type="button" className="material-fox-chat" disabled={disabled} onClick={() => onChat(document)}><span>和令狸聊聊这篇</span><span className="material-fox-portrait" aria-hidden="true"><img src={uiAsset('lingli-chat-wave.webp')} alt="" /></span></button></footer>}
    </section> : <>
      {status}
      {!loading && !error && (items.length ? <div className="material-grid">{items.map((item, index) => <button type="button" className="material-card" key={`${item.conversationId}/${item.id}`} style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }} aria-label={`阅读 ${item.title}`} onClick={() => setSelected(item)}>
        <span className="material-cover material-cover--paper">
          <span className="material-paper-content" aria-hidden="true"><span className="material-paper-sprig"><i /><i /><i /><i /><i /></span><span className="manuscript-cover-title">{item.title}</span><span className="material-paper-lines" /></span>
          <span className="material-cover-caption"><span>文稿</span><span>版本 {item.version}</span></span>
        </span>
        <span className="material-card-title" title={item.title}>{item.title}</span>
      </button>)}</div> : <div className="material-empty manuscript-empty"><span className="material-paper-sprig" aria-hidden="true"><i /><i /><i /><i /><i /></span><strong>故事，慢慢写下来</strong><p>还没有已保存的文稿。<br />和令狸聊聊，请它帮你整理成篇。</p></div>)}
    </>}
  </div>;
}

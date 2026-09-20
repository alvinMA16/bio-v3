import { useEffect, useState } from 'react';
import type { PanelDocument } from '@bio/contracts';
import { DocumentReader } from './document-reader';

type Entry = { conversationId: string; id: string; title: string; version: number };
export function ManuscriptFolder({ onChat }: { onChat?: ((document: PanelDocument) => void) | undefined }) {
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
  return <div className="manuscript-folder">
    {selected && <button type="button" onClick={() => setSelected(undefined)}>返回文稿列表</button>}
    {loading && <p role="status">正在读取文稿…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
    {!loading && !error && !selected && (items.length ? items.map(item => <button type="button" key={`${item.conversationId}/${item.id}`} onClick={() => setSelected(item)}>{item.title}<small>已保存草稿 · 版本 {item.version}</small></button>) : <p>还没有已保存的文稿。通话中可以请令狸帮你整理。</p>)}
    {document && <article><DocumentReader document={document} /><small>已保存文稿 · 版本 {document.version}</small>
      {onChat && <button type="button" onClick={() => onChat(document)}>和令狸一起看这篇</button>}</article>}
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import type { PanelAttachment } from '@bio/contracts';
import { useMaterialOriginal } from './use-material-original';
import './attachment-viewer.css';
export function AttachmentViewer({ attachment, onPage }: { attachment: PanelAttachment; onPage?: ((materialId: string, page: number) => void) | undefined }) {
  const pageCallback = useRef(onPage); pageCallback.current = onPage;
  const original = useMaterialOriginal(attachment);
  const { id, material } = original;
  const [page, setPage] = useState(1), [count, setCount] = useState(0);
  const [image, setImage] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [pageStatus, setPageStatus] = useState<PanelAttachment['originalStatus']>();
  const originalStatus = original.originalStatus ?? pageStatus;
  useEffect(() => {
    setPage(1); setCount(0); setImage(''); setError(''); setPageStatus(undefined); setLoading(false);
  }, [id, material]);
  useEffect(() => {
    if (!material || material.id !== id) return;
    const controller = new AbortController(); setLoading(true); setError(''); setImage('');
    if (material.kind === 'image') { setImage(material.url); setLoading(false); setCount(1); return; }
    if (material.mimeType === 'text/plain') { setLoading(false); setCount(1); return; }
    fetch(`/api/v1/materials/${material.id}/pages/${page}`, { signal: controller.signal }).then(async response => {
      if (response.status === 410 || response.status === 404) { if (!controller.signal.aborted) setPageStatus(response.status === 410 ? 'deleted' : 'unavailable'); return; }
      if (!response.ok) throw new Error(); return response.json() as Promise<{ image: string; pageCount: number }>;
    })
      .then(value => { if (value && !controller.signal.aborted) { setImage(value.image); setCount(value.pageCount); } })
      .catch(() => { if (!controller.signal.aborted) setError('这一页暂时无法预览'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [material, id, page]);
  useEffect(() => { if (id && image && !loading && !originalStatus) pageCallback.current?.(id, page); }, [id, image, loading, page, originalStatus]);
  return <section className="attachment-viewer" aria-label="资料预览">
    <header className="attachment-heading"><h3 title={attachment.title}>{attachment.title}</h3></header>
    <div className="attachment-viewer-stage" aria-busy={loading} aria-label="文件预览">
      {originalStatus ? <div role="status"><p>{originalStatus === 'deleted' ? '原文件已删除' : '原文件不可用'}</p><p>已有对话仍保留，可以继续聊。查看或核对原文需重新上传。</p></div> : loading || original.loading ? <p role="status">正在展开资料…</p> : error || original.error ? <div role="alert">{error || original.error}<button onClick={original.retry}>重试</button></div> : image ? <img draggable={false} src={image} alt={`${attachment.title}，第 ${page} 页`} onError={() => {
        setError('原件加载失败，请重试');
        if (id) void fetch(`/api/v1/materials/${id}`).then(response => { if (response.status === 410 || response.status === 404) original.retry(); }).catch(() => {});
      }} /> : <pre>{material?.text || '暂无预览内容'}</pre>}
    </div>
    {!originalStatus && count > 1 && <nav className="attachment-pages" aria-label="文件翻页"><button type="button" aria-label="上一页" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button><span aria-live="polite" aria-label={`第 ${page} 页，共 ${count} 页`}><b>{page}</b><i aria-hidden="true">/</i>{count}</span><button type="button" aria-label="下一页" disabled={page === count || loading} onClick={() => setPage(value => value + 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button></nav>}
  </section>;
}

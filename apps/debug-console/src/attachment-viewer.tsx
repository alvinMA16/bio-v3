import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Material, PanelAttachment } from '@bio/contracts';
import './attachment-viewer.css';
import { boundZoom } from './zoom-geometry';

/** Transform stays anchored to the gesture midpoint; panning is bounded by the fitted image. */
export function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const stage = useRef<HTMLDivElement>(null), img = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pose = useRef({ scale: 1, x: 0, y: 0 });
  const gesture = useRef({ x: 0, y: 0, distance: 0 });
  const [view, setView] = useState(pose.current);
  const lastTap = useRef(0), down = useRef({ x: 0, y: 0, moved: false });
  function apply(next: typeof view) {
    const box = stage.current, image = img.current;
    if (!box || !image || !image.naturalWidth) return;
    pose.current = boundZoom(next, { width: box.clientWidth, height: box.clientHeight }, { width: image.naturalWidth, height: image.naturalHeight });
    setView(pose.current);
  }
  function metrics() {
    const values = [...pointers.current.values()];
    const a = values[0]!, b = values[1] ?? a;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: values.length > 1 ? Math.hypot(a.x - b.x, a.y - b.y) : 0 };
  }
  function toggleZoom(x = 0, y = 0) { const old = pose.current; const scale = old.scale > 1 ? 1 : 2.5; const ratio = scale / old.scale; apply({ scale, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio }); }
  function point(event: PointerEvent) { const box = stage.current!.getBoundingClientRect(); return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }; }
  function end(event: PointerEvent) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size) { gesture.current = metrics(); return; }
    if (event.type === 'pointerup' && !down.current.moved) {
      if (Date.now() - lastTap.current < 300) { const p = point(event); toggleZoom(p.x, p.y); lastTap.current = 0; }
      else lastTap.current = Date.now();
    }
  }
  useEffect(() => {
    pose.current = { scale: 1, x: 0, y: 0 }; setView(pose.current); pointers.current.clear();
  }, [src]);
  useEffect(() => { const observer = new ResizeObserver(() => apply(pose.current)); if (stage.current) observer.observe(stage.current); return () => observer.disconnect(); }, []);
  return <div className="attachment-zoom" ref={stage} onPointerDown={event => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, point(event)); gesture.current = metrics();
    down.current = { ...point(event), moved: pointers.current.size > 1 };
  }} onPointerMove={event => {
    if (!pointers.current.has(event.pointerId)) return;
    const p = point(event); if (Math.hypot(p.x - down.current.x, p.y - down.current.y) > 5) down.current.moved = true;
    pointers.current.set(event.pointerId, p); const next = metrics(), previous = gesture.current, old = pose.current;
    const scale = Math.max(1, Math.min(4, previous.distance > 0 && next.distance > 0 ? old.scale * next.distance / previous.distance : old.scale));
    const ratio = scale / old.scale;
    apply({ scale, x: next.x - (previous.x - old.x) * ratio, y: next.y - (previous.y - old.y) * ratio }); gesture.current = next;
  }} onPointerUp={end} onPointerCancel={event => { down.current.moved = true; end(event); }} onLostPointerCapture={event => { pointers.current.delete(event.pointerId); if (pointers.current.size) gesture.current = metrics(); }}>
    <img ref={img} src={src} alt={alt} draggable={false} onLoad={() => apply(pose.current)} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    <button className="attachment-zoom-reset" type="button" aria-label={view.scale > 1 ? '恢复整页' : '放大文件'} onPointerDown={event => event.stopPropagation()} onClick={() => toggleZoom()}>{view.scale > 1 ? '恢复整页' : '放大'}</button>
  </div>;
}

export function AttachmentViewer({ attachment, focused, onFocus, onPage }: { attachment: PanelAttachment; focused: boolean; onFocus: () => void; onPage?: ((materialId: string, page: number) => void) | undefined }) {
  const pageCallback = useRef(onPage); pageCallback.current = onPage;
  const id = attachment.url?.match(/\/api\/v1\/materials\/([0-9a-f-]{36})\/file$/)?.[1];
  const [material, setMaterial] = useState<Material>();
  const [page, setPage] = useState(1), [count, setCount] = useState(0);
  const [image, setImage] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setMaterial(undefined); setPage(1); setCount(0); setImage(''); setError(''); setLoading(true);
    if (!id) { setError('此附件暂不支持页面预览'); setLoading(false); return; }
    fetch(`/api/v1/materials/${id}`, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<Material>; })
      .then(value => { if (!controller.signal.aborted) setMaterial(value); }).catch(() => { if (!controller.signal.aborted) { setError('资料加载失败'); setLoading(false); } });
    return () => controller.abort();
  }, [id, retry]);
  useEffect(() => {
    if (!material || material.id !== id) return;
    const controller = new AbortController(); setLoading(true); setError(''); setImage('');
    if (material.kind === 'image') { setImage(material.url); setLoading(false); setCount(1); return; }
    if (material.mimeType === 'text/plain') { setLoading(false); setCount(1); return; }
    fetch(`/api/v1/materials/${material.id}/pages/${page}`, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<{ image: string; pageCount: number }>; })
      .then(value => { if (!controller.signal.aborted) { setImage(value.image); setCount(value.pageCount); } })
      .catch(() => { if (!controller.signal.aborted) setError('这一页暂时无法预览'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [material, id, page]);
  useEffect(() => { if (id && image && !loading) pageCallback.current?.(id, page); }, [id, image, loading, page]);
  return <section className="attachment-viewer" aria-label="资料预览">
    <div className="attachment-viewer-stage" aria-busy={loading}>
      {loading ? <p role="status">正在展开资料…</p> : error ? <div role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></div> : image ? <ZoomImage src={image} alt={`${attachment.title}，第 ${page} 页`} /> : <pre>{material?.text || '暂无预览内容'}</pre>}
    </div>
    {count > 1 && <nav className="attachment-pages" aria-label="文件翻页"><button aria-label="上一页" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>‹</button><span aria-live="polite">{page} / {count}</span><button aria-label="下一页" disabled={page === count || loading} onClick={() => setPage(value => value + 1)}>›</button></nav>}
    <div className="attachment-filebar"><span title={attachment.title}>{attachment.title}</span><button onClick={onFocus} aria-pressed={focused}>{focused ? '退出专注' : '专注查看'}</button></div>
  </section>;
}

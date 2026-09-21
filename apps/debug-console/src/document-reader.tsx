import { useEffect, useRef } from 'react';
import { documentPages, type DocumentView, type PanelDocument } from '@bio/contracts';

// Small inline spans let us report visible text without changing paragraph layout.
function textSpans(text: string, blockId: string, base = 0) {
  let offset = base;
  const characters = Array.from(text);
  return Array.from({ length: Math.ceil(characters.length / 80) }, (_, index) => {
    const part = characters.slice(index * 80, (index + 1) * 80).join('');
    const start = offset; offset += part.length;
    return <span key={start} data-block={blockId} data-start={start} data-end={offset}>{part}</span>;
  });
}

function listItems(text: string, blockId: string) {
  let offset = 0;
  return text.split('\n').map((line, index) => {
    const start = offset; offset += line.length + 1;
    return <li key={index}>{textSpans(line, blockId, start)}</li>;
  });
}

export function DocumentReader({ document, view, onView }: {
  document: PanelDocument; view?: DocumentView | undefined;
  onView?: ((view: DocumentView) => void) | undefined;
}) {
  const content = useRef<HTMLElement>(null);
  const following = useRef(true);
  const current = useRef({ document, view, onView }); current.current = { document, view, onView };
  const report = useRef<() => void>(() => {});
  useEffect(() => {
    const root = content.current;
    const scroller = root?.closest<HTMLElement>('.phone-panel-scroll');
    if (!root || !scroller) return;
    following.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    let pointerActive = false;
    const publish = () => {
      clearTimeout(timer);
      const { document, view, onView } = current.current;
      const bounds = scroller.getBoundingClientRect();
      const visibleRanges: NonNullable<DocumentView['visibleRanges']> = [];
      for (const span of root.querySelectorAll<HTMLElement>('[data-block]')) {
        if (!Array.from(span.getClientRects()).some(rect => rect.bottom > bounds.top && rect.top < bounds.bottom)) continue;
        const blockId = span.dataset.block!, start = Number(span.dataset.start), end = Number(span.dataset.end);
        const previous = visibleRanges.at(-1);
        if (previous?.blockId === blockId) previous.end = end;
        else visibleRanges.push({ blockId, start, end });
      }
      const next: DocumentView = { documentId: document.id, version: document.version,
        page: view?.page ?? 1, visibleRanges: visibleRanges.slice(0, 100), following: following.current };
      const serialized = JSON.stringify(next);
      if (serialized !== last) { last = serialized; onView?.(next); }
    };
    report.current = publish;
    const scroll = () => { if (pointerActive) following.current = false; clearTimeout(timer); timer = setTimeout(publish, 180); };
    const pointerDown = () => { pointerActive = true; };
    const pointerUp = () => { pointerActive = false; };
    const manual = () => { following.current = false; scroll(); };
    const key = (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) manual();
    };
    scroller.addEventListener('scroll', scroll, { passive: true });
    scroller.addEventListener('wheel', manual, { passive: true });
    scroller.addEventListener('touchmove', manual, { passive: true });
    scroller.addEventListener('pointerdown', pointerDown); // Track scrollbar drags without treating taps as scrolls.
    window.addEventListener('pointerup', pointerUp); window.addEventListener('pointercancel', pointerUp);
    scroller.addEventListener('keydown', key);
    window.addEventListener('bio:document-view-request', publish);
    const resize = new ResizeObserver(scroll); resize.observe(scroller); resize.observe(root);
    publish();
    return () => {
      clearTimeout(timer); resize.disconnect();
      scroller.removeEventListener('scroll', scroll); scroller.removeEventListener('wheel', manual);
      scroller.removeEventListener('touchmove', manual); scroller.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointerup', pointerUp); window.removeEventListener('pointercancel', pointerUp);
      scroller.removeEventListener('keydown', key); window.removeEventListener('bio:document-view-request', publish);
      report.current = () => {};
    };
  }, [document.id]);
  useEffect(() => {
    const root = content.current;
    const scroller = root?.closest<HTMLElement>('.phone-panel-scroll');
    if (view?.followRequest !== undefined) following.current = true;
    if (root && scroller && following.current) {
      const anchor = documentPages(document)[(view?.page ?? 1) - 1]?.fragments[0];
      const target = anchor && Array.from(root.querySelectorAll<HTMLElement>('[data-block]')).find(span =>
        span.dataset.block === anchor.blockId && Number(span.dataset.end) > anchor.start);
      if (target && (view?.page ?? 1) > 1) {
        scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      } else scroller.scrollTop = 0;
    }
    report.current();
  }, [document.id, view?.page, view?.followRequest]);
  useEffect(() => { report.current(); }, [document.version]);
  return <section className="document-reader" ref={content} aria-label="文稿阅读">
    <header className="document-heading"><h3>{document.title}</h3><small>已保存 · 版本 {document.version}</small></header>
    {document.blocks.filter((block, index) => !(index === 0 && block.kind === 'heading' && block.text.trim() === document.title.trim())).map(block =>
      <section key={block.id} className="panel-block">
        {block.kind === 'heading' ? <h4>{textSpans(block.text, block.id)}</h4>
          : block.kind === 'quote' ? <blockquote>{textSpans(block.text, block.id)}</blockquote>
          : block.kind === 'list' ? <ul>{listItems(block.text, block.id)}</ul>
          : block.kind === 'code' ? <pre><code>{textSpans(block.text, block.id)}</code></pre>
          : <p style={{ whiteSpace: 'pre-wrap' }}>{textSpans(block.text, block.id)}</p>}
      </section>)}
  </section>;
}

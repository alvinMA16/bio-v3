import { useEffect, useRef, useState } from 'react';
import { documentPages, documentTextSegments, type DocumentNavigationReceipt, type DocumentRange, type DocumentView, type PanelDocument } from '@bio/contracts';
import { navigateDocumentFocus } from './document-navigation';
import './document-highlight.css';

// Small inline spans let us report visible text without changing paragraph layout.
function textSpans(text: string, blockId: string, ranges: DocumentRange[], base = 0) {
  return documentTextSegments(text, blockId, ranges, base).map(part =>
    <span key={part.start} data-block={blockId} data-start={part.start} data-end={part.end}>
      {part.highlighted ? <mark className="document-highlight">{part.text}</mark> : part.text}
    </span>);
}

function listItems(text: string, blockId: string, ranges: DocumentRange[]) {
  let offset = 0;
  return text.split('\n').map((line, index) => {
    const start = offset; offset += line.length + 1;
    return <li key={index}>{textSpans(line, blockId, ranges, start)}</li>;
  });
}

export function DocumentReader({ document, view, onView }: {
  document: PanelDocument; view?: DocumentView | undefined;
  onView?: ((view: DocumentView) => void) | undefined;
}) {
  const [dismissed, setDismissed] = useState<string>();
  const highlight = view?.version === document.version && view.highlight?.requestId !== dismissed ? view.highlight : undefined;
  const ranges = highlight?.ranges ?? [];
  const titleBlock = document.blocks[0]?.kind === 'heading' && document.blocks[0].text.trim() === document.title.trim() ? document.blocks[0] : undefined;
  const content = useRef<HTMLElement>(null);
  const following = useRef(true);
  const lastNavigation = useRef<{ documentId: string; page: number; followRequest?: number | undefined; focusId?: string | undefined } | undefined>(undefined);
  const current = useRef({ document, view, onView }); current.current = { document, view, onView };
  const receipt = useRef<DocumentNavigationReceipt | undefined>(undefined);
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
        page: view?.page ?? 1, visibleRanges: visibleRanges.slice(0, 100), following: following.current,
        ...(receipt.current && receipt.current.requestId === view?.focus?.requestId ? { navigation: receipt.current } : {}) };
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
    const previous = lastNavigation.current;
    const navigation = { documentId: document.id, page: view?.page ?? 1, followRequest: view?.followRequest, focusId: view?.focus?.requestId };
    lastNavigation.current = navigation;
    const resume = navigation.followRequest !== undefined && navigation.followRequest !== previous?.followRequest;
    const focusRequested = navigation.focusId !== undefined && navigation.focusId !== receipt.current?.requestId;
    if (resume) following.current = true;
    if (root && view?.focus && focusRequested) {
      receipt.current = undefined;
      return navigateDocumentFocus(root, view.focus, value => { receipt.current = value; report.current(); });
    }
    if (previous?.documentId === document.id && previous.page === navigation.page && !resume) return;
    if (root && scroller && following.current) {
      const anchor = documentPages(document)[(view?.page ?? 1) - 1]?.fragments[0];
      const target = anchor && Array.from(root.querySelectorAll<HTMLElement>('[data-block]')).find(span =>
        span.dataset.block === anchor.blockId && Number(span.dataset.end) > anchor.start);
      if (target && (view?.page ?? 1) > 1) {
        scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      } else scroller.scrollTop = 0;
    }
    report.current();
  }, [document.id, document.version, view?.page, view?.followRequest, view?.focus?.requestId]);
  useEffect(() => { report.current(); }, [document.version]);
  return <section className={`document-reader document-reader--${highlight?.kind ?? 'plain'}`} ref={content} aria-label="文稿阅读">
    <header className="document-heading"><h3>{titleBlock ? textSpans(titleBlock.text, titleBlock.id, ranges) : document.title}</h3><small>已保存 · 版本 {document.version}</small></header>
    {highlight && <aside className="document-highlight-note" aria-label="文稿标记">
      <span><i aria-hidden="true" />{highlight.kind === 'focus' ? '已标出你要找的片段' : highlight.ranges.length ? '已标出本次文字改动' : highlight.deletions?.length ? '本次移除了文字' : '本次未标记正文文字'}</span>
      <button type="button" aria-label="清除高亮" onClick={() => setDismissed(highlight.requestId)}>清除</button>
      {!!highlight.deletions?.length && <details><summary>查看移除的文字</summary><div>{highlight.deletions.map((item, index) => <del key={index}>{item.text}</del>)}</div></details>}
      {highlight.notice && <small>{highlight.notice}</small>}
    </aside>}
    {document.blocks.filter((block, index) => !(index === 0 && block.kind === 'heading' && block.text.trim() === document.title.trim())).map(block =>
      <section key={block.id} className="panel-block">
        {block.kind === 'heading' ? <h4>{textSpans(block.text, block.id, ranges)}</h4>
          : block.kind === 'quote' ? <blockquote>{textSpans(block.text, block.id, ranges)}</blockquote>
          : block.kind === 'list' ? <ul>{listItems(block.text, block.id, ranges)}</ul>
          : block.kind === 'code' ? <pre><code>{textSpans(block.text, block.id, ranges)}</code></pre>
          : <p style={{ whiteSpace: 'pre-wrap' }}>{textSpans(block.text, block.id, ranges)}</p>}
      </section>)}
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { documentPages, type DocumentView, type PanelBlock, type PanelDocument } from '@bio/contracts';

export function DocumentReader({ document, view, navigationKey = 0, onView, onSelectBlock, selectedBlockId }: {
  document: PanelDocument; view?: DocumentView | undefined; navigationKey?: number; onView?: ((view: DocumentView, manual: boolean) => void) | undefined;
  onSelectBlock?: ((block: PanelBlock) => void) | undefined; selectedBlockId?: string | undefined;
}) {
  const [manual, setManual] = useState<{ key: string; page: number }>();
  const [selection, setSelection] = useState<{ key: string; blockId: string }>();
  const pages = documentPages(document);
  const key = `${document.id}:${document.version}:${view?.page ?? 1}:${navigationKey}`;
  const page = Math.max(1, Math.min(manual?.key === key ? manual.page : view?.page ?? 1, pages.length));
  const selectionKey = `${key}:${page}`;
  const activeBlockId = selection?.key === selectionKey ? selection.blockId : undefined;
  const callback = useRef(onView); callback.current = onView;
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    callback.current?.({ documentId: document.id, version: document.version, page }, manual?.key === key);
    content.current?.closest('.phone-panel-scroll')?.scrollTo({ top: 0 });
  }, [document.id, document.version, page]);
  return <section className="document-reader" ref={content} aria-label="文稿阅读">
    <header className="document-heading"><h3>{document.title}</h3><small>已保存 · 版本 {document.version}</small></header>
    {pages[page - 1]!.fragments.filter(fragment => !(fragment.kind === 'heading' && fragment.blockId === document.blocks[0]?.id && fragment.text.trim() === document.title.trim())).map((fragment, index) => <section key={`${fragment.blockId}:${fragment.start}`} className={`panel-block ${activeBlockId === fragment.blockId ? 'panel-block--selected' : ''}`}>
      {fragment.kind === 'heading' ? <h4>{fragment.text}</h4>
        : fragment.kind === 'quote' ? <blockquote>{fragment.text}</blockquote>
        : fragment.kind === 'list' ? <ul>{fragment.text.split('\n').map((line, index) => <li key={index}>{line}</li>)}</ul>
        : fragment.kind === 'code' ? <pre><code>{fragment.text}</code></pre>
        : <p style={{ whiteSpace: 'pre-wrap' }}>{fragment.text}</p>}
      {onSelectBlock && <button type="button" className="document-select-block" aria-label={`选择第 ${index + 1} 段`} aria-pressed={activeBlockId === fragment.blockId}
        onClick={() => setSelection({ key: selectionKey, blockId: activeBlockId === fragment.blockId ? '' : fragment.blockId })} />}
      {onSelectBlock && activeBlockId === fragment.blockId && <div className="document-block-action"><button type="button"
        onClick={() => onSelectBlock(document.blocks.find(block => block.id === fragment.blockId)!)}>和令狸改这段</button>
        {selectedBlockId === fragment.blockId && <small role="status">已选中，请告诉令狸怎么改</small>}</div>}
    </section>)}
    <nav className="document-pagination" aria-label="文稿翻页">
      <button type="button" disabled={page <= 1} onClick={() => setManual({ key, page: page - 1 })}>上一页</button>
      <span aria-live="polite">第 {page} / {pages.length} 页</span>
      <button type="button" disabled={page >= pages.length} onClick={() => setManual({ key, page: page + 1 })}>下一页</button>
    </nav>
  </section>;
}

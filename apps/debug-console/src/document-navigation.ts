import type { DocumentNavigationReceipt, DocumentView } from '@bio/contracts';

/** A focus request is complete only after layout confirms the target is visible. */
export function navigateDocumentFocus(root: HTMLElement, focus: NonNullable<DocumentView['focus']>,
  complete: (receipt: DocumentNavigationReceipt) => void): () => void {
  let attempts = 0, frame = 0, timer = 0, deadline = 0, stopped = false;
  let reason: 'target_missing' | 'not_visible' = 'target_missing';
  const scroller = () => root.closest<HTMLElement>('.phone-panel-scroll');
  const before = Math.max(0, scroller()?.scrollTop ?? 0);
  const surface = scroller() ?? root;
  const target = () => Array.from(root.querySelectorAll<HTMLElement>('[data-block]')).find(span =>
    span.dataset.block === focus.blockId && Number(span.dataset.start) <= focus.start && Number(span.dataset.end) > focus.start);
  const cleanup = () => {
    stopped = true; cancelAnimationFrame(frame); window.clearTimeout(timer); window.clearTimeout(deadline);
    surface.removeEventListener('wheel', interrupt); surface.removeEventListener('touchmove', interrupt);
    surface.removeEventListener('pointerdown', interrupt); surface.removeEventListener('keydown', key);
  };
  const finish = (status: DocumentNavigationReceipt['status'], failure?: DocumentNavigationReceipt['reason']) => {
    if (stopped) return;
    cleanup(); complete({ requestId: focus.requestId, status, ...(failure ? { reason: failure } : {}), attempts,
      scrollBefore: before, scrollAfter: Math.max(0, scroller()?.scrollTop ?? 0) });
  };
  const interrupt = () => finish('failed', 'user_interrupted');
  const key = (event: KeyboardEvent) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) interrupt(); };
  const retry = () => {
    if (attempts >= 6) finish('failed', reason);
    else timer = window.setTimeout(attempt, 100);
  };
  const attempt = () => {
    if (stopped) return;
    attempts++;
    const scroll = scroller(), span = target();
    if (!scroll || !span || !scroll.clientHeight || !span.getClientRects().length) { reason = 'target_missing'; retry(); return; }
    reason = 'not_visible';
    scroll.scrollTop += span.getBoundingClientRect().top - scroll.getBoundingClientRect().top - Math.min(80, scroll.clientHeight * .2);
    frame = requestAnimationFrame(() => {
      if (stopped) return;
      const bounds = scroll.getBoundingClientRect();
      const visible = Array.from(target()?.getClientRects() ?? []).some(rect => rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom);
      if (visible) finish('visible'); else retry();
    });
  };
  surface.addEventListener('wheel', interrupt, { passive: true }); surface.addEventListener('touchmove', interrupt, { passive: true });
  surface.addEventListener('pointerdown', interrupt); surface.addEventListener('keydown', key);
  // Timeout also covers background tabs where animation frames stop running.
  deadline = window.setTimeout(() => finish('failed', reason), 1200);
  frame = requestAnimationFrame(attempt);
  return cleanup;
}

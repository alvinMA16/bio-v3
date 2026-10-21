import type { DocumentNarrationPosition, PanelDocument } from '@bio/contracts';
import { documentViewport } from './document-viewport.ts';

/** Follow audible original-text positions; gestures temporarily own the viewport. */
export function followDocumentNarration(root: HTMLElement, getDocument: () => PanelDocument,
  following: (value: boolean) => void) {
  const scroller = root.closest<HTMLElement>('.phone-panel-scroll');
  let position: DocumentNarrationPosition | undefined;
  let browsing = false, pointerHeld = false, touchHeld = false, frame = 0;
  const held = () => pointerHeld || touchHeld;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const matches = () => {
    const document = getDocument();
    return !!position && position.documentId === document.id && position.version === document.version;
  };
  const follow = () => {
    if (!scroller || !matches() || held() || browsing) return;
    const span = Array.from(root.querySelectorAll<HTMLElement>('[data-block]')).find(element =>
      element.dataset.block === position!.blockId && Number(element.dataset.start) <= position!.start
      && Number(element.dataset.end) > position!.start);
    // Use the first rendered line, including when the span wraps over several lines.
    const rect = span?.getClientRects()[0], bounds = documentViewport(scroller);
    const height = bounds.bottom - bounds.top;
    if (!rect || height <= 0) return;
    following(true);
    if (rect.top >= bounds.top + 12 && rect.bottom <= bounds.top + height * .7) return;
    scroller.scrollTo({ top: scroller.scrollTop + rect.top - bounds.top - height * .3,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(follow); };
  const settle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (held()) return;
      browsing = false;
      if (matches()) schedule();
    }, 220);
  };
  const manual = () => {
    browsing = true; following(false); cancelAnimationFrame(frame);
    // Stop an in-flight smooth scroll as soon as the user takes control.
    scroller?.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
    settle();
  };
  const scroll = () => { if (held() && !browsing) manual(); else if (browsing) settle(); };
  const hold = () => { clearTimeout(idle); cancelAnimationFrame(frame); };
  const down = () => { pointerHeld = true; hold(); };
  const up = () => { if (!pointerHeld) return; pointerHeld = false; settle(); };
  const touchDown = () => { touchHeld = true; hold(); };
  const touchUp = () => { if (!touchHeld) return; touchHeld = false; settle(); };
  const key = (event: KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) manual();
  };
  const narration = (event: Event) => {
    const wasFollowing = matches();
    position = (event as CustomEvent<DocumentNarrationPosition | undefined>).detail;
    if (!matches()) {
      cancelAnimationFrame(frame);
      if (wasFollowing) scroller?.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
      return;
    }
    schedule();
  };
  document.addEventListener('bio:document-narration', narration);
  scroller?.addEventListener('scroll', scroll, { passive: true });
  scroller?.addEventListener('wheel', manual, { passive: true });
  scroller?.addEventListener('touchmove', manual, { passive: true });
  scroller?.addEventListener('pointerdown', down);
  scroller?.addEventListener('touchstart', touchDown, { passive: true });
  scroller?.addEventListener('keydown', key);
  window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  window.addEventListener('touchend', touchUp); window.addEventListener('touchcancel', touchUp);
  const resize = new ResizeObserver(schedule); resize.observe(root); if (scroller) resize.observe(scroller);
  return {
    active: () => matches() || held() || browsing,
    cleanup: () => {
      clearTimeout(idle); cancelAnimationFrame(frame); resize.disconnect();
      document.removeEventListener('bio:document-narration', narration);
      scroller?.removeEventListener('scroll', scroll); scroller?.removeEventListener('wheel', manual);
      scroller?.removeEventListener('touchmove', manual); scroller?.removeEventListener('pointerdown', down);
      scroller?.removeEventListener('touchstart', touchDown); scroller?.removeEventListener('keydown', key);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchend', touchUp); window.removeEventListener('touchcancel', touchUp);
    },
  };
}

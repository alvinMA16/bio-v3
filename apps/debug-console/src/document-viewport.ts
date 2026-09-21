/** Exclude the floating glass dock: blurred text behind it is not readable. */
export function documentViewport(scroller: HTMLElement) {
  const bounds = scroller.getBoundingClientRect();
  const dock = scroller.closest?.('.phone-screen--editor')?.querySelector<HTMLElement>('.phone-call-dock');
  const dockTop = dock?.getBoundingClientRect().top ?? bounds.bottom;
  return { top: Math.max(0, bounds.top), bottom: Math.min(window.innerHeight ?? bounds.bottom, bounds.bottom, dockTop) };
}

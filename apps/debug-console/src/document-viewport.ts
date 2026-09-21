/** The reading panel is separate from controls; clip only to the browser viewport. */
export function documentViewport(scroller: HTMLElement) {
  const bounds = scroller.getBoundingClientRect();
  return { top: Math.max(0, bounds.top), bottom: Math.min(window.innerHeight ?? bounds.bottom, bounds.bottom) };
}

import { useEffect, useRef, type RefObject } from 'react';

// Copy presentation only: the reflection must never register reading/navigation behavior.
const presentation = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'color', 'padding', 'margin', 'text-indent', 'white-space',
  'word-break', 'overflow-wrap', 'background-image', 'background-size', 'background-color',
  'box-decoration-break', '-webkit-box-decoration-break', 'border-radius'];

export function DocumentGlassBackdrop({ source }: { source: RefObject<HTMLDivElement | null> }) {
  const mirror = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = source.current, target = mirror.current;
    if (!scroller || !target) return;
    let frame = 0, dirty = true;
    let observedReader: HTMLElement | null = null;
    const paint = () => {
      frame = 0;
      const reader = scroller.querySelector<HTMLElement>('.document-reader');
      if (reader !== observedReader) {
        if (observedReader) resize.unobserve(observedReader);
        observedReader = reader;
        if (reader) resize.observe(reader);
        dirty = true;
      }
      if (!reader) { target.replaceChildren(); return; }
      if (dirty) {
        dirty = false;
        const copy = reader.cloneNode(true) as HTMLElement;
        const originals = [reader, ...reader.querySelectorAll<HTMLElement>('*')];
        const copies = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
        originals.forEach((node, index) => {
          const clone = copies[index]!;
          const style = getComputedStyle(node);
          // No IDs, data anchors, or live-region semantics in the decorative copy.
          for (const attribute of Array.from(clone.attributes)) clone.removeAttribute(attribute.name);
          for (const property of presentation) clone.style.setProperty(property, style.getPropertyValue(property));
          clone.style.animation = 'none';
          clone.style.transition = 'none';
        });
        copy.querySelectorAll('button, input, textarea, select, script, style').forEach(node => node.remove());
        copy.style.width = `${reader.getBoundingClientRect().width}px`;
        target.replaceChildren(copy);
      }
      const readerTop = reader.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      target.style.transform = `translate3d(-18px, ${readerTop * 1.5 - 60}px, 0) scale(1.5)`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const refresh = () => { dirty = true; schedule(); };
    const mutations = new MutationObserver(refresh);
    mutations.observe(scroller, { subtree: true, childList: true, characterData: true, attributes: true });
    const resize = new ResizeObserver(refresh);
    resize.observe(scroller);
    scroller.addEventListener('scroll', schedule, { passive: true });
    refresh();
    return () => {
      cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect();
      scroller.removeEventListener('scroll', schedule);
      target.replaceChildren();
    };
  }, [source]);
  return <div className="document-glass-backdrop" aria-hidden="true" inert>
    <div ref={mirror} className="document-glass-backdrop__paper" />
  </div>;
}

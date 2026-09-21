import { useEffect, useRef } from 'react';
import { uiAsset } from './ui-asset';

export function DialAvatar({ active, getPhase }: { active: boolean; getPhase: () => number }) {
  const root = useRef<HTMLDivElement>(null);
  const phase = useRef(getPhase);
  phase.current = getPhase;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const render = () => {
      const t = active ? phase.current() : -1;
      const breath = t < 0 || t >= .8 ? 0 : t < .2
        ? .5 - .5 * Math.cos(Math.PI * t / .2) : .5 + .5 * Math.cos(Math.PI * (t - .2) / .6);
      node.style.setProperty('--dial-breath', String(reduced.matches ? 0 : breath));
      node.querySelectorAll<HTMLElement>('i').forEach((ring, index) => {
        const progress = t < 0 ? -1 : t / 1.2;
        ring.style.transform = `scale(${reduced.matches ? 1.2 + index * .2 : 1 + Math.max(0, progress) * (.45 + index * .35)})`;
        ring.style.opacity = String(reduced.matches ? .18 : progress < 0 ? 0 : Math.sin(Math.PI * Math.min(1, progress)) * (.65 - index * .14));
      });
      if (active) frame = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <div ref={root} className="phone-dial-avatar">
    <span className="phone-dial-halo" aria-hidden="true" />
    <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
    <img className="phone-dial-portrait" src={uiAsset('lingli-avatar.png')} alt="令狸的头像" />
  </div>;
}

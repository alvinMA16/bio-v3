import { useEffect, useRef } from 'react';
import './voice-call-status.css';

type Props = { state: 'listen' | 'speak' | 'think' | 'idle'; label: string; getLevel: () => number };

/** Shares the approved 04D renderer with the motion study, loaded only in a call. */
export function VoiceCallStatus(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const node = canvas.current;
    const ctx = node?.getContext('2d');
    if (!node || !ctx) return;
    let disposed = false, frame = 0, previous = 0, level = 0, thinking = 0;
    let release: (() => void) | undefined;
    let width = 0, height = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width = entry.contentRect.width; height = entry.contentRect.height;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      node.width = Math.round(width * dpr); node.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    observer.observe(node);
    void import('./voice-glass-stack.js').then(renderer => {
      if (disposed) return;
      release = renderer.disposeGlassStack;
      const render = (now: number) => {
        frame = requestAnimationFrame(render);
        if (document.hidden || now - previous < (reduced.matches ? 100 : 33)) return;
        const dt = Math.min(.1, (now - previous) / 1000); previous = now;
        const { state, getLevel } = current.current;
        const target = state === 'listen' || state === 'speak' ? getLevel() : 0;
        level += (target - level) * (1 - Math.exp(-dt / (target > level ? .065 : .24)));
        thinking += ((state === 'think' ? 1 : 0) - thinking) * (1 - Math.exp(-dt / .32));
        renderer.drawGlassStack({ ctx, w: width, h: height }, {
          time: now / 1000, level, bands: [0, 0, 0], state,
          thinkingMix: thinking, reduced: reduced.matches, index: 10,
        });
      };
      frame = requestAnimationFrame(render);
    }).catch(() => { /* The status remains usable if WebGL assets cannot load. */ });
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); release?.(); };
  }, []);
  const label = props.state === 'speak' ? '令狸正在说' : props.state === 'think' ? '令狸在思考' : props.label;
  return <div className="phone-call-status phone-call-status--glass">
    <canvas ref={canvas} aria-hidden="true" />
    <span role="status">{label}</span>
  </div>;
}

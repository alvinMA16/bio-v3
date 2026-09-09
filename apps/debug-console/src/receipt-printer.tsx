import { useEffect, useRef, useState } from 'react';
import type { SessionReceipt } from './session-receipt';
import type { createReceiptScene } from './receipt-paper-scene';

export function ReceiptPrinter({ receipt, onClose }: { receipt: SessionReceipt; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<typeof createReceiptScene> | null>(null);
  const latest = useRef(receipt);
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mode, setMode] = useState<'loading' | '3d' | 'fallback'>('loading');
  const [finished, setFinished] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fallback = () => {
      if (cancelled) return;
      scene.current?.dispose(); scene.current = null;
      setMode('fallback'); setFinished(false);
    };
    // Load the renderer only when a receipt is requested, keeping the ordinary call screen light.
    void import('./receipt-paper-scene').then(({ createReceiptScene }) => {
      if (cancelled || !host.current) return;
      try {
        scene.current = createReceiptScene(host.current, latest.current, () => { if (!cancelled) setFinished(true); }, fallback);
        setMode('3d');
      } catch { fallback(); }
    }).catch(fallback);
    return () => { cancelled = true; scene.current?.dispose(); scene.current = null; clearTimeout(closeTimer.current); };
  }, []);
  useEffect(() => {
    if (finished) button.current?.focus({ preventScroll: true });
  }, [finished]);
  useEffect(() => {
    if (mode !== 'fallback') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { if (media.matches) setFinished(true); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mode]);
  useEffect(() => { latest.current = receipt; scene.current?.update(receipt); }, [receipt]);
  const close = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360);
  };
  return <section className={`receipt-workshop ${closing ? 'receipt-workshop--closing' : ''}`} role="dialog" aria-label="令狸送你的聊天小票" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <div className="receipt-mouth" aria-hidden="true"><div className="receipt-mouth__well" /></div>
    <div className="receipt-mouth__lip" aria-hidden="true" />
    <div className="receipt-stage">
      <div className="receipt-canvas" ref={host} aria-hidden="true" />
      <div className={mode === 'fallback' ? 'receipt-fallback' : 'receipt-readable'}>
        <div className="receipt-fallback__paper" onAnimationEnd={event => {
          if (mode === 'fallback' && event.target === event.currentTarget && event.animationName === 'receipt-physical-feed') setFinished(true);
        }}>
          <h2>聊天小票</h2>
          <p>{receipt.date}<br />{receipt.timeRange}</p><hr />
          <dl><div><dt>聊天时长</dt><dd>{receipt.duration}</dd></div><div><dt>你发言</dt><dd>{receipt.shares} 次</dd></div><div><dt>令狸发言</dt><dd>{receipt.replies} 次</dd></div></dl><hr />
        </div>
      </div>
    </div>
    <span className="receipt-readable" aria-live="polite">{finished ? '打印完成' : '正在打印'}</span>
    <div className="receipt-actions">{finished && <button type="button" ref={button} className="receipt-dismiss" onClick={close}>我知道了</button>}</div>
  </section>;
}

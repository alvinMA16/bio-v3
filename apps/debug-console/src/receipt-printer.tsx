import { useEffect, useRef, useState } from 'react';
import type { SessionReceipt } from './session-receipt';

export function ReceiptPrinter({ receipt, onClose }: { receipt: SessionReceipt; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [finished, setFinished] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { if (media.matches) setFinished(true); };
    update(); media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); clearTimeout(closeTimer.current); };
  }, []);
  useEffect(() => { if (finished) button.current?.focus({ preventScroll: true }); }, [finished]);
  const close = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360);
  };
  return <section className={`receipt-workshop ${closing ? 'receipt-workshop--closing' : ''}`} role="dialog" aria-label="令狸送你的聊天小票" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <div className="receipt-mouth" aria-hidden="true"><div className="receipt-mouth__well" /></div>
    <div className="receipt-mouth__lip" aria-hidden="true" />
    <div className="receipt-stage">
      <article className="receipt-paper" onAnimationEnd={event => {
        if (event.target === event.currentTarget && event.animationName === 'receipt-physical-feed') setFinished(true);
      }}>
        <header><h2>聊天小票</h2><p>{receipt.date}</p><p>{receipt.timeRange}</p></header>
        <dl><div><dt>聊天时长</dt><dd>{receipt.duration}</dd></div><div><dt>你发言</dt><dd>{receipt.shares} 次</dd></div><div><dt>令狸发言</dt><dd>{receipt.replies} 次</dd></div></dl>
      </article>
    </div>
    <span className="receipt-readable" aria-live="polite">{finished ? '打印完成' : '正在打印'}</span>
    <div className="receipt-actions">{finished && <button type="button" ref={button} className="product-control product-control--primary receipt-dismiss" onClick={close}>我知道了</button>}</div>
  </section>;
}

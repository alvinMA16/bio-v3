import type { CSSProperties, ReactNode } from 'react';
import { READING_FONT_SIZES } from '@bio/contracts';
import type { ReadingFontFeedback } from './use-reading-font';
import './top-toast.css';

/** One shared placement for brief, non-interactive feedback. */
export function TopToast({ children, label }: { children: ReactNode; label: string }) {
  return <div className="top-toast" role="status" aria-label={label} aria-live="polite" aria-atomic="true">
    <div aria-hidden="true">{children}</div>
  </div>;
}

export function ReadingFontToast({ feedback }: { feedback: ReadingFontFeedback }) {
  const previous = READING_FONT_SIZES.indexOf(feedback.previous);
  const current = READING_FONT_SIZES.indexOf(feedback.current);
  const unchanged = previous === current;
  const title = unchanged ? current === 0 ? '已经是最小字号' : current === READING_FONT_SIZES.length - 1 ? '已经是最大字号' : `已经是${feedback.current}` : `${feedback.previous} → ${feedback.current}`;
  const detail = unchanged ? `第 ${current + 1} 档，共 ${READING_FONT_SIZES.length} 档` : `第 ${previous + 1} 档 → 第 ${current + 1} 档，共 ${READING_FONT_SIZES.length} 档`;
  return <TopToast label={`字号：${title}。${detail}`}>
    <div className="font-toast-scale" style={{ '--font-from': previous, '--font-to': current, '--font-stops': READING_FONT_SIZES.length } as CSSProperties}>
      <i className="font-toast-selection" />
      {READING_FONT_SIZES.map((size, index) => <span key={size} className={index === current ? 'is-current' : ''}>{size}</span>)}
    </div>
  </TopToast>;
}

import { useId, useRef, useState } from 'react';
import './slide-to-end.css';

/** Only a completed thumb drag (or explicit keyboard confirmation) ends the call. */
export function SlideToEnd({ onEnd, dialing = false }: { onEnd: () => void; dialing?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointer: number; start: number; startY: number; distance: number; value: number } | undefined>(undefined);
  const completed = useRef(false);
  const [value, setValue] = useState(0);
  const [dragging, setDragging] = useState(false);
  const helpId = useId();
  const label = dialing ? '滑动取消' : '滑动退出';
  function reset() { gesture.current = undefined; setDragging(false); if (!completed.current) setValue(0); }
  function finish() { if (completed.current) return; completed.current = true; gesture.current = undefined; setDragging(false); setValue(100); onEnd(); }
  return <div ref={track} className={`slide-to-end ${dragging ? 'slide-to-end--dragging' : ''}`}>
    <span className="slide-to-end-label" aria-hidden="true" style={{ opacity: 1 - value / 100 }}>{dialing ? '取消' : '退出'} ›</span>
    <button type="button" role="slider" className="slide-to-end-thumb" aria-label={label}
      aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}
      aria-valuetext={value >= 96 ? '松开或按回车确认退出' : '向右滑到底后松开退出'} aria-describedby={helpId}
      style={{ transform: `translateX(${value * .4}px)` }}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || completed.current || gesture.current) return;
        const distance = (track.current?.clientWidth ?? 0) - 52;
        if (distance < 36) return;
        event.preventDefault(); event.currentTarget.focus();
        gesture.current = { pointer: event.pointerId, start: event.clientX, startY: event.clientY, distance, value: 0 };
        setValue(0); setDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        current.value = Math.max(0, Math.min(100, (event.clientX - current.start) / current.distance * 100));
        setValue(current.value);
      }}
      onPointerUp={event => {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        if (current.value >= 96 && event.clientX - current.start >= current.distance * .96 && Math.abs(event.clientY - current.startY) <= 44) finish(); else reset();
      }}
      onPointerCancel={reset} onLostPointerCapture={reset} onBlur={reset}
      onKeyDown={event => {
        if (gesture.current || completed.current) return;
        if (['ArrowRight', 'ArrowLeft', 'Home', 'End', 'Escape', 'Enter', ' '].includes(event.key)) event.preventDefault();
        if (event.key === 'ArrowRight') setValue(previous => Math.min(100, previous + 10));
        else if (event.key === 'ArrowLeft') setValue(previous => Math.max(0, previous - 10));
        else if (event.key === 'End') setValue(100);
        else if (event.key === 'Home' || event.key === 'Escape') reset();
        else if (event.key === 'Enter' && value >= 96) finish();
      }}>
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 15v-4c5-5 13-5 18 0v4l-5-1v-3a14 14 0 0 0-8 0v3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
    </button>
    <span id={helpId} className="slide-to-end-instructions">向右拖动圆钮到底后松开，未到底会返回。键盘用左右方向键移动，到底后按回车确认；Escape 取消。</span>
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_READING_FONT_SIZE, isReadingFontSize, type ReadingFontSize } from '@bio/contracts';
import { accountCacheKey } from './account-cache';

export function useReadingFont() {
  const key = accountCacheKey('bio-reading-font');
  const [fontSize, setFontSize] = useState<ReadingFontSize>(() => {
    try { const cached = localStorage.getItem(key); return isReadingFontSize(cached) ? cached : DEFAULT_READING_FONT_SIZE; }
    catch { return DEFAULT_READING_FONT_SIZE; }
  });
  const revision = useRef(0);
  const [feedback, setFeedback] = useState<{ id: number; text: string }>();
  const apply = (size: ReadingFontSize, previous?: ReadingFontSize) => {
    if (!isReadingFontSize(size)) return;
    revision.current++;
    setFontSize(size);
    if (previous) setFeedback({ id: revision.current, text: previous === size ? `已经是${size}` : `字号已从${previous}调为${size}` });
    try { localStorage.setItem(key, size); } catch { /* Server persistence remains authoritative. */ }
  };
  useEffect(() => {
    const controller = new AbortController(), started = revision.current;
    void fetch('/api/v1/agent/reading-preferences', { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('Preference unavailable'); return response.json(); })
      .then(value => { if (!controller.signal.aborted && revision.current === started && isReadingFontSize(value.fontSize)) apply(value.fontSize); })
      .catch(() => { /* Retain this account's cached size while offline. */ });
    return () => controller.abort();
  }, [key]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return { fontSize, feedback, applyReadingFont: apply };
}

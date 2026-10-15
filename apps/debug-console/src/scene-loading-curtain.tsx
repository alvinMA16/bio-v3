import { useEffect, useRef, useState, type CSSProperties } from 'react';
import portrait from './assets/lingli-loading.png';
import felt from '../../miniprogram/miniprogram/assets/materials/felt-oat.webp';

export function SceneLoadingCurtain({ prepared, revealed, progress, error, onReveal, onRetry }: {
  prepared: boolean; revealed: boolean; progress: number; error: boolean;
  onReveal: () => void; onRetry: () => void;
}) {
  const startedAt = useRef(Date.now());
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  const [complete, setComplete] = useState(false);
  const [portraitReady, setPortraitReady] = useState(false);
  const [portraitFailed, setPortraitFailed] = useState(false);
  useEffect(() => {
    if (!prepared || error || !portraitReady) { setComplete(false); return; }
    // Let even cached visits show a brief, readable pass through the progress bar.
    const finish = window.setTimeout(() => setComplete(true), Math.max(0, 600 - (Date.now() - startedAt.current)));
    return () => window.clearTimeout(finish);
  }, [prepared, error, portraitReady]);
  useEffect(() => {
    if (!complete || error) return;
    const timer = window.setTimeout(() => reveal.current(), 260);
    return () => window.clearTimeout(timer);
  }, [complete, error]);
  const percentage = complete ? 100 : Math.min(90, progress);
  return <div className={`phone-scene-curtain ${revealed ? 'phone-scene-curtain--open' : ''}`} inert={revealed} aria-hidden={revealed}
    style={{ '--scene-felt': `url(${felt})` } as CSSProperties}>
    <link rel="preload" as="image" href={portrait} />
    <div className="phone-scene-welcome">
      <img className={`phone-scene-mascot ${portraitReady ? 'phone-scene-mascot--ready' : ''}`} src={portrait} alt="" width="128" height="128"
        hidden={portraitFailed} onLoad={() => setPortraitReady(true)} onError={() => { setPortraitFailed(true); setPortraitReady(true); }} />
      <div className="phone-scene-progress" role="progressbar" aria-label="书房加载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
        <span style={{ width: `${percentage}%` }} />
      </div>
      {error && <span className="phone-scene-error" role="alert">书房暂时未能打开</span>}
      {error && <button type="button" onClick={() => { startedAt.current = Date.now(); setComplete(false); onRetry(); }}>重新加载</button>}
    </div>
  </div>;
}

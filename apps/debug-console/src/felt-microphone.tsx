import { useEffect, useId, useRef, useState } from 'react';

export function FeltMicrophone({ enabled, listening, replying, disabled, onToggle }: {
  level: number; enabled: boolean; listening: boolean; replying: boolean; disabled: boolean; onToggle: () => void;
}) {
  const texture = useId();
  const previousEnabled = useRef(enabled);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (previousEnabled.current === enabled) return;
    previousEnabled.current = enabled;
    setNotice(enabled ? '麦克风已开' : '麦克风已关');
    const timer = setTimeout(() => setNotice(''), 1400);
    return () => clearTimeout(timer);
  }, [enabled]);
  const paused = enabled && !listening;
  const state = !enabled ? 'off' : paused ? 'paused' : 'on';
  const hint = !enabled ? '轻点开麦，和令狸聊聊' : listening ? '说完停一会儿，我就回应你' : replying ? '正在回复，稍后听你说 · 暂不收音' : '正在准备，请稍等 · 暂不收音';
  return <div className={`felt-mic felt-mic--${state}`}>
    <button type="button" className="felt-mic__button" aria-label="麦克风" aria-pressed={enabled}
      disabled={disabled} onClick={onToggle} title={`${hint} · 点击${enabled ? '关麦' : '开麦'}`} aria-describedby={`${texture}-status`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <rect x="32" y="16" width="16" height="31" rx="8" className="felt-mic__icon" />
        <path d="M24 37v6a16 16 0 0 0 32 0v-6M40 59v9m-9 0h18" className="felt-mic__stem" />
        {!enabled && <path d="m18 18 44 44" className="felt-mic__slash" />}
      </svg>
    </button>
    {notice && <span className="felt-mic__notice" aria-hidden="true">{notice}</span>}
    <span id={`${texture}-status`} className="felt-mic__status" role="status">
      {!enabled ? '麦克风已关' : listening ? '麦克风已开，正在听' : `麦克风已开，${hint}`}
    </span>
  </div>;
}

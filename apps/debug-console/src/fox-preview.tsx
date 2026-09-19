import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PhonePreview } from './phone-preview';
import type { FoxActivity } from '../../miniprogram/miniprogram/lib/fox-behavior';
import './styles.css';
const options = [
  { label: '用户说话', phase: 'listening', speech: 'silent' },
  { label: '等待开口', phase: 'waiting', speech: 'silent' },
  { label: '思考', phase: 'processing', speech: 'silent' },
  { label: '令狸回复', phase: 'idle', speech: 'audio' },
] satisfies { label: string; phase: FoxActivity['phase']; speech: FoxActivity['speech'] }[];
function Preview() {
  const [selected, setSelected] = useState(0);
  const option = options[selected]!;
  const attached = new URLSearchParams(location.search).has('attachment');
  return <main style={{ display: 'grid', justifyItems: 'center', gap: 12, padding: 20 }}>
    <h2>通话动作预览</h2><p>只预览动作，不开启麦克风或发起通话。</p>
    <div style={{ display: 'flex', gap: 8 }}>{options.map((value, index) => <button key={value.label} onClick={() => setSelected(index)} aria-pressed={index === selected}>{value.label}</button>)}</div>
    <div style={{ width: 350 }}><PhonePreview motionState={selected === 2 ? 'think' : selected === 3 ? 'speak' : 'listen'} getMotionLevel={() => selected === 0 || selected === 3 ? .35 + .25 * Math.sin(performance.now() / 180) : 0} activity={{ phase: option.phase, speech: option.speech, notebook: true, reducedMotion: false }} subtitle={option.label} running={false} callOpen callStartedAt={null} status={option.label} mode={attached ? 'attachment' : 'conversation'} startDisabled onStart={() => {}} speakerEnabled onSpeakerToggle={() => {}} onEnd={() => {}} receipt={null} receiptVisible={false} onReceiptClose={() => {}} onMaterialChat={() => {}}>{null}</PhonePreview></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);

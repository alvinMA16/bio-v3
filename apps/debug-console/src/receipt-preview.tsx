import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PhonePreview } from './phone-preview';
import './styles.css';

function ReceiptPreview() {
  const [visible, setVisible] = useState(true);
  const [take, setTake] = useState(1);
  const replay = () => { setVisible(true); setTake(value => value + 1); };
  return <main className="receipt-preview" style={{ display: 'grid', justifyItems: 'center', gap: 20, padding: 24 }}>
    <div style={{ textAlign: 'center', color: '#88785f', fontSize: 13 }}>令狸 · 小票动效预览（示例内容）</div>
    <div style={{ width: 350 }}><PhonePreview key={take} subtitle="" activity={{ phase: 'idle', notebook: false, speech: 'silent', reducedMotion: false }} running={false} callOpen={false} callStartedAt={null} status="" mode="conversation" startDisabled={false} onStart={replay} speakerEnabled={true} onSpeakerToggle={() => {}} onEnd={() => {}} receipt={{ id: `sample-${take}`, date: '2026.09.09', timeRange: '15:20 — 15:28', duration: '8 分 12 秒', shares: 6, replies: 6 }} receiptVisible={visible} onReceiptClose={() => setVisible(false)} onReceiptOpen={replay} onMaterialChat={() => {}}>{null}</PhonePreview></div>
    <div style={{ display: 'flex', gap: 12 }}><button onClick={replay}>重播打印</button></div>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<ReceiptPreview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());

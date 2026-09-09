import type { FoxActivity } from '../../miniprogram/miniprogram/lib/fox-behavior';
import { FoxAnimationController, type FoxAnimationState } from '../../miniprogram/miniprogram/lib/fox-animation-controller';
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Animation {
  id: string; src: string; columns: number; rows: number; frameCount: number;
  frameWidth: number; frameHeight: number; fps: number;
}
interface Manifest {
  layers: { environment: { src: string }; innerPanel: { src: string } };
  animations: Animation[];
}

export function PhonePreview({ children, subtitle, activity, running, microphone, callOpen, callStartedAt, status, mode, startDisabled, onStart, speakerEnabled, onSpeakerToggle, onEnd }: {
  children: ReactNode; subtitle: string; activity: FoxActivity; running: boolean; microphone?: ReactNode;
  callOpen: boolean; callStartedAt: number | null; status: string; mode: 'conversation' | 'attachment' | 'editor';
  startDisabled: boolean; onStart: () => void; speakerEnabled: boolean; onSpeakerToggle: () => void; onEnd: () => void;
}) {
  const { phase, notebook, speech } = activity;
  const speaking = speech !== 'silent' && phase !== 'listening';
  const [manifest, setManifest] = useState<Manifest>();
  const [assetError, setAssetError] = useState(false);
  const [drawer, setDrawer] = useState<'folder' | 'manuscripts' | null>(null);
  const [callSeconds, setCallSeconds] = useState(0);
  useEffect(() => {
    if (callStartedAt === null || !callOpen) { setCallSeconds(0); return; }
    const update = () => setCallSeconds(Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [callStartedAt, callOpen]);
  const callDuration = `${String(Math.floor(callSeconds / 60)).padStart(2, '0')}:${String(callSeconds % 60).padStart(2, '0')}`;
  const [animationState, setAnimationState] = useState<FoxAnimationState>();
  const controllerRef = useRef<FoxAnimationController | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const animation = manifest?.animations.find(item => item.id === (animationState?.action.id ?? 'blink'));

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/animations/fox-clerk/manifest.json', { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Assets unavailable'); return response.json() as Promise<Manifest>; })
      .then(setManifest).catch(() => { if (!controller.signal.aborted) setAssetError(true); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const controller = new FoxAnimationController(setAnimationState);
    controllerRef.current = controller;
    controller.setActivity({ phase: 'idle', notebook: false, speech: 'silent', reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    controller.startWelcomeSequence();
    const visibility = () => { if (document.hidden) controller.suspend(); else controller.resume(); };
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => { document.removeEventListener('visibilitychange', visibility); controller.destroy(); controllerRef.current = null; };
  }, []);
  useEffect(() => {
    controllerRef.current?.setActivity({
      phase, notebook, speech, reducedMotion,
    });
  }, [phase, notebook, speech, reducedMotion]);
  useEffect(() => {
    if (running && subtitleRef.current) subtitleRef.current.scrollTop = subtitleRef.current.scrollHeight;
  }, [subtitle, running]);
  const safeFrame = animation ? (animationState?.frame ?? 0) % animation.frameCount : 0;
  const column = animation ? safeFrame % animation.columns : 0;
  const row = animation ? Math.floor(safeFrame / animation.columns) : 0;

  const artwork = <>
      {manifest && <>
        <div className="phone-art phone-art--background" style={{ backgroundImage: `url(${manifest.layers.environment.src})` }} />
        {animation && <div className="phone-art phone-art--actor" style={{
          backgroundImage: `url(${animation.src})`, backgroundSize: `${animation.columns * 100}% ${animation.rows * 100}%`,
          backgroundPosition: `${animation.columns > 1 ? column / (animation.columns - 1) * 100 : 0}% ${animation.rows > 1 ? row / (animation.rows - 1) * 100 : 0}%`,
        }} />}
        <div className="phone-art phone-art--board" style={{ backgroundImage: `url(${manifest.layers.innerPanel.src})` }} />
      </>}
      {!manifest && <div className="phone-art-fallback">令狸<span>{assetError ? '场景素材加载失败' : '正在加载场景…'}</span></div>}
    </>;
  return <div className="phone-preview" aria-label="手机用户界面预览">
    <div className={`phone-screen ${callOpen ? 'phone-screen--call' : ''}`} style={{ aspectRatio: '320/692' }}>
      {!callOpen ? <>
        {artwork}
        <section className="phone-desk" aria-label="令狸的书桌">
          <button type="button" className="phone-desk-entry phone-desk-entry--folder" onClick={() => setDrawer('folder')}><img src="/desk/folder.png" alt="" /><span>资料夹</span></button>
          <button type="button" className="phone-desk-entry phone-desk-entry--call" disabled={startDisabled} onClick={onStart}><img src="/desk/phone.png" alt="" /><span>呼叫令狸</span></button>
          <button type="button" className="phone-desk-entry phone-desk-entry--manuscripts" onClick={() => setDrawer('manuscripts')}><img src="/desk/manuscripts.png" alt="" /><span>文稿集</span></button>
        </section>
        {drawer && <div className="phone-desk-backdrop" onClick={() => setDrawer(null)}>
          <section className="phone-desk-drawer" role="dialog" aria-modal="true" aria-label={drawer === 'folder' ? '资料夹' : '文稿集'} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setDrawer(null); }}>
            <button type="button" autoFocus aria-label="关闭" onClick={() => setDrawer(null)}>×</button>
            <h2>{drawer === 'folder' ? '资料夹' : '文稿集'}</h2>
            <p>{drawer === 'folder' ? '资料收纳功能正在准备中' : '文稿收录功能正在准备中'}</p>
          </section>
        </div>}

      </> : <>
        <header className="phone-call-header">
          <div><h2>令狸</h2><p className="phone-call-duration" aria-label="通话时长">{callStartedAt === null ? '未连接' : callDuration}</p></div>
          <div className="phone-video" role="img" aria-label={`令狸 · ${speaking ? '正在说话' : phase === 'listening' ? '正在听' : '陪伴中'}`}>
            <div className="phone-video-scene">{artwork}</div>
          </div>
        </header>
        <section className={`phone-content-panel ${mode !== 'conversation' ? 'phone-content-panel--document' : ''}`} aria-label={mode === 'conversation' ? '对话内容' : mode === 'attachment' ? '附件内容' : '编辑内容'}>
          {mode === 'conversation' ? <div className="phone-panel-scroll phone-dialogue" ref={subtitleRef}>
            <p>{subtitle || (running && phase !== 'listening' ? '让我想一想…' : '我在这里，慢慢讲。')}</p>
          </div> : <div className="phone-panel-scroll">{children}</div>}
        </section>
        <p className="phone-call-status" role="status">{status || (running ? speaking ? '正在回应' : '正在思考' : '等待连接')}</p>
        <footer className="phone-call-controls" aria-label="通话控制">
          <div className="phone-call-control">{microphone}<span>麦克风</span></div>
          <div className="phone-call-control"><button type="button" className="phone-control-button phone-control-button--end" aria-label="结束通话" onClick={onEnd}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15v-4c5-5 13-5 18 0v4l-5-1v-3a14 14 0 0 0-8 0v3Z" /></svg>
          </button><span>结束</span></div>
          <div className="phone-call-control"><button type="button" className="phone-control-button" aria-label="扬声器" aria-pressed={speakerEnabled} onClick={onSpeakerToggle}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z" />{speakerEnabled ? <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /> : <path d="m16 9 6 6m0-6-6 6" />}</svg>
          </button><span>{speakerEnabled ? '扬声器' : '扬声器已关'}</span></div>
        </footer>
      </>}
    </div>
  </div>;
}

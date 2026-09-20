import { SlideToEnd } from './slide-to-end';
import { VoiceCallStatus } from './voice-call-status';
import { AttachmentViewer } from './attachment-viewer';
import { MaterialFolder } from './material-folder';
import { uiAsset } from './ui-asset';
import { ManuscriptFolder } from './manuscript-folder';
import { ReceiptPrinter } from './receipt-printer';
import type { Material, PanelAttachment } from '@bio/contracts';
import type { SessionReceipt } from './session-receipt';
import type { FoxActivity } from '../../miniprogram/miniprogram/lib/fox-behavior';
import { FoxAnimationController, type FoxAnimationState } from '../../miniprogram/miniprogram/lib/fox-animation-controller';
import { FoxFrameGate } from '../../miniprogram/miniprogram/lib/fox-frame-gate';
import type { FoxActionId } from '../../miniprogram/miniprogram/lib/fox-animation-controller';
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Animation {
  id: string; src: string; columns: number; rows: number; frameCount: number;
  frameWidth: number; frameHeight: number; fps: number;
}
interface Manifest {
  layers: { environment: { src: string }; innerPanel: { src: string } };
  animations: Animation[];
}

export function PhonePreview({ attachment, onAttachmentPage, onManuscriptChat, children, subtitle, activity, running, callOpen, callStartedAt, status, callFailed = false, motionState = 'listen', getMotionLevel = () => 0, mode, startDisabled, onStart, onEnd, receipt, receiptVisible, onReceiptClose, onMaterialChat }: {
  onManuscriptChat?: ((document: import('@bio/contracts').PanelDocument) => void) | undefined;
  attachment?: PanelAttachment | undefined; onAttachmentPage?: ((materialId: string, page: number) => void) | undefined;
  onMaterialChat: (item: Material) => void;
  receipt: SessionReceipt | null; receiptVisible: boolean; onReceiptClose: () => void;
  children: ReactNode; subtitle: string; activity: FoxActivity; running: boolean;
  callOpen: boolean; callStartedAt: number | null; status: string; mode: 'conversation' | 'attachment' | 'editor';
  callFailed?: boolean;
  motionState?: 'listen' | 'speak' | 'think'; getMotionLevel?: () => number;
  startDisabled: boolean; onStart: () => void; onEnd: () => void;
}) {
  const dialing = callOpen && callStartedAt === null;
  const { phase, notebook, speech } = activity;
  const [manifest, setManifest] = useState<Manifest>();
  const [assetError, setAssetError] = useState(false);
  const [folderSearchOpen, setFolderSearchOpen] = useState(false);
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
  const frameGate = useRef(new FoxFrameGate());
  const controllerRef = useRef<FoxAnimationController | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const animation = manifest?.animations.find(item => item.id === (animationState?.action.id ?? 'blink'));

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/animations/fox-clerk/manifest.json', { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Assets unavailable'); return response.json() as Promise<Manifest>; })
      .then(value => setManifest({ ...value,
        layers: { environment: { src: uiAsset(value.layers.environment.src) }, innerPanel: { src: uiAsset(value.layers.innerPanel.src) } },
        animations: value.animations.map(animation => ({ ...animation, src: uiAsset(animation.src) })),
      })).catch(() => { if (!controller.signal.aborted) setAssetError(true); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const controller = new FoxAnimationController(state => setAnimationState(frameGate.current.request(state)));
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
        <div className="phone-art-actors">{manifest.animations.map(sheet => <img key={sheet.id} src={sheet.src} alt=""
          onLoad={() => setAnimationState(frameGate.current.loaded(sheet.id as FoxActionId))}
          style={{ position: 'absolute', maxWidth: 'none', pointerEvents: 'none', zIndex: 1,
            width: `${sheet.columns * 100}%`, height: `${sheet.rows * 100}%`,
            left: `${sheet.id === animation?.id ? -column * 100 : 0}%`, top: `${sheet.id === animation?.id ? -row * 100 : 0}%`,
            visibility: animationState && sheet.id === animation?.id ? 'visible' : 'hidden',
          }} />)}
        </div>
        <div className="phone-art phone-art--board" style={{ backgroundImage: `url(${manifest.layers.innerPanel.src})` }} />
      </>}
      {!manifest && <div className="phone-art-fallback">令狸<span>{assetError ? '场景素材加载失败' : '正在加载场景…'}</span></div>}
    </>;
  return <div className="phone-preview" aria-label="手机用户界面预览">
    <div className={`phone-screen ${callOpen ? 'phone-screen--call' : ''} ${mode === 'attachment' ? 'phone-screen--attachment' : ''} ${mode === 'editor' ? 'phone-screen--editor' : ''} ${callOpen && mode === 'conversation' ? 'phone-screen--conversation' : ''} ${dialing ? 'phone-screen--dialing' : ''}`} style={{ aspectRatio: '320/692' }}>
      {!callOpen ? <>
        {artwork}
        <section className={`phone-desk ${receiptVisible ? 'phone-desk--printing' : ''}`} inert={receiptVisible || !!drawer} aria-label="令狸的书桌">
          <button type="button" className="phone-desk-entry phone-desk-entry--folder" aria-label="资料夹" onClick={() => { setFolderSearchOpen(false); setDrawer('folder'); }}><img src={uiAsset('folder.png')} alt="" /></button>
          <button type="button" className="phone-desk-entry phone-desk-entry--call" aria-label="呼叫令狸" disabled={startDisabled} onClick={onStart}><img src={uiAsset('phone.png')} alt="" /></button>
          <button type="button" className="phone-desk-entry phone-desk-entry--manuscripts" aria-label="文稿集" onClick={() => setDrawer('manuscripts')}><span className="phone-manuscript-art"><img src={uiAsset('manuscripts.png')} alt="" /><img className="phone-manuscript-label" src={uiAsset('manuscripts-label.png')} alt="" /></span></button>
        </section>
        {drawer === 'folder' && <section className="phone-folder-page" aria-label="资料夹" onKeyDown={event => { if (event.key === 'Escape') setDrawer(null); }}>
          <header className="phone-folder-nav" inert={folderSearchOpen}><button type="button" autoFocus aria-label="返回书桌" onClick={() => setDrawer(null)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button><h2>资料夹</h2><button className="phone-folder-search-toggle" type="button" aria-label={folderSearchOpen ? '收起搜索' : '搜索资料'} aria-expanded={folderSearchOpen} onClick={() => setFolderSearchOpen(value => !value)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" /><path d="m16 16 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button></header>
          <div className="phone-folder-scroll"><MaterialFolder onCloseSearch={() => setFolderSearchOpen(false)} searchOpen={folderSearchOpen} disabled={startDisabled} onChat={item => { setDrawer(null); onMaterialChat(item); }} /></div>
        </section>}
        {drawer === 'manuscripts' && <div className="phone-desk-backdrop" onClick={() => setDrawer(null)}>
          <section className="phone-desk-drawer" role="dialog" aria-modal="true" aria-label="文稿集" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setDrawer(null); }}>
            <button type="button" autoFocus aria-label="关闭" onClick={() => setDrawer(null)}>×</button>
            <h2>文稿集</h2><ManuscriptFolder onChat={onManuscriptChat ? document => { setDrawer(null); onManuscriptChat(document); } : undefined} />
          </section>
        </div>}

      </> : <>
        {dialing ? <section className="phone-dialing" aria-label="呼叫令狸" aria-busy={!callFailed}>
          <div className="phone-dial-avatar"><i /><i /><i /><div className="phone-video"><div className="phone-video-scene">{artwork}</div></div></div>
          <p role="status">{callFailed ? '暂时未能接通' : '正在呼叫'}</p>
          {callFailed && <small>{status}</small>}
          {callFailed && <button type="button" className="phone-redial" disabled={startDisabled} onClick={onStart}>重新呼叫</button>}
        </section> : <>
          {mode === 'conversation' && <div className="phone-conversation-window" role="img" aria-label="令狸在书房里"><div className="phone-conversation-scene">{artwork}</div></div>}
          <section className={`phone-content-panel ${mode !== 'conversation' ? 'phone-content-panel--document' : ''}`} aria-label={mode === 'conversation' ? '对话内容' : mode === 'attachment' ? '附件内容' : '编辑内容'}>
            {mode === 'attachment' && attachment ? <AttachmentViewer key={attachment.id} attachment={attachment} onPage={onAttachmentPage} /> : mode === 'conversation' ? <div className="phone-panel-scroll phone-dialogue" ref={subtitleRef}>
              <p>{subtitle || (running && phase !== 'listening' ? '让我想一想…' : '我在这里，慢慢讲。')}</p>
            </div> : <div className="phone-panel-scroll">{children}</div>}
          </section>
        </>}
        {!dialing && <VoiceCallStatus state={motionState} getLevel={getMotionLevel} label="我在听" />}
        <footer className="phone-call-controls" aria-label="通话控制">
          <div className="document-call-state"><span>令狸</span><small>{dialing ? callFailed ? '未接通' : '等待接通' : callDuration}</small></div>
          <SlideToEnd key={`${mode}:${dialing}`} dialing={dialing} onEnd={onEnd} />
        </footer>
      </>}
      {receiptVisible && receipt && !callOpen && <ReceiptPrinter key={receipt.id} receipt={receipt} onClose={onReceiptClose} />}
    </div>
  </div>;
}

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Animation {
  id: string; src: string; columns: number; rows: number; frameCount: number;
  frameWidth: number; frameHeight: number; fps: number;
}
interface Manifest {
  layers: { environment: { src: string }; innerPanel: { src: string } };
  animations: Animation[];
}

export function PhonePreview({ children, subtitle, speaking, running }: {
  children: ReactNode; subtitle: string; speaking: boolean; running: boolean;
}) {
  const [manifest, setManifest] = useState<Manifest>();
  const [assetError, setAssetError] = useState(false);
  const [frame, setFrame] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const animation = manifest?.animations.find(item => item.id === (speaking ? 'talk' : 'blink'));

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
    setFrame(0);
    if (!animation || reducedMotion || !speaking) return;
    const timer = window.setInterval(() => setFrame(value => (value + 1) % animation.frameCount), 1000 / animation.fps);
    return () => window.clearInterval(timer);
  }, [animation, speaking, reducedMotion]);
  useEffect(() => {
    if (running && subtitleRef.current) subtitleRef.current.scrollTop = subtitleRef.current.scrollHeight;
  }, [subtitle, running]);
  const safeFrame = animation ? frame % animation.frameCount : 0;
  const column = animation ? safeFrame % animation.columns : 0;
  const row = animation ? Math.floor(safeFrame / animation.columns) : 0;

  return <div className="phone-preview" aria-label="手机用户界面预览">
    <div className="phone-screen" style={{ aspectRatio: animation ? `${animation.frameWidth}/${animation.frameHeight}` : '320/692' }}>
      {manifest && <>
        <div className="phone-art phone-art--background" style={{ backgroundImage: `url(${manifest.layers.environment.src})` }} />
        {animation && <div className="phone-art phone-art--actor" style={{
          backgroundImage: `url(${animation.src})`, backgroundSize: `${animation.columns * 100}% ${animation.rows * 100}%`,
          backgroundPosition: `${animation.columns > 1 ? column / (animation.columns - 1) * 100 : 0}% ${animation.rows > 1 ? row / (animation.rows - 1) * 100 : 0}%`,
        }} />}
        <div className="phone-art phone-art--board" style={{ backgroundImage: `url(${manifest.layers.innerPanel.src})` }} />
      </>}
      {!manifest && <div className="phone-art-fallback">令狸<span>{assetError ? '场景素材加载失败' : '正在加载场景…'}</span></div>}
      <div className="phone-state">{running ? speaking ? '回应中' : '处理中' : '等待用户'}</div>
      <section className="phone-content-panel" aria-label="手机内容面板">
        <div className="phone-panel-scroll">{children}</div>
        <div className="phone-subtitle" ref={subtitleRef}><span>令狸</span><p>{subtitle || (running ? '正在理解你的请求…' : '今天想聊点什么？')}</p></div>
      </section>
    </div>
  </div>;
}

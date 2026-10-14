import { uiAsset } from './ui-asset';

export interface SceneAnimation {
  id: string; src: string; columns: number; rows: number; frameCount: number;
  frameWidth: number; frameHeight: number; fps: number;
}
export interface SceneManifest {
  layers: { environment: { src: string }; innerPanel: { src: string } };
  animations: SceneAnimation[];
}
// Retain decoded backgrounds and sheets for the lifetime of the cached scene.
const decodedSceneAssets = new WeakMap<SceneManifest, HTMLImageElement[]>();
let deskPreparation: Promise<SceneManifest> | undefined;

/** Resolve only after every visible scene asset has downloaded and decoded. */
export function prepareDeskScene(): Promise<SceneManifest> {
  if (!deskPreparation) deskPreparation = loadCallUi(undefined, true).then(manifest => manifest!).catch(error => {
    deskPreparation = undefined;
    throw error;
  });
  return deskPreparation;
}

let scenePreparation: Promise<void> | undefined;

/** Start on the desk; concurrent calls share assets and failures remain retryable. */
export function warmCallUi(): Promise<void> {
  if (!scenePreparation) scenePreparation = Promise.all([prepareDeskScene(), import('./voice-glass-stack.js').then(renderer => renderer.prepareGlassStack())]).then(() => {}).catch(error => {
    scenePreparation = undefined; throw error;
  });
  return scenePreparation;
}

export async function prepareCallUi(materialId?: string): Promise<void> {
  await Promise.all([
    warmCallUi(),
    // A previous call may have released its GPU resources while images stay cached.
    import('./voice-glass-stack.js').then(renderer => renderer.prepareGlassStack()),
    materialId ? loadCallUi(materialId, false) : Promise.resolve(),
  ]);
}

async function loadCallUi(materialId?: string, includeScene = true): Promise<SceneManifest | undefined> {
  let scene: SceneManifest | undefined;
  const decodedImages: HTMLImageElement[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  async function json(url: string) {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('通话资源加载失败，请重新呼叫。');
    return response.json();
  }
  function image(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', abort);
        img.onload = null; img.onerror = null;
        if (error) { img.src = ''; reject(error); } else { decodedImages.push(img); resolve(); }
      };
      const abort = () => finish(new Error('通话资源加载超时，请重新呼叫。'));
      if (controller.signal.aborted) { abort(); return; }
      controller.signal.addEventListener('abort', abort, { once: true });
      img.onload = () => {
        if (img.decode) void img.decode().then(() => finish(), () => finish(new Error('场景素材解码失败，请重试。')));
        else finish();
      };
      img.onerror = () => finish(new Error('场景或附件加载失败，请重新呼叫。'));
      img.src = src;
    });
  }
  try {
    await Promise.race([
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('通话资源加载超时，请重新呼叫。')), { once: true })),
      Promise.all([
      (async () => {
        if (!includeScene) return;
        const manifest = await json('/animations/fox-clerk/manifest.json') as SceneManifest;
        const sources = [...Object.values(manifest.layers), ...manifest.animations].flatMap(item => item.src ? [uiAsset(item.src)] : []);
        sources.push(...['folder.png', 'phone.png', 'manuscripts.png', 'manuscripts-label.png', 'lingli-avatar.png'].map(uiAsset));
        await Promise.all([...new Set(sources)].map(image));
        scene = { ...manifest,
          layers: { environment: { src: uiAsset(manifest.layers.environment.src) }, innerPanel: { src: uiAsset(manifest.layers.innerPanel.src) } },
          animations: manifest.animations.map(animation => ({ ...animation, src: uiAsset(animation.src) })),
        };
      })(),
      (async () => {
        if (!materialId) return;
        const material = await json(`/api/v1/materials/${encodeURIComponent(materialId)}`) as { kind: string; mimeType?: string; url: string };
        if (material.kind === 'image') await image(material.url);
        else if (material.mimeType !== 'text/plain') {
          const page = await json(`/api/v1/materials/${encodeURIComponent(materialId)}/pages/1`) as { image: string };
          await image(page.image);
        }
      })(),
      ]),
    ]);
    if (scene) decodedSceneAssets.set(scene, decodedImages);
    return scene;
  } finally { clearTimeout(timeout); controller.abort(); }
}

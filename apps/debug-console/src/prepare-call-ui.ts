import { uiAsset } from './ui-asset';

let scenePreparation: Promise<void> | undefined;

/** Start on the desk; concurrent calls share assets and failures remain retryable. */
export function warmCallUi(): Promise<void> {
  if (!scenePreparation) scenePreparation = loadCallUi().catch(error => {
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

async function loadCallUi(materialId?: string, includeScene = true): Promise<void> {
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
      const finish = (error?: Error) => {
        controller.signal.removeEventListener('abort', abort);
        img.onload = null; img.onerror = null;
        if (error) { img.src = ''; reject(error); } else resolve();
      };
      const abort = () => finish(new Error('通话资源加载超时，请重新呼叫。'));
      if (controller.signal.aborted) { abort(); return; }
      controller.signal.addEventListener('abort', abort, { once: true });
      img.onload = () => finish();
      img.onerror = () => finish(new Error('场景或附件加载失败，请重新呼叫。'));
      img.src = src;
    });
  }
  try {
    await Promise.race([
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('通话资源加载超时，请重新呼叫。')), { once: true })),
      Promise.all([
      includeScene ? import('./voice-glass-stack.js').then(renderer => renderer.prepareGlassStack()) : Promise.resolve(),
      (async () => {
        if (!includeScene) return;
        const manifest = await json('/animations/fox-clerk/manifest.json') as {
          layers: Record<string, { src?: string }>; animations: { src: string }[];
        };
        await Promise.all([...Object.values(manifest.layers), ...manifest.animations].flatMap(item => item.src ? [image(uiAsset(item.src))] : []));
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
  } finally { clearTimeout(timeout); controller.abort(); }
}

import { useEffect, useState } from 'react';
import type { Material, PanelAttachment } from '@bio/contracts';

/** Revalidate old history cards as well as the currently displayed attachment. */
export function useMaterialOriginal(attachment: PanelAttachment) {
  const id = attachment.url?.match(/\/api\/v1\/materials\/([0-9a-f-]{36})\/file$/)?.[1];
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{ material?: Material; originalStatus?: PanelAttachment['originalStatus']; error: string; loading: boolean }>({ error: '', loading: true });
  useEffect(() => {
    const controller = new AbortController();
    const deleted = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) return;
      controller.abort();
      setValue({ originalStatus: 'deleted', error: '', loading: false });
    };
    window.addEventListener('bio-material-deleted', deleted);
    setValue({ originalStatus: attachment.originalStatus, error: '', loading: !!id && !attachment.originalStatus });
    if (id && !attachment.originalStatus) void fetch(`/api/v1/materials/${id}`, { signal: controller.signal }).then(async response => {
      if (response.status === 410 || response.status === 404) {
        if (!controller.signal.aborted) setValue({ originalStatus: response.status === 410 ? 'deleted' : 'unavailable', error: '', loading: false });
        return;
      }
      if (!response.ok) throw new Error('资料加载失败');
      const material = await response.json() as Material;
      if (!controller.signal.aborted) setValue({ material, error: '', loading: false });
    }).catch(() => { if (!controller.signal.aborted) setValue({ error: '资料加载失败', loading: false }); });
    return () => { controller.abort(); window.removeEventListener('bio-material-deleted', deleted); };
  }, [id, attachment.originalStatus, revision]);
  return { ...value, id, retry: () => setRevision(value => value + 1) };
}

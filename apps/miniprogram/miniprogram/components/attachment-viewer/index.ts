import { authHeader, handleUnauthorized } from '../../lib/account';
import type { Material, PanelAttachment } from '@bio/contracts';
const base = () => getApp<IAppOption>().globalData.apiBaseUrl;
Component({
  properties: { attachment: { type: Object, value: {} }, focused: { type: Boolean, value: false } },
  data: { generation: 0, dead: false, path: '', attachmentKey: '', lastTap: 0, tapX: 0, tapY: 0, image: '', text: '', page: 1, count: 0, loading: true, error: '', originalStatus: '' },
  observers: { focused() { this.data.lastTap = 0; }, attachment(value: PanelAttachment | null) { const key = `${value?.id || ''}:${value?.originalStatus || ''}`; if (key !== this.data.attachmentKey) { this.data.attachmentKey = key; this.setData({ page: 1 }); void this.load(); } } },
  lifetimes: { detached() { this.data.dead = true; this.data.generation++; this.cleanup(); } },
  pageLifetimes: { show() { void this.load(); } },
  methods: {
    cleanup() { if (this.data.path) wx.getFileSystemManager().unlink({ filePath: this.data.path }); this.data.path = ''; },
    async load() {
      const id = (this.properties.attachment as PanelAttachment | null)?.url?.match(/\/materials\/([0-9a-f-]{36})\/file$/)?.[1];
      const generation = ++this.data.generation;
      this.data.lastTap = 0;
      this.cleanup();
      const originalStatus = (this.properties.attachment as PanelAttachment | null)?.originalStatus || '';
      this.setData({ loading: true, error: '', image: '', text: '', count: 0, originalStatus });
      if (originalStatus) { this.setData({ loading: false }); return; }
      if (!id) { this.setData({ loading: false, error: '此附件暂不支持预览' }); return; }
      try {
        const item = await this.request<Material>(`/materials/${id}`);
        if (this.data.dead || generation !== this.data.generation) return;
        if (item.mimeType === 'text/plain') { this.setData({ text: item.text, count: 1 }); return; }
        let path: string;
        if (item.kind === 'image') {
          path = await new Promise<string>((resolve, reject) => wx.downloadFile({ url: `${base()}/materials/${id}/file`, header: authHeader(), success: value => { handleUnauthorized(value.statusCode); value.statusCode === 200 ? resolve(value.tempFilePath) : reject(Object.assign(new Error(), { status: value.statusCode })); }, fail: reject }));
          if (this.data.dead || generation !== this.data.generation) return;
          this.setData({ count: 1 });
        } else {
          const result = await this.request<{ image: string; pageCount: number }>(`/materials/${id}/pages/${this.data.page}`);
          if (this.data.dead || generation !== this.data.generation) return;
          path = `${wx.env.USER_DATA_PATH}/call-file-${Date.now()}-${generation}.webp`;
          await new Promise<void>((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: result.image.split(',')[1]!, encoding: 'base64', success: () => resolve(), fail: reject }));
          if (this.data.dead || generation !== this.data.generation) { wx.getFileSystemManager().unlink({ filePath: path }); return; }
          this.cleanup(); this.data.path = path; this.setData({ count: result.pageCount });
        }
        this.setData({ image: path });
        this.triggerEvent('page', { materialId: id, page: this.data.page });
      } catch (error) {
        if (!this.data.dead && generation === this.data.generation) {
          const status = (error as { status?: number }).status;
          this.setData(status === 410 || status === 404 ? { originalStatus: status === 410 ? 'deleted' : 'unavailable', count: 0 } : { error: '资料暂时无法预览，请重试' });
        }
      }
      finally { if (!this.data.dead && generation === this.data.generation) this.setData({ loading: false }); }
    },
    request<T extends WechatMiniprogram.IAnyObject>(path: string): Promise<T> { return new Promise((resolve, reject) => wx.request<T>({ url: base() + path, header: authHeader(), success: result => { handleUnauthorized(result.statusCode); result.statusCode === 200 ? resolve(result.data) : reject(Object.assign(new Error(), { status: result.statusCode })); }, fail: reject })); },
    turn(event: WechatMiniprogram.TouchEvent) { const page = this.data.page + Number(event.currentTarget.dataset.step); if (!this.data.loading && page >= 1 && page <= this.data.count) { this.setData({ page }); void this.load(); } },
    toggleFocus() { this.triggerEvent('focus'); },
    tap(event: WechatMiniprogram.TouchEvent) {
      if (this.properties.focused || this.data.loading || this.data.error || this.data.originalStatus) return;
      const now = Date.now(), touch = event.changedTouches[0];
      if (!touch) return;
      if (now - this.data.lastTap < 300 && Math.hypot(touch.clientX - this.data.tapX, touch.clientY - this.data.tapY) < 24) {
        this.data.lastTap = 0; this.triggerEvent('focus');
      } else { this.data.lastTap = now; this.data.tapX = touch.clientX; this.data.tapY = touch.clientY; }
    },
  },
});

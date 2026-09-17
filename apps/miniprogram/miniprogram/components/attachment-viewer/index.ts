import { authHeader, handleUnauthorized } from '../../lib/account';
import type { Material, PanelAttachment } from '@bio/contracts';
const base = () => getApp<IAppOption>().globalData.apiBaseUrl;
Component({
  properties: { attachment: { type: Object, value: {} }, focused: { type: Boolean, value: false } },
  data: { generation: 0, dead: false, path: '', attachmentKey: '', currentScale: 1, lastTap: 0, image: '', text: '', page: 1, count: 0, loading: true, error: '', scale: 1, x: 0, y: 0, width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 },
  observers: { focused() { wx.nextTick(() => this.fitImage()); }, attachment(value: PanelAttachment | null) { if (value?.id !== this.data.attachmentKey) { this.data.attachmentKey = value?.id || ''; this.setData({ page: 1 }); void this.load(); } } },
  lifetimes: { detached() { this.data.dead = true; this.data.generation++; this.cleanup(); } },
  methods: {
    cleanup() { if (this.data.path) wx.getFileSystemManager().unlink({ filePath: this.data.path }); this.data.path = ''; },
    async load() {
      const id = (this.properties.attachment as PanelAttachment | null)?.url?.match(/\/materials\/([0-9a-f-]{36})\/file$/)?.[1];
      const generation = ++this.data.generation;
      this.data.currentScale = 1;
      this.setData({ loading: true, error: '', image: '', text: '', scale: 1, x: 0, y: 0 });
      if (!id) { this.setData({ loading: false, error: '此附件暂不支持预览' }); return; }
      try {
        const item = await this.request<Material>(`/materials/${id}`);
        if (this.data.dead || generation !== this.data.generation) return;
        if (item.mimeType === 'text/plain') { this.setData({ text: item.text, count: 1 }); return; }
        let path: string;
        if (item.kind === 'image') {
          path = await new Promise<string>((resolve, reject) => wx.downloadFile({ url: `${base()}/materials/${id}/file`, header: authHeader(), success: value => { handleUnauthorized(value.statusCode); value.statusCode === 200 ? resolve(value.tempFilePath) : reject(new Error()); }, fail: reject }));
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
      } catch { if (!this.data.dead && generation === this.data.generation) this.setData({ error: '资料暂时无法预览，请重试' }); }
      finally { if (!this.data.dead && generation === this.data.generation) this.setData({ loading: false }); }
    },
    request<T extends WechatMiniprogram.IAnyObject>(path: string): Promise<T> { return new Promise((resolve, reject) => wx.request<T>({ url: base() + path, header: authHeader(), success: result => { handleUnauthorized(result.statusCode); result.statusCode === 200 ? resolve(result.data) : reject(new Error()); }, fail: reject })); },
    turn(event: WechatMiniprogram.TouchEvent) { const page = this.data.page + Number(event.currentTarget.dataset.step); if (!this.data.loading && page >= 1 && page <= this.data.count) { this.setData({ page }); void this.load(); } },
    imageLoaded(event: WechatMiniprogram.CustomEvent) { this.setData({ naturalWidth: event.detail.width, naturalHeight: event.detail.height }); this.fitImage(); },
    fitImage() {
      if (!this.data.naturalWidth) return;
      this.createSelectorQuery().select('.stage').boundingClientRect(rect => {
        const box = rect as WechatMiniprogram.BoundingClientRectCallbackResult;
        if (!box || this.data.dead) return;
        const fit = Math.min(box.width / this.data.naturalWidth, box.height / this.data.naturalHeight);
        const width = this.data.naturalWidth * fit, height = this.data.naturalHeight * fit;
        this.setData({ width, height, x: (box.width - width) / 2, y: (box.height - height) / 2 });
      }).exec();
    },
    toggleFocus() { this.triggerEvent('focus'); },
    onScale(event: WechatMiniprogram.CustomEvent) { this.data.currentScale = event.detail.scale; },
    zoom() { this.setData({ scale: this.data.currentScale > 1 ? 1 : 2.5, }); this.fitImage(); this.data.currentScale = this.data.scale; },
    tap() { const now = Date.now(); if (now - this.data.lastTap < 300) { this.zoom(); this.data.lastTap = 0; } else this.data.lastTap = now; },
  },
});

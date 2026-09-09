import type { Material } from '@bio/contracts';
const base = () => getApp<IAppOption>().globalData.apiBaseUrl;
function request<T extends object = Record<string, unknown>>(path = '', method: 'GET' | 'PUT' | 'DELETE' = 'GET', data?: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => wx.request<T>({ url: `${base()}/materials${path}`, method, ...(data ? { data } : {}),
    success: result => result.statusCode >= 200 && result.statusCode < 300 ? resolve(result.data) : reject(new Error('资料操作失败，请重试')),
    fail: () => reject(new Error('网络连接失败，请重试')),
  }));
}
Page({
  unloaded: false,
  data: { items: [] as Material[], selected: null as Material | null, title: '', description: '', busy: false, loading: true, error: '', previewUrl: '' },
  onLoad() { void this.refresh(); },
  onUnload() { this.unloaded = true; },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try { const items = await request<Material[]>(); if (!this.unloaded) this.setData({ items }); }
    catch { if (!this.unloaded) this.setData({ error: '暂时无法打开资料夹，请重试。' }); }
    finally { if (!this.unloaded) this.setData({ loading: false }); }
  },
  select(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.items.find(value => value.id === event.currentTarget.dataset.id);
    if (item) this.showItem(item);
  },
  showItem(item: Material) { this.setData({ selected: item, title: item.title, description: item.description, previewUrl: `${base()}/materials/${item.id}/file`, error: '' }); },
  back() { this.setData({ selected: null, error: '' }); },
  titleInput(event: WechatMiniprogram.Input) { this.setData({ title: event.detail.value }); },
  descriptionInput(event: WechatMiniprogram.Input) { this.setData({ description: event.detail.value }); },
  add() {
    if (this.data.busy) return;
    wx.showActionSheet({ itemList: ['从相册选择照片', '从微信聊天选择文件'], success: result => {
      if (result.tapIndex === 0) wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], success: result => {
        const file = result.tempFiles[0]; if (file) this.upload(file.tempFilePath, file.size);
      } });
      else wx.chooseMessageFile({ count: 1, type: 'file', extension: ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'docx', 'txt', 'md'], success: result => {
        const file = result.tempFiles[0]; if (file) this.upload(file.path, file.size, file.name);
      } });
    } });
  },
  upload(path: string, size: number, name?: string) {
    if (size > 20 * 1024 * 1024) { this.setData({ error: '每份文件不能超过 20 MB' }); return; }
    // wx.uploadFile derives multipart filename from filePath. Preserve the selected extension.
    const filename = (name || path.split('/').pop() || '照片.jpg').replace(/[^\p{L}\p{N}._ -]/gu, '_');
    const uploadPath = `${wx.env.USER_DATA_PATH}/${Date.now()}-${filename}`;
    this.setData({ busy: true, error: '' });
    wx.getFileSystemManager().copyFile({ srcPath: path, destPath: uploadPath, success: () => {
      wx.uploadFile({ url: `${base()}/materials`, filePath: uploadPath, name: 'file', timeout: 180000,
        success: result => {
          if (this.unloaded) return;
          try {
            const body = JSON.parse(result.data);
            if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(body.message || '上传失败');
            this.showItem(body as Material); void this.refresh();
          } catch (e) { this.setData({ error: e instanceof Error ? e.message : '上传失败，请重试' }); }
        }, fail: () => { if (!this.unloaded) this.setData({ error: '上传失败，请重试' }); },
        complete: () => { wx.getFileSystemManager().unlink({ filePath: uploadPath }); if (!this.unloaded) this.setData({ busy: false }); },
      });
    }, fail: () => this.setData({ busy: false, error: '无法读取所选文件，请重试' }) });
  },
  async save() {
    const item = this.data.selected;
    if (!item || this.data.busy || !this.data.title.trim()) return;
    this.setData({ busy: true, error: '' });
    try {
      const saved = await request<Material>(`/${item.id}`, 'PUT', { title: this.data.title, description: this.data.description });
      if (!this.unloaded) { this.showItem(saved); await this.refresh(); wx.showToast({ title: '已保存' }); }
    } catch { if (!this.unloaded) this.setData({ error: '保存失败，请重试' }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  preview() {
    const item = this.data.selected; if (!item) return;
    if (item.kind === 'image') { wx.previewImage({ urls: [this.data.previewUrl] }); return; }
    if (/\.(txt|md)$/i.test(item.filename)) { wx.showModal({ title: item.title, content: item.text.slice(0, 3000) || '没有可显示的正文', showCancel: false }); return; }
    wx.downloadFile({ url: this.data.previewUrl, success: result => {
      if (result.statusCode !== 200) { this.setData({ error: '原件下载失败' }); return; }
      wx.openDocument({ filePath: result.tempFilePath, fileType: item.filename.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx', showMenu: true, fail: () => this.setData({ error: '原件暂时无法打开' }) });
    }, fail: () => this.setData({ error: '原件下载失败' }) });
  },
  chat() {
    const item = this.data.selected; if (!item || this.data.busy) return;
    wx.navigateTo({ url: `/pages/chat/index?materialId=${item.id}&title=${encodeURIComponent(item.title)}` });
  },
  remove() {
    const item = this.data.selected; if (!item || this.data.busy) return;
    wx.showModal({ title: '删除这份资料？', content: '删除后无法恢复原件。', confirmText: '删除', success: async result => {
      if (!result.confirm) return;
      this.setData({ busy: true });
      try { await request(`/${item.id}`, 'DELETE'); if (!this.unloaded) { this.back(); await this.refresh(); } }
      catch { if (!this.unloaded) this.setData({ error: '删除失败，请重试' }); }
      finally { if (!this.unloaded) this.setData({ busy: false }); }
    } });
  },
});

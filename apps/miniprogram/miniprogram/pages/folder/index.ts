import type { Material } from '@bio/contracts';
import { authHeader, requireAccount, handleUnauthorized } from '../../lib/account';
const base = () => getApp<IAppOption>().globalData.apiBaseUrl;
type MaterialCard = Material & { fileType: string; sizeLabel: string };
function request<T extends object = Record<string, unknown>>(path = '', method: 'GET' | 'PUT' | 'DELETE' = 'GET', data?: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => wx.request<T>({ url: `${base()}/materials${path}`, method, header: authHeader(), ...(data ? { data } : {}),
    success: result => { handleUnauthorized(result.statusCode); result.statusCode >= 200 && result.statusCode < 300 ? resolve(result.data) : reject(new Error('资料操作失败，请重试')); },
    fail: () => reject(new Error('网络连接失败，请重试')),
  }));
}
Page({
  unloaded: false,
  thumbnailGeneration: 0,
  pdfGeneration: 0,
  pdfPath: '',
  suppressTapUntil: 0,
  filterTimer: null as ReturnType<typeof setTimeout> | null,
  data: { pdfPage: 1, pdfCount: 0, pdfLoading: false, pdfError: '', pdfUrl: '', actionItem: null as MaterialCard | null, statusBarHeight: 24, navigationHeight: 44, navigationRight: 100, searchOpen: false, leaving: false, tabIndex: 0, renderedFilter: 'all', renderedQuery: '', query: '', filter: 'all', visibleItems: [] as MaterialCard[], imageCount: 0, documentCount: 0, items: [] as MaterialCard[], thumbnails: {} as Record<string, string>, selected: null as Material | null, busy: false, loading: true, error: '', previewUrl: '' },
  async onLoad() {
    const window = wx.getWindowInfo();
    const capsule = wx.getMenuButtonBoundingClientRect();
    const statusBarHeight = window.statusBarHeight || 24;
    this.setData({ statusBarHeight, navigationHeight: capsule.height > 0 ? (capsule.top - statusBarHeight) * 2 + capsule.height : 44, navigationRight: capsule.width > 0 ? window.windowWidth - capsule.left + 8 : 100 });
    if (await requireAccount()) void this.refresh();
  },
  exitFolder() { if (this.data.busy) return; if (this.data.selected) { this.back(); return; } if (this.data.searchOpen) { this.toggleSearch(); return; } wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/character/index' }) }); },
  onUnload() { this.unloaded = true; this.clearPdf(); if (this.filterTimer) clearTimeout(this.filterTimer); },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const materials = await request<Material[]>();
      const items = materials.map(item => ({ ...item, fileType: item.filename.split('.').pop()?.toUpperCase() || '文件', sizeLabel: item.size >= 1048576 ? `${(item.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(item.size / 1024))} KB` }));
      if (!this.unloaded) { this.setData({ items, imageCount: items.filter(item => item.kind === 'image').length, documentCount: items.filter(item => item.kind === 'document').length }); this.applyFilter(); void this.loadThumbnails(items); }
    }
    catch { if (!this.unloaded) this.setData({ error: '暂时无法打开资料夹，请重试。' }); }
    finally { if (!this.unloaded) this.setData({ loading: false }); }
  },
  async loadThumbnails(items: Material[]) {
    const generation = ++this.thumbnailGeneration;
    const pending = items.filter(item => item.thumbnailUrl || item.kind === 'image');
    const worker = async () => {
      while (pending.length && !this.unloaded && generation === this.thumbnailGeneration) {
        const item = pending.shift()!;
        await new Promise<void>(resolve => wx.downloadFile({ url: `${base()}/materials/${item.id}/${item.thumbnailUrl ? 'thumbnail' : 'file'}`, header: authHeader(),
          success: result => {
            handleUnauthorized(result.statusCode);
            if (result.statusCode === 200 && !this.unloaded && generation === this.thumbnailGeneration) this.setData({ [`thumbnails.${item.id}`]: result.tempFilePath });
          }, complete: () => resolve(),
        }));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  },
  applyFilter() { this.setData({ visibleItems: this.data.items.filter(item => (!this.data.searchOpen || !!this.data.renderedQuery.trim()) && (this.data.searchOpen || this.data.renderedFilter === 'all' || item.kind === this.data.renderedFilter) && `${item.title} ${item.filename}`.toLowerCase().includes(this.data.renderedQuery.trim().toLowerCase())) }); },
  toggleSearch() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.setData({ searchOpen: !this.data.searchOpen, selected: null, query: '', renderedQuery: '', renderedFilter: this.data.filter, leaving: false });
    this.applyFilter();
  },
  searchInput(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value });
    if (!event.detail.value.trim()) { this.searchNow(); return; }
    this.transitionFilter();
  },
  searchNow() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.setData({ query: this.data.query.trim(), renderedQuery: this.data.query.trim(), renderedFilter: this.data.filter, leaving: false });
    this.applyFilter();
  },
  changeFilter(event: WechatMiniprogram.TouchEvent) { const filter = event.currentTarget.dataset.filter; if (!['all', 'image', 'document'].includes(filter) || filter === this.data.filter) return; this.setData({ filter, tabIndex: ['all', 'image', 'document'].indexOf(filter) }); this.transitionFilter(); },
  transitionFilter() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.setData({ leaving: !this.data.searchOpen });
    this.filterTimer = setTimeout(() => {
      if (this.unloaded) return;
      this.setData({ renderedFilter: this.data.filter, renderedQuery: this.data.query });
      this.applyFilter();
      this.setData({ leaving: false });
      this.filterTimer = null;
    }, this.data.searchOpen ? 1000 : 150);
  },
  fileActions(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.leaving) return;
    const item = this.data.items.find(value => value.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.suppressTapUntil = Date.now() + 800;
    this.setData({ actionItem: item });
  },
  dismissActions() { this.setData({ actionItem: null }); },
  keepActions() {},
  chooseAction(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.actionItem;
    if (!item || this.data.busy || this.unloaded) return;
    this.dismissActions();
    const action = event.currentTarget.dataset.action;
    if (action === 'preview') { if (this.data.searchOpen) this.toggleSearch(); this.showItem(item); }
    else if (action === 'chat') wx.navigateTo({ url: `/pages/chat/index?mode=call&materialId=${item.id}&title=${encodeURIComponent(item.title)}` });
    else if (action === 'delete') this.removeItem(item);
  },
  select(event: WechatMiniprogram.TouchEvent) {
    if (Date.now() < this.suppressTapUntil) return;
    const item = this.data.items.find(value => value.id === event.currentTarget.dataset.id);
    if (item) { if (this.data.searchOpen) this.toggleSearch(); this.showItem(item); }
  },
  showItem(item: Material) {
    this.clearPdf();
    this.setData({ selected: item, previewUrl: '', error: '', pdfPage: 1, pdfCount: item.pageCount || 0, pdfUrl: '', pdfError: '' });
    if (item.mimeType === 'application/pdf') void this.loadPdfPage(1);
    if (item.kind === 'image') wx.downloadFile({ url: `${base()}/materials/${item.id}/file`, header: authHeader(), success: result => {
      handleUnauthorized(result.statusCode);
      if (!this.unloaded && this.data.selected?.id === item.id && result.statusCode === 200) this.setData({ previewUrl: result.tempFilePath });
    } });
  },
  clearPdf() {
    this.pdfGeneration++;
    if (this.pdfPath) wx.getFileSystemManager().unlink({ filePath: this.pdfPath });
    this.pdfPath = '';
  },
  async loadPdfPage(page: number) {
    const item = this.data.selected;
    if (!item || item.mimeType !== 'application/pdf') return;
    const generation = ++this.pdfGeneration;
    this.setData({ pdfPage: page, pdfLoading: true, pdfError: '', pdfUrl: '' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    try {
      const result = await request<{ image: string; pageCount: number }>(`/${item.id}/pages/${page}`);
      if (this.unloaded || generation !== this.pdfGeneration) return;
      const path = `${wx.env.USER_DATA_PATH}/pdf-preview-${Date.now()}-${generation}.webp`;
      await new Promise<void>((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: result.image.split(',')[1]!, encoding: 'base64', success: () => resolve(), fail: reject }));
      if (this.unloaded || generation !== this.pdfGeneration) { wx.getFileSystemManager().unlink({ filePath: path }); return; }
      if (this.pdfPath) wx.getFileSystemManager().unlink({ filePath: this.pdfPath });
      this.pdfPath = path;
      this.setData({ pdfUrl: path, pdfCount: result.pageCount });
    } catch { if (!this.unloaded && generation === this.pdfGeneration) this.setData({ pdfError: '这一页暂时未能加载' }); }
    finally { if (!this.unloaded && generation === this.pdfGeneration) this.setData({ pdfLoading: false }); }
  },
  turnPdf(event: WechatMiniprogram.TouchEvent) {
    const page = this.data.pdfPage + Number(event.currentTarget.dataset.step);
    if (!this.data.pdfLoading && page >= 1 && page <= this.data.pdfCount) void this.loadPdfPage(page);
  },
  retryPdf() { if (!this.data.pdfLoading) void this.loadPdfPage(this.data.pdfPage); },
  back() { if (!this.data.busy) { this.clearPdf(); this.setData({ selected: null, error: '' }); } },
  add() {
    if (this.data.busy) return;
    wx.showActionSheet({ itemList: ['从相册选择照片', '从微信聊天选择文件'], success: result => {
      if (result.tapIndex === 0) wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], success: result => {
        const file = result.tempFiles[0]; if (file) this.upload(file.tempFilePath, file.size);
      } });
      else wx.chooseMessageFile({ count: 1, type: 'file', extension: ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'md'], success: result => {
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
      wx.uploadFile({ url: `${base()}/materials`, filePath: uploadPath, name: 'file', timeout: 180000, header: authHeader(),
        success: result => {
          handleUnauthorized(result.statusCode);
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
  preview() {
    const item = this.data.selected; if (!item) return;
    if (item.kind === 'image') { if (this.data.previewUrl) wx.previewImage({ urls: [this.data.previewUrl] }); return; }
    if (/\.(txt|md)$/i.test(item.filename)) { wx.showModal({ title: item.title, content: item.text.slice(0, 3000) || '没有可显示的正文', showCancel: false }); return; }
    wx.downloadFile({ url: `${base()}/materials/${item.id}/file`, header: authHeader(), success: result => {
      handleUnauthorized(result.statusCode);
      if (result.statusCode !== 200) { this.setData({ error: '原件下载失败' }); return; }
      wx.openDocument({ filePath: result.tempFilePath, fileType: item.filename.toLowerCase().endsWith('.pdf') ? 'pdf' : item.filename.toLowerCase().endsWith('.doc') ? 'doc' : 'docx', showMenu: true, fail: () => this.setData({ error: '原件暂时无法打开' }) });
    }, fail: () => this.setData({ error: '原件下载失败' }) });
  },
  chat() {
    const item = this.data.selected; if (!item || this.data.busy) return;
    wx.navigateTo({ url: `/pages/chat/index?mode=call&materialId=${item.id}&title=${encodeURIComponent(item.title)}` });
  },
  remove() {
    const item = this.data.selected; if (item) this.removeItem(item);
  },
  removeItem(item: Material) {
    if (this.data.busy) return;
    wx.showModal({ title: '删除这份资料？', content: `删除「${item.title}」后无法恢复原件。`, confirmText: '删除', success: async result => {
      if (!result.confirm || this.unloaded || this.data.busy) return;
      this.setData({ busy: true });
      try { await request(`/${item.id}`, 'DELETE'); if (!this.unloaded) { this.setData({ selected: null, error: '' }); await this.refresh(); } }
      catch { if (!this.unloaded) this.setData({ error: '删除失败，请重试' }); }
      finally { if (!this.unloaded) this.setData({ busy: false }); }
    } });
  },
});

import type { FoxActivity } from '../../lib/fox-behavior';
import { getLatestReceipt, takePendingReceipt, type SessionReceipt } from '../../lib/session-receipt';
import {
  FOX_ANIMATION_CLIPS,
  FoxAnimationController,
  type FoxActionId,
  type FoxAnimationState,
} from '../../lib/fox-animation-controller';

const ENVIRONMENT_SRC = '/assets/animations/fox-clerk/environment.webp';
const INNER_PANEL_SRC = '/assets/animations/fox-clerk/inner-panel.webp';

let animationController: FoxAnimationController | null = null;

Page({
  unloaded: false,
  receiptCloseTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  receiptPrintTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  data: {
    receipt: null as SessionReceipt | null,
    receiptVisible: false,
    receiptClosing: false,
    receiptFinished: false,
    activeDrawer: '',
    environmentSrc: ENVIRONMENT_SRC,
    innerPanelSrc: INNER_PANEL_SRC,
    blinkSrc: FOX_ANIMATION_CLIPS.blink.src,
    talkSrc: FOX_ANIMATION_CLIPS.talk.src,
    waveSrc: FOX_ANIMATION_CLIPS.wave.src,
    noteSrc: FOX_ANIMATION_CLIPS.note.src,
    nodSrc: FOX_ANIMATION_CLIPS.nod.src,
    notebookTalkSrc: FOX_ANIMATION_CLIPS.notebookTalk.src,
    notebookTalkLeftPercent: 0,
    notebookTalkTopPercent: 0,
    noteLeftPercent: 0,
    noteTopPercent: 0,
    nodLeftPercent: 0,
    nodTopPercent: 0,
    activeAction: 'wave' as FoxActionId,
    blinkLeftPercent: 0,
    blinkTopPercent: 0,
    talkLeftPercent: 0,
    talkTopPercent: 0,
    waveLeftPercent: 0,
    waveTopPercent: 0,
  },

  onLoad(): void {
    this.unloaded = false;
    animationController = new FoxAnimationController((state) => this.renderAnimationState(state));
    animationController.startAutoCycle();
  },

  onShow(): void {
    animationController?.resume();
    const pending = takePendingReceipt();
    if (pending) this.openReceipt();
    else this.setData({ receipt: getLatestReceipt() });

  },

  onHide(): void {
    animationController?.suspend();
  },

  onUnload(): void {
    this.unloaded = true;
    clearTimeout(this.receiptCloseTimer);
    clearTimeout(this.receiptPrintTimer);
    animationController?.destroy();
    animationController = null;
  },

  openReceipt(): void {
    clearTimeout(this.receiptCloseTimer);
    clearTimeout(this.receiptPrintTimer);
    this.setData({ receipt: getLatestReceipt(), receiptVisible: true, receiptClosing: false, receiptFinished: false }, () => {
      this.receiptPrintTimer = setTimeout(() => this.onReceiptPrinted(), 4200);
    });
  },

  onReceiptPrinted(): void {
    if (!this.unloaded && this.data.receiptVisible && !this.data.receiptClosing) this.setData({ receiptFinished: true });
  },

  closeReceipt(): void {
    if (this.data.receiptClosing) return;
    clearTimeout(this.receiptPrintTimer);
    this.setData({ receiptClosing: true });
    this.receiptCloseTimer = setTimeout(() => {
      if (!this.unloaded) this.setData({ receiptVisible: false, receiptClosing: false });
    }, 360);
  },

  openFolder(): void {
    wx.navigateTo({ url: '/pages/folder/index' });
  },

  openManuscripts(): void {
    this.setData({ activeDrawer: 'manuscripts' });
  },

  closeDrawer(): void {
    this.setData({ activeDrawer: '' });
  },

  keepDrawerOpen(): void {
    // Keep taps inside the sheet from reaching its dismissible backdrop.
  },

  callLingli(): void {
    wx.navigateTo({
      url: '/pages/chat/index?mode=call',
      success: () => this.closeDrawer(),
      fail: () => wx.showToast({ title: '暂时无法打开聊天，请再试一次', icon: 'none' }),
    });
  },

  renderAnimationState(state: FoxAnimationState): void {
    const column = state.frame % state.action.columns;
    const row = Math.floor(state.frame / state.action.columns);
    this.setData({
      activeAction: state.action.id,
      [`${state.action.id}LeftPercent`]: column * -100,
      [`${state.action.id}TopPercent`]: row * -100,
    });
  },

  updateCharacterActivity(activity: FoxActivity): void {
    animationController?.setActivity(activity);
  },

  playCharacterAction(action: FoxActionId): void {
    animationController?.playAction(action);
  },
});

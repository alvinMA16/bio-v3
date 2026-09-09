import type { FoxActivity } from '../../lib/fox-behavior';
import { getLatestReceipt, takePendingReceipt, summarizeReceipt, type SessionReceipt } from '../../lib/session-receipt';
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
  data: {
    receipt: null as SessionReceipt | null,
    receiptVisible: false,
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
    this.setData({ receipt: getLatestReceipt(), ...(pending ? { receiptVisible: true } : {}) });
    if (pending) {
      summarizeReceipt(pending.receipt, pending.messages, receipt => {
        if (!this.unloaded) this.setData({ receipt });
      });
    }
  },

  onHide(): void {
    animationController?.suspend();
  },

  onUnload(): void {
    this.unloaded = true;
    animationController?.destroy();
    animationController = null;
  },

  openReceipt(): void {
    this.setData({ receipt: getLatestReceipt(), receiptVisible: true });
  },

  closeReceipt(): void {
    this.setData({ receiptVisible: false });
  },

  openFolder(): void {
    this.setData({ activeDrawer: 'folder' });
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

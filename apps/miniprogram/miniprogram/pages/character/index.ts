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
  data: {
    environmentSrc: ENVIRONMENT_SRC,
    innerPanelSrc: INNER_PANEL_SRC,
    spriteSrc: FOX_ANIMATION_CLIPS.blink.src,
    sheetWidthPercent: FOX_ANIMATION_CLIPS.blink.columns * 100,
    sheetHeightPercent: FOX_ANIMATION_CLIPS.blink.rows * 100,
    sheetLeftPercent: 0,
    sheetTopPercent: 0,
  },

  onLoad(): void {
    animationController = new FoxAnimationController((state) => this.renderAnimationState(state));
    animationController.startAutoCycle();
  },

  onShow(): void {
    animationController?.resume();
  },

  onHide(): void {
    animationController?.suspend();
  },

  onUnload(): void {
    animationController?.destroy();
    animationController = null;
  },

  renderAnimationState(state: FoxAnimationState): void {
    const column = state.frame % state.action.columns;
    const row = Math.floor(state.frame / state.action.columns);
    this.setData({
      spriteSrc: state.action.src,
      sheetWidthPercent: state.action.columns * 100,
      sheetHeightPercent: state.action.rows * 100,
      sheetLeftPercent: column * -100,
      sheetTopPercent: row * -100,
    });
  },

  playCharacterAction(action: FoxActionId): void {
    animationController?.playAction(action);
  },
});

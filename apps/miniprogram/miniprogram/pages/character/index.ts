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
    blinkSrc: FOX_ANIMATION_CLIPS.blink.src,
    talkSrc: FOX_ANIMATION_CLIPS.talk.src,
    waveSrc: FOX_ANIMATION_CLIPS.wave.src,
    activeAction: 'wave' as FoxActionId,
    blinkLeftPercent: 0,
    blinkTopPercent: 0,
    talkLeftPercent: 0,
    talkTopPercent: 0,
    waveLeftPercent: 0,
    waveTopPercent: 0,
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
      activeAction: state.action.id,
      [`${state.action.id}LeftPercent`]: column * -100,
      [`${state.action.id}TopPercent`]: row * -100,
    });
  },

  playCharacterAction(action: FoxActionId): void {
    animationController?.playAction(action);
  },
});

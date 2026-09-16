import { FOX_ANIMATION_CLIPS, type FoxActionId, type FoxAnimationState } from './fox-animation-controller';

/** Keep the previous actor visible until the requested sheet has loaded. */
export class FoxFrameGate {
  private ready = new Set<FoxActionId>();
  private requested: FoxAnimationState | undefined;
  private displayed: FoxAnimationState | undefined;

  request(state: FoxAnimationState): FoxAnimationState | undefined {
    this.requested = state;
    return this.resolve();
  }

  loaded(id: FoxActionId): FoxAnimationState | undefined {
    this.ready.add(id);
    if (!this.displayed) this.displayed = {
      action: FOX_ANIMATION_CLIPS[id], frame: ['note', 'nod', 'notebookTalk'].includes(id) ? 1 : 0,
      playing: false, phase: 'idle',
    };
    return this.resolve();
  }

  private resolve(): FoxAnimationState | undefined {
    if (this.requested && this.ready.has(this.requested.action.id)) this.displayed = this.requested;
    return this.displayed;
  }
}

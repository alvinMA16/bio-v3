export const FOX_ACTION_ORDER = ['blink', 'talk', 'wave'] as const;

export type FoxActionId = (typeof FOX_ACTION_ORDER)[number];

export interface FoxAnimationClip {
  id: FoxActionId;
  name: string;
  src: string;
  frameCount: number;
  columns: number;
  rows: number;
  fps: number;
}

export interface FoxAnimationState {
  action: FoxAnimationClip;
  frame: number;
  playing: boolean;
  autoCycle: boolean;
}

export const FOX_ANIMATION_CLIPS: Record<FoxActionId, FoxAnimationClip> = {
  blink: {
    id: 'blink',
    name: '眨眼',
    src: '/assets/animations/fox-clerk/blink.webp',
    frameCount: 9,
    columns: 4,
    rows: 3,
    fps: 8,
  },
  talk: {
    id: 'talk',
    name: '说话',
    src: '/assets/animations/fox-clerk/talk.webp',
    frameCount: 13,
    columns: 4,
    rows: 4,
    fps: 6,
  },
  wave: {
    id: 'wave',
    name: '挥手',
    src: '/assets/animations/fox-clerk/wave.webp',
    frameCount: 12,
    columns: 4,
    rows: 3,
    fps: 5,
  },
};

type StateListener = (state: FoxAnimationState) => void;

const ACTION_TRANSITION_PAUSE_MS = 420;

/**
 * Owns which visual state is shown on the character screen.
 *
 * The current policy cycles blink -> talk -> wave. Call `playAction` later
 * from an Agent event, voice state, or business state to take manual control.
 */
export class FoxAnimationController {
  private actionIndex = 0;
  private frame = 0;
  private playing = false;
  private autoCycle = true;
  private suspended = false;
  private timer: number | undefined;

  constructor(private readonly listener: StateListener) {}

  startAutoCycle(): void {
    this.stopTimer();
    this.autoCycle = true;
    this.playing = true;
    this.actionIndex = 0;
    this.frame = 0;
    this.emit();
    this.scheduleNextFrame();
  }

  playAction(action: FoxActionId): void {
    this.stopTimer();
    this.autoCycle = false;
    this.playing = true;
    this.actionIndex = FOX_ACTION_ORDER.indexOf(action);
    this.frame = 0;
    this.emit();
    this.scheduleNextFrame();
  }

  togglePlayback(): void {
    if (this.playing) {
      this.pause();
      return;
    }

    this.playing = true;
    this.emit();
    this.scheduleNextFrame();
  }

  pause(): void {
    this.playing = false;
    this.stopTimer();
    this.emit();
  }

  suspend(): void {
    this.suspended = true;
    this.stopTimer();
  }

  resume(): void {
    this.suspended = false;
    if (this.playing && this.timer === undefined) this.scheduleNextFrame();
  }

  destroy(): void {
    this.playing = false;
    this.stopTimer();
  }

  private get clip(): FoxAnimationClip {
    const actionId = FOX_ACTION_ORDER[this.actionIndex] ?? FOX_ACTION_ORDER[0];
    return FOX_ANIMATION_CLIPS[actionId];
  }

  private scheduleNextFrame(delayMs = 1000 / this.clip.fps): void {
    if (!this.playing || this.suspended) return;
    this.timer = setTimeout(() => this.advance(), delayMs);
  }

  private advance(): void {
    this.frame += 1;

    if (this.frame < this.clip.frameCount) {
      this.emit();
      this.scheduleNextFrame();
      return;
    }

    this.frame = 0;
    if (this.autoCycle) {
      this.actionIndex = (this.actionIndex + 1) % FOX_ACTION_ORDER.length;
      this.emit();
      this.scheduleNextFrame(ACTION_TRANSITION_PAUSE_MS);
      return;
    }

    this.emit();
    this.scheduleNextFrame();
  }

  private emit(): void {
    this.listener({
      action: this.clip,
      frame: this.frame,
      playing: this.playing,
      autoCycle: this.autoCycle,
    });
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

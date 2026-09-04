export const FOX_ACTION_ORDER = ['blink', 'talk', 'wave'] as const;

export type FoxActionId = (typeof FOX_ACTION_ORDER)[number];
export type FoxAnimationPhase = 'welcome' | 'idle' | 'action';

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
  phase: FoxAnimationPhase;
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
    frameCount: 15,
    columns: 4,
    rows: 4,
    fps: 5,
  },
};

type StateListener = (state: FoxAnimationState) => void;

const IDLE_BLINK_MIN_DELAY_MS = 18_000;
const IDLE_BLINK_MAX_DELAY_MS = 35_000;

/**
 * Drives the character's ambient behavior.
 *
 * The default policy is a one-time welcome wave, a still neutral pose, and an
 * occasional blink. Agent or voice events can call `playAction` at any time;
 * after that one-shot action finishes, the fox returns to the same idle pose.
 */
export class FoxAnimationController {
  private actionId: FoxActionId = 'wave';
  private frame = 0;
  private playing = false;
  private phase: FoxAnimationPhase = 'welcome';
  private suspended = false;
  private timer: number | undefined;

  constructor(private readonly listener: StateListener) {}

  startWelcomeSequence(): void {
    this.startOneShot('wave', 'welcome');
  }

  /** Backward-compatible page entry; the behavior is no longer a cycle. */
  startAutoCycle(): void {
    this.startWelcomeSequence();
  }

  playAction(action: FoxActionId): void {
    this.startOneShot(action, 'action');
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
    if (!this.playing || this.timer !== undefined) return;
    if (this.phase === 'idle') this.scheduleIdleBlink();
    else this.scheduleNextFrame();
  }

  destroy(): void {
    this.playing = false;
    this.stopTimer();
  }

  private get clip(): FoxAnimationClip {
    return FOX_ANIMATION_CLIPS[this.actionId];
  }

  private startOneShot(action: FoxActionId, phase: FoxAnimationPhase): void {
    this.stopTimer();
    this.actionId = action;
    this.frame = 0;
    this.phase = phase;
    this.playing = true;
    this.emit();
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (!this.playing || this.suspended) return;
    this.timer = setTimeout(() => this.advance(), 1000 / this.clip.fps);
  }

  private advance(): void {
    this.timer = undefined;
    this.frame += 1;

    if (this.frame < this.clip.frameCount) {
      this.emit();
      this.scheduleNextFrame();
      return;
    }

    this.settleIdle();
  }

  private settleIdle(): void {
    this.actionId = 'blink';
    this.frame = 0;
    this.phase = 'idle';
    this.emit();
    this.scheduleIdleBlink();
  }

  private scheduleIdleBlink(): void {
    if (!this.playing || this.suspended) return;
    const delay = IDLE_BLINK_MIN_DELAY_MS
      + Math.random() * (IDLE_BLINK_MAX_DELAY_MS - IDLE_BLINK_MIN_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startOneShot('blink', 'action');
    }, delay);
  }

  private emit(): void {
    this.listener({
      action: this.clip,
      frame: this.frame,
      playing: this.playing,
      phase: this.phase,
    });
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

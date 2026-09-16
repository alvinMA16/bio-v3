import { chooseFoxBehavior, continueFoxActivity, DEFAULT_FOX_ACTIVITY, FOX_TIMING, type FoxActivity, type FoxBehavior } from './fox-behavior';

export const FOX_ACTION_ORDER = ['blink', 'talk', 'wave', 'note', 'nod', 'notebookTalk'] as const;

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
  notebookTalk: {
    id: 'notebookTalk',
    name: '拿本子说话',
    src: '/assets/animations/fox-clerk/notebookTalk.webp',
    frameCount: 13,
    columns: 4,
    rows: 4,
    fps: 6,
  },
  note: {
    id: 'note',
    name: '拿本子记笔记',
    src: '/assets/animations/fox-clerk/note.webp',
    frameCount: 13,
    columns: 4,
    rows: 4,
    fps: 5,
  },
  nod: {
    id: 'nod',
    name: '拿本子点头',
    src: '/assets/animations/fox-clerk/nod.webp',
    frameCount: 13,
    columns: 4,
    rows: 4,
    fps: 5,
  },
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

/** Shared playback driver. Hosts provide activity and render emitted frames. */
export class FoxAnimationController {
  private actionId: FoxActionId = 'blink';
  private frame = 0;
  private playing = false;
  private phase: FoxAnimationPhase = 'idle';
  private suspended = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activity: FoxActivity = { ...DEFAULT_FOX_ACTIVITY };
  private behavior: FoxBehavior = chooseFoxBehavior(this.activity);
  private welcomed = false;
  private lastAcknowledged = -Infinity;
  private strokes = 0;
  private listener: StateListener;

  constructor(listener: StateListener) { this.listener = listener; }

  startWelcomeSequence(): void {
    if (this.welcomed) return;
    this.welcomed = true;
    this.playing = true;
    if (this.activity.phase === 'idle' && this.activity.speech === 'silent' && !this.activity.reducedMotion) {
      this.startOneShot('wave', 'welcome');
    } else this.applyBehavior();
  }

  startAutoCycle(): void { this.startWelcomeSequence(); }

  setActivity(activity: FoxActivity): void {
    activity = continueFoxActivity(activity, this.activity);
    const changed = Object.keys(activity).some(key => activity[key as keyof FoxActivity] !== this.activity[key as keyof FoxActivity]);
    const previous = this.behavior;
    this.activity = { ...activity };
    this.behavior = chooseFoxBehavior(activity);
    if (this.playing && (!changed || (this.phase !== 'welcome'
      && previous.action === this.behavior.action && previous.playback === this.behavior.playback
      && this.actionId !== 'nod'))) return;
    this.playing = true;
    this.applyBehavior();
  }

  /** Optional deliberate listening acknowledgment; never inferred from tool success. */
  acknowledge(): void {
    if (this.activity.reducedMotion || this.activity.speech !== 'silent'
      || !['idle', 'waiting', 'listening', 'processing'].includes(this.activity.phase)
      || !this.activity.notebook || Date.now() - this.lastAcknowledged < FOX_TIMING.acknowledgeCooldown) return;
    this.lastAcknowledged = Date.now();
    this.startOneShot('nod', 'action');
  }

  /** Manual preview only; runtime should use setActivity. */
  playAction(action: FoxActionId): void { this.startOneShot(action, 'action'); }

  pause(): void { this.playing = false; this.stopTimer(); this.emit(); }
  suspend(): void { this.suspended = true; this.stopTimer(); }
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.playing) this.applyBehavior();
  }
  destroy(): void { this.playing = false; this.stopTimer(); }
  private get clip(): FoxAnimationClip { return FOX_ANIMATION_CLIPS[this.actionId]; }
  // Notebook sheets have empty-handed bookends. Keep them out of every runtime loop.
  private get firstFrame(): number { return ['note', 'nod', 'notebookTalk'].includes(this.actionId) ? 1 : 0; }
  private get endFrame(): number { return this.clip.frameCount - (this.firstFrame === 1 ? 1 : 0); }

  private startOneShot(action: FoxActionId, phase: FoxAnimationPhase): void {
    this.stopTimer(); this.actionId = action; this.frame = this.firstFrame;
    if (action === 'note' && this.behavior.playback === 'writing') { this.frame = 4; this.strokes = 0; }
    this.phase = phase; this.playing = true; this.emit();
    this.schedule(() => this.advance(), 1000 / this.clip.fps);
  }

  private applyBehavior(): void {
    this.stopTimer();
    this.phase = 'idle'; this.frame = 0;
    this.actionId = this.behavior.playback === 'writing' ? 'notebookTalk' : this.behavior.action;
    this.frame = this.firstFrame;
    this.emit();
    if (this.behavior.playback === 'speech') {
      this.phase = 'action';
      this.schedule(() => this.advance(), 1000 / this.clip.fps);
    } else if (this.behavior.playback === 'writing') {
      this.schedule(() => this.startOneShot('note', 'action'), FOX_TIMING.writingDelay);
    } else this.scheduleAmbient();
  }

  private advance(): void {
    if (this.actionId === 'note' && this.behavior.playback === 'writing') {
      this.strokes++;
      if (this.strokes >= 8 && Date.now() - this.lastAcknowledged >= FOX_TIMING.acknowledgeCooldown) {
        this.lastAcknowledged = Date.now(); this.startOneShot('nod', 'action'); return;
      }
      this.frame = this.frame === 4 ? 1 : 4;
      this.emit();
      this.schedule(() => this.advance(), this.strokes % 8 === 0 ? FOX_TIMING.writingPause : 360);
      return;
    }
    this.frame += 1;
    if (this.frame < this.endFrame) {
      this.emit(); this.schedule(() => this.advance(), 1000 / this.clip.fps); return;
    }
    if (this.behavior.playback === 'speech' && this.actionId === this.behavior.action) {
      this.frame = this.firstFrame; this.emit(); this.schedule(() => this.advance(), 1000 / this.clip.fps);
    } else this.applyBehavior();
  }

  private scheduleAmbient(): void {
    if (this.behavior.playback !== 'ambient') return;
    this.schedule(() => this.startOneShot(this.activity.notebook ? 'nod' : 'blink', 'action'),
      FOX_TIMING.blinkMin + Math.random() * (FOX_TIMING.blinkMax - FOX_TIMING.blinkMin));
  }
  private schedule(callback: () => void, delay: number): void {
    if (!this.playing || this.suspended) return;
    this.timer = setTimeout(() => { this.timer = undefined; callback(); }, delay);
  }
  private emit(): void {
    this.listener({ action: this.clip, frame: this.frame, playing: this.playing, phase: this.phase });
  }
  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

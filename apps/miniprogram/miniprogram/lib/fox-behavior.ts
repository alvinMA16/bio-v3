/** Shared policy; contains no rendering, network, or model calls. */
export interface FoxActivity {
  phase: 'idle' | 'listening' | 'processing' | 'writing';
  notebook: boolean;
  speech: 'silent' | 'text' | 'audio';
  reducedMotion: boolean;
}

export const DEFAULT_FOX_ACTIVITY: FoxActivity = {
  phase: 'idle', notebook: false, speech: 'silent', reducedMotion: false,
};
export const FOX_TIMING = {
  blinkMin: 18_000, blinkMax: 35_000, writingDelay: 450,
  writingPause: 1800, acknowledgeCooldown: 20_000,
};
export type FoxBehaviorAction = 'blink' | 'talk' | 'wave' | 'note' | 'nod' | 'notebookTalk';
export interface FoxBehavior {
  action: FoxBehaviorAction;
  playback: 'still' | 'speech' | 'writing' | 'ambient';
}

export function chooseFoxBehavior(activity: FoxActivity): FoxBehavior {
  const resting = activity.notebook ? 'notebookTalk' : 'blink';
  if (activity.reducedMotion) return { action: resting, playback: 'still' };
  // A user interruption always wins over buffered speech and work events.
  if (activity.phase === 'listening') return { action: resting, playback: 'ambient' };
  if (activity.speech !== 'silent') return {
    action: activity.notebook ? 'notebookTalk' : 'talk', playback: 'speech',
  };
  if (activity.phase === 'writing') return { action: 'note', playback: 'writing' };
  return { action: resting, playback: 'ambient' };
}

import type { PanelState } from '@bio/contracts';
import type { FoxActivity } from '../../miniprogram/miniprogram/lib/fox-behavior';
import type { LiveRun } from './live-run';

/** Translate runtime observations into character activity, independently of rendering. */
export function foxActivityOf({ running, live, panel, audioPlaying, userSpeaking = false }: {
  running: boolean; live: LiveRun; panel: PanelState | undefined;
  /** Omit until audio is connected; false explicitly disables text-based mouth animation. */
  audioPlaying?: boolean; userSpeaking?: boolean;
}): FoxActivity {
  const writing = running && !!live.activeTools?.some(tool => tool.name === 'update_panel_content');
  const message = live.messages.at(-1);
  return {
    phase: userSpeaking ? 'listening' : running ? writing ? 'writing' : 'processing' : 'idle',
    notebook: panel?.mode === 'editor' || writing,
    speech: audioPlaying !== undefined ? audioPlaying ? 'audio' : 'silent'
      : running && message && !message.completed ? 'text' : 'silent',
    reducedMotion: false,
  };
}

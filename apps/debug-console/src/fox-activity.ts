import type { PanelState, VoiceServerMessage } from '@bio/contracts';
import type { FoxActivity } from '../../miniprogram/miniprogram/lib/fox-behavior';
import type { LiveRun } from './live-run';

/** Translate runtime observations into character activity, independently of rendering. */
export function foxActivityOf({ running, live, panel, audioPlaying, userSpeaking = false, voiceState }: {
  running: boolean; live: LiveRun; panel: PanelState | undefined;
  /** Omit until audio is connected; false explicitly disables text-based mouth animation. */
  audioPlaying?: boolean; userSpeaking?: boolean;
  voiceState?: Extract<VoiceServerMessage, { type: 'state' }>['state'];
}): FoxActivity {
  const writing = running && !!live.activeTools?.some(tool => tool.name === 'update_content');
  const reading = running && !!live.activeTools?.some(tool => tool.name === 'get_content');
  const awaitingInput = audioPlaying !== undefined && (voiceState === 'connecting' || voiceState === 'listening');
  const processing = running || (audioPlaying !== undefined && voiceState !== undefined
    && ['finalizing', 'agent', 'synthesizing'].includes(voiceState));
  const message = live.messages.at(-1);
  return {
    phase: userSpeaking || awaitingInput ? 'listening' : processing ? writing ? 'writing' : reading ? 'reading' : 'processing' : 'idle',
    notebook: panel?.mode === 'editor' || writing,
    speech: audioPlaying !== undefined ? audioPlaying ? 'audio' : 'silent'
      : running && message && !message.completed ? 'text' : 'silent',
    reducedMotion: false,
  };
}

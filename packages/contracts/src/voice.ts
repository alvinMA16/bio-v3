import type { AgentEvent, ChatCompletionRequest, ChatCompletionResponse } from './index.js';

export type VoiceRequest = Omit<ChatCompletionRequest, 'message'>;
export type VoiceClientMessage =
  | { type: 'listen'; turnId: string; callId?: string; resume?: boolean; playbackFeedback?: boolean; request: VoiceRequest }
  | { type: 'playback'; turnId: string; playedSamples: number }
  | { type: 'playback.stop'; turnId: string; code: string }
  | { type: 'attachment.view'; turnId: string; view: { materialId: string; page: number } }
  | { type: 'finish'; turnId: string }
  | { type: 'cancel'; turnId: string }
  | { type: 'hangup'; turnId: string }
  | { type: 'disconnect'; turnId: string; reason: 'page_hidden' | 'client_error' };
export type VoiceState = 'connecting' | 'listening' | 'finalizing' | 'agent' | 'synthesizing';
export type VoiceServerMessage = { turnId: string; elapsedMs: number } & (
  | { type: 'connected'; callId: string; conversationId: string; resumed: boolean }
  | { type: 'state'; state: VoiceState }
  | { type: 'asr'; text: string; final: boolean }
  | { type: 'transcript'; text: string }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'result'; result: ChatCompletionResponse }
  | { type: 'audio'; segmentId: number; messageId: string; text: string; data: string; sampleRate: number; endSample?: number }
  | { type: 'segment.end'; segmentId: number }
  | { type: 'done' }
  | { type: 'cancelled'; reason?: string }
  | { type: 'error'; stage: 'asr' | 'agent' | 'tts' | 'transport'; message: string; code?: string; recoverable?: boolean }
);

/** Client acknowledgements describe playback, never user agreement or comprehension. */
export interface VoicePlaybackSnapshot {
  turnId: string;
  runId?: string;
  generated: boolean;
  sentSamples: number;
  playedSamples: number;
  interrupted: boolean;
  lastPlayed?: { segmentId: number; messageId: string; text: string };
}

export interface Recognition { text: string; final: boolean; speechStart?: boolean; error?: boolean }
export interface AsrStream {
  write(pcm: Uint8Array): void;
  finish(): Promise<string>;
  close(): void;
}
export interface AsrProvider {
  open(onResult: (result: Recognition) => void, signal: AbortSignal): Promise<AsrStream>;
}
export interface TtsProvider {
  synthesize(text: string, signal: AbortSignal, onAudio: (pcm: Uint8Array) => void): Promise<void>;
}

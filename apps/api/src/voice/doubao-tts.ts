import { randomUUID } from 'node:crypto';
import type { TtsProvider } from './providers.js';

export class DoubaoTts implements TtsProvider {
  constructor(private config: { appId: string; accessKey: string; resourceId: string; speaker: string }) {}
  async synthesize(text: string, signal: AbortSignal, onAudio: (pcm: Uint8Array) => void): Promise<void> {
    const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      headers: { 'Content-Type': 'application/json', 'X-Api-App-Id': this.config.appId,
        'X-Api-Access-Key': this.config.accessKey, 'X-Api-Resource-Id': this.config.resourceId, 'X-Api-Request-Id': randomUUID() },
      body: JSON.stringify({ user: { uid: 'lingli-voice' }, req_params: {
        text, speaker: this.config.speaker, audio_params: { format: 'pcm', sample_rate: 16000 },
      } }),
    });
    if (!response.ok || !response.body) throw new Error('TTS request failed');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', completed = false;
    const line = (value: string) => {
      if (!value.trim()) return;
      const data = JSON.parse(value) as { code: number; data?: string };
      if (data.code === 20000000) { completed = true; return; }
      if (data.code !== 0) throw new Error(`TTS synthesis failed (${data.code})`);
      if (data.data) {
        const pcm = Buffer.from(data.data, 'base64');
        if (!pcm.length || pcm.length % 2) throw new Error('Invalid TTS PCM');
        onAudio(pcm);
      }
    };
    try {
      while (!completed) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 2 * 1024 * 1024) throw new Error('TTS frame too large');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
        if (chunk.done) { line(buffer); break; }
      }
      if (!completed) throw new Error('TTS stream incomplete');
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

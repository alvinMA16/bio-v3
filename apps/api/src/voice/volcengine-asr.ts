import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import type { AsrProvider, AsrStream, Recognition } from './providers.js';

export function volcPacket(type: number, sequence: number, payload: Uint8Array): Buffer {
  const compressed = gzipSync(payload);
  const header = Buffer.alloc(12);
  header[0] = 0x11; header[1] = (type << 4) | (sequence < 0 ? 3 : 1);
  header[2] = type === 1 ? 0x11 : 0x01;
  header.writeInt32BE(sequence, 4); header.writeUInt32BE(compressed.length, 8);
  return Buffer.concat([header, compressed]);
}

export function parseVolcFrame(frame: Buffer): { last: boolean; payload: Buffer } {
  if (frame.length < 4 || frame[0]! >> 4 !== 1) throw new Error('Invalid ASR header');
  let offset = (frame[0]! & 15) * 4;
  const type = frame[1]! >> 4, flags = frame[1]! & 15, compression = frame[2]! & 15;
  if (offset < 4 || frame.length < offset + 4) throw new Error('Truncated ASR header');
  if (type === 15) throw new Error(`ASR provider error ${frame.readUInt32BE(offset)}`);
  if (type !== 9 || ![0, 1].includes(compression)) throw new Error('Unsupported ASR frame');
  let sequence = 0;
  if (flags & 1) { sequence = frame.readInt32BE(offset); offset += 4; }
  if (frame.length < offset + 4) throw new Error('Missing ASR payload size');
  const size = frame.readUInt32BE(offset); offset += 4;
  if (size > 1024 * 1024 || frame.length !== offset + size) throw new Error('Invalid ASR payload size');
  const payload = frame.subarray(offset);
  return { last: !!(flags & 2) || sequence < 0,
    payload: compression === 1 && size ? gunzipSync(payload, { maxOutputLength: 2 * 1024 * 1024 }) : payload };
}

export class VolcengineAsr implements AsrProvider {
  constructor(private config: { appId: string; accessToken: string; resourceId: string }) {}
  async open(onResult: (result: Recognition) => void, signal: AbortSignal): Promise<AsrStream> {
    signal.throwIfAborted();
    const id = randomUUID();
    const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {
      handshakeTimeout: 10_000, maxPayload: 1024 * 1024,
      headers: { 'X-Api-App-Key': this.config.appId, 'X-Api-Access-Key': this.config.accessToken,
        'X-Api-Resource-Id': this.config.resourceId, 'X-Api-Request-Id': id, 'X-Api-Connect-Id': id },
    });
    let ended = false, ready = false, stopping = false, sequence = 2;
    let pending: Uint8Array | undefined;
    let lastText = '', lastFinal = false;
    let readTimer: ReturnType<typeof setTimeout>, finishTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    let resolveDone!: (text: string) => void, rejectDone!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const done = new Promise<string>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => undefined);
    const close = () => {
      clearTimeout(readTimer); clearTimeout(finishTimer); signal.removeEventListener('abort', fail);
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    };
    const fail = () => {
      if (ended) return;
      ended = true;
      rejectReady(new Error('Volcengine ASR unavailable')); rejectDone(new Error('Volcengine ASR incomplete'));
      close(); if (!signal.aborted) onResult({ text: '', final: false, error: true });
    };
    readTimer = setTimeout(fail, 10_000);
    signal.addEventListener('abort', fail, { once: true });
    ws.on('open', () => ws.send(volcPacket(1, 1, Buffer.from(JSON.stringify({
      user: { uid: id }, audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel', show_utterances: true, enable_itn: true, enable_punc: true,
        enable_ddc: true, enable_nonstream: true },
    })))));
    ws.on('message', bytes => {
      if (ended) return;
      try {
        const frame = parseVolcFrame(Buffer.from(bytes as Buffer));
        clearTimeout(readTimer); readTimer = setTimeout(fail, 45_000);
        if (!ready) { ready = true; resolveReady(); }
        const data = frame.payload.length ? JSON.parse(frame.payload.toString()) as {
          result?: { text?: string; utterances?: { text?: string; definite?: boolean }[] };
        } : {};
        const utterance = data.result?.utterances?.at(-1);
        const text = (data.result?.text ?? utterance?.text ?? lastText).trim();
        const final = frame.last || utterance?.definite === true;
        // The provider returns cumulative snapshots. Repeated finals must not restart the endpoint window.
        if ((text || utterance) && (text !== lastText || final !== lastFinal)) {
          lastText = text; lastFinal = final;
          onResult({ text, final });
        }
        if (frame.last) { ended = true; resolveDone(lastText); close(); }
      } catch { fail(); }
    });
    ws.on('error', fail); ws.on('close', () => { if (!ended) fail(); });
    await started;
    return {
      write(pcm) {
        if (ended || stopping || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256_000) throw new Error('ASR unavailable');
        if (pending) ws.send(volcPacket(2, sequence++, pending));
        pending = Uint8Array.from(pcm);
      },
      finish() {
        if (!ended && !stopping) {
          stopping = true;
          ws.send(volcPacket(2, -sequence++, pending ?? new Uint8Array())); pending = undefined;
          finishTimer = setTimeout(fail, 10_000);
        }
        return done;
      },
      close() { if (!ended) { ended = true; rejectDone(new Error('ASR closed')); } close(); },
    };
  }
}

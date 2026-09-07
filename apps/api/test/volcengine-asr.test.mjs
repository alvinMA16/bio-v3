import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { volcPacket, parseVolcFrame } from '../dist/voice/volcengine-asr.js';

test('Volcengine request packets carry gzip and signed final sequence', () => {
  const frame = volcPacket(2, -7, new Uint8Array([0, 0, 1, 0]));
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x23, 0x01, 0]);
  assert.equal(frame.readInt32BE(4), -7);
  assert.equal(frame.readUInt32BE(8), frame.length - 12);
  assert.deepEqual([...gunzipSync(frame.subarray(12))], [0, 0, 1, 0]);
});

test('Volcengine parser accepts compressed final snapshots and rejects truncated/error packets', () => {
  const packet = volcPacket(1, -3, Buffer.from(JSON.stringify({ result: { text: '测试。' } })));
  packet[1] = 0x93;
  const parsed = parseVolcFrame(packet);
  assert.equal(parsed.last, true);
  assert.equal(JSON.parse(parsed.payload).result.text, '测试。');
  assert.throws(() => parseVolcFrame(packet.subarray(0, 7)));
  assert.throws(() => parseVolcFrame(packet.subarray(0, packet.length - 1)));
  const error = Buffer.alloc(8); error[0] = 0x11; error[1] = 0xf0; error.writeUInt32BE(45000001, 4);
  assert.throws(() => parseVolcFrame(error), /45000001/);
});

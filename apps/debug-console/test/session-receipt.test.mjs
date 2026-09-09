import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReceiptMessage, createReceipt, summarizeReceipt, saveReceipt, readReceipt } from '../src/session-receipt.ts';

test('streaming transcripts and assistant completion are counted once per message', () => {
  const messages = new Map();
  collectReceiptMessage(messages, { type: 'asr', turnId: 'one', text: '小时候' });
  collectReceiptMessage(messages, { type: 'transcript', turnId: 'one', text: '小时候和奶奶一起做饭。' });
  collectReceiptMessage(messages, { type: 'agent', event: { type: 'speech.delta', messageId: 'reply', delta: '记得' } });
  collectReceiptMessage(messages, { type: 'agent', event: { type: 'speech.completed', messageId: 'reply', text: '记得做了什么吗？' } });
  const receipt = createReceipt([...messages.values()], 1000, 65000, 64000);
  assert.equal(receipt.shares, 1);
  assert.equal(receipt.replies, 1);
  assert.match(receipt.summary, /奶奶/);
  assert.equal(createReceipt([], 1000, 2000, 1000), null);
});

test('summary failure keeps the excerpt and persisted pending receipt can be reopened', async t => {
  const receipt = createReceipt([{ role: 'user', content: '和奶奶做饭' }], 1000, 2000, 1000);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  const result = await summarizeReceipt(receipt, [{ role: 'user', content: '和奶奶做饭' }]);
  assert.equal(result.status, 'excerpt');
  assert.equal(result.summary, receipt.summary);
  let stored;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (_, value) => { stored = value; }, getItem: () => stored } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; });
  saveReceipt(receipt);
  assert.equal(readReceipt().status, 'excerpt');
});

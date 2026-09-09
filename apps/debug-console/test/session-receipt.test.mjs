import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReceiptMessage, createReceipt, saveReceipt, readReceipt } from '../src/session-receipt.ts';

test('streaming transcripts and assistant completion are counted once per message', () => {
  const messages = new Map();
  collectReceiptMessage(messages, { type: 'asr', turnId: 'one', text: '小时候' });
  collectReceiptMessage(messages, { type: 'transcript', turnId: 'one', text: '小时候和奶奶一起做饭。' });
  collectReceiptMessage(messages, { type: 'agent', event: { type: 'speech.delta', messageId: 'reply', delta: '记得' } });
  collectReceiptMessage(messages, { type: 'agent', event: { type: 'speech.completed', messageId: 'reply', text: '记得做了什么吗？' } });
  const receipt = createReceipt([...messages.values()], 1000, 65000, 64000);
  assert.equal(receipt.shares, 1);
  assert.equal(receipt.replies, 1);
  assert.equal('summary' in receipt, false);
  assert.equal(createReceipt([], 1000, 2000, 1000), null);
});

test('basic receipt is stored locally without requesting a model; legacy summary fields are discarded', t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Receipt must not call a model'); });
  let stored;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (_, value) => { stored = value; }, getItem: () => stored } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; });
  const receipt = createReceipt([{ role: 'user', content: '和奶奶做饭' }], 1000, 2000, 1000);
  saveReceipt(receipt);
  assert.deepEqual(readReceipt(), receipt);
  stored = JSON.stringify({ ...receipt, summary: 'old text', topics: ['旧主题'], status: 'ready' });
  assert.deepEqual(readReceipt(), receipt);
  assert.equal(network.mock.callCount(), 0);
});

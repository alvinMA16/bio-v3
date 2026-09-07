import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationOf, conversationThrough, panelOf } from '../src/run-history.ts';

const run = (id, conversationId) => ({ id, conversationId, request: { message: id }, startedAt: '', durationMs: 1 });
test('dialogue history isolates conversations and excludes turns after selected snapshot', () => {
  const oldest = run('one', 'a');
  const middle = run('two', 'a');
  const newest = run('three', 'a');
  const history = [newest, run('unrelated', 'b'), middle, oldest];
  assert.deepEqual(conversationThrough(history, middle).map(item => item.id), ['one', 'two']);
  assert.deepEqual(conversationThrough(history, newest).map(item => item.id), ['one', 'two', 'three']);
  assert.deepEqual(conversationThrough(history, undefined), []);
});
test('cancelled first turns use assigned server conversation ID and unknown runs stay isolated', () => {
  const cancelled = { ...run('cancelled', 'server-id'), error: '运行已取消' };
  assert.equal(conversationOf(cancelled), 'server-id');
  const unknown = { id: 'old-error', request: { message: 'old' } };
  assert.deepEqual(conversationThrough([unknown, { id: 'another-error', request: { message: 'other' } }], unknown), [unknown]);
});
test('phone preview restores the last panel event and supports legacy panel history', () => {
  const panel = { revision: 2, mode: 'conversation' };
  assert.deepEqual(panelOf({ response: { events: [{ type: 'panel.state.updated', panel }] } }), panel);
  const legacy = panelOf({ response: { events: [{ type: 'panel.updated', panel: { id: 'old', title: '旧草稿', content: '正文' } }] } });
  assert.equal(legacy.document.blocks[0].text, '正文');
  assert.equal(panelOf(undefined), undefined);
});

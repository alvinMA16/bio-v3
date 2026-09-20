import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceSession } from '../dist/voice/voice-session.js';

const waitFor = async condition => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for playback condition');
};
function fixture() {
  const events = [];
  let advanced = false;
  const session = new VoiceSession(
    { async open() { return { write() {}, close() {}, async finish() { return '从头念到尾'; } }; } },
    { async synthesize(_text, _signal, audio) { await audio(new Uint8Array([0, 0, 0, 0])); } },
    async (_input, emit, signal, _trigger, runtime) => {
      emit({ type: 'speech.completed', messageId: 'page1', text: '第一页原文。' });
      await runtime.beforeShow(signal);
      advanced = true;
      emit({ type: 'panel.state.updated', panel: { mode: 'editor', revision: 2 } });
      emit({ type: 'speech.completed', messageId: 'page2', text: '第二页原文。' });
      return { conversationId: 'test', message: { content: '第二页原文。' } };
    }, event => events.push(event));
  return { session, events, advanced: () => advanced };
}
test('next-page tool resumes only after actual playback, not synthesis completion', async () => {
  const f = fixture();
  try {
    await f.session.listen('read', {}, false, true); f.session.finish('read');
    await waitFor(() => f.events.some(event => event.type === 'segment.end'));
    assert.equal(f.advanced(), false);
    f.session.playback('stale-turn', 2);
    f.session.playback('read', 999);
    assert.equal(f.advanced(), false);
    f.session.playback('read', 2);
    await f.session.settled();
    assert.equal(f.advanced(), true);
    assert.equal(f.events.filter(event => event.type === 'audio').length, 2);
    assert.ok(f.events.some(event => event.type === 'done'));
  } finally { f.session.close(); }
});
test('interruption while waiting for playback never flips the page or speaks the next page', async () => {
  const f = fixture();
  await f.session.listen('read', {}, false, true); f.session.finish('read');
  await waitFor(() => f.events.some(event => event.type === 'segment.end'));
  f.session.cancel('read');
  f.session.playback('read', 2);
  await f.session.settled();
  assert.equal(f.advanced(), false);
  assert.equal(f.events.filter(event => event.type === 'audio').length, 1);
  f.session.close();
});

test('document speech budget covers the entire maximum-length manuscript', async () => {
  const text = '字'.repeat(40000), events = [], spoken = [];
  const session = new VoiceSession(
    { async open() { return { write() {}, close() {}, async finish() { return '念完整篇'; } }; } },
    { async synthesize(part, _signal, audio) { spoken.push(part); await audio(new Uint8Array([0, 0])); } },
    async (_input, emit) => {
      emit({ type: 'panel.state.updated', panel: { mode: 'editor', revision: 1, document: { id: 'long', version: 1, title: '长文', blocks: [] } } });
      // Many separate assistant messages, as in page-by-page tool execution.
      for (let i = 0; i < text.length; i += 600) emit({ type: 'speech.completed', messageId: `p${i}`, text: text.slice(i, i + 600) });
      return { conversationId: 'test', message: { content: '' } };
    }, event => events.push(event));
  try {
    await session.listen('long', {}); session.finish('long'); await session.settled();
    assert.equal(spoken.join(''), text);
    assert.equal(events.some(event => event.type === 'error'), false);
  } finally { session.close(); }
});

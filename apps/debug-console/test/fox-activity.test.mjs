import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foxActivityOf } from '../src/fox-activity.ts';

const live = { messages: [], steps: [], status: '', activeTools: [] };
test('reads stay quiet, edits write, and stale tools cannot animate an ended run', () => {
  const input = { running: true, panel: undefined, live: { ...live, activeTools: [{ id: 'a', name: 'get_content' }] } };
  assert.equal(foxActivityOf(input).phase, 'reading');
  input.live.activeTools[0].name = 'update_content';
  assert.equal(foxActivityOf(input).phase, 'writing');
  assert.equal(foxActivityOf({ ...input, running: false }).phase, 'idle');
});
test('audio playback overrides text streaming, including silence and user interruption', () => {
  const input = { running: true, panel: undefined, live: { ...live, messages: [{ id: 'a', text: '你好', completed: false }] } };
  assert.equal(foxActivityOf(input).speech, 'text');
  assert.equal(foxActivityOf({ ...input, audioPlaying: false }).speech, 'silent');
  assert.equal(foxActivityOf({ ...input, running: false, audioPlaying: true }).speech, 'audio');
  assert.equal(foxActivityOf({ ...input, audioPlaying: true, userSpeaking: true }).phase, 'listening');
});


test('connecting and listening do not write; finalizing and queued speech keep thinking', () => {
  const input = { running: true, panel: undefined, live, audioPlaying: false };
  for (const voiceState of ['connecting', 'listening']) {
    assert.equal(foxActivityOf({ ...input, voiceState }).phase, 'listening');
  }
  for (const voiceState of ['finalizing', 'agent', 'synthesizing']) {
    assert.equal(foxActivityOf({ ...input, running: false, voiceState }).phase, 'processing');
  }
  assert.equal(foxActivityOf({ ...input, running: false }).phase, 'idle');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelObservations } from '../dist/agent/model-observation.js';

function harness(observations, scope, record) {
  const handlers = {};
  observations.extension(scope, record)({ on: (name, handler) => { handlers[name] = handler; } });
  return handlers;
}
const payload = contents => ({ model: 'gemini-test', config: { systemInstruction: 'private system', tools: [{ name: 'private tool' }] }, contents });
const user = text => ({ role: 'user', parts: [{ text }] });

test('compares across runs without modifying or retaining plaintext in output', () => {
  const obs = new ModelObservations(), records = [];
  const record = (type, data) => records.push({ type, data });
  const first = harness(obs, 'account/session', record);
  const p = payload([user('secret context'), user('secret question')]);
  const original = JSON.stringify(p);
  first.before_provider_request({ payload: p });
  assert.equal(JSON.stringify(p), original);
  harness(obs, 'account/session', record).before_provider_request({ payload: payload([...p.contents, user('next')]) });
  assert.equal(records[1].data.commonMessages, 2);
  assert.equal(records[1].data.previousCallId, records[0].data.id);
  assert.equal(records[1].data.firstChangedMessage, null);
  assert.ok(!JSON.stringify(records).includes('secret'));
  assert.ok(!JSON.stringify(records).includes('private system'));
  harness(obs, 'other-account/session', record).before_provider_request({ payload: p });
  assert.equal(records[2].data.baseline, 'unavailable');
});

test('detects moving context and separates tool followup usage, including zero input', () => {
  const records = [], h = harness(new ModelObservations(), 'session', (type, data) => records.push({ type, data }));
  h.before_provider_request({ payload: payload([user('D'), user('U1')]) });
  h.message_end({ message: { role: 'assistant', model: 'gemini-test', stopReason: 'toolUse', usage: { input: 60, cacheRead: 40, cacheWrite: 0, output: 10 } } });
  h.before_provider_request({ payload: payload([user('U1'), user('D'), user('U2')]) });
  h.message_end({ message: { role: 'assistant', model: 'gemini-test', stopReason: 'aborted', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } });
  assert.equal(records[1].data.cacheRatio, 0.4);
  assert.equal(records[1].data.callId, records[0].data.id);
  assert.equal(records[2].data.firstChangedMessage, 1);
  assert.equal(records[2].data.ordinal, 2);
  assert.equal(records[3].data.cacheRatio, null);
  assert.equal(records[3].data.rawCacheFieldPresence, 'unavailable');
});

test('trace failures do not abort requests', () => {
  const h = harness(new ModelObservations(), 'session', () => { throw new Error('disk full'); });
  assert.doesNotThrow(() => h.before_provider_request({ payload: payload([user('hi')]) }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLiveEvent, emptyLiveRun } from '../src/live-run.ts';

const event = (payload, sequence = 1) => ({ ...payload, sequence, runId: 'run', conversationId: 'conversation', timestamp: '2026-09-07T00:00:00Z' });

test('streamed utterances stay separate and completion replaces the same message', () => {
  let state = emptyLiveRun();
  state = applyLiveEvent(state, event({ type: 'speech.delta', messageId: 'a', delta: '我来' }), 10);
  state = applyLiveEvent(state, event({ type: 'speech.delta', messageId: 'a', delta: '改一下。' }), 20);
  state = applyLiveEvent(state, event({ type: 'speech.completed', messageId: 'a', text: '我来改一下。' }), 30);
  state = applyLiveEvent(state, event({ type: 'speech.delta', messageId: 'b', delta: '改好' }), 40);
  assert.deepEqual(state.messages, [
    { id: 'a', text: '我来改一下。', completed: true },
    { id: 'b', text: '改好', completed: false },
  ]);
});

test('panel changes and tool failures appear before final response and survive cancellation', () => {
  let state = emptyLiveRun();
  const panel = { revision: 1, mode: 'editor', document: { id: 'draft', title: '回忆', version: 1, blocks: [] } };
  state = applyLiveEvent(state, event({ type: 'tool.started', name: 'update_content', toolCallId: 't' }, 2), 100);
  state = applyLiveEvent(state, event({ type: 'panel.state.updated', panel }, 3), 200);
  assert.equal(state.panel.document.version, 1);
  assert.match(state.steps[1].label, /版本 1/);
  state = applyLiveEvent(state, event({ type: 'tool.completed', name: 'update_content', toolCallId: 't', isError: true }, 4), 300);
  state = applyLiveEvent(state, event({ type: 'run.cancelled' }, 5), 400);
  assert.equal(state.steps[2].failed, true);
  assert.equal(state.status, '本轮已取消');
  assert.equal(state.panel, panel);
  assert.deepEqual(state.steps.map(step => step.elapsedMs), [100, 200, 300, 400]);
  assert.equal(emptyLiveRun().panel, undefined);
});

test('overlapping tools are tracked by ID and terminal events clear pending work', () => {
  let state = emptyLiveRun();
  state = applyLiveEvent(state, event({ type: 'tool.started', name: 'update_content', toolCallId: 'write' }), 0);
  state = applyLiveEvent(state, event({ type: 'tool.started', name: 'get_content', toolCallId: 'read' }), 10);
  state = applyLiveEvent(state, event({ type: 'tool.completed', name: 'get_content', toolCallId: 'read', isError: false }), 20);
  assert.deepEqual(state.activeTools, [{ id: 'write', name: 'update_content' }]);
  state = applyLiveEvent(state, event({ type: 'run.failed', message: '断流' }), 30);
  assert.deepEqual(state.activeTools, []);
});

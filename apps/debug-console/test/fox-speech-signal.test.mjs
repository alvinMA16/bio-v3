import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoxSpeechSignal } from '../../miniprogram/miniprogram/lib/fox-speech-signal.ts';

test('quiet input waits, short pauses keep writing, longer silence and reset stop writing', () => {
  const changes = [];
  const signal = new FoxSpeechSignal(value => changes.push(value));
  signal.update(0.001, 2000);
  assert.deepEqual(changes, []);
  signal.update(0.03, 100);
  signal.update(0, 500);
  signal.update(0.03, 100);
  assert.deepEqual(changes, [true]);
  signal.update(0, 700);
  assert.deepEqual(changes, [true, false]);
  signal.update(0.03, 100);
  signal.reset();
  signal.reset();
  assert.deepEqual(changes, [true, false, true, false]);
});

test('new ASR words activate quiet speech but repeated text does not keep writing forever', () => {
  const changes = [];
  const signal = new FoxSpeechSignal(value => changes.push(value));
  signal.recognize('轻声讲述');
  signal.update(0.001, 800);
  assert.deepEqual(changes, [true]);
  signal.recognize('轻声讲述');
  signal.update(0, 600);
  assert.deepEqual(changes, [true, false]);
  signal.reset();
  signal.recognize('轻声讲述');
  assert.deepEqual(changes, [true, false, true]);
});

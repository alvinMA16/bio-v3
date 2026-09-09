import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedProgress, paperPoint } from '../src/receipt-feed.ts';

test('feeding advances monotonically with motor rests and ends exactly at one', () => {
  let previous = 0;
  for (let time = 0; time <= 5000; time += 10) {
    const position = feedProgress(time);
    assert.ok(position >= previous && position <= 1);
    previous = position;
  }
  assert.equal(feedProgress(0), 0);
  assert.equal(feedProgress(1400), feedProgress(1500));
  assert.equal(feedProgress(5000), 1);
});

test('bottom edge emerges first; printed text travels with paper instead of revealing top down', () => {
  const top = paperPoint(.5, 0, .1, 224, 300);
  const bottom = paperPoint(.5, 1, .1, 224, 300);
  assert.ok(top.y > 0, 'heading remains inside printer');
  assert.ok(bottom.y < 0, 'bottom edge has emerged below mouth');
  const halfway = paperPoint(.5, .8, .5, 224, 300);
  const later = paperPoint(.5, .8, .8, 224, 300);
  assert.ok(later.y < halfway.y, 'same ink coordinate moves down as feed advances');
  assert.equal(paperPoint(.5, 0, 1, 224, 300).y, 0);
  assert.ok(paperPoint(.5, 1, 1, 224, 300).z > 2, 'free edge stays softly curled');
});


test('first exposed millimetres remain connected to the mouth instead of curling back above it', () => {
  for (const progress of [.001, .005, .01, .05, .1]) {
    const mouthRow = 1 - progress;
    assert.ok(Math.abs(paperPoint(.5, mouthRow, progress, 224, 190).y) < .000001);
    const halfway = paperPoint(.5, mouthRow + progress / 2, progress, 224, 190);
    const bottom = paperPoint(.5, 1, progress, 224, 190);
    assert.ok(halfway.y < 0 && bottom.y < halfway.y);
  }
});

test('the free edge has sixteen visible cut teeth without changing the mouth edge', () => {
  const tip = paperPoint(0, 1, 1, 224, 360);
  const notch = paperPoint(1 / 32, 1, 1, 224, 360);
  assert.ok(notch.y - tip.y > 4.5);
  assert.equal(paperPoint(1 / 32, 0, 1, 224, 360).y, 0);
});

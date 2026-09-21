import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigateDocumentFocus } from '../src/document-navigation.ts';

function fixture(t, { present = true, movable = true, scrollerPresent = true, highlight = false, marked = false, offscreen = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map(); let nextFrame = 0, top = 0;
  globalThis.window = { setTimeout, clearTimeout, innerHeight: 600 };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const scroll = new EventTarget();
  Object.assign(scroll, { clientHeight: 400, getBoundingClientRect: () => ({ top: offscreen ? 800 : 0, bottom: offscreen ? 1200 : 400 }) });
  Object.defineProperty(scroll, 'scrollTop', { get: () => top, set: value => { if (movable) top = Math.max(0, value); } });
  const span = { dataset: { block: 'fifth', start: '0', end: '20' }, getBoundingClientRect: () => ({ top: 1000 - top, bottom: 1020 - top, height: 20 }), getClientRects: () => [span.getBoundingClientRect()] };
  span.querySelector = () => marked ? span : null;
  const root = { closest: () => scrollerPresent ? scroll : null, querySelectorAll: () => present ? [span] : [], addEventListener() {}, removeEventListener() {} };
  const receipts = [], stages = [];
  const cancel = navigateDocumentFocus(root, { requestId: 'focus', blockId: 'fifth', start: 0, end: 20 }, receipt => { stages.push(receipt); if (receipt.status !== 'rendering') receipts.push(receipt); }, highlight);
  const frame = () => { const ready = [...frames.values()]; frames.clear(); for (const callback of ready) callback(); };
  return { scroll, receipts, stages, frame, cancel, reveal: () => { present = true; } };
}

test('confirms visibility after layout, not immediately after assigning scrollTop', t => {
  const f = fixture(t); f.frame(); assert.equal(f.receipts.length, 0);
  assert.equal(f.stages[0].status, 'rendering');
  f.frame(); assert.equal(f.receipts[0].status, 'visible'); assert.equal(f.receipts[0].scrollAfter, 920);
  assert.equal(f.receipts[0].attempts, 1);
});

test('missing scroll container returns explicit failure without waiting for the deadline', t => {
  const f = fixture(t, { scrollerPresent: false }); f.frame();
  assert.equal(f.receipts[0].reason, 'scroller_missing'); assert.equal(f.receipts[0].attempts, 1);
});
for (const marked of [true, false]) test(`highlight verification is independent of successful scrolling: mark=${marked}`, t => {
  const f = fixture(t, { highlight: true, marked }); f.frame(); f.frame();
  assert.equal(f.receipts[0].status, 'visible');
  assert.equal(f.receipts[0].highlight, marked ? 'visible' : 'missing');
  assert.equal(f.receipts[0].targetTop, 80); assert.equal(f.receipts[0].viewportBottom, 400);
});
test('a container outside the browser viewport cannot claim visible', t => {
  const f = fixture(t, { offscreen: true }); f.frame();
  for (let i = 0; i < 6; i++) { f.frame(); t.mock.timers.tick(100); }
  assert.equal(f.receipts[0].status, 'failed'); assert.equal(f.receipts[0].reason, 'not_visible');
});
test('retries a target that appears after the first render', t => {
  const f = fixture(t, { present: false }); f.frame(); assert.equal(f.receipts.length, 0);
  f.reveal(); t.mock.timers.tick(100); f.frame(); assert.equal(f.receipts[0].status, 'visible'); assert.equal(f.receipts[0].attempts, 2);
});
test('a scroll assignment that does not move the viewport is reported as failure', t => {
  const f = fixture(t, { movable: false });
  f.frame();
  for (let i = 0; i < 6; i++) { f.frame(); t.mock.timers.tick(100); }
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].reason, 'not_visible'); assert.equal(f.receipts[0].attempts, 6);
});
test('user scrolling cancels retries without stealing the viewport back', t => {
  const f = fixture(t, { present: false }); f.frame(); f.scroll.dispatchEvent(new Event('wheel'));
  f.reveal(); t.mock.timers.tick(1500); f.frame();
  assert.equal(f.scroll.scrollTop, 0); assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].reason, 'user_interrupted');
});
test('superseded requests never send late receipts or scroll', t => {
  const f = fixture(t); f.cancel(); t.mock.timers.tick(1500); f.frame();
  assert.equal(f.receipts.length, 0); assert.equal(f.scroll.scrollTop, 0);
});
test('background tabs have a bounded deadline even without animation frames', t => {
  const f = fixture(t); t.mock.timers.tick(1200);
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].status, 'failed');
  f.frame(); assert.equal(f.scroll.scrollTop, 0);
});

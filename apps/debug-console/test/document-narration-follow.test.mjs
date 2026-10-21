import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followDocumentNarration } from '../src/document-narration-follow.ts';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = {};
  const frames = new Map(); let id = 0;
  const window = Object.assign(new EventTarget(), { innerHeight: 700, matchMedia: () => ({ matches: false }) });
  const document = new EventTarget();
  for (const [key, value] of Object.entries({ window, document,
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: n => frames.delete(n), ResizeObserver: class { observe() {} disconnect() {} },
  })) { previous[key] = globalThis[key]; globalThis[key] = value; }
  t.after(() => { control.cleanup(); for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  const moves = [], states = [];
  const scroller = Object.assign(new EventTarget(), { scrollTop: 0,
    getBoundingClientRect: () => ({ top: 20, bottom: 620 }),
    scrollTo(options) { moves.push(options); this.scrollTop = Math.max(0, options.top); },
  });
  const spans = [0, 180, 360].map((start, index) => ({ dataset: { block: 'p1', start: String(start), end: String(start + 180) },
    getClientRects: () => [{ top: 100 + index * 700 - scroller.scrollTop, bottom: 120 + index * 700 - scroller.scrollTop }],
  }));
  const manuscript = { id: 'story', version: 1 };
  const control = followDocumentNarration({ closest: () => scroller, querySelectorAll: () => spans }, () => manuscript, value => states.push(value));
  const audio = (start = 0, other = {}) => document.dispatchEvent(new CustomEvent('bio:document-narration', {
    detail: { documentId: 'story', version: 1, blockId: 'p1', start, end: start + 180, ...other },
  }));
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const stop = () => document.dispatchEvent(new CustomEvent('bio:document-narration'));
  return { window, document, scroller, manuscript, control, audio, frame, moves, states, stop };
}

test('keeps visible text still, follows a long paragraph by its audible offsets, respects reduced motion', t => {
  const f = fixture(t); f.audio(); f.frame(); assert.equal(f.moves.length, 0);
  f.audio(180); f.frame(); assert.equal(f.scroller.scrollTop, 600); assert.equal(f.moves.at(-1).behavior, 'smooth');
  f.window.matchMedia = () => ({ matches: true });
  f.audio(360); f.frame(); assert.equal(f.scroller.scrollTop, 1300); assert.equal(f.moves.at(-1).behavior, 'instant');
});

test('holding and inertia defer following; release returns to the newest audible position', t => {
  const f = fixture(t); f.audio(); f.frame();
  f.scroller.dispatchEvent(new Event('pointerdown')); f.scroller.dispatchEvent(new Event('touchstart'));
  f.scroller.dispatchEvent(new Event('touchmove'));
  // Native touch scrolling cancels pointer events while the finger is still down.
  f.window.dispatchEvent(new Event('pointercancel'));
  f.audio(180); t.mock.timers.tick(1000); f.frame(); assert.equal(f.scroller.scrollTop, 0);
  f.window.dispatchEvent(new Event('touchend')); t.mock.timers.tick(150);
  f.scroller.scrollTop = 200; f.scroller.dispatchEvent(new Event('scroll')); // inertia
  f.audio(360); t.mock.timers.tick(219); f.frame(); assert.equal(f.scroller.scrollTop, 200);
  t.mock.timers.tick(1); f.frame(); assert.equal(f.scroller.scrollTop, 1300);
  assert.equal(f.states.at(-1), true);
});

for (const input of ['wheel', 'keydown']) test(`${input} resumes automatically after scrolling settles`, t => {
  const f = fixture(t); f.audio(); f.frame();
  const event = new Event(input); Object.assign(event, { key: 'PageDown' }); f.scroller.dispatchEvent(event);
  f.audio(180); f.frame(); assert.equal(f.scroller.scrollTop, 0);
  t.mock.timers.tick(220); f.frame(); assert.equal(f.scroller.scrollTop, 600);
});

for (const mode of ['stop', 'version', 'foreign', 'unmount']) test(`${mode} prevents pending or stale scrolling`, t => {
  const f = fixture(t); f.scroller.dispatchEvent(new Event('wheel')); f.audio(180);
  if (mode === 'stop') f.stop();
  if (mode === 'version') f.manuscript.version++;
  if (mode === 'foreign') f.audio(180, { documentId: 'elsewhere' });
  if (mode === 'unmount') f.control.cleanup();
  t.mock.timers.tick(1000); f.frame(); assert.equal(f.scroller.scrollTop, 0);
});

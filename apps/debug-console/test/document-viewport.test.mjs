import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentViewport } from '../src/document-viewport.ts';

test('reading reports exclude text under the floating dock while retaining the paper above it', t => {
  const previous = globalThis.window;
  globalThis.window = { innerHeight: 800 };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const paper = { getBoundingClientRect: () => ({ top: 20, bottom: 720 }),
    closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ top: 560 }) }) }) };
  assert.deepEqual(documentViewport(paper), { top: 20, bottom: 560 });
  paper.closest = () => null;
  assert.deepEqual(documentViewport(paper), { top: 20, bottom: 720 });
  globalThis.window.innerHeight = 500;
  assert.deepEqual(documentViewport(paper), { top: 20, bottom: 500 });
});

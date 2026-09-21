import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentViewport } from '../src/document-viewport.ts';

test('reading reports include the full panel and clip to the browser viewport', t => {
  const previous = globalThis.window;
  globalThis.window = { innerHeight: 800 };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const paper = { getBoundingClientRect: () => ({ top: 20, bottom: 720 }) };
  assert.deepEqual(documentViewport(paper), { top: 20, bottom: 720 });
  globalThis.window.innerHeight = 500;
  assert.deepEqual(documentViewport(paper), { top: 20, bottom: 500 });
});

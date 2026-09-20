import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/prepare-call-ui.ts', import.meta.url), 'utf8')
  .replace("'./ui-asset'", JSON.stringify(new URL('../src/ui-asset.ts', import.meta.url).href))
  .replace("import('./voice-glass-stack.js')", 'Promise.resolve()');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { prepareCallUi } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t, hang = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const urls = [], images = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return { ok: true, json: async () => url.includes('manifest') ? { layers: { actor: { kind: 'sprite' }, environment: { src: '/environment.webp' } }, animations: [{ src: '/blink.webp' }] } : url.includes('/pages/') ? { image: '/first-page.png' } : { kind: 'document', mimeType: 'application/pdf' } };
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    set src(url) { if (!url) return; images.push(url); if (!hang) queueMicrotask(() => this.onload?.()); }
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Image', original); else delete globalThis.Image; });
  return { urls, images };
}
test('preflight loads sprites and first attachment page, ignores non-image manifest layers, keeps dialing visible', async t => {
  const f = setup(t); let finished = false;
  const promise = prepareCallUi('file').then(() => { finished = true; });
  await flush(); assert.equal(finished, false);
  assert.deepEqual(f.images.sort(), ['/api/v1/ui-assets/blink.webp', '/api/v1/ui-assets/environment.webp', '/first-page.png'].sort());
  t.mock.timers.tick(1200); await promise; assert.equal(finished, true);
});
test('a hanging image becomes a retryable failure rather than endless dialing', async t => {
  setup(t, true); const check = assert.rejects(prepareCallUi(), /超时/);
  await flush(); t.mock.timers.tick(25000); await check;
});

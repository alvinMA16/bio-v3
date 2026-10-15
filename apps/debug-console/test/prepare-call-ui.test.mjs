import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/prepare-call-ui.ts', import.meta.url), 'utf8')
  .replace("'./ui-asset'", JSON.stringify(new URL('../src/ui-asset.ts', import.meta.url).href))
  .replaceAll("import('./voice-glass-stack.js')", 'Promise.resolve({ prepareGlassStack() {} })');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
let instance = 0;
const fresh = () => import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${instance++}`);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t, hang = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const urls = [], images = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return { ok: true, json: async () => url.includes('manifest') ? { layers: { actor: { kind: 'sprite' }, environment: { src: '/environment.webp' }, innerPanel: { src: '/inner-panel.webp' } }, animations: [{ src: '/blink.webp' }] } : url.includes('/pages/') ? { image: '/first-page.png' } : { kind: 'document', mimeType: 'application/pdf' } };
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    set src(url) { if (!url) return; images.push(url); if (!hang) queueMicrotask(() => this.onload?.()); }
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Image', original); else delete globalThis.Image; });
  return { urls, images };
}
test('preflight loads sprites and first attachment page without an artificial delay', async t => {
  const { prepareCallUi } = await fresh();
  const f = setup(t); let finished = false;
  const promise = prepareCallUi('file').then(() => { finished = true; });
  await promise; assert.equal(finished, true);
  assert.deepEqual(f.images.sort(), ['/api/v1/ui-assets/blink.webp', '/api/v1/ui-assets/environment.webp', '/api/v1/ui-assets/inner-panel.webp', ...['folder.png', 'phone.png', 'manuscripts.png', 'manuscripts-label.png', 'lingli-avatar.png'].map(name => `/api/v1/ui-assets/${name}`), '/first-page.png'].sort());

});
test('a hanging image becomes a retryable failure rather than endless dialing', async t => {
  const { prepareCallUi } = await fresh();
  setup(t, true); const check = assert.rejects(prepareCallUi(), /超时/);
  await flush(); t.mock.timers.tick(25000); await check;
});

test('desk warming and repeated calls share one scene preparation', async t => {
  const { warmCallUi, prepareCallUi } = await fresh();
  const f = setup(t);
  await Promise.all([warmCallUi(), prepareCallUi(), prepareCallUi()]);
  await prepareCallUi('file');
  assert.equal(f.urls.filter(url => url.includes('manifest')).length, 1);
  assert.equal(f.images.filter(url => url.endsWith('blink.webp')).length, 1);
  assert.ok(f.images.includes('/first-page.png'));
});
test('failed warming is retried on the next call', async t => {
  const { warmCallUi, prepareCallUi } = await fresh();
  const f = setup(t, true);
  const failed = assert.rejects(warmCallUi(), /超时/);
  await flush(); t.mock.timers.tick(25000); await failed;
  const retry = assert.rejects(prepareCallUi(), /超时/);
  await flush(); t.mock.timers.tick(25000); await retry;
  assert.equal(f.urls.filter(url => url.includes('manifest')).length, 2);
});

test('the scene stays pending until every image has decoded', async t => {
  const { prepareDeskScene } = await fresh();
  setup(t);
  const decoders = [];
  globalThis.Image.prototype.decode = function () { return new Promise(resolve => decoders.push(resolve)); };
  let ready = false;
  const scene = prepareDeskScene().then(value => { ready = true; return value; });
  await flush();
  assert.equal(decoders.length, 8);
  decoders.slice(0, -1).forEach(resolve => resolve());
  await flush(); assert.equal(ready, false);
  decoders.at(-1)();
  const manifest = await scene;
  assert.equal(ready, true);
  assert.equal(manifest.layers.environment.src, '/api/v1/ui-assets/environment.webp');
});
test('decode failure keeps the scene closed and allows a fresh retry', async t => {
  const { prepareDeskScene } = await fresh();
  const fixture = setup(t);
  globalThis.Image.prototype.decode = async function () { throw new Error('decode failed'); };
  await assert.rejects(prepareDeskScene(), /解码/);
  globalThis.Image.prototype.decode = async function () {};
  await prepareDeskScene();
  assert.equal(fixture.urls.filter(url => url.includes('manifest')).length, 2);
});

test('progress counts decoded assets, reserves completion for rendering, and supports late subscribers', async t => {
  const { prepareDeskScene, subscribeSceneProgress } = await fresh();
  setup(t);
  const decoders = [];
  globalThis.Image.prototype.decode = function () { return new Promise(resolve => decoders.push(resolve)); };
  const updates = [];
  const unsubscribe = subscribeSceneProgress(value => updates.push(value));
  const pending = prepareDeskScene();
  await flush();
  assert.equal(updates.at(-1), 8);
  for (const resolve of decoders.slice(0, -1)) { resolve(); await flush(); }
  assert.ok(updates.at(-1) > 70 && updates.at(-1) < 90);
  const late = [];
  const stopLate = subscribeSceneProgress(value => late.push(value));
  assert.equal(late.at(-1), updates.at(-1));
  unsubscribe();
  const count = updates.length;
  decoders.at(-1)(); await pending;
  assert.equal(updates.length, count);
  assert.equal(late.at(-1), 90);
  stopLate();
});

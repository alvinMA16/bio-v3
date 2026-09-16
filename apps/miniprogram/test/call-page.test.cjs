const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function setup(authenticate = async () => true) {
  let page, callbacks;
  let starts = 0, closes = 0, destroyed = 0;
  const timers = new Set();
  const activities = [];
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../miniprogram/pages/chat/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    exports: {}, Date,
    Page: value => { page = value; },
    wx: { setNavigationBarTitle() {}, showToast() {} },
    getApp: () => ({ globalData: { apiBaseUrl: '/api/v1' } }),
    setInterval: fn => { timers.add(fn); return fn; },
    clearInterval: fn => timers.delete(fn),
    require: id => id.includes('account') ? { requireAccount: authenticate } : id.includes('fox-frame-gate') ? { FoxFrameGate: class {} } : id.includes('fox-animation') ? { FOX_ANIMATION_CLIPS: {}, FoxAnimationController: class {
      startAutoCycle() {} resume() {} suspend() {} setActivity(activity) { activities.push(activity); } destroy() { destroyed++; }
    } } : id.includes('voice-client') ? { MiniVoiceClient: class {
      constructor(_, handlers) { callbacks = handlers; }
      start() { starts++; } close() { closes++; callbacks.ended(); }
    } } : { createReceipt: () => null, queueReceipt() {} },
  });
  page.setData = values => Object.assign(page.data, values);
  return { page, timers, activities, callbacks: () => callbacks, counts: () => ({ starts, closes, destroyed }) };
}

test('phone call route starts voice once, updates subtitle and releases call resources on exit', async () => {
  const state = setup();
  await state.page.onLoad({ mode: 'call' });
  state.page.onShow();
  state.page.onReady();
  state.page.startVoice();
  assert.equal(state.page.data.callMode, true);
  assert.equal(state.counts().starts, 1);
  state.callbacks().event({ type: 'state', state: 'listening' });
  state.callbacks().event({ type: 'state', state: 'listening' });
  assert.equal(state.timers.size, 1);
  state.callbacks().event({ type: 'agent', event: { type: 'speech.completed', messageId: 'reply', conversationId: 'session', text: '你好' } });
  assert.equal(state.page.data.callSubtitle, '你好');
  state.page.onHide();
  assert.equal(state.timers.size, 0);
  assert.equal(state.page.data.voiceActive, false);
  state.page.onShow();
  assert.equal(state.counts().starts, 1, 'foregrounding must not silently reopen the microphone');
  state.page.onUnload();
  assert.equal(state.counts().destroyed, 1);
});

test('plain chat route does not start microphone or animation', async () => {
  const state = setup();
  await state.page.onLoad();
  state.page.onReady();
  assert.equal(state.page.data.callMode, false);
  assert.equal(state.counts().starts, 0);
});

test('call distinguishes waiting, user speech, playback and hangup without dropping the notebook', async () => {
  const state = setup();
  await state.page.onLoad({ mode: 'call' });
  state.page.onReady();
  const handlers = state.callbacks();
  handlers.event({ type: 'state', state: 'listening' });
  assert.equal(state.activities.at(-1).phase, 'waiting');
  handlers.speaking(true);
  assert.equal(state.activities.at(-1).phase, 'listening');
  handlers.speaking(false);
  assert.equal(state.activities.at(-1).phase, 'waiting');
  handlers.event({ type: 'state', state: 'agent' });
  handlers.playback(true);
  assert.equal(state.activities.at(-1).speech, 'audio');
  handlers.event({ type: 'state', state: 'synthesizing' });
  assert.equal(state.activities.at(-1).speech, 'audio', 'server state must not stop ongoing mouth animation');
  handlers.playback(false);
  assert.equal(state.activities.at(-1).phase, 'processing');
  assert.ok(state.activities.every(activity => activity.notebook));
  handlers.ended();
  assert.equal(state.activities.at(-1).phase, 'idle');
  assert.equal(state.activities.at(-1).notebook, false);
});

test('authentication finishing after onReady starts one call; denied or unloaded pages never start', async () => {
  let resolve;
  const state = setup(() => new Promise(done => { resolve = done; }));
  const load = state.page.onLoad({ mode: 'call' }); state.page.onReady();
  assert.equal(state.counts().starts, 0);
  resolve(true); await load; assert.equal(state.counts().starts, 1); state.page.onUnload();
  const denied = setup(async () => false); await denied.page.onLoad({ mode: 'call' }); denied.page.onReady();
  assert.equal(denied.counts().starts, 0);
  const abandoned = setup(() => new Promise(done => { resolve = done; }));
  const pending = abandoned.page.onLoad({ mode: 'call' }); abandoned.page.onReady(); abandoned.page.onUnload(); resolve(true); await pending;
  assert.equal(abandoned.counts().starts, 0);
  const hidden = setup(() => new Promise(done => { resolve = done; }));
  const hiddenLoad = hidden.page.onLoad({ mode: 'call' }); hidden.page.onReady(); hidden.page.onHide(); resolve(true); await hiddenLoad;
  assert.equal(hidden.counts().starts, 0); hidden.page.onUnload();
});

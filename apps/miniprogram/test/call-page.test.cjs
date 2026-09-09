const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
  let page, callbacks;
  let starts = 0, closes = 0, destroyed = 0;
  const timers = new Set();
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
    require: id => id.includes('fox-animation') ? { FoxAnimationController: class {
      startAutoCycle() {} resume() {} suspend() {} setActivity() {} destroy() { destroyed++; }
    } } : id.includes('voice-client') ? { MiniVoiceClient: class {
      constructor(_, handlers) { callbacks = handlers; }
      start() { starts++; } close() { closes++; callbacks.ended(); }
    } } : { createReceipt: () => null, queueReceipt() {} },
  });
  page.setData = values => Object.assign(page.data, values);
  return { page, timers, callbacks: () => callbacks, counts: () => ({ starts, closes, destroyed }) };
}

test('phone call route starts voice once, updates subtitle and releases call resources on exit', () => {
  const state = setup();
  state.page.onLoad({ mode: 'call' });
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

test('plain chat route does not start microphone or animation', () => {
  const state = setup();
  state.page.onLoad();
  state.page.onReady();
  assert.equal(state.page.data.callMode, false);
  assert.equal(state.counts().starts, 0);
});

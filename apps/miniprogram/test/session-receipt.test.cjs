const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../miniprogram', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { exports, Date, require: id => { if (id === './session-receipt-data') return load('lib/session-receipt-data.ts'); throw new Error(`Unexpected module ${id}`); }, ...globals });
  return exports;
}

function setup() {
  let stored;
  const requests = [];
  const wx = {
    setStorageSync: (_, value) => { stored = value; },
    getStorageSync: () => stored,
    request: options => { requests.push(options); },
  };
  const receipt = load('lib/session-receipt.ts', { wx, getApp: () => ({ globalData: { apiBaseUrl: '/api/v1' } }) });
  return { receipt, wx, requests };
}

const messages = [{ role: 'user', content: '今天想说说小时候和奶奶一起做饭的事。' }, { role: 'assistant', content: '你还记得做了什么菜吗？' }];

test('empty chats produce no receipt; counts and active duration are independent of wall time', () => {
  const { receipt } = setup();
  assert.equal(receipt.createReceipt([], 1000, 5000, 4000), null);
  assert.equal(receipt.createReceipt([{ role: 'assistant', content: '你好' }], 1000, 5000, 4000), null);
  const value = receipt.createReceipt(messages, 1000, 601000, 65000);
  assert.equal(value.duration, '1 分 5 秒');
  assert.equal(value.shares, 1);
  assert.equal(value.replies, 1);
  assert.equal('summary' in value, false);
});

test('receipt is queued once and only contains basic information without any network request', () => {
  const { receipt, requests } = setup();
  const first = receipt.createReceipt(messages, 1000, 5000, 4000);
  receipt.queueReceipt(first);
  assert.equal(receipt.takePendingReceipt().id, first.id);
  assert.equal(receipt.takePendingReceipt(), null);
  assert.equal(receipt.getLatestReceipt().shares, 1);
  assert.deepEqual(Object.keys(first).sort(), ['date', 'duration', 'id', 'replies', 'shares', 'timeRange']);
  assert.equal(requests.length, 0);
});

test('chat backgrounding does not print; unloading prints once and cancels pending request', () => {
  const { receipt } = setup();
  let page;
  load('pages/chat/index.ts', {
    Page: value => { page = value; },
    require: id => id.includes('session-receipt') ? receipt : { MiniVoiceClient: class {} },
  });
  page.onLoad();
  page.onShow();
  page.data.messages = messages;
  page.onHide();
  assert.equal(receipt.takePendingReceipt(), null);
  let aborted = false;
  page.requestTask = { abort: () => { aborted = true; } };
  page.onUnload();
  assert.equal(aborted, true);
  assert.equal(receipt.takePendingReceipt().shares, 1);
  page.onUnload();
  assert.equal(receipt.takePendingReceipt(), null);
});

test('explicit hang-up prepares receipt before the home page becomes visible', () => {
  const { receipt } = setup();
  let page, shown;
  load('pages/chat/index.ts', {
    Page: value => { page = value; },
    wx: { navigateBack: () => { shown = receipt.takePendingReceipt(); } },
    require: id => id.includes('session-receipt') ? receipt : { MiniVoiceClient: class {} },
  });
  page.onLoad(); page.onShow(); page.data.messages = messages;
  page.leaveChat();
  assert.equal(shown.shares, 1);
  page.onUnload();
  assert.equal(receipt.takePendingReceipt(), null);
});

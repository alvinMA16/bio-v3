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
  vm.runInNewContext(source, { exports, Date, ...globals });
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
  assert.match(value.summary, /奶奶/);
});

test('pending receipt is consumed once; failure preserves excerpt and late results cannot overwrite new sessions', () => {
  const { receipt, requests } = setup();
  const first = receipt.createReceipt(messages, 1000, 5000, 4000);
  receipt.queueReceipt(first, messages);
  assert.equal(receipt.takePendingReceipt().receipt.id, first.id);
  assert.equal(receipt.takePendingReceipt(), null);
  let updates = 0;
  receipt.summarizeReceipt(first, messages, () => updates++);
  requests[0].fail();
  assert.equal(receipt.getLatestReceipt().status, 'excerpt');
  receipt.summarizeReceipt(first, messages, () => updates++);
  const second = receipt.createReceipt(messages, 6000, 9000, 3000);
  receipt.queueReceipt(second, messages);
  requests[1].success({ statusCode: 201, data: { summary: '旧总结', topics: ['回忆'] } });
  assert.equal(receipt.getLatestReceipt().id, second.id);
  assert.equal(updates, 1);
});

test('long transcript is bounded and successful summary is retained', () => {
  const { receipt, requests } = setup();
  const long = Array.from({ length: 100 }, (_, index) => ({ role: 'user', content: `${index}:` + '字'.repeat(2000) }));
  const value = receipt.createReceipt(long, 1000, 5000, 4000);
  receipt.queueReceipt(value, long);
  const pending = receipt.takePendingReceipt();
  assert.equal(pending.messages.length, 40);
  assert.equal(pending.messages[0].content.length, 1000);
  assert.match(pending.messages[39].content, /^99:/);
  receipt.summarizeReceipt(value, pending.messages, () => {});
  requests[0].success({ statusCode: 201, data: { summary: '回忆和奶奶一起做饭的童年时光。', topics: ['童年', '家人'] } });
  assert.equal(receipt.getLatestReceipt().status, 'ready');
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
  assert.equal(receipt.takePendingReceipt().receipt.shares, 1);
  page.onUnload();
  assert.equal(receipt.takePendingReceipt(), null);
});

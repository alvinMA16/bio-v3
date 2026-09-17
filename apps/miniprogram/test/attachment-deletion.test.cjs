const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
  let definition;
  const requests = [], events = [];
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../miniprogram/components/attachment-viewer/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    exports: {}, require: () => ({ authHeader: () => ({}), handleUnauthorized() {} }),
    Component: value => { definition = value; }, getApp: () => ({ globalData: { apiBaseUrl: '/api/v1' } }),
    wx: { request: value => requests.push(value), getFileSystemManager: () => ({ unlink() {} }) },
  });
  const instance = { ...definition.methods, data: { ...definition.data },
    properties: { attachment: { id: 'historical', title: '家书.txt', url: '/api/v1/materials/11111111-1111-4111-8111-111111111111/file' }, focused: false },
    setData(value) { Object.assign(this.data, value); }, triggerEvent(name) { events.push(name); },
  };
  return { instance, definition, requests, events };
}

test('deleted originals show a persistent card state; temporary errors remain retryable', async () => {
  for (const [status, expected] of [[410, 'deleted'], [404, 'unavailable'], [503, '']]) {
    const { instance, requests } = setup();
    const loading = instance.load();
    requests[0].success({ statusCode: status, data: {} });
    await loading;
    assert.equal(instance.data.originalStatus, expected);
    assert.equal(instance.data.loading, false);
    assert.equal(instance.data.image, '');
    assert.equal(instance.data.count, 0);
    assert.equal(Boolean(instance.data.error), status === 503);
    assert.equal(instance.properties.attachment.title, '家书.txt');
  }
});

test('a late preview response cannot restore an original after its deletion event', async () => {
  const { instance, definition, requests, events } = setup();
  const old = instance.load();
  instance.properties.attachment.originalStatus = 'deleted';
  definition.observers.attachment.call(instance, instance.properties.attachment);
  requests[0].success({ statusCode: 200, data: { mimeType: 'text/plain', text: '原件内容' } });
  await old;
  assert.equal(instance.data.originalStatus, 'deleted');
  assert.equal(instance.data.text, '');
  assert.equal(instance.data.image, '');
  assert.equal(requests.length, 1);
  assert.deepEqual(events, []);
});

test('returning from the folder revalidates a historical attachment', async () => {
  const { instance, definition, requests } = setup();
  definition.pageLifetimes.show.call(instance);
  assert.equal(requests.length, 1);
  requests[0].success({ statusCode: 410, data: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.data.originalStatus, 'deleted');
});

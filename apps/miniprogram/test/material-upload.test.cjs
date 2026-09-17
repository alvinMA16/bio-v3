const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('upload preserves filename, reuses duplicate and explains renamed material', () => {
  let page, upload, opened, message, cleaned;
  const fs = { mkdirSync() {}, copyFile: options => options.success(), rmdir: options => { cleaned = options.dirPath; } };
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../miniprogram/pages/folder/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    wx: { env: { USER_DATA_PATH: '/private' }, getFileSystemManager: () => fs,
      uploadFile: options => { upload = options; }, showToast: value => { message = value.title; }, showModal: value => { message = value.content; } },
    exports: {}, require: () => ({ authHeader: () => ({}), handleUnauthorized() {} }),
    getApp: () => ({ globalData: { apiBaseUrl: 'https://example.test/api/v1' } }),
    Page: value => { page = value; }, setTimeout, clearTimeout,
  });
  page.setData = values => Object.assign(page.data, values);
  page.showItem = item => { opened = item; };
  page.refresh = async () => {};
  page.upload('/tmp/source', 100, '家书.txt');
  assert.match(upload.filePath, /^\/private\/upload-\d+\/家书\.txt$/);
  const pending = upload;
  page.upload('/tmp/second', 100, 'another.txt');
  assert.equal(upload, pending);
  upload.success({ statusCode: 201, data: JSON.stringify({ id: 'existing', uploadOutcome: 'duplicate' }) });
  assert.equal(opened.id, 'existing');
  assert.match(message, /已经在资料夹/);
  upload.complete();
  assert.equal(cleaned, upload.filePath.slice(0, upload.filePath.lastIndexOf('/')));
  assert.equal(page.data.busy, false);
  page.upload('/tmp/source', 100, '家书.txt');
  upload.success({ statusCode: 201, data: JSON.stringify({ id: 'new', filename: '家书 (2).txt', uploadOutcome: 'renamed' }) });
  assert.equal(opened.id, 'new');
  assert.match(message, /家书 \(2\)\.txt/);
  upload.complete();
  cleaned = undefined;
  fs.copyFile = options => options.fail();
  page.upload('/tmp/source', 100, '家书.txt');
  assert.equal(page.data.busy, false);
  assert.match(page.data.error, /无法读取/);
  assert.ok(cleaned);
});

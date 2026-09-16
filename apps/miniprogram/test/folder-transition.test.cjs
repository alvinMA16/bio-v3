const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
  let page, delay, sheet, modal, route;
  const timers = new Set();
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../miniprogram/pages/folder/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    wx: { showActionSheet: value => { sheet = value; }, showModal: value => { modal = value; }, navigateTo: value => { route = value.url; } },
    exports: {}, require: () => ({}), Page: value => { page = value; },
    setTimeout: (fn, ms) => { delay = ms; timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  });
  page.setData = values => Object.assign(page.data, values);
  page.data.items = [
    { id: 'photo', kind: 'image', title: '院子', filename: '院子.jpg' },
    { id: 'doc', kind: 'document', title: '家书', filename: '家书.pdf' },
  ];
  page.applyFilter();
  return { page, timers, sheet: () => sheet, modal: () => modal, route: () => route, delay: () => delay, choose: filter => page.changeFilter({ currentTarget: { dataset: { filter } } }),
    flush: () => { const pending = [...timers]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('rapid tab and search changes settle on the latest intent after outgoing files leave', () => {
  const s = setup();
  s.choose('image');
  assert.equal(s.page.data.visibleItems.length, 2);
  assert.equal(s.page.data.leaving, true);
  s.choose('document');
  s.page.searchInput({ detail: { value: '家书' } });
  assert.equal(s.timers.size, 1);
  s.flush();
  assert.equal(s.page.data.filter, 'document');
  assert.equal(s.page.data.renderedFilter, 'document');
  assert.equal(s.page.data.visibleItems.length, 1);
  assert.equal(s.page.data.visibleItems[0].id, 'doc');
  assert.equal(s.page.data.leaving, false);
  s.choose('all'); s.choose('image'); s.choose('all');
  s.page.searchInput({ detail: { value: '' } }); s.flush();
  assert.equal(s.page.data.visibleItems.length, 2);
});

test('leaving the page cancels pending transitions', () => {
  const s = setup(); s.choose('image'); s.page.onUnload();
  assert.equal(s.timers.size, 0);
  s.page.setData = () => assert.fail('unloaded page must not update');
  s.flush();
});

test('search waits one second, searches across categories, submits immediately and clears on exit', () => {
  const s = setup(); s.choose('image'); s.flush();
  s.page.toggleSearch();
  assert.equal(s.page.data.visibleItems.length, 0);
  s.page.searchInput({ detail: { value: '家' } });
  assert.equal(s.delay(), 1000);
  s.page.searchInput({ detail: { value: '家书' } });
  assert.equal(s.timers.size, 1);
  assert.equal(s.page.data.visibleItems.length, 0);
  s.flush();
  assert.equal(s.page.data.visibleItems[0].id, 'doc');
  s.page.searchInput({ detail: { value: '院子' } });
  s.page.searchNow();
  assert.equal(s.timers.size, 0);
  assert.equal(s.page.data.visibleItems[0].id, 'photo');
  s.page.searchInput({ detail: { value: '   ' } });
  assert.equal(s.page.data.visibleItems.length, 0);
  s.page.searchInput({ detail: { value: '家书' } });
  s.page.toggleSearch();
  assert.equal(s.timers.size, 0);
  assert.equal(s.page.data.visibleItems[0].id, 'photo');
});

test('preview back returns to the folder instead of leaving the page', () => {
  const s = setup();
  s.page.data.selected = { id: 'doc', title: '家书', description: '' };
  s.page.data.title = '家书'; s.page.data.description = '';
  s.page.exitFolder();
  assert.equal(s.page.data.selected, null);
  assert.equal(s.page.data.items.length, 2);
});

test('long press offers preview/chat/delete, suppresses release tap and confirms deletion', () => {
  const s = setup(); const event = { currentTarget: { dataset: { id: 'doc' } } };
  let previewed;
  s.page.showItem = item => { previewed = item.id; };
  s.page.fileActions(event);
  assert.equal(s.page.data.actionItem.id, 'doc');
  s.page.select(event); assert.equal(previewed, undefined);
  s.page.chooseAction({ currentTarget: { dataset: { action: 'preview' } } }); assert.equal(previewed, 'doc');
  s.page.fileActions(event); s.page.chooseAction({ currentTarget: { dataset: { action: 'chat' } } });
  assert.ok(s.route().includes('materialId=doc'));
  s.page.fileActions(event); s.page.chooseAction({ currentTarget: { dataset: { action: 'delete' } } });
  assert.ok(s.modal().content.includes('家书'));
  assert.equal(s.page.data.items.length, 2);
  s.modal().success({ confirm: false });
  assert.equal(s.page.data.items.length, 2);
});

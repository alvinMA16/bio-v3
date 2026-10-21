import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

function phoneMarkup(html) {
  const start = html.indexOf('<div class="phone-preview"');
  assert.notEqual(start, -1, 'The product phone must be rendered');
  let depth = 0;
  for (const match of html.slice(start).matchAll(/<div\b[^>]*>|<\/div>/g)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) return html.slice(start, start + match.index + match[0].length);
  }
  assert.fail('The phone markup must be complete');
}

test('public and internal entries render identical product content without public debug controls', async () => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null };
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, entries: [] },
    appType: 'custom',
  });
  try {
    const { App } = await server.ssrLoadModule('/src/App.tsx');
    const { PhonePreview } = await server.ssrLoadModule('/src/phone-preview.tsx');
    const product = renderToStaticMarkup(createElement(App));
    const internal = renderToStaticMarkup(createElement(App, { internal: true }));
    assert.equal(phoneMarkup(product), phoneMarkup(internal));
    const callProps = { children: null, subtitle: '', activity: { phase: 'idle', notebook: false, speech: 'silent' }, running: false,
      callOpen: true, callStartedAt: null, callFailed: true, status: '已保存的内容会保留。', mode: 'conversation',
      startDisabled: false, onStart() {}, onEnd() {}, receipt: null, receiptVisible: false, onReceiptClose() {}, onMaterialChat() {} };
    const paused = renderToStaticMarkup(createElement(PhonePreview, { ...callProps, callRecovery: 'available' }));
    const expired = renderToStaticMarkup(createElement(PhonePreview, { ...callProps, callRecovery: 'expired' }));
    assert.ok(paused.includes('继续刚才的对话')); assert.ok(paused.includes('通话已暂停'));
    assert.ok(expired.includes('开始新通话')); assert.ok(!expired.includes('继续刚才的对话'));
    const recoverable = renderToStaticMarkup(createElement(PhonePreview, { ...callProps, hasSavedCapture: true, onStartNew() {} }));
    assert.ok(recoverable.includes('继续讲述')); assert.ok(recoverable.includes('开始新通话'));
    assert.ok(recoverable.includes('有未完成的讲述')); assert.ok(!recoverable.includes('通话已暂停'));
    const expiredCapture = renderToStaticMarkup(createElement(PhonePreview, { ...callProps, hasSavedCapture: true, callRecovery: 'expired', onStartNew() {} }));
    assert.ok(expiredCapture.includes('上次通话已结束')); assert.ok(expiredCapture.includes('新通话继续讲述'));
    assert.ok(!expiredCapture.includes('通话已暂停')); assert.ok(!expiredCapture.includes('继续刚才的对话'));
    const pausedCapture = renderToStaticMarkup(createElement(PhonePreview, { ...callProps, hasSavedCapture: true, callRecovery: 'available' }));
    assert.ok(pausedCapture.includes('通话已暂停')); assert.ok(pausedCapture.includes('继续刚才的对话'));
    const waiting = renderToStaticMarkup(createElement(PhonePreview, { ...callProps, callFailed: false, status: '正在恢复对话' }));
    assert.ok(waiting.includes('正在恢复对话')); assert.doesNotMatch(waiting, /重放|补存|转写|\d+ 秒/); assert.ok(waiting.includes('取消呼叫'));
    for (const label of ['资料夹', '呼叫令狸', '文稿集']) assert.ok(product.includes(label));
    for (const label of ['Prompt &amp; runtime debugger', '对话历史与输入', '配置与上下文', '运行详情与历史']) {
      assert.ok(internal.includes(label), `Internal retains ${label}`);
      assert.ok(!product.includes(label), `Public excludes ${label}`);
    }
  } finally {
    await server.close();
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});

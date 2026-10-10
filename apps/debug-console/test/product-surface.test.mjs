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
    const product = renderToStaticMarkup(createElement(App));
    const internal = renderToStaticMarkup(createElement(App, { internal: true }));
    assert.equal(phoneMarkup(product), phoneMarkup(internal));
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

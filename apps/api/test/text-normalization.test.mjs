import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDocumentBlock, normalizeDocumentTitle, normalizeSpeechText } from '../dist/text-normalization/index.js';

test('shared recognition has distinct speech and document link policies', () => {
  const text = '查看[**资料**](https://example.com/a(b)?x=1)。';
  assert.equal(normalizeSpeechText(text), '查看资料。');
  assert.deepEqual(normalizeDocumentBlock({ id: 'p', kind: 'paragraph', text }), {
    id: 'p', kind: 'paragraph', text: '查看资料（https://example.com/a(b)?x=1）。',
  });
});

test('document structure and line breaks survive normalization without mutating inputs', () => {
  for (const [kind, text, expected] of [
    ['heading', '## **标题**', '标题'],
    ['paragraph', '**甲**\n乙和 *丙*。', '甲\n乙和 丙。'],
    ['list', '- **第一项**\n- 第二项', '第一项\n第二项'],
    ['list', '3. **第三项**\n4. 第四项', '3、第三项\n4、第四项'],
    ['quote', '> **引文**', '引文'],
    ['paragraph', '|项目|金额|\n|---|---:|\n|合计|12.50|', '项目\t金额\n\n合计\t12.50\n'],
  ]) {
    const input = Object.freeze({ id: 'p', kind, text });
    const result = normalizeDocumentBlock(input);
    assert.deepEqual(result, { id: 'p', kind, text: expected });
    assert.equal(input.text, text);
    assert.deepEqual(normalizeDocumentBlock(result), result);
  }
  assert.equal(normalizeDocumentTitle('# **回忆**'), '回忆');
});

test('code blocks bypass processing, including formatting examples and escapes', () => {
  const block = { id: 'code', kind: 'code', text: '```md\n# **heading**\n[x](url)\n```\nC:\\new\\report' };
  assert.deepEqual(normalizeDocumentBlock(block), block);
  assert.equal(normalizeDocumentBlock({ id: 'p', kind: 'paragraph', text: '计算 `a * b`，变量 file_name，负数 -3.14。' }).text,
    '计算 a * b，变量 file_name，负数 -3.14。');
});

test('unsafe document structures fail rather than dropping code or link content', () => {
  for (const text of ['```js\nconst n = 1;\n```', '看[资料](https://example.com', '看[资料](https://example.com\n后文']) {
    assert.throws(() => normalizeDocumentBlock({ id: 'p', kind: 'paragraph', text }), /本批次未保存/);
  }
});

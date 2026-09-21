import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeechTextStream, normalizeSpeechText as plainSpeechText } from '../dist/text-normalization/index.js';
import { SpokenSegments } from '../dist/voice/spoken-segments.js';

const cases = [
  ['这是**强调**，也有 *斜体* 和 ~~删除线~~。', '这是强调，也有 斜体 和 删除线。'],
  ['**English Name**，以及__中文名称__。', 'English Name，以及中文名称。'],
  ['## 标题\n- 第一项\n2. 第二项\n> 引用\n', '标题\n第一项\n第二项\n引用\n'],
  ['看[**官网**](https://example.com/a(b)?x=1)。![图片](https://example.com/image.png)', '看官网。图片'],
  ['`file_name` 与 `a * b`\n```js\nconst a = 2 * 3;\n```\n结束。', 'file_name 与 a * b\n\nconst a = 2 * 3;\n结束。'],
  ['价格 -3.14 元，2 * 3 = 6，a*b，C#，file_name，#话题，x**2。', '价格 -3.14 元，2 * 3 = 6，a*b，C#，file_name，#话题，x**2。'],
  ['说明[待确认]，括号保留。\\* 是星号。', '说明[待确认]，括号保留。* 是星号。'],
  ['|项目|金额|\n|---|---:|\n|**合计**|12.50|\n', '项目，金额\n\n合计，12.50\n'],
  ['这是**跨句强调。下一句也在里面**。', '这是跨句强调。下一句也在里面。'],
  ['**bold *nested*** and *nested **bold***。', 'bold nested and nested bold。'],
  ['正常中文，café 👩🏽‍💻。', '正常中文，café 👩🏽‍💻。'],
];

for (const [source, expected] of cases) test(`speech normalization is independent of every split: ${source.slice(0, 20)}`, () => {
  assert.equal(plainSpeechText(source), expected);
  for (let cut = 0; cut <= source.length; cut++) {
    const stream = createSpeechTextStream();
    const deltas = stream.push(source.slice(0, cut)) + stream.push(source.slice(cut));
    const done = stream.finish(source);
    assert.equal(deltas + done.delta, expected, `split ${cut}`);
    assert.equal(done.text, expected);
  }
  const stream = createSpeechTextStream();
  let output = '';
  for (let at = 0; at < source.length; at++) output += stream.push(source[at]);
  assert.equal(output + stream.finish(source).delta, expected);
});

test('plain speech and emphasized content stream before the closing marker or completion', () => {
  const stream = createSpeechTextStream();
  assert.equal(stream.push('我先查一下。'), '我先查一下。');
  assert.equal(stream.push('*'), '');
  assert.equal(stream.push('*这个名字'), '这个名字');
  assert.equal(stream.push('*'), '');
  assert.equal(stream.push('*。'), '。');
  assert.deepEqual(stream.finish('我先查一下。**这个名字**。'), { delta: '', text: '我先查一下。这个名字。' });
});

test('completion can supply an unstreamed suffix without duplicating already queued TTS', () => {
  const stream = createSpeechTextStream(), segments = new SpokenSegments();
  const heard = segments.push('one', stream.push('已经**完成**。'));
  const done = stream.finish('已经**完成**。请查看。');
  heard.push(...segments.push('one', done.delta), ...segments.push('one', done.text, true));
  assert.deepEqual(heard, ['已经完成。', '请查看。']);
});

test('a changed final snapshot fails rather than rewriting text already spoken', () => {
  const stream = createSpeechTextStream(); stream.push('已经完成。');
  assert.throws(() => stream.finish('没有完成。'), /snapshot changed/);
});

test('unfinished syntax and fresh messages do not leak parser state or hold unlimited text', () => {
  assert.equal(plainSpeechText('**未结束'), '未结束');
  assert.equal(plainSpeechText('[没有闭合'), '[没有闭合');
  const stream = createSpeechTextStream();
  assert.ok(stream.push('[' + '字'.repeat(600)).length > 500);
  assert.equal(plainSpeechText('普通回复。'), '普通回复。');
});

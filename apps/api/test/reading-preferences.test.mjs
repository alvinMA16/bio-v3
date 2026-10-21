import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { readingFontTool } from '../dist/agent/reading-preferences.js';

test('reading size persists by user across new storage instances, moves one step and clamps at both ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bio-reading-'));
  try {
    const config = new ConfigService({ AGENT_DATA_DIR: root }), storage = new AgentStorage(config), events = [];
    const tool = readingFontTool(storage, 'alice', event => events.push(event));
    const adjust = async size => JSON.parse((await tool.execute('font', { size })).content[0].text);
    assert.equal(storage.readingFontSize('alice'), '标准');
    assert.equal((await adjust('调小')).fontSize, '较小');
    assert.deepEqual(events.at(-1), { type: 'reading.preference.updated', previousFontSize: '标准', fontSize: '较小' });
    assert.equal(new AgentStorage(config).readingFontSize('alice'), '较小');
    assert.equal(storage.readingFontSize('bob'), '标准'); assert.equal(storage.readingFontSize(), '标准');
    await adjust('调小'); assert.equal((await adjust('调小')).changed, false);
    assert.equal(storage.readingFontSize('alice'), '小号');
    await adjust('大号'); assert.equal((await adjust('调大')).changed, false);
    assert.equal((await adjust('恢复默认')).fontSize, '标准');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(tool.execute('font', { size: '小号' }, abort.signal));
    assert.equal(storage.readingFontSize('alice'), '标准');
    assert.throws(() => storage.saveReadingFontSize('invalid', 'alice'));
    const oldClient = readingFontTool(storage, 'alice', event => events.push(event), false);
    await assert.rejects(oldClient.execute('font', { size: '调小' }), /刷新页面/);
    assert.equal(storage.readingFontSize('alice'), '标准');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('background tool validates colors, persists by account, supports undo/reset and rejects old clients', async () => {
  const { documentBackgroundTool } = await import('../dist/agent/reading-preferences.js');
  const root = mkdtempSync(join(tmpdir(), 'bio-background-'));
  try {
    const config = new ConfigService({ AGENT_DATA_DIR: root }), storage = new AgentStorage(config), events = [];
    const tool = documentBackgroundTool(storage, 'alice', event => events.push(event));
    const call = async params => JSON.parse((await tool.execute('background', params)).content[0].text);
    assert.equal((await call({ backgroundColor: '#001a2b' })).textColor, '#FFFFFF');
    assert.equal(new AgentStorage(config).documentBackground('alice').backgroundColor, '#001A2B');
    assert.equal(storage.documentBackground('bob').backgroundColor, '#FCFCF9');
    assert.deepEqual(events.at(-1), { type: 'document.background.updated', backgroundColor: '#001A2B' });
    for (const params of [{}, { backgroundColor: 'red' }, { backgroundColor: '#00000000' }, { backgroundColor: '#ffffff', action: 'reset' }]) await assert.rejects(call(params));
    assert.equal(storage.documentBackground('alice').backgroundColor, '#001A2B');
    await call({ backgroundColor: '#ffff00' });
    assert.equal((await call({ action: 'undo' })).backgroundColor, '#001A2B');
    assert.equal((await call({ action: 'reset' })).backgroundColor, '#FCFCF9');
    const old = documentBackgroundTool(storage, 'alice', () => assert.fail('Must not emit'), false);
    await assert.rejects(old.execute('background', { backgroundColor: '#000000' }), /刷新/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(tool.execute('background', { backgroundColor: '#000000' }, abort.signal));
    assert.equal(storage.documentBackground('alice').backgroundColor, '#FCFCF9');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automatic text contrast meets 4.5 across an RGB grid and boundary grays', async () => {
  const { documentTextColor } = await import('@bio/contracts');
  const check = (r, g, b) => {
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    const linear = [r, g, b].map(v => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4);
    const l = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    const contrast = documentTextColor(hex) === '#000000' ? (l + .05) / .05 : 1.05 / (l + .05);
    assert.ok(contrast >= 4.5, `${hex}: ${contrast}`);
  };
  for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) check(r, g, b);
  for (let gray = 0; gray < 256; gray++) check(gray, gray, gray);
  assert.equal(documentTextColor('#FFFF00'), '#000000');
  assert.equal(documentTextColor('#0000FF'), '#FFFFFF');
});

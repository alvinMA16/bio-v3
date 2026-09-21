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

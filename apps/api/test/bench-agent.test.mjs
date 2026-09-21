import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('bench replays full history through production context without leaking evaluation targets', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bio-bench-test-'));
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/bench-agent.mjs', import.meta.url)), '--output', join(root, 'run')]);
    const run = JSON.parse(await readFile(join(root, 'run/results.json'), 'utf8'));
    assert.equal(run.live, false);
    assert.equal(run.results.length, run.cases.length);
    for (const c of run.cases) {
      const row = run.results.find(r => r.id === c.id);
      assert.equal(row.status, 'ok', c.id);
      assert.equal(row.requests.length, 1);
      const payload = row.requests[0];
      const serialized = JSON.stringify(payload);
      assert.ok(!serialized.includes(c.rubric.expectation), 'rubric must not enter model input');
      for (const message of c.messages) assert.ok(serialized.includes(message.content), `missing history in ${c.id}`);
      const text = m => typeof m.content === 'string' ? m.content : m.content?.map(p => p.text ?? '').join('');
      const runtime = payload.messages.filter(m => text(m)?.includes('"type":"bio_runtime_context"'));
      assert.equal(runtime.length, 1);
      assert.equal(JSON.parse(text(runtime[0])).scene, c.scene);
      assert.deepEqual(payload.tools.map(t => t.function.name), ['list_attachments', 'switch_mode', 'read_document', 'edit_document', 'show_document', 'restore_document', 'read_attachment', 'set_reading_font_size']);
      if (c.scene === 'attachment_conversation') assert.ok(serialized.includes(c.attachment.text));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

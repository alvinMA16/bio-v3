import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MaterialsService } from '../dist/materials/materials.service.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bio-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = new ConfigService({ AGENT_DATA_DIR: root });
  return { service: new MaterialsService(config), restart: () => new MaterialsService(config) };
}

test('renamed duplicates reuse edited metadata; same names with different bytes retain both originals', async t => {
  const { service } = await setup(t);
  const source = Buffer.from('first version');
  const first = await service.upload('记忆.txt', source, 'alice');
  await service.update(first.id, '童年', '我的说明', 'alice');
  const duplicate = await service.upload('改名.txt', source, 'alice');
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.uploadOutcome, 'duplicate');
  assert.equal(duplicate.title, '童年');
  assert.equal(duplicate.description, '我的说明');
  const next = await service.upload('记忆.txt', Buffer.from('second version'), 'alice');
  assert.equal(next.filename, '记忆 (2).txt');
  assert.equal(next.uploadOutcome, 'renamed');
  const third = await service.upload('记忆.txt', Buffer.from('third version'), 'alice');
  assert.equal(third.filename, '记忆 (3).txt');
  assert.deepEqual((await service.original(first.id, 'alice')).buffer, source);
  assert.equal((await service.original(next.id, 'alice')).buffer.toString(), 'second version');
  const bob = await service.upload('记忆.txt', source, 'bob');
  assert.notEqual(bob.id, first.id);
  assert.equal(bob.uploadOutcome, 'created');
  await service.remove(first.id, 'alice');
  const restored = await service.upload('记忆.txt', source, 'alice');
  assert.notEqual(restored.id, first.id);
  assert.equal(restored.uploadOutcome, 'created');
});

test('concurrent uploads across service instances save one copy and allocate distinct names', async t => {
  const { service, restart } = await setup(t);
  const other = restart();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? service : other).upload(`name${i}.txt`, Buffer.from('same bytes'), 'alice')));
  assert.equal(new Set(results.map(item => item.id)).size, 1);
  assert.equal(results.filter(item => item.uploadOutcome === 'created').length, 1);
  assert.equal((await service.list('alice')).length, 1);
  const different = await Promise.all(['one', 'two', 'three'].map(text => service.upload('same.txt', Buffer.from(text), 'alice')));
  assert.deepEqual(different.map(item => item.filename), ['same.txt', 'same (2).txt', 'same (3).txt']);
  await assert.rejects(service.upload('bad.png', Buffer.from('invalid'), 'alice'));
  assert.equal((await service.upload('good.txt', Buffer.from('recovered'), 'alice')).uploadOutcome, 'created');
});

test('legacy originals get persistent fingerprints without changing user metadata', async t => {
  const { service, restart } = await setup(t);
  const source = Buffer.from('legacy contents');
  const item = await service.upload('legacy.txt', source, 'alice');
  const directory = join(service.root, '.users', createHash('sha256').update('alice').digest('hex'), item.id);
  await rm(join(directory, 'sha256'));
  const metadata = await readFile(join(directory, 'metadata.json'), 'utf8');
  const restarted = restart();
  const original = t.mock.method(restarted, 'original');
  assert.equal((await restarted.upload('again.txt', source, 'alice')).id, item.id);
  assert.equal(original.mock.callCount(), 1);
  assert.equal(await readFile(join(directory, 'metadata.json'), 'utf8'), metadata);
  assert.equal(await readFile(join(directory, 'sha256'), 'utf8'), createHash('sha256').update(source).digest('hex'));
  await restarted.upload('again.txt', source, 'alice');
  assert.equal(original.mock.callCount(), 1);
  await writeFile(join(directory, 'sha256'), 'partial');
  assert.equal((await restarted.upload('again.txt', source, 'alice')).id, item.id);
  assert.equal(original.mock.callCount(), 2);
});

test('deletion queued before a new upload permits a fresh material ID', async t => {
  const { service } = await setup(t);
  const source = Buffer.from('delete and reupload');
  const item = await service.upload('file.txt', source);
  const [, next] = await Promise.all([service.remove(item.id), service.upload('file.txt', source)]);
  assert.notEqual(next.id, item.id);
  assert.equal(next.uploadOutcome, 'created');
  assert.deepEqual((await service.list()).map(item => item.id), [next.id]);
});

import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { MaterialsService } from '../dist/materials/materials.service.js';

const fakeConfig = root => new ConfigService({ AGENT_DATA_DIR: root, MATERIAL_STORAGE: 'oss', MATERIAL_OSS_ACCESS_KEY_ID: 'test-id', MATERIAL_OSS_ACCESS_KEY_SECRET: 'test-secret', MATERIAL_OSS_BUCKET: 'test-bucket', MATERIAL_OSS_REGION: 'oss-cn-beijing' });
test('authenticated production requires configured OSS instead of silently using local uploads', () => {
  assert.throws(() => new MaterialsService(new ConfigService({ NODE_ENV: 'production', AUTH_ENABLED: 'true' })), /OSS configuration is incomplete/);
});
test('OSS originals and thumbnails stay private, owner-scoped, durable and inaccessible through another account', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bio-oss-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new MaterialsService(fakeConfig(root));
  const objects = new Map(); let reads = 0;
  const client = service.objectStore.client;
  t.mock.method(client, 'put', async (key, data, options) => {
    assert.match(key, /^bio-v3\/users\/[a-f0-9]{64}\/materials\/[a-f0-9-]{36}\/(original|thumbnail.webp)$/);
    assert.equal(options.headers['x-oss-object-acl'], 'private');
    assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
    assert.ok(!objects.has(key)); objects.set(key, Buffer.from(data));
  });
  t.mock.method(client, 'get', async key => { reads++; assert.ok(objects.has(key)); return { content: objects.get(key) }; });
  t.mock.method(client, 'delete', async key => { objects.delete(key); });
  const source = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#718261' } }).png().toBuffer();
  const alice = await service.upload('family.png', source, 'alice');
  const bob = await service.upload('family.png', source, 'bob');
  assert.equal(objects.size, 4);
  const aPrefix = createHash('sha256').update('alice').digest('hex');
  assert.ok([...objects.keys()].filter(key => key.includes(aPrefix)).length === 2);
  const files = await readdir(join(service.root, '.users', aPrefix, alice.id));
  assert.deepEqual(files.sort(), ['metadata.json', 'storage']);
  assert.ok(!JSON.stringify(alice).includes('oss-'));
  assert.ok(!JSON.stringify(alice).includes(aPrefix));
  await assert.rejects(service.upload('unowned.txt', Buffer.from('unowned')));
  for (const operation of [() => service.original(alice.id, 'bob'), () => service.thumbnail(alice.id, 'bob'), () => service.remove(alice.id, 'bob'), () => service.update(alice.id, 'stolen', '', 'bob'), () => service.attachment(alice.id, 'bob')]) await assert.rejects(operation, /资料不存在/);
  assert.equal(reads, 0, 'Unauthorized reads must fail before contacting OSS');
  assert.deepEqual((await service.original(alice.id, 'alice')).buffer, source);
  assert.ok((await sharp(await service.thumbnail(alice.id, 'alice')).metadata()).width <= 480);
  const restarted = new MaterialsService(fakeConfig(root)); restarted.objectStore = service.objectStore;
  assert.deepEqual((await restarted.original(bob.id, 'bob')).buffer, source);
  await service.remove(alice.id, 'alice');
  assert.equal(objects.size, 2); assert.equal((await service.list('bob')).length, 1);
  const local = new MaterialsService(new ConfigService({ AGENT_DATA_DIR: root }));
  await assert.rejects(local.original(bob.id, 'bob'), /尚未配置/);
  await service.remove(bob.id, 'bob'); assert.equal(objects.size, 0);
});

test('failed OSS derivative upload does not publish metadata and cleans the partial original', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bio-oss-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new MaterialsService(fakeConfig(root));
  const objects = new Map();
  t.mock.method(service.objectStore.client, 'put', async (key, data) => { if (key.endsWith('thumbnail.webp')) throw new Error('provider-secret'); objects.set(key, data); });
  t.mock.method(service.objectStore.client, 'delete', async key => { objects.delete(key); });
  const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(service.upload('photo.png', source, 'alice'), /资料存储暂时不可用/);
  assert.equal(objects.size, 0); assert.deepEqual(await service.list('alice'), []);
});

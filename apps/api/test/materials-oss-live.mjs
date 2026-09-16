// Explicitly opt in: creates only synthetic users/files and removes them on completion.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { MaterialsService } from '../dist/materials/materials.service.js';
assert.equal(process.env.MATERIAL_OSS_LIVE_EVAL, 'true');
const root = await mkdtemp(join(tmpdir(), 'bio-material-oss-live-'));
const service = new MaterialsService(new ConfigService({ ...process.env, AGENT_DATA_DIR: root, MATERIAL_STORAGE: 'oss', MATERIAL_VISION_API_KEY: '' }));
const alice = `oss-eval-${randomUUID()}`, bob = `oss-eval-${randomUUID()}`;
const created = [];
try {
  const original = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#758361' } }).png().toBuffer();
  for (const user of [alice, bob]) {
    const item = await service.upload('synthetic-test.png', original, user); created.push({ user, item });
    assert.deepEqual((await service.original(item.id, user)).buffer, original);
    assert.equal((await sharp(await service.thumbnail(item.id, user)).metadata()).format, 'webp');
    const stranger = user === alice ? bob : alice;
    for (const operation of [() => service.original(item.id, stranger), () => service.thumbnail(item.id, stranger), () => service.update(item.id, 'stolen', '', stranger), () => service.remove(item.id, stranger)]) await assert.rejects(operation, /资料不存在/);
    const key = `bio-v3/users/${createHash('sha256').update(user).digest('hex')}/materials/${item.id}/original`;
    const anonymous = await fetch(`https://${process.env.MATERIAL_OSS_BUCKET}.${process.env.MATERIAL_OSS_REGION}.aliyuncs.com/${key}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(anonymous.status, 403, 'Original must not be publicly readable');
    await anonymous.body?.cancel();
  }
  assert.equal((await service.list(alice)).length, 1); assert.equal((await service.list(bob)).length, 1);
  console.log('PASS: real OSS originals/thumbs, account isolation and anonymous 403 for both synthetic users');
} finally {
  const results = await Promise.allSettled(created.map(({ user, item }) => service.remove(item.id, user)));
  await rm(root, { recursive: true, force: true });
  assert.ok(results.every(result => result.status === 'fulfilled'), 'Test object cleanup failed');
  console.log('Synthetic OSS files cleaned up');
}

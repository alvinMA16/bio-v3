import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { MaterialsService, MAX_FILE_SIZE } from '../dist/materials/materials.service.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bio-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new MaterialsService(new ConfigService({ AGENT_DATA_DIR: root }));
}
test('materials preserve originals, edits and chat content across restart, and delete cleanly', async t => {
  const service = await setup(t);
  assert.deepEqual(await service.list(), []);
  const source = Buffer.from('外婆在院子里种了一棵桂花树。');
  const item = await service.upload('回忆.TXT', source);
  assert.equal(item.status, 'ready');
  assert.equal(item.text, source.toString());
  assert.deepEqual((await service.original(item.id)).buffer, source);
  const restored = new MaterialsService(new ConfigService({ AGENT_DATA_DIR: join(service.root, '..') }));
  assert.equal((await restored.list())[0].id, item.id);
  await restored.update(item.id, '桂花树', '小时候的院子');
  const attachment = await restored.attachment(item.id);
  assert.equal(attachment.title, '桂花树');
  assert.match(attachment.text, /小时候的院子/);
  assert.match(attachment.text, /外婆/);
  assert.deepEqual((await restored.original(item.id)).buffer, source);
  await restored.remove(item.id);
  assert.deepEqual(await restored.list(), []);
  await assert.rejects(restored.get(item.id), /资料不存在/);
});
test('rejects unsupported, mismatched, oversized, empty and invalid text files', async t => {
  const service = await setup(t);
  for (const [name, buffer] of [['bad.exe', Buffer.from('hi')], ['bad.png', Buffer.from('hello')], ['bad.pdf', Buffer.from('hello')], ['bad.docx', Buffer.from('hello')], ['empty.txt', Buffer.alloc(0)], ['bad.txt', Buffer.from([0xff])], ['big.txt', Buffer.alloc(MAX_FILE_SIZE + 1)]]) {
    await assert.rejects(service.upload(name, buffer));
  }
  await assert.rejects(service.get('../../private'));
  assert.deepEqual(await service.list(), []);
});
test('valid image is stored without claiming recognition when no vision provider is configured', async t => {
  const service = await setup(t);
  for (const format of ['png', 'jpeg', 'webp']) {
    const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#997755' } }).toFormat(format).toBuffer();
    const item = await service.upload(`photo.${format}`, source);
    assert.equal(item.kind, 'image');
    assert.equal(item.status, 'needs-description');
    assert.equal(item.text, '');
    assert.match(item.statusMessage, /尚未识别/);
    assert.deepEqual((await service.original(item.id)).buffer, source);
  }
});
test('long text clearly reports truncation while keeping the whole original', async t => {
  const service = await setup(t);
  const source = Buffer.from('树'.repeat(100001));
  const item = await service.upload('diary.md', source);
  assert.equal(item.text.length, 100000);
  assert.match(item.statusMessage, /10 万字/);
  assert.deepEqual((await service.original(item.id)).buffer, source);
  await assert.rejects(service.update(item.id, ' ', ''));
});
test('extracts genuine PDF and DOCX text', async t => {
  const service = await setup(t);
  const { readFile } = await import('node:fs/promises');
  for (const extension of ['pdf', 'docx']) {
    const buffer = await readFile(new URL(`./fixtures/letter.${extension}`, import.meta.url));
    const item = await service.upload(`letter.${extension}`, buffer);
    assert.equal(item.status, 'ready');
    assert.match(item.text, /Grandma planted a tree/);
  }
});
test('HTTP upload, validation, original download and deletion work through Fastify', async t => {
  const service = await setup(t);
  const [{ Test }, { FastifyAdapter }, { ValidationPipe }, { MaterialsController }, { default: multipart }] = await Promise.all([
    import('@nestjs/testing'), import('@nestjs/platform-fastify'), import('@nestjs/common'),
    import('../dist/materials/materials.controller.js'), import('@fastify/multipart'),
  ]);
  const module = await Test.createTestingModule({ controllers: [MaterialsController], providers: [{ provide: MaterialsService, useValue: service }] }).compile();
  const app = module.createNestApplication(new FastifyAdapter(), { logger: false });
  await app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 0, parts: 1 } });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close());
  const form = new FormData(); form.append('file', new Blob(['The garden tree.']), 'memory.txt');
  const request = new Request('http://localhost', { method: 'POST', body: form });
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/materials', headers: { 'content-type': request.headers.get('content-type') }, payload: Buffer.from(await request.arrayBuffer()) });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const item = uploaded.json();
  const original = await app.inject({ method: 'GET', url: item.url });
  assert.equal(original.statusCode, 200);
  assert.equal(original.body, 'The garden tree.');
  assert.equal(original.headers['x-content-type-options'], 'nosniff');
  const invalid = await app.inject({ method: 'PUT', url: `/api/v1/materials/${item.id}`, payload: { title: '  ', description: '' } });
  assert.equal(invalid.statusCode, 400);
  const saved = await app.inject({ method: 'PUT', url: `/api/v1/materials/${item.id}`, payload: { title: 'Garden', description: 'childhood' } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().description, 'childhood');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/materials/${item.id}` });
  assert.equal(deleted.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: item.url })).statusCode, 404);
});
test('vision success provides attributed text and failures preserve the image', async t => {
  const base = await setup(t);
  const service = new MaterialsService(new ConfigService({ AGENT_DATA_DIR: join(base.root, '..'), MATERIAL_VISION_BASE_URL: 'https://vision.example/v1', MATERIAL_VISION_API_KEY: 'test', MATERIAL_VISION_MODEL: 'vision-test' }));
  const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://vision.example/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    return Response.json({ choices: [{ message: { content: 'A tree beside a house.' } }] });
  });
  const item = await service.upload('photo.png', buffer);
  assert.equal(item.status, 'ready');
  assert.match((await service.attachment(item.id)).text, /机器识别内容/);
  mock.mock.mockImplementation(async () => new Response('', { status: 503 }));
  const failed = await service.upload('another.png', buffer);
  assert.equal(failed.status, 'needs-description');
  assert.match(failed.statusMessage, /识别失败/);
  assert.deepEqual((await service.original(failed.id)).buffer, buffer);
});

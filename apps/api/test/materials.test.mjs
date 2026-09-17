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
  for (const [name, buffer] of [['bad.exe', Buffer.from('hi')], ['bad.png', Buffer.from('hello')], ['bad.pdf', Buffer.from('hello')], ['bad.doc', Buffer.from('hello')], ['bad.docx', Buffer.from('hello')], ['empty.txt', Buffer.alloc(0)], ['bad.txt', Buffer.from([0xff])], ['big.txt', Buffer.alloc(MAX_FILE_SIZE + 1)]]) {
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
    assert.ok(item.thumbnailUrl);
    assert.equal((await sharp(await service.thumbnail(item.id)).metadata()).format, 'webp');
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
test('extracts genuine PDF, DOC and DOCX text and renders PDF first-page thumbnails', async t => {
  const service = await setup(t);
  const { readFile } = await import('node:fs/promises');
  for (const extension of ['pdf', 'doc', 'docx']) {
    const buffer = await readFile(new URL(`./fixtures/letter.${extension}`, import.meta.url));
    const item = await service.upload(`letter.${extension}`, buffer);
    assert.equal(item.status, 'ready');
    assert.match(item.text, /Grandma planted a tree/);
    assert.deepEqual((await service.original(item.id)).buffer, buffer);
    if (extension === 'pdf') {
      assert.equal(item.pageCount, 1);
      assert.ok(item.thumbnailUrl);
      assert.equal((await sharp(await service.thumbnail(item.id)).metadata()).format, 'webp');
    }
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

test('PDF preview renders distinct pages, checks bounds and isolates accounts', async t => {
  const service = await setup(t);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['First page: the garden.', 'Second page: the family.'].map(text => {
      const stream = `BT /F1 18 Tf 30 300 Td (${text}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const item = await service.upload('two-pages.pdf', Buffer.from(pdf), 'alice');
  const first = await service.pdfPage(item.id, 1, 'alice');
  const second = await service.pdfPage(item.id, 2, 'alice');
  assert.equal(first.pageCount, 2); assert.equal(second.page, 2);
  assert.notEqual(first.image, second.image);
  assert.equal((await sharp(Buffer.from(second.image.split(',')[1], 'base64')).metadata()).width, 1000);
  for (const page of [0, -1, 1.5, 3, NaN]) await assert.rejects(service.pdfPage(item.id, page, 'alice'));
  await assert.rejects(service.pdfPage(item.id, 1, 'bob'), /资料不存在/);
  const text = await service.upload('note.txt', Buffer.from('hello'), 'alice');
  await assert.rejects(service.pdfPage(text.id, 1, 'alice'), /仅 PDF/);
});

test('office PDF conversion is reused by model input and page preview; unavailable converter is explicit', async t => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'bio-conversion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'converter'), count = join(root, 'count');
  const pdf = new URL('./fixtures/letter.pdf', import.meta.url).pathname;
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // Stub the external converter only; exercise real persistence and PDF rendering.
  await writeFile(executable, `#!/bin/sh\nprintf x >> ${quote(count)}\ncp ${quote(pdf)} "$6/document.pdf"\n`, { mode: 0o700 });
  const service = new MaterialsService(new ConfigService({ AGENT_DATA_DIR: root, LIBREOFFICE_BIN: executable }));
  const office = await service.upload('letter.docx', await readFile(new URL('./fixtures/letter.docx', import.meta.url)), 'owner');
  const converted = await service.modelFile(office.id, 'owner');
  assert.equal(converted.mimeType, 'application/pdf');
  assert.equal((await service.pdfPage(office.id, 1, 'owner')).pageCount, 1);
  assert.equal((await readFile(count, 'utf8')).length, 1);
  await assert.rejects(service.modelFile(office.id, 'other'), /资料不存在/);
  const broken = new MaterialsService(new ConfigService({ AGENT_DATA_DIR: root, LIBREOFFICE_BIN: join(root, 'missing') }));
  const doc = await broken.upload('letter.doc', await readFile(new URL('./fixtures/letter.doc', import.meta.url)), 'owner');
  await assert.rejects(broken.modelFile(doc.id, 'owner'), /无法转换/);
  const deck = await service.upload('slides.pptx', Buffer.from('mock office converter input'), 'owner');
  assert.equal(deck.pageCount, 1); assert.ok(deck.thumbnailUrl);
  await service.modelFile(deck.id, 'owner');
  assert.equal((await readFile(count, 'utf8')).length, 2);
});

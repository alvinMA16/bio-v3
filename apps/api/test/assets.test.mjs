import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AssetsController } from '../dist/assets/assets.controller.js';
import { UI_ASSETS } from '../dist/assets/asset-catalog.js';

test('asset gateway signs only published UI files and prevents caching expired redirects', async () => {
  const config = new ConfigService({ NODE_ENV: 'production', ASSET_CDN_DOMAIN: 'cdn.example.com', ASSET_CDN_PRIVATE_KEY: 'test-key' });
  const module = await Test.createTestingModule({ controllers: [AssetsController], providers: [{ provide: ConfigService, useValue: config }] }).compile();
  const app = module.createNestApplication(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  await app.init(); await app.getHttpAdapter().getInstance().ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/ui-assets/blink.webp' });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers['cache-control'], 'no-store');
    const url = new URL(response.headers.location);
    assert.equal(url.host, 'cdn.example.com');
    assert.equal(url.pathname, '/' + UI_ASSETS['blink.webp']);
    const [time, rand, uid, signature] = url.searchParams.get('auth_key').split('-');
    assert.ok(Number(time) >= Math.floor(Date.now() / 1000) + 1790);
    assert.equal(signature, createHash('md5').update(`${url.pathname}-${time}-${rand}-${uid}-test-key`).digest('hex'));
    for (const name of ['__proto__', 'constructor', 'private.jpg', 'avatars%2Fother.png', '..%2Fphone.png']) {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ui-assets/' + name })).statusCode, 404);
    }
    config.set('ASSET_CDN_PRIVATE_KEY', '');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ui-assets/blink.webp' })).statusCode, 503);
  } finally { await app.close(); }
});

test('published artwork catalog matches the checked-in images and content hashes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../infra/oss/assets-manifest.json', import.meta.url)));
  for (const file of manifest.files) {
    const data = readFileSync(new URL('../../miniprogram/miniprogram/assets/' + file.path, import.meta.url));
    assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256);
    if (file.contentType.startsWith('image/')) assert.equal(UI_ASSETS[file.path.split('/').at(-1)], manifest.prefix + file.path);
  }
  assert.equal(Object.keys(UI_ASSETS).length, manifest.files.filter(file => file.contentType.startsWith('image/')).length);
});

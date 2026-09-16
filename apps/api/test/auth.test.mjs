import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../dist/auth/auth.service.js';
import { SmsService } from '../dist/auth/sms.service.js';
import { MemoryService } from '../dist/memory/memory.service.js';
import { MaterialsService } from '../dist/materials/materials.service.js';

const secret = 'test-secret-only-'.repeat(3);
test('account mode fails closed without database, secret, or production SMS credentials', () => {
  const sms = new SmsService(new ConfigService({ SMS_PROVIDER: 'test', SMS_TEST_CODE: '123456', NODE_ENV: 'test' }));
  assert.throws(() => new AuthService(new ConfigService({ AUTH_ENABLED: 'true' }), sms), /DATABASE/);
  assert.throws(() => new AuthService(new ConfigService({ AUTH_ENABLED: 'true', MEMORY_DATABASE_URL: 'postgres://unused' }), sms), /SECRET/);
  assert.throws(() => new SmsService(new ConfigService({ SMS_PROVIDER: 'test', NODE_ENV: 'production' })).validate());
});

test('Aliyun ACS3 signing and template parameters match biography-v2 protocol', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url), headers = options.headers;
    assert.equal(parsed.origin, 'https://dysmsapi.aliyuncs.com');
    assert.equal(parsed.searchParams.get('PhoneNumbers'), '13800138000');
    const params = JSON.parse(parsed.searchParams.get('TemplateParam'));
    assert.equal(params.verification, '123456'); assert.equal(params.code, '123456'); assert.equal(params.minutes, '5');
    const keys = Object.keys(headers).filter(key => key === 'host' || key.startsWith('x-acs-')).sort();
    const sha = text => createHash('sha256').update(text).digest('hex');
    const canonical = ['POST', '/', parsed.search.slice(1), keys.map(key => `${key}:${headers[key]}\n`).join(''), keys.join(';'), sha('')].join('\n');
    const signature = createHmac('sha256', 'secret').update(`ACS3-HMAC-SHA256\n${sha(canonical)}`).digest('hex');
    assert.equal(headers.Authorization, `ACS3-HMAC-SHA256 Credential=key,SignedHeaders=${keys.join(';')},Signature=${signature}`);
    return new Response('{"Code":"OK"}', { status: 200 });
  };
  const sms = new SmsService(new ConfigService({ ALIYUN_ACCESS_KEY_ID: 'key', ALIYUN_ACCESS_KEY_SECRET: 'secret', ALIYUN_SMS_SIGN_NAME: '令狸', ALIYUN_SMS_TEMPLATE_CODE: 'SMS_TEST', ALIYUN_SMS_TEMPLATE_PARAM_KEY: 'verification' }));
  sms.validate(); await sms.send('13800138000', '123456');
  globalThis.fetch = async () => new Response('{"Code":"isv.BUSINESS_LIMIT_CONTROL"}', { status: 200 });
  await assert.rejects(sms.send('13800138000', '123456'), /短信暂时无法发送/);
});

test('materials isolate list, original, mutations and model attachment access by user', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bio-account-materials-')); t.after(() => rm(root, { recursive: true, force: true }));
  const materials = new MaterialsService(new ConfigService({ AGENT_DATA_DIR: root }));
  const item = await materials.upload('alice.txt', Buffer.from('Alice private story'), 'alice');
  assert.equal((await materials.list('alice')).length, 1); assert.deepEqual(await materials.list('bob'), []); assert.deepEqual(await materials.list(), []);
  for (const operation of [() => materials.get(item.id, 'bob'), () => materials.original(item.id, 'bob'), () => materials.update(item.id, 'stolen', '', 'bob'), () => materials.remove(item.id, 'bob'), () => materials.attachment(item.id, 'bob')]) await assert.rejects(operation, /资料不存在/);
  assert.equal((await materials.attachment(item.id, 'alice')).title, 'alice.txt');
});

test('PostgreSQL OTP lifecycle, races, durable sessions, HTTP guards and account isolation', { skip: !process.env.AUTH_TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const prefix = randomUUID(), phone = `139${String(Date.now()).slice(-8)}`, otherPhone = `138${String(Date.now()).slice(-8)}`;
  const root = await mkdtemp(join(tmpdir(), 'bio-account-test-'));
  const config = new ConfigService({ AUTH_ENABLED: 'true', AUTH_CODE_SECRET: secret, MEMORY_DATABASE_URL: process.env.AUTH_TEST_DATABASE_URL, SMS_PROVIDER: 'test', SMS_TEST_CODE: '123456', NODE_ENV: 'test', AGENT_DATA_DIR: root });
  const auth = new AuthService(config, new SmsService(config)); await auth.onModuleInit();
  const memory = new MemoryService(config, auth); await memory.onModuleInit();
  const materials = new MaterialsService(config);
  let app; const users = [];
  t.after(async () => {
    await app?.close();
    // Dedicated test database only. Keep cleanup scoped to this test's phone numbers.
    await auth.pool.query('DELETE FROM bio_auth_sessions WHERE user_id IN (SELECT id FROM bio_auth_users WHERE phone=ANY($1))', [[phone, otherPhone]]);
    await auth.pool.query('DELETE FROM bio_auth_users WHERE phone=ANY($1)', [[phone, otherPhone]]);
    await auth.pool.query('DELETE FROM bio_auth_codes WHERE phone=ANY($1)', [[phone, otherPhone]]);
    const hashes = [phone, otherPhone].map(p => createHash('sha256').update(p).digest('hex'));
    await auth.pool.query('DELETE FROM bio_auth_sends WHERE phone_key=ANY($1)', [hashes]);
    await memory.pool.query('DELETE FROM bio_memory_runs WHERE user_id=ANY($1)', [users]);
    await memory.pool.query('DELETE FROM bio_memory_sessions WHERE user_id=ANY($1)', [users]);
    await memory.pool.query('DELETE FROM bio_memory_users WHERE id=ANY($1)', [users]);
    await auth.pool.end(); await memory.pool.end(); await rm(root, { recursive: true, force: true });
  });
  const sends = await Promise.allSettled([auth.sendCode(phone, prefix), auth.sendCode(phone, prefix)]);
  assert.equal(sends.filter(value => value.status === 'fulfilled').length, 1);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login(phone, '000000'), /验证码/);
  await assert.rejects(auth.login(phone, '123456'), /验证码/);
  await auth.pool.query('UPDATE bio_auth_codes SET attempts=0,expires_at=now()-interval \'1 second\' WHERE phone=$1', [phone]);
  await assert.rejects(auth.login(phone, '123456'), /验证码/);
  await auth.pool.query('UPDATE bio_auth_codes SET expires_at=now()+interval \'5 minutes\' WHERE phone=$1', [phone]);
  const attempts = await Promise.allSettled([auth.login(phone, '123456'), auth.login(phone, '123456')]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  const alice = attempts.find(value => value.status === 'fulfilled').value; users.push(alice.user.id);
  assert.notEqual(alice.user.id, phone); assert.equal(alice.user.phone, `${phone.slice(0,3)}****${phone.slice(-4)}`);
  assert.equal(await memory.resolveIdentity(`Bearer ${alice.token}`), alice.user.id);
  await assert.rejects(memory.resolveIdentity('Bearer owner-token-that-used-to-work'));
  const restarted = new AuthService(config, new SmsService(config));
  assert.equal(await restarted.identity(undefined, `bio-voice,bio-auth.${alice.token}`), alice.user.id); await restarted.onModuleDestroy();
  await auth.sendCode(otherPhone, prefix); const bob = await auth.login(otherPhone, '123456'); users.push(bob.user.id);
  const item = await materials.upload('private.txt', Buffer.from('Private'), alice.user.id);
  const conversation = randomUUID(), run = randomUUID(); await memory.ensureUser(alice.user.id);
  await memory.pool.query('INSERT INTO bio_memory_sessions(id,user_id,snapshot) VALUES($1,$2,$3)', [conversation, alice.user.id, { 'panel.json': JSON.stringify({ documents: [{ id: 'doc', title: 'Private manuscript', version: 1 }] }) }]);
  await memory.pool.query('INSERT INTO bio_memory_runs(id,user_id) VALUES($1,$2)', [run, alice.user.id]);
  assert.equal((await memory.manuscripts(bob.user.id, conversation)).length, 0); await assert.rejects(memory.assertRun(bob.user.id, run));
  const [{ Test }, { FastifyAdapter }, { ValidationPipe }, { AuthController }, { MaterialsController }, { AgentController }, { AgentService }, { AgentStorage }] = await Promise.all([
    import('@nestjs/testing'), import('@nestjs/platform-fastify'), import('@nestjs/common'), import('../dist/auth/auth.controller.js'), import('../dist/materials/materials.controller.js'), import('../dist/agent/agent.controller.js'), import('../dist/agent/agent.service.js'), import('../dist/agent/agent-storage.js'),
  ]);
  auth.onModuleDestroy = async () => {}; memory.onModuleDestroy = async () => {};
  const module = await Test.createTestingModule({ controllers: [AuthController, MaterialsController, AgentController], providers: [
    { provide: AuthService, useValue: auth }, { provide: ConfigService, useValue: config }, { provide: MaterialsService, useValue: materials }, { provide: MemoryService, useValue: memory }, { provide: AgentService, useValue: {} }, { provide: AgentStorage, useValue: new AgentStorage(config) },
  ] }).compile();
  // Avoid lifecycle duplication/closing shared test services via the Nest test app.
  app = module.createNestApplication(new FastifyAdapter()); app.setGlobalPrefix('api/v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  const http = app.getHttpAdapter().getInstance();
  for (const url of ['/api/v1/materials', `/api/v1/materials/${item.id}/file`, '/api/v1/agent/manuscripts', `/api/v1/agent/runs/${run}/trace`]) assert.equal((await http.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal((await http.inject({ method: 'POST', url: '/api/v1/auth/code', payload: { phone: 'invalid' } })).statusCode, 400);
  assert.equal((await http.inject({ method: 'GET', url: `/api/v1/materials/${item.id}/file`, headers: { authorization: `Bearer ${bob.token}` } })).statusCode, 404);
  assert.equal((await http.inject({ method: 'GET', url: `/api/v1/materials/${item.id}/file`, headers: { cookie: `bio-file-session=${alice.token}` } })).statusCode, 200);
  assert.equal((await http.inject({ method: 'GET', url: '/api/v1/materials', headers: { cookie: `bio-file-session=${alice.token}` } })).statusCode, 401);
  assert.equal((await http.inject({ method: 'GET', url: `/api/v1/agent/manuscripts/${conversation}/doc`, headers: { authorization: `Bearer ${bob.token}` } })).statusCode, 404);
  assert.equal((await http.inject({ method: 'GET', url: `/api/v1/agent/manuscripts/${conversation}/doc`, headers: { authorization: `Bearer ${alice.token}` } })).statusCode, 200);
  const logout = await http.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${alice.token}` }, payload: {} });
  assert.equal(logout.statusCode, 201); assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  await assert.rejects(auth.identity(`Bearer ${alice.token}`)); assert.equal(await auth.identity(`Bearer ${bob.token}`), bob.user.id);
  await auth.pool.query("UPDATE bio_auth_sends SET created_at=now()-interval '70 seconds' WHERE phone_key=$1", [createHash('sha256').update(phone).digest('hex')]);
  await auth.sendCode(phone, prefix);
  const relogin = await http.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone, code: '123456' } });
  assert.equal(relogin.statusCode, 201); assert.equal(relogin.json().user.id, alice.user.id);
  assert.match(relogin.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.equal(relogin.headers['cache-control'], 'no-store');
  await auth.pool.query("UPDATE bio_auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [bob.user.id]);
  assert.equal((await http.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${bob.token}` } })).statusCode, 401);
});

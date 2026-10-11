import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AdminService,page } from '../dist/admin/admin.service.js';
import { AdminGuard } from '../dist/admin/admin.guard.js';
import { AdminController } from '../dist/admin/admin.controller.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { SmsService } from '../dist/auth/sms.service.js';
import { MemoryService } from '../dist/memory/memory.service.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { DocumentStore } from '../dist/agent/document-store.js';
import { MaterialsService } from '../dist/materials/materials.service.js';

test('admin access requires account authentication and an explicit server-side role',async()=>{
  const config=new ConfigService({ADMIN_OPERATOR_USER_IDS:'owner',ADMIN_VIEWER_USER_IDS:'reader'});
  const auth={enabled:false,identity:async token=>token};
  const admin=new AdminService(config,auth,{}, {}, {});
  await assert.rejects(admin.authorize('owner'),error=>error.getStatus()===503);
  // Avoid constructing an unused pool in this unit test; account resolution is tested below with a real database.
  auth.enabled=true;
  assert.deepEqual(await admin.authorize('owner',true),{id:'owner',role:'operator'});
  assert.deepEqual(await admin.authorize('reader'),{id:'reader',role:'viewer'});
  await assert.rejects(admin.authorize('reader',true),error=>error.getStatus()===403);
  await assert.rejects(admin.authorize('ordinary'),error=>error.getStatus()===403);
  config.set('ADMIN_OPERATOR_USER_IDS','');
  await assert.rejects(admin.authorize('owner'),error=>error.getStatus()===403);
  for(const value of ['-1','1.5','Infinity','1 OR 1=1','999999999']) assert.throws(()=>page(value));
  assert.equal(page(),0);assert.equal(page('25'),25);
});

test('real HTTP admin roles, scoped reads, pagination, audit rollback and concurrent retry', {skip:!process.env.AUTH_TEST_DATABASE_URL,timeout:60000},async t=>{
  const { Test }=await import('@nestjs/testing');
  const { FastifyAdapter }=await import('@nestjs/platform-fastify');
  const root=await mkdtemp(join(tmpdir(),'bio-admin-test-'));
  const prefix=`admin-${randomUUID()}`,operator=`${prefix}-operator`,viewer=`${prefix}-viewer`,ordinary=`${prefix}-ordinary`;
  const users=[operator,viewer,ordinary];
  const config=new ConfigService({AUTH_ENABLED:'true',AUTH_CODE_SECRET:'test-secret-'.repeat(4),MEMORY_DATABASE_URL:process.env.AUTH_TEST_DATABASE_URL,
    SMS_PROVIDER:'test',SMS_TEST_CODE:'123456',NODE_ENV:'test',AGENT_DATA_DIR:root,ADMIN_OPERATOR_USER_IDS:operator,ADMIN_VIEWER_USER_IDS:viewer});
  const auth=new AuthService(config,new SmsService(config));await auth.onModuleInit();
  const memory=new MemoryService(config,auth);await memory.onModuleInit();
  const storage=new AgentStorage(config),documents=new DocumentStore(storage,memory),materials=new MaterialsService(config);
  const admin=new AdminService(config,auth,storage,documents,materials);await admin.onModuleInit();
  let app;
  t.after(async()=>{
    await auth.pool.query('DELETE FROM bio_auth_sessions WHERE user_id=ANY($1)',[users]);
    for(const table of ['bio_run_metrics','bio_memory_runs','bio_memory_sources','bio_memory_revisions','bio_memories','bio_document_revisions','bio_documents','bio_voice_playback','bio_voice_failures','bio_memory_jobs','bio_memory_messages','bio_memory_calls','bio_memory_sessions','bio_memory_overview_revisions']) {
      if(table==='bio_memory_sources'||table==='bio_memory_revisions') await memory.pool.query(`DELETE FROM ${table} WHERE memory_id IN (SELECT id FROM bio_memories WHERE user_id=ANY($1))`,[users]);
      else await memory.pool.query(`DELETE FROM ${table} WHERE user_id=ANY($1)`,[users]);
    }
    await admin.pool.query('DELETE FROM bio_admin_audit WHERE actor_id=ANY($1)',[users]);
    await memory.pool.query('DELETE FROM bio_memory_users WHERE id=ANY($1)',[users]);
    await auth.pool.query('DELETE FROM bio_auth_users WHERE id=ANY($1)',[users]);
    if(app) await app.close(); else await admin.onModuleDestroy();
    await memory.onModuleDestroy();await auth.onModuleDestroy();await rm(root,{recursive:true,force:true});
  });
  const tokens={};
  for(let index=0;index<3;index++) {
    const id=users[index],token=randomUUID().replaceAll('-','');tokens[id]=token;
    await auth.pool.query('INSERT INTO bio_auth_users(id,phone) VALUES($1,$2)',[id,`139${String(Date.now()+index).slice(-8)}`]);
    await memory.pool.query('INSERT INTO bio_memory_users(id) VALUES($1)',[id]);
    await auth.pool.query("INSERT INTO bio_auth_sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),id]);
  }
  const conversation=randomUUID(),run=randomUUID(),call=`call-${randomUUID()}`,doc=randomUUID(),mem=randomUUID(),message=randomUUID();
  await memory.pool.query('INSERT INTO bio_memory_sessions(id,user_id) VALUES($1,$2)',[conversation,ordinary]);
  await memory.pool.query("INSERT INTO bio_memory_calls(id,user_id,conversation_id,status,overview) VALUES($1,$2,$3,'ended','{}')",[call,ordinary,conversation]);
  await memory.pool.query("INSERT INTO bio_memory_jobs(call_id,user_id,status,error) VALUES($1,$2,'failed','test failure')",[call,ordinary]);
  await memory.pool.query('INSERT INTO bio_memory_runs(id,user_id) VALUES($1,$2)',[run,ordinary]);
  await memory.pool.query("INSERT INTO bio_memory_messages(id,user_id,call_id,conversation_id,run_id,role,body,origin) VALUES($1,$2,$3,$4,$5,'user','synthetic private message','typed')",[message,ordinary,call,conversation,run]);
  await memory.recordRun({id:run,userId:ordinary,conversationId:conversation,callId:call,status:'done',model:'unpriced-model',usage:{totalTokens:12},durationMs:70});
  await memory.recordRun({id:run,userId:ordinary,conversationId:conversation,status:'failed',usage:{totalTokens:100},durationMs:100});
  await memory.recordVoiceFailure(ordinary,call,{turnId:'synthetic-turn',stage:'tts',code:'playback_timeout'});
  await memory.recordVoiceFailure(viewer,call,{turnId:'wrong-owner',stage:'tts',code:'must-not-record'});
  assert.equal((await memory.pool.query('SELECT count(*) FROM bio_voice_failures WHERE call_id=$1',[call])).rows[0].count,'1');
  assert.equal((await memory.pool.query('SELECT status,estimated_cost FROM bio_run_metrics WHERE id=$1',[run])).rows[0].status,'done');
  assert.equal((await memory.pool.query('SELECT estimated_cost FROM bio_run_metrics WHERE id=$1',[run])).rows[0].estimated_cost,null);
  await memory.pool.query("INSERT INTO bio_voice_playback(call_id,turn_id,user_id,data) VALUES($1,'voice-turn',$2,$3)",[call,ordinary,JSON.stringify({runId:run,generated:true,playedSamples:24})]);
  storage.appendTrace({runId:run,conversationId:conversation,sequence:1,timestamp:new Date().toISOString(),source:'input',type:'request',data:{authorization:'Bearer private-token',promptTokens:12,apiKey:'private-key'}});
  await documents.edit(ordinary,conversation,{documentId:doc,expectedVersion:0,title:'Synthetic document',operations:[{action:'insert',block:{id:'p1',kind:'paragraph',text:'Original body'}}]});
  for(let index=0;index<26;index++) {
    const id=randomUUID();
    await memory.pool.query('INSERT INTO bio_documents(user_id,id,origin_conversation_id,version,body) VALUES($1,$2,$3,1,$4)',
      [ordinary,id,conversation,JSON.stringify({schemaVersion:1,id,title:`Paged document ${index}`,version:1,blocks:[]})]);
  }
  const material=await materials.upload('test.txt',Buffer.from('Synthetic attachment'),ordinary);
  await memory.pool.query("INSERT INTO bio_memories(id,user_id,type,title,summary,body,version) VALUES($1,$2,'story','Synthetic memory','Summary','Body',1)",[mem,ordinary]);
  await memory.pool.query("INSERT INTO bio_memory_revisions(memory_id,version,data) VALUES($1,1,'{\"title\":\"Synthetic memory\",\"body\":\"Body\"}')",[mem]);
  await memory.pool.query('INSERT INTO bio_memory_sources(memory_id,version,message_id) VALUES($1,1,$2)',[mem,message]);
  const module=await Test.createTestingModule({controllers:[AdminController],providers:[AdminGuard,{provide:AdminService,useValue:admin}]}).compile();
  app=module.createNestApplication(new FastifyAdapter());app.setGlobalPrefix('api/v1');await app.init();
  const http=app.getHttpAdapter().getInstance();await http.ready();
  const inject=(path,id=operator,method='GET')=>http.inject({url:`/api/v1/admin/${path}`,method,headers:id ? {authorization:`Bearer ${tokens[id]}`} : {}});
  const routes=['me','overview','users',`users/${ordinary}`,'sessions',`sessions/${conversation}`,`runs/${run}/trace`,'jobs',`users/${ordinary}/documents`,`users/${ordinary}/documents/${doc}`,`users/${ordinary}/documents/${doc}/revisions/1`,`users/${ordinary}/materials`,`users/${ordinary}/materials/${material.id}`,`users/${ordinary}/materials/${material.id}/file`,`users/${ordinary}/memories`,`users/${ordinary}/memories/${mem}`,'logs','errors','services'];
  for(const route of routes) {
    assert.equal((await inject(route,null)).statusCode,401,route);
    assert.equal((await inject(route,ordinary)).statusCode,403,route);
    const response=await inject(route,viewer);assert.equal(response.statusCode,200,`${route}: ${response.body}`);
    assert.equal(response.headers['cache-control'],'no-store');
  }
  assert.equal((await inject(`users/${viewer}/documents/${doc}`)).statusCode,404);
  assert.equal((await inject(`users/${viewer}/materials/${material.id}`)).statusCode,404);
  assert.equal((await inject(`users/${viewer}/memories/${mem}`)).statusCode,404);
  assert.equal((await inject('users?q=%25')).json().items.length,0,'LIKE wildcard must be literal');
  assert.equal((await inject('users?offset=-1')).statusCode,400);
  const list=(await inject(`users?q=${prefix}`)).json();assert.equal(list.items.length,3);assert.match(list.items[0].phone,/\*{4}/);
  const session=(await inject(`sessions/${conversation}`)).json();assert.equal(session.messages.items[0].body,'synthetic private message');assert.equal(session.runs[0].playback.playedSamples,24);
  const firstDocs=(await inject(`users/${ordinary}/documents`)).json(),secondDocs=(await inject(`users/${ordinary}/documents?offset=25`)).json();
  assert.equal(firstDocs.items.length,25);assert.equal(firstDocs.total,27);assert.equal(secondDocs.items.length,2);
  assert.equal(new Set([...firstDocs.items,...secondDocs.items].map(row=>row.id)).size,27);
  assert.equal((await inject('errors')).json().items.some(row=>row.code==='playback_timeout'),true);
  const trace=(await inject(`runs/${run}/trace`)).json();assert.equal(trace.items[0].data.apiKey,'[已隐藏]');assert.equal(trace.items[0].data.promptTokens,12);
  const logBefore=(await admin.pool.query('SELECT count(*) FROM bio_admin_audit WHERE actor_id=$1 AND action=$2',[viewer,'retry_memory_job'])).rows[0].count;
  assert.equal((await inject(`jobs/${call}/retry`,viewer,'POST')).statusCode,403);
  assert.equal((await inject(`jobs/${call}/retry`,null,'POST')).statusCode,401);
  const results=await Promise.all([inject(`jobs/${call}/retry`,operator,'POST'),inject(`jobs/${call}/retry`,operator,'POST')]);
  assert.deepEqual(results.map(x=>x.statusCode).sort(),[201,409]);
  assert.equal((await admin.pool.query("SELECT count(*) FROM bio_admin_audit WHERE target_id=$1 AND action='retry_memory_job'",[call])).rows[0].count,'1');
  assert.equal((await admin.pool.query('SELECT count(*) FROM bio_admin_audit WHERE actor_id=$1 AND action=$2',[viewer,'retry_memory_job'])).rows[0].count,logBefore);
  // An audit write failure must roll back the retry, not leave an unrecorded mutation.
  await memory.pool.query("UPDATE bio_memory_jobs SET status='failed' WHERE call_id=$1",[call]);
  const originalAudit=admin.audit.bind(admin);admin.audit=async()=>{throw new Error('audit unavailable');};
  await assert.rejects(admin.retry({id:operator,role:'operator'},call),/audit unavailable/);admin.audit=originalAudit;
  assert.equal((await memory.pool.query('SELECT status FROM bio_memory_jobs WHERE call_id=$1',[call])).rows[0].status,'failed');
  // Exercise the real module graph, not just a controller with injected fixtures.
  config.set('MEMORY_WORKER_ENABLED','false');
  const { AppModule }=await import('../dist/app.module.js');
  const wiredModule=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(ConfigService).useValue(config).compile();
  const wiredApp=wiredModule.createNestApplication(new FastifyAdapter());wiredApp.setGlobalPrefix('api/v1');
  try {
    await wiredApp.init();const wiredHttp=wiredApp.getHttpAdapter().getInstance();await wiredHttp.ready();
    const result=await wiredHttp.inject({url:'/api/v1/admin/me',headers:{authorization:`Bearer ${tokens[operator]}`}});
    assert.equal(result.statusCode,200);assert.equal(result.json().role,'operator');
  } finally { await wiredApp.close(); }
  await auth.logout(`Bearer ${tokens[operator]}`);assert.equal((await inject('me')).statusCode,401);
});

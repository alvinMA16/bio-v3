import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../auth/auth.service.js';
import { AgentStorage } from '../agent/agent-storage.js';
import { DocumentStore } from '../agent/document-store.js';
import { MaterialsService } from '../materials/materials.service.js';

export type AdminActor = { id: string; role: 'operator' | 'viewer' };
export function page(value?: string) {
  if (value === undefined) return 0;
  if (!/^\d{1,8}$/.test(value)) throw new BadRequestException('无效的分页位置');
  return Number(value);
}
export const PAGE_SIZE = 25;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const masked = (phone: string) => `${phone.slice(0,3)}****${phone.slice(-4)}`;
const ADMIN_SCHEMA = `CREATE TABLE IF NOT EXISTS bio_admin_audit (
 id uuid PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, user_id text,
 target_id text, created_at timestamptz NOT NULL DEFAULT now()
); CREATE INDEX IF NOT EXISTS bio_admin_audit_time ON bio_admin_audit(created_at DESC);`;

@Injectable()
export class AdminService implements OnModuleInit, OnModuleDestroy {
  readonly pool?: Pool;
  constructor(private readonly config: ConfigService, private readonly auth: AuthService,
    private readonly storage: AgentStorage, private readonly documents: DocumentStore, private readonly materials: MaterialsService) {
    if (auth.enabled) this.pool = new Pool({ connectionString: config.get<string>('MEMORY_DATABASE_URL'), max: 2,
      connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  }
  async onModuleInit() { await this.pool?.query(ADMIN_SCHEMA); }
  async onModuleDestroy() { await this.pool?.end(); }
  db() { if (!this.pool) throw new ServiceUnavailableException('管理后台需要启用手机号账号和数据库'); return this.pool; }
  async authorize(authorization?: string, write = false): Promise<AdminActor> {
    if (!this.auth.enabled) throw new ServiceUnavailableException('管理后台需要启用手机号账号');
    const id = await this.auth.identity(authorization);
    const ids = (key: string) => this.config.get<string>(key, '').split(',').map(x => x.trim()).filter(Boolean);
    const role = ids('ADMIN_OPERATOR_USER_IDS').includes(id) ? 'operator' : ids('ADMIN_VIEWER_USER_IDS').includes(id) ? 'viewer' : undefined;
    if (!role || (write && role !== 'operator')) throw new ForbiddenException(write ? '当前账号没有操作权限' : '当前账号没有管理权限');
    return { id, role };
  }
  async audit(actor: AdminActor, action: string, user?: string, target?: string, client?: PoolClient) {
    await (client ?? this.db()).query('INSERT INTO bio_admin_audit(id,actor_id,action,user_id,target_id) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),actor.id,action,user ?? null,target ?? null]);
  }
  async user(id: string) {
    const row = (await this.db().query('SELECT id,phone,created_at FROM bio_auth_users WHERE id=$1', [id])).rows[0];
    if (!row) throw new NotFoundException('用户不存在');
    return { ...row, phone: masked(row.phone) };
  }
  async overview() {
    const result = await this.db().query(`SELECT
      (SELECT count(*) FROM bio_auth_users) AS users,
      (SELECT count(DISTINCT user_id) FROM bio_memory_messages WHERE role='user' AND btrim(body)<>'' AND created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS active_today,
      (SELECT count(*) FROM bio_memory_calls WHERE started_at>=now()-interval '7 days') AS calls_week,
      (SELECT count(*) FROM bio_documents WHERE created_at>=now()-interval '7 days') AS documents_week,
      (SELECT count(*) FROM bio_memory_jobs WHERE status='failed') AS failed_jobs,
      (SELECT count(*) FROM bio_memory_jobs WHERE status IN ('pending','running')) AS waiting_jobs,
      (SELECT min(created_at) FROM bio_memory_jobs WHERE status IN ('pending','running')) AS oldest_job,
      (SELECT count(*) FROM bio_run_metrics WHERE status='failed' AND created_at>=now()-interval '7 days') AS failed_runs_week,
      (SELECT count(*) FROM bio_run_metrics) AS recorded_runs,
      (SELECT count(*) FROM bio_run_metrics WHERE estimated_cost IS NOT NULL AND created_at>=now()-interval '7 days') AS priced_runs_week,
      (SELECT count(*) FROM bio_run_metrics WHERE estimated_cost IS NULL AND created_at>=now()-interval '7 days') AS unpriced_runs_week,
      (SELECT count(*) FROM bio_memory_runs) AS owned_runs,
      (SELECT sum((estimated_cost->>'total')::numeric) FROM bio_run_metrics WHERE created_at>=now()-interval '7 days') AS estimated_llm_cost_week`);
    return { ...result.rows[0], costCoverage: '新采集的 Agent 模型调用估算；不含 ASR、TTS、图片识别、搜索、记忆整理和历史未采集调用' };
  }
  async users(query = '', offset = 0) {
    if (query.length > 100) throw new BadRequestException('搜索词过长');
    const values = [`%${escapeLike(query.trim())}%`,offset];
    const result = await this.db().query(`SELECT u.id,u.phone,u.created_at,
      (SELECT max(created_at) FROM bio_memory_messages WHERE user_id=u.id AND role='user') AS last_activity,
      (SELECT count(*) FROM bio_memory_calls WHERE user_id=u.id) AS calls,
      (SELECT count(*) FROM bio_documents WHERE user_id=u.id) AS documents,
      (SELECT count(*) FROM bio_memory_jobs WHERE user_id=u.id AND status='failed') AS failed_jobs,
      count(*) OVER() AS total FROM bio_auth_users u WHERE u.phone ILIKE $1 OR u.id ILIKE $1
      ORDER BY u.created_at DESC,u.id LIMIT ${PAGE_SIZE} OFFSET $2`,values);
    return this.paged(result.rows.map(row=>({ ...row, phone:masked(row.phone) })),offset);
  }
  paged(rows: any[], offset: number) { return { items: rows, total: Number(rows[0]?.total ?? 0), offset, limit: PAGE_SIZE }; }
  async userDetail(id: string) {
    const user = await this.user(id);
    const row = (await this.db().query(`SELECT
      (SELECT count(*) FROM bio_memory_calls WHERE user_id=$1) AS calls,
      (SELECT count(*) FROM bio_documents WHERE user_id=$1) AS documents,
      (SELECT count(*) FROM bio_memories WHERE user_id=$1 AND active) AS memories,
      (SELECT count(*) FROM bio_memory_jobs WHERE user_id=$1 AND status='failed') AS failed_jobs,
      (SELECT max(created_at) FROM bio_memory_messages WHERE user_id=$1 AND role='user') AS last_activity`,[id])).rows[0];
    return { ...user, ...row };
  }
  async sessions(user?: string, offset=0) {
    const rows = (await this.db().query(`SELECT s.id,s.user_id,c.id AS call_id,c.status,c.started_at,c.ended_at,c.call_summary,
      j.status AS job_status,coalesce(c.started_at,m.started_at) AS activity_at,m.messages,count(*) OVER() AS total
      FROM bio_memory_sessions s LEFT JOIN bio_memory_calls c ON c.conversation_id=s.id
      LEFT JOIN bio_memory_jobs j ON j.call_id=c.id
      LEFT JOIN LATERAL (SELECT min(created_at) AS started_at,count(*) AS messages FROM bio_memory_messages WHERE conversation_id=s.id AND user_id=s.user_id) m ON true
      WHERE ($1::text IS NULL OR s.user_id=$1) ORDER BY coalesce(c.started_at,m.started_at) DESC NULLS LAST,s.id
      LIMIT ${PAGE_SIZE} OFFSET $2`,[user ?? null,offset])).rows;
    return this.paged(rows,offset);
  }
  async session(actor: AdminActor, id: string, offset=0) {
    this.storage.assertId(id);
    const session = (await this.db().query(`SELECT s.id,s.user_id,c.id AS call_id,c.status,c.started_at,c.ended_at,c.call_summary,
      j.status AS job_status FROM bio_memory_sessions s LEFT JOIN bio_memory_calls c ON c.conversation_id=s.id
      LEFT JOIN bio_memory_jobs j ON j.call_id=c.id WHERE s.id=$1`,[id])).rows[0];
    if (!session) throw new NotFoundException('会话不存在');
    await this.audit(actor,'read_session',session.user_id,id);
    const messages = (await this.db().query(`SELECT id,run_id,role,body,origin,created_at,count(*) OVER() AS total
      FROM bio_memory_messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY ordinal LIMIT ${PAGE_SIZE} OFFSET $3`,[id,session.user_id,offset])).rows;
    const runs = (await this.db().query(`SELECT r.*,p.data AS playback FROM bio_run_metrics r
      LEFT JOIN bio_voice_playback p ON p.call_id=r.call_id AND p.data->>'runId'=r.id::text AND p.user_id=r.user_id
      WHERE r.conversation_id=$1 AND r.user_id=$2 ORDER BY r.created_at DESC LIMIT 100`,[id,session.user_id])).rows;
    return { ...session, messages:this.paged(messages,offset),runs };
  }
  async trace(actor: AdminActor, id: string, offset=0) {
    this.storage.assertId(id);
    const row = (await this.db().query('SELECT user_id FROM bio_memory_runs WHERE id=$1',[id])).rows[0];
    if (!row) throw new NotFoundException('运行不存在');
    await this.audit(actor,'read_trace',row.user_id,id);
    // Slice the returned data, never expose private tokens/keys echoed into old traces.
    const entries = await this.storage.tracePage(id,offset);
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9_.-]+/gi,'Bearer [已隐藏]');
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key, /^(token|access.?token|refresh.?token|secret|password|authorization|api.?key)$/i.test(key) ? '[已隐藏]' : redact(item)]));
      return value;
    };
    return { ...entries,items:entries.items.map(redact) };
  }
  async jobs(user?: string, status?: string, offset=0) {
    if (status && !['pending','running','done','failed'].includes(status)) throw new BadRequestException('无效的任务状态');
    const rows=(await this.db().query(`SELECT j.call_id,j.user_id,j.status,j.attempts,j.error,j.created_at,j.finished_at,j.available_at,c.conversation_id,
      EXISTS(SELECT 1 FROM bio_memory_jobs p WHERE p.user_id=j.user_id AND p.status<>'done' AND (p.created_at,p.call_id)<(j.created_at,j.call_id)) AS blocked,
      count(*) OVER() AS total FROM bio_memory_jobs j JOIN bio_memory_calls c ON c.id=j.call_id
      WHERE ($1::text IS NULL OR j.user_id=$1) AND ($2::text IS NULL OR j.status=$2)
      ORDER BY j.created_at DESC,j.call_id LIMIT ${PAGE_SIZE} OFFSET $3`,[user ?? null,status || null,offset])).rows;
    return this.paged(rows,offset);
  }
  async retry(actor: AdminActor, id: string) {
    if(actor.role!=='operator') throw new ForbiddenException('当前账号没有操作权限');
    const c=await this.db().connect();
    try {
      await c.query('BEGIN');
      const result=await c.query(`UPDATE bio_memory_jobs SET status='pending',attempts=0,available_at=now(),error=NULL
        WHERE call_id=$1 AND status='failed' RETURNING user_id`,[id]);
      if(!result.rowCount) throw new ConflictException('任务不存在或已不处于失败状态，请刷新');
      await this.audit(actor,'retry_memory_job',result.rows[0].user_id,id,c);
      await c.query('COMMIT'); return { queued:true };
    } catch(error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async documentList(user: string, offset=0) {
    await this.user(user);
    return this.paged((await this.db().query(`SELECT id,body->>'title' AS title,version,origin_conversation_id,updated_at,count(*) OVER() AS total
      FROM bio_documents WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT ${PAGE_SIZE} OFFSET $2`,[user,offset])).rows,offset);
  }
  async document(actor: AdminActor,user: string,id: string,offset=0) {
    const document=await this.documents.get(user,id);
    await this.audit(actor,'read_document',user,id);
    const revisions=(await this.db().query(`SELECT version,summary,conversation_id,created_at,count(*) OVER() AS total
      FROM bio_document_revisions WHERE user_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT ${PAGE_SIZE} OFFSET $3`,[user,id,offset])).rows;
    return { document,revisions:this.paged(revisions,offset) };
  }
  async revision(actor:AdminActor,user:string,id:string,version:string) {
    if(!/^[1-9]\d{0,8}$/.test(version)) throw new BadRequestException('无效的版本');
    const row=(await this.db().query('SELECT body FROM bio_document_revisions WHERE user_id=$1 AND document_id=$2 AND version=$3',[user,id,Number(version)])).rows[0];
    if(!row) throw new NotFoundException('文稿版本不存在');
    await this.audit(actor,'read_document_revision',user,`${id}:${version}`); return row.body;
  }
  async materialList(user:string,offset=0) {
    await this.user(user);
    const items=await this.materials.list(user);
    return { items:items.slice(offset,offset+PAGE_SIZE).map(({ text,description,url,thumbnailUrl,...item })=>item),total:items.length,offset,limit:PAGE_SIZE };
  }
  async material(actor:AdminActor,user:string,id:string) {
    await this.user(user); const item=await this.materials.get(id,user);
    await this.audit(actor,'read_material',user,id); const {url,thumbnailUrl,...result}=item; return result;
  }
  async original(actor:AdminActor,user:string,id:string) {
    await this.user(user); const result=await this.materials.original(id,user);
    await this.audit(actor,'download_material',user,id); return result;
  }
  async memories(actor:AdminActor,user:string,offset=0) {
    await this.user(user);
    await this.audit(actor,'read_memory_overview',user);
    const overview=(await this.db().query('SELECT overview,version FROM bio_memory_users WHERE id=$1',[user])).rows[0] ?? null;
    const rows=(await this.db().query(`SELECT id,type,title,summary,version,updated_at,count(*) OVER() AS total FROM bio_memories
      WHERE user_id=$1 AND active ORDER BY updated_at DESC,id LIMIT ${PAGE_SIZE} OFFSET $2`,[user,offset])).rows;
    return { overview, ...this.paged(rows,offset) };
  }
  async memory(actor:AdminActor,user:string,id:string,version?:string) {
    this.storage.assertId(id);
    if(version && !/^[1-9]\d{0,8}$/.test(version)) throw new BadRequestException('无效的版本');
    const current=(await this.db().query('SELECT * FROM bio_memories WHERE user_id=$1 AND id=$2',[user,id])).rows[0];
    if(!current) throw new NotFoundException('记忆不存在');
    const chosen=version ? Number(version) : current.version;
    const old=version ? (await this.db().query('SELECT data FROM bio_memory_revisions WHERE memory_id=$1 AND version=$2',[id,chosen])).rows[0] : undefined;
    if(version && !old) throw new NotFoundException('记忆版本不存在');
    await this.audit(actor,'read_memory',user,`${id}:${chosen}`);
    const sources=(await this.db().query(`SELECT m.id,m.call_id,m.conversation_id,m.role,m.body,m.created_at FROM bio_memory_sources s
      JOIN bio_memory_messages m ON m.id=s.message_id WHERE s.memory_id=$1 AND s.version=$2 AND m.user_id=$3 ORDER BY m.ordinal`,[id,chosen,user])).rows;
    const versions=(await this.db().query('SELECT version,created_at FROM bio_memory_revisions WHERE memory_id=$1 ORDER BY version DESC LIMIT 100',[id])).rows;
    return { memory:old?.data ?? current,version:chosen,sources,versions };
  }
  async logs(offset=0) { return this.paged((await this.db().query(`SELECT *,count(*) OVER() AS total FROM bio_admin_audit ORDER BY created_at DESC,id LIMIT ${PAGE_SIZE} OFFSET $1`,[offset])).rows,offset); }
  async errors(offset=0) {
    return this.paged((await this.db().query(`SELECT e.*,count(*) OVER() AS total FROM (
      SELECT id,user_id,conversation_id,'agent' AS stage,status AS code,created_at FROM bio_run_metrics WHERE status='failed'
      UNION ALL SELECT f.id,f.user_id,c.conversation_id,f.stage,f.code,f.created_at FROM bio_voice_failures f JOIN bio_memory_calls c ON c.id=f.call_id
    ) e ORDER BY created_at DESC,id LIMIT ${PAGE_SIZE} OFFSET $1`,[offset])).rows,offset);
  }
  async services() {
    await this.db().query('SELECT 1');
    return { database:'ready',deployment:this.config.get('BIO_COMMIT','本地开发'),
      model:this.config.get('MODEL_PROVIDER','deepseek'), materialStorage:this.materials.objectStore ? 'oss' : 'local',
      traceStorage:'local', externalServices:'未主动探测；请结合近期运行结果判断',
      usageCoverage:'仅新采集 Agent 模型调用；历史记录和其他收费服务不在汇总内' };
  }
}

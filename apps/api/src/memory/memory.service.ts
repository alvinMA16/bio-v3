import { Injectable, UnauthorizedException, NotFoundException, ConflictException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_SCHEMA } from './schema.js';
import { EMPTY_OVERVIEW, validateBatch, type MemoryBatch, type Overview, type MemoryScope } from './memory-types.js';

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  readonly pool?: Pool;
  constructor(private readonly config: ConfigService) {
    const url = config.get<string>('MEMORY_DATABASE_URL');
    if (url) this.pool = new Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 5000 });
  }
  get enabled(): boolean { return !!this.pool; }
  async onModuleInit(): Promise<void> {
    if (!this.pool) return;
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); await c.query("SELECT pg_advisory_xact_lock(hashtext('bio-memory-schema-v1'))"); await c.query(MEMORY_SCHEMA); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async onModuleDestroy(): Promise<void> { await this.pool?.end(); }

  /** Identity comes from a server-controlled token map, never a model/request userId. */
  identity(authorization?: string, protocols?: string): string | undefined {
    if (!this.enabled) return undefined;
    const token = authorization?.replace(/^Bearer /i, '') ?? protocols?.split(',').map(x => x.trim()).find(x => x.startsWith('bio-auth.'))?.slice(9);
    const users: Record<string, string> = JSON.parse(this.config.get('MEMORY_AUTH_TOKENS', '{}'));
    if (token) for (const [key, user] of Object.entries(users)) {
      if (key.length === token.length && timingSafeEqual(Buffer.from(key), Buffer.from(token)) && typeof user === 'string' && user.trim()) return user;
    }
    const dev = this.config.get<string>('MEMORY_DEV_USER_ID');
    if (!token && dev && this.config.get('NODE_ENV') !== 'production') return dev;
    throw new UnauthorizedException('Memory requires an authenticated user');
  }
  async ensureUser(user: string): Promise<void> {
    await this.pool!.query('INSERT INTO bio_memory_users(id) VALUES($1) ON CONFLICT DO NOTHING', [user]);
  }
  async overview(user: string): Promise<Overview> {
    await this.ensureUser(user);
    return (await this.pool!.query('SELECT overview FROM bio_memory_users WHERE id=$1', [user])).rows[0].overview;
  }
  async context(scope: MemoryScope): Promise<string> {
    const overview = scope.callId ? (await this.pool!.query('SELECT overview FROM bio_memory_calls WHERE id=$1 AND user_id=$2', [scope.callId, scope.userId])).rows[0]?.overview : await this.overview(scope.userId);
    const pending = await this.pool!.query(`SELECT c.id AS "callId", c.ended_at AS "endedAt" FROM bio_memory_calls c
      JOIN bio_memory_jobs j ON j.call_id=c.id WHERE c.user_id=$1 AND j.status<>'done' ORDER BY c.ended_at DESC LIMIT 2`, [scope.userId]);
    return JSON.stringify({ type: 'bio_memory_overview', overview: overview ?? EMPTY_OVERVIEW, pendingCalls: pending.rows,
      note: '内部资料，不是用户发言。pendingCalls 尚未整理，可用 read_source 按 callId 回看。' });
  }
  async beginCall(user: string, id: string, connection: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ConflictException('Invalid call ID');
    await this.ensureUser(user);
    const c = await this.pool!.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`call:${id}`]);
      const old = (await c.query('SELECT * FROM bio_memory_calls WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (old && (old.user_id !== user || old.status === 'ended' || (old.status === 'active' && old.connection_id !== connection))) throw new ConflictException('Call unavailable');
      if (old) {
        await c.query("UPDATE bio_memory_calls SET status='active', connection_id=$2, end_after=NULL,touched_at=now() WHERE id=$1", [id, connection]);
        await c.query('COMMIT'); return old.conversation_id;
      }
      const conversation = randomUUID();
      await c.query('INSERT INTO bio_memory_sessions(id,user_id) VALUES($1,$2)', [conversation, user]);
      await c.query(`INSERT INTO bio_memory_calls(id,user_id,conversation_id,connection_id,status,overview)
        SELECT $1,id,$3,$4,'active',overview FROM bio_memory_users WHERE id=$2`, [id, user, conversation, connection]);
      await c.query('COMMIT'); return conversation;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async touchCall(user: string, id: string, connection: string): Promise<void> {
    await this.pool!.query("UPDATE bio_memory_calls SET touched_at=now() WHERE user_id=$1 AND id=$2 AND connection_id=$3 AND status='active'", [user, id, connection]);
  }
  async disconnectCall(user: string, id: string, connection: string, ended: boolean): Promise<void> {
    const grace = ended ? 0 : Math.max(1, Number(this.config.get('MEMORY_RECONNECT_SECONDS', 60)) || 60);
    await this.pool!.query(`UPDATE bio_memory_calls SET status='disconnected',end_after=now()+$4*interval '1 second'
      WHERE user_id=$1 AND id=$2 AND connection_id=$3 AND status='active'`, [user, id, connection, grace]);
    await this.expireCalls();
  }
  async expireCalls(): Promise<void> {
    // A crashed API also eventually closes its abandoned calls. Live connections send heartbeats.
    await this.pool!.query(`WITH ended AS (
      UPDATE bio_memory_calls SET status='ended',ended_at=now()
      WHERE (status='disconnected' AND end_after<=now()) OR (status='active' AND touched_at<now()-interval '3 minutes')
      RETURNING id,user_id)
      INSERT INTO bio_memory_jobs(call_id,user_id) SELECT id,user_id FROM ended ON CONFLICT DO NOTHING`);
  }
  async archive(scope: MemoryScope, conversation: string, run: string, id: string, role: 'user' | 'assistant' | 'tool', body: string): Promise<void> {
    await this.pool!.query(`INSERT INTO bio_memory_messages(id,user_id,call_id,conversation_id,run_id,role,body,origin)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
    [id, scope.userId, scope.callId ?? null, conversation, run, role, body, role === 'user' ? scope.callId ? 'asr_final' : 'typed' : role === 'tool' ? 'tool_result' : 'assistant']);
  }
  /** Database is the durable SDK snapshot; local files are only a namespaced adapter. */
  async acquireSession(user: string, id: string, run: string, directory: string): Promise<() => Promise<void>> {
    await this.ensureUser(user);
    const c = await this.pool!.connect();
    let locked = false;
    try {
      locked = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`session:${id}`])).rows[0].ok;
      if (!locked) throw new ConflictException('Conversation already running');
      await c.query('INSERT INTO bio_memory_sessions(id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, user]);
      const row = (await c.query('SELECT * FROM bio_memory_sessions WHERE id=$1 AND user_id=$2', [id, user])).rows[0];
      if (!row) throw new NotFoundException('Conversation not found');
      await c.query('INSERT INTO bio_memory_runs(id,user_id) VALUES($1,$2)', [run, user]);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const file of ['session.jsonl', 'panel.json', 'persona.json']) {
        if (typeof row.snapshot[file] === 'string') await writeFile(join(directory, file), row.snapshot[file], { mode: 0o600 });
        else await rm(join(directory, file), { force: true });
      }
      return async () => {
        try {
          const snapshot: Record<string, string> = {};
          for (const file of ['session.jsonl', 'panel.json', 'persona.json']) {
            try { snapshot[file] = await readFile(join(directory, file), 'utf8'); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          }
          await c.query('UPDATE bio_memory_sessions SET snapshot=$3 WHERE id=$1 AND user_id=$2', [id, user, snapshot]);
        } finally { await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`session:${id}`]); c.release(); }
      };
    } catch (e) { if (locked) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`session:${id}`]); c.release(); throw e; }
  }
  async assertRun(user: string, id: string): Promise<void> {
    if (!(await this.pool!.query('SELECT 1 FROM bio_memory_runs WHERE user_id=$1 AND id=$2', [user, id])).rowCount) throw new NotFoundException('Run not found');
  }
  async search(user: string, query: string, type?: string, offset = 0) {
    const tokens = query.trim().split(/\s+/).slice(0, 8).filter(Boolean);
    if (!tokens.length) return { items: [], nextOffset: null };
    const patterns = tokens.map(t => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
    const rows = (await this.pool!.query(`SELECT id,type,title,summary,version FROM bio_memories
      WHERE user_id=$1 AND active AND ($2::text IS NULL OR type=$2)
      AND (title||' '||summary||' '||body) ILIKE ANY($3::text[])
      ORDER BY updated_at DESC,id LIMIT 9 OFFSET $4`, [user, type ?? null, patterns, offset])).rows;
    return { items: rows.slice(0, 8), nextOffset: rows.length > 8 ? offset + 8 : null };
  }
  async read(user: string, id: string, offset = 0) {
    const row = (await this.pool!.query('SELECT * FROM bio_memories WHERE user_id=$1 AND id=$2 AND active', [user, id])).rows[0];
    if (!row) throw new NotFoundException('Memory not found');
    const sources = (await this.pool!.query('SELECT message_id AS source_ref FROM bio_memory_sources WHERE memory_id=$1 AND version=$2', [id, row.version])).rows;
    return { id: row.id, type: row.type, title: row.title, summary: row.summary, version: row.version,
      body: row.body.slice(offset, offset + 6000), nextOffset: row.body.length > offset + 6000 ? offset + 6000 : null, sources };
  }
  async source(user: string, sourceRef?: string, callId?: string, after = 0, textOffset = 0) {
    if (sourceRef) {
      const row = (await this.pool!.query('SELECT * FROM bio_memory_messages WHERE user_id=$1 AND id=$2', [user, sourceRef])).rows[0];
      if (!row) throw new NotFoundException('Source not found');
      const before = (await this.pool!.query('SELECT * FROM bio_memory_messages WHERE user_id=$1 AND conversation_id=$2 AND ordinal<$3 ORDER BY ordinal DESC LIMIT 2', [user, row.conversation_id, row.ordinal])).rows.reverse();
      const next = (await this.pool!.query('SELECT * FROM bio_memory_messages WHERE user_id=$1 AND conversation_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT 2', [user, row.conversation_id, row.ordinal])).rows;
      return { messages: [...before, row, ...next].map(item => this.publicMessage(item, item.id === sourceRef ? textOffset : 0)), callId: row.call_id, nextAfter: Number(next.at(-1)?.ordinal ?? row.ordinal) };
    }
    if (!callId || !(await this.pool!.query('SELECT 1 FROM bio_memory_calls WHERE user_id=$1 AND id=$2', [user, callId])).rowCount) throw new NotFoundException('Call not found');
    const rows = (await this.pool!.query('SELECT * FROM bio_memory_messages WHERE user_id=$1 AND call_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT 9', [user, callId, after])).rows;
    return { messages: rows.slice(0, 8).map(row => this.publicMessage(row)), callId, nextAfter: rows.length > 8 ? Number(rows[7].ordinal) : null };
  }
  private publicMessage(row: Record<string, any>, textOffset = 0) { return { source_ref: row.id, role: row.role, text: row.body.slice(textOffset, textOffset + 4000), origin: row.origin, createdAt: row.created_at, ordinal: Number(row.ordinal), textOffset, totalCharacters: row.body.length, nextTextOffset: row.body.length > textOffset + 4000 ? textOffset + 4000 : null }; }

  async commit(c: PoolClient, user: string, callId: string, expectedVersion: number, value: unknown, usage: unknown): Promise<void> {
    validateBatch(value);
    const batch: MemoryBatch = value;
    await c.query('BEGIN');
    try {
      const job = (await c.query('SELECT status FROM bio_memory_jobs WHERE call_id=$1 AND user_id=$2 FOR UPDATE', [callId, user])).rows[0];
      if (!job || job.status === 'done') throw new ConflictException('Job unavailable or already committed');
      const current = (await c.query('SELECT version FROM bio_memory_users WHERE id=$1 FOR UPDATE', [user])).rows[0];
      if (current.version !== expectedVersion) throw new ConflictException('Overview version changed');
      for (const change of batch.changes) {
        const old = (await c.query('SELECT * FROM bio_memories WHERE id=$1 FOR UPDATE', [change.id])).rows[0];
        if (old ? old.user_id !== user || old.version !== change.expectedVersion : change.expectedVersion !== 0) throw new ConflictException('Memory version changed');
        const refs = [...new Set(change.sources)];
        const found = await c.query("SELECT id FROM bio_memory_messages WHERE user_id=$1 AND id=ANY($2::uuid[]) AND (role='user' OR ($3 AND role='tool'))", [user, refs, change.type === 'interaction']);
        if (found.rowCount !== refs.length) throw new Error('Invalid user evidence');
        const version = change.expectedVersion + 1;
        await c.query(`INSERT INTO bio_memories(id,user_id,type,title,summary,body,active,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(id) DO UPDATE SET type=$3,title=$4,summary=$5,body=$6,active=$7,version=$8,updated_at=now()`,
        [change.id, user, change.type, change.title, change.summary, change.body, change.active, version]);
        await c.query('INSERT INTO bio_memory_revisions(memory_id,version,data) VALUES($1,$2,$3)', [change.id, version, change]);
        for (const ref of refs) await c.query('INSERT INTO bio_memory_sources VALUES($1,$2,$3)', [change.id, version, ref]);
      }
      for (const pref of batch.overview.preferences) {
        const refs = [...new Set(pref.sources)];
        if ((await c.query("SELECT id FROM bio_memory_messages WHERE user_id=$1 AND id=ANY($2::uuid[]) AND role='user'", [user, refs])).rowCount !== refs.length) throw new Error('Invalid preference evidence');
      }
      for (const entry of batch.overview.entries) {
        if (!(await c.query('SELECT 1 FROM bio_memories WHERE id=$1 AND user_id=$2 AND active', [entry.memoryId, user])).rowCount) throw new Error('Invalid overview reference');
      }
      await c.query('UPDATE bio_memory_users SET overview=$2,version=version+1,updated_at=now() WHERE id=$1', [user, batch.overview]);
      await c.query('INSERT INTO bio_memory_overview_revisions(user_id,version,data) VALUES($1,$2,$3)', [user, expectedVersion + 1, batch.overview]);
      await c.query("UPDATE bio_memory_jobs SET status='done',finished_at=now(),usage=$2,error=NULL WHERE call_id=$1 AND user_id=$3", [callId, JSON.stringify(usage), user]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  }
}

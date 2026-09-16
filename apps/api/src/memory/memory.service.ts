import { Injectable, UnauthorizedException, NotFoundException, ConflictException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_SCHEMA } from './schema.js';
import { beijingTime, isCalendarDate, validateCallSummary, type CallSummary } from './call-history.js';
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
    if (!scope.callId) return JSON.stringify({ type: 'bio_memory_overview', overview: await this.overview(scope.userId) });
    const row = (await this.pool!.query('SELECT initial_context,overview,started_at FROM bio_memory_calls WHERE id=$1 AND user_id=$2', [scope.callId, scope.userId])).rows[0];
    if (!row) throw new NotFoundException('Call not found');
    if (row.initial_context) return JSON.stringify(row.initial_context);
    // Calls already active at migration time acquire a snapshot once, atomically.
    const context = await this.initialContext(this.pool!, scope.userId, row.overview, row.started_at);
    const saved = await this.pool!.query(`UPDATE bio_memory_calls SET initial_context=COALESCE(initial_context,$3::jsonb)
      WHERE id=$1 AND user_id=$2 RETURNING initial_context`, [scope.callId, scope.userId, JSON.stringify(context)]);
    return JSON.stringify(saved.rows[0].initial_context);
  }
  private async initialContext(db: Pool | PoolClient, user: string, overview: Overview, startedAt: Date) {
    const configured = Number(this.config.get('MEMORY_RECENT_CALL_COUNT', 3));
    const count = Number.isInteger(configured) && configured >= 0 && configured <= 20 ? configured : 3;
    // One query gives summaries and pending entries a consistent view during worker commits.
    const rows = (await db.query(`SELECT c.id,c.started_at,c.ended_at,c.call_summary,j.status AS job_status
      FROM bio_memory_calls c LEFT JOIN bio_memory_jobs j ON j.call_id=c.id
      WHERE c.user_id=$1 AND c.status='ended' AND c.started_at<=$2
        AND EXISTS (SELECT 1 FROM bio_memory_messages m WHERE m.call_id=c.id AND m.user_id=$1 AND m.role='user' AND btrim(m.body)<>'')
        AND (c.id IN (SELECT id FROM bio_memory_calls WHERE user_id=$1 AND status='ended' AND call_summary IS NOT NULL
          AND started_at<=$2 ORDER BY started_at DESC,id DESC LIMIT $3)
          OR c.id IN (SELECT p.id FROM bio_memory_calls p JOIN bio_memory_jobs pj ON pj.call_id=p.id
            WHERE p.user_id=$1 AND p.status='ended' AND p.started_at<=$2 AND p.call_summary IS NULL AND pj.status<>'done'
              AND EXISTS (SELECT 1 FROM bio_memory_messages m WHERE m.call_id=p.id AND m.user_id=$1 AND m.role='user' AND btrim(m.body)<>'')
            ORDER BY p.started_at DESC,p.id DESC LIMIT 2))
      ORDER BY c.started_at DESC,c.id DESC`, [user, startedAt, count])).rows;
    return { type: 'bio_memory_overview', overview: overview ?? EMPTY_OVERVIEW,
      callStartedAt: beijingTime(startedAt),
      call_history: rows.filter(row => row.call_summary).slice(0, count).reverse().map(row => this.publicCall(row)),
      pendingCalls: rows.filter(row => !row.call_summary && row.job_status !== 'done').slice(0, 2).map(row => ({
        callId: row.id, started_at: beijingTime(row.started_at), ended_at: beijingTime(row.ended_at),
      })),
    };
  }

  private publicCall(row: Record<string, any>) {
    return { callId: row.id, started_at: beijingTime(row.started_at), ended_at: beijingTime(row.ended_at),
      summary: row.call_summary?.summary ?? null, follow_ups: row.call_summary?.follow_ups ?? [] };
  }

  async searchCallHistory(user: string, query?: string, date?: string, offset = 0) {
    if (date !== undefined && !isCalendarDate(date)) throw new Error('Invalid calendar date');
    const patterns = query?.trim().split(/\s+/).filter(Boolean).slice(0, 8).map(t => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
    const rows = (await this.pool!.query(`SELECT c.id,c.started_at,c.ended_at,c.call_summary FROM bio_memory_calls c
      WHERE c.user_id=$1 AND c.status='ended'
        AND EXISTS (SELECT 1 FROM bio_memory_messages m WHERE m.user_id=$1 AND m.call_id=c.id AND m.role='user' AND btrim(m.body)<>'')
        AND ($2::date IS NULL OR (c.started_at AT TIME ZONE 'Asia/Shanghai')::date=$2::date)
        AND ($3::text[] IS NULL OR c.call_summary::text ILIKE ANY($3::text[])
          OR EXISTS (SELECT 1 FROM bio_memory_messages m WHERE m.user_id=$1 AND m.call_id=c.id AND m.role='user' AND m.body ILIKE ANY($3::text[])))
      ORDER BY c.started_at DESC,c.id DESC LIMIT 9 OFFSET $4`, [user, date ?? null, patterns?.length ? patterns : null, offset])).rows;
    return { items: rows.slice(0, 8).map(row => this.publicCall(row)), nextOffset: rows.length > 8 ? offset + 8 : null };
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
      const call = (await c.query('SELECT overview,started_at FROM bio_memory_calls WHERE id=$1', [id])).rows[0];
      const context = await this.initialContext(c, user, call.overview, call.started_at);
      await c.query('UPDATE bio_memory_calls SET initial_context=$2 WHERE id=$1', [id, JSON.stringify(context)]);
      await c.query('COMMIT'); return conversation;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async touchCall(user: string, id: string, connection: string): Promise<void> {
    await this.pool!.query("UPDATE bio_memory_calls SET touched_at=now() WHERE user_id=$1 AND id=$2 AND connection_id=$3 AND status='active'", [user, id, connection]);
  }
  /** Claim once before generation. Interrupted greetings are not replayed on reconnect. */
  async claimCallOpening(user: string, id: string, connection: string): Promise<boolean> {
    const result = await this.pool!.query(`UPDATE bio_memory_calls c SET opening_claimed=true
      WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND status='active' AND NOT opening_claimed
        AND NOT EXISTS (SELECT 1 FROM bio_memory_messages m WHERE m.call_id=c.id AND m.user_id=$2)
      RETURNING id`, [id, user, connection]);
    return !!result.rowCount;
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
  async manuscripts(user: string, conversationId?: string) {
    const rows = (await this.pool!.query(`SELECT id,snapshot->>'panel.json' AS panel FROM bio_memory_sessions
      WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2::uuid) AND snapshot ? 'panel.json'`, [user, conversationId ?? null])).rows;
    return rows.flatMap(row => {
      const value = JSON.parse(row.panel);
      return (value.documents ?? []).map((document: import('@bio/contracts').PanelDocument) => ({ conversationId: row.id as string, document }));
    });
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

  async commit(c: PoolClient, user: string, callId: string, expectedVersion: number, value: unknown, usage: unknown, callSummary: CallSummary): Promise<void> {
    if (value !== undefined) validateBatch(value);
    validateCallSummary(callSummary);
    const batch = value as MemoryBatch | undefined;
    await c.query('BEGIN');
    try {
      const job = (await c.query('SELECT status FROM bio_memory_jobs WHERE call_id=$1 AND user_id=$2 FOR UPDATE', [callId, user])).rows[0];
      if (!job || job.status === 'done') throw new ConflictException('Job unavailable or already committed');
      const current = (await c.query('SELECT version FROM bio_memory_users WHERE id=$1 FOR UPDATE', [user])).rows[0];
      if (current.version !== expectedVersion) throw new ConflictException('Overview version changed');
      const saved = await c.query(`UPDATE bio_memory_calls c SET call_summary=$3 WHERE id=$1 AND user_id=$2 AND status='ended'
        AND EXISTS (SELECT 1 FROM bio_memory_messages m WHERE m.call_id=c.id AND m.user_id=$2 AND m.role='user' AND btrim(m.body)<>'')`,
      [callId, user, JSON.stringify(callSummary)]);
      if (!saved.rowCount) throw new ConflictException('No completed conversation to summarize');
      if (batch) {
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
      }
      await c.query("UPDATE bio_memory_jobs SET status='done',finished_at=now(),usage=$2,error=NULL WHERE call_id=$1 AND user_id=$3", [callId, JSON.stringify(usage), user]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  }
}

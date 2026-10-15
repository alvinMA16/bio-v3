import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface CaptureSnapshot { id: string; sequence: number; block: number; text: string; frames: Array<{ sequence: number; pcm: Uint8Array }> }
export interface CaptureStore {
  load(): Promise<CaptureSnapshot>;
  append(id: string, sequence: number, pcm: Uint8Array): Promise<boolean>;
  checkpoint(id: string, text: string): Promise<void>;
  seal(id: string, block: number, sequence: number, text: string): Promise<void>;
  text(id: string): Promise<string>;
}

/** Every mutation is fenced by the current authenticated call connection. */
export class PostgresCaptureStore implements CaptureStore {
  constructor(private pool: Pool, private user: string, private call: string, private connection: string, private requested?: string) {}
  private async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const owner = await db.query("SELECT id FROM bio_memory_calls WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND status='active' FOR UPDATE", [this.call, this.user, this.connection]);
      if (!owner.rowCount) throw new Error('Capture connection replaced');
      const result = await fn(db); await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async load(): Promise<CaptureSnapshot> {
    return this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`capture:${this.user}`]);
      const row = (await db.query(`SELECT d.* FROM bio_voice_captures d JOIN bio_memory_calls c ON c.id=d.call_id
        WHERE d.user_id=$1 AND d.status='pending' AND (d.call_id=$2 OR c.status<>'active')
          AND (($3::uuid IS NULL AND d.call_id=$2) OR d.id=$3)
        ORDER BY d.updated_at DESC LIMIT 1 FOR UPDATE OF d`, [this.user, this.call, this.requested ?? null])).rows[0];
      if (!row && this.requested) {
        const busy = await db.query("SELECT id FROM bio_voice_captures WHERE id=$1 AND user_id=$2 AND status='pending'", [this.requested, this.user]);
        if (busy.rowCount) throw new Error('Capture is active on another connection');
      }
      const id = row?.id ?? randomUUID();
      if (row) await db.query('UPDATE bio_voice_captures SET call_id=$2,connection_id=$3 WHERE id=$1', [id, this.call, this.connection]);
      else await db.query('INSERT INTO bio_voice_captures(id,user_id,call_id,connection_id) VALUES($1,$2,$3,$4)', [id, this.user, this.call, this.connection]);
      const frames = (await db.query('SELECT sequence,pcm FROM bio_voice_capture_audio WHERE capture_id=$1 ORDER BY sequence', [id])).rows;
      return { id, sequence: row?.sequence ?? 0, block: row?.block ?? 0, text: row?.draft ?? '', frames: frames.map(f => ({ sequence: f.sequence, pcm: f.pcm })) };
    });
  }
  async append(id: string, sequence: number, pcm: Uint8Array): Promise<boolean> {
    return this.transaction(async db => {
      const row = (await db.query("SELECT sequence FROM bio_voice_captures WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND status='pending' FOR UPDATE", [id, this.user, this.connection])).rows[0];
      if (!row) throw new Error('Capture unavailable');
      if (sequence <= row.sequence) return false;
      if (sequence !== row.sequence + 1) throw new Error('Capture sequence gap');
      await db.query('INSERT INTO bio_voice_capture_audio(capture_id,sequence,pcm) VALUES($1,$2,$3)', [id, sequence, Buffer.from(pcm)]);
      await db.query('UPDATE bio_voice_captures SET sequence=$2,updated_at=now() WHERE id=$1', [id, sequence]);
      return true;
    });
  }
  async checkpoint(id: string, text: string): Promise<void> {
    await this.transaction(async db => {
      await db.query("UPDATE bio_voice_captures SET draft=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND status='pending'", [id, this.user, this.connection, text]);
    });
  }
  async seal(id: string, block: number, sequence: number, text: string): Promise<void> {
    await this.transaction(async db => {
      const result = await db.query("UPDATE bio_voice_captures SET block=$4+1,draft='',updated_at=now() WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND block=$4 AND status='pending' RETURNING id", [id, this.user, this.connection, block]);
      if (!result.rowCount) throw new Error('Capture block conflict');
      await db.query('INSERT INTO bio_voice_capture_blocks(capture_id,block,text) VALUES($1,$2,$3)', [id, block, text]);
      await db.query('DELETE FROM bio_voice_capture_audio WHERE capture_id=$1 AND sequence<=$2', [id, sequence]);
    });
  }
  async text(id: string): Promise<string> {
    const rows = (await this.pool.query('SELECT b.text FROM bio_voice_capture_blocks b JOIN bio_voice_captures d ON d.id=b.capture_id WHERE d.id=$1 AND d.user_id=$2 ORDER BY b.block', [id, this.user])).rows;
    return rows.map(row => row.text).filter(Boolean).join('\n');
  }
}

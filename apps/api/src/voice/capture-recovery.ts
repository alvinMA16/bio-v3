import type { Pool } from 'pg';
import type { AsrProvider, AsrStream } from './providers.js';

/** Prepare disconnected captures without generating replies or submitting user messages. */
export class CaptureRecovery {
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private retryAfter = new Map<string, number>();
  constructor(private pool: Pool, private provider: AsrProvider,
    private report: (event: { captureId?: string; code: string }) => void = () => {}) {}

  start(): void { this.wake(); }
  wake(): void {
    if (this.stopped || this.running) return;
    clearTimeout(this.timer);
    this.running = this.runOnce().then(() => undefined).catch(() => this.report({ code: 'capture_recovery_scan_failed' }))
      .finally(() => {
        this.running = undefined;
        if (!this.stopped) { this.timer = setTimeout(() => this.wake(), 1000); this.timer.unref(); }
      });
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); await this.running;
  }

  async runOnce(): Promise<boolean> {
    const db = await this.pool.connect();
    let locked: string | undefined, stream: AsrStream | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      for (const [id, until] of this.retryAfter) if (until <= Date.now()) this.retryAfter.delete(id);
      const candidates = await db.query(`SELECT d.id FROM bio_voice_captures d JOIN bio_memory_calls c ON c.id=d.call_id
        WHERE d.status='pending' AND (c.status<>'active' OR c.touched_at<now()-interval '5 minutes')
          AND NOT (d.id=ANY($1::uuid[]))
          AND EXISTS (SELECT 1 FROM bio_voice_capture_audio a WHERE a.capture_id=d.id)
        ORDER BY d.updated_at LIMIT 16`, [[...this.retryAfter.keys()]]);
      for (const candidate of candidates.rows) {
        if (this.stopped) return false;
        const key = `capture-recovery:${candidate.id}`;
        if (!(await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])).rows[0].locked) continue;
        locked = key;
        // Recheck after acquiring the same lock used by authenticated live takeover.
        const row = (await db.query(`SELECT d.* FROM bio_voice_captures d JOIN bio_memory_calls c ON c.id=d.call_id
          WHERE d.id=$1 AND d.status='pending' AND (c.status<>'active' OR c.touched_at<now()-interval '5 minutes')`, [candidate.id])).rows[0];
        if (!row) { await db.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); locked = undefined; continue; }
        const frames = (await db.query('SELECT sequence,pcm FROM bio_voice_capture_audio WHERE capture_id=$1 ORDER BY sequence', [row.id])).rows;
        if (!frames.length) return false;
        // Bound each background connection and lock to one 8-second block. Remaining audio
        // stays in the journal for the next pass or a live takeover.
        const batch: typeof frames = []; let bytes = 0;
        for (const frame of frames) { batch.push(frame); bytes += frame.pcm.length; if (bytes >= 8 * 32000) break; }
        const controller = new AbortController(); this.controller = controller;
        timeout = setTimeout(() => controller.abort(), 50_000);
        try {
          stream = await this.provider.open(result => { if (result.error) controller.abort(); }, controller.signal);
          for (const frame of batch) {
            controller.signal.throwIfAborted();
            if (!stream.replay) throw new Error('Background ASR requires paced replay');
            await stream.replay(frame.pcm);
          }
          const text = (await stream.finish()).trim();
          controller.signal.throwIfAborted();
          await db.query('BEGIN');
          try {
            // Commit text and retire only its audio atomically. Never overwrite a changed capture.
            const saved = await db.query(`UPDATE bio_voice_captures SET block=block+1,draft='',updated_at=now()
              WHERE id=$1 AND status='pending' AND block=$2 AND sequence=$3 AND connection_id=$4 RETURNING id`,
              [row.id, row.block, row.sequence, row.connection_id]);
            if (!saved.rowCount) throw new Error('Capture changed');
            await db.query('INSERT INTO bio_voice_capture_blocks(capture_id,block,text) VALUES($1,$2,$3)', [row.id, row.block, text]);
            await db.query('DELETE FROM bio_voice_capture_audio WHERE capture_id=$1 AND sequence<=$2', [row.id, batch.at(-1)!.sequence]);
            await db.query('COMMIT');
          } catch (error) { await db.query('ROLLBACK'); throw error; }
          this.report({ captureId: row.id, code: 'capture_recovery_ready' });
          return true;
        } catch {
          if (!this.stopped) {
            this.retryAfter.set(row.id, Date.now() + 60_000);
            this.report({ captureId: row.id, code: 'capture_recovery_retry' });
          }
          return false;
        }
      }
      return false;
    } finally {
      clearTimeout(timeout); stream?.close(); this.controller = undefined;
      try { if (locked) await db.query('SELECT pg_advisory_unlock(hashtext($1))', [locked]); }
      catch (error) { db.release(true); throw error; }
      db.release();
    }
  }
}

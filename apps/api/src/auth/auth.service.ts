import { Injectable, UnauthorizedException, ServiceUnavailableException, HttpException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { SmsService } from './sms.service.js';
import { AUTH_SCHEMA } from './schema.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const SESSION_SECONDS = 30 * 86400;
export function bearer(authorization?: string, protocols?: string): string | undefined {
  return authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/i)?.[1]
    ?? protocols?.split(',').map(value => value.trim()).find(value => value.startsWith('bio-auth.'))?.slice(9);
}
@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;
  readonly pool?: Pool;
  constructor(private readonly config: ConfigService, private readonly sms: SmsService) {
    this.enabled = config.get('AUTH_ENABLED') === 'true';
    if (this.enabled) {
      const url = config.get<string>('MEMORY_DATABASE_URL');
      if (!url) throw new Error('AUTH_ENABLED requires MEMORY_DATABASE_URL');
      if (config.get<string>('AUTH_CODE_SECRET', '').length < 32) throw new Error('AUTH_CODE_SECRET must contain at least 32 characters');
      sms.validate();
      this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 });
    }
  }
  async onModuleInit() {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bio-auth-schema-v1'))");
      await client.query(AUTH_SCHEMA);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private requireEnabled() { if (!this.pool) throw new ServiceUnavailableException('手机号登录尚未配置'); return this.pool; }
  private codeHash(phone: string, code: string) { return createHmac('sha256', this.config.get('AUTH_CODE_SECRET', '')).update(`${phone}:${code}`).digest('hex'); }
  async sendCode(phone: string, ip: string) {
    const pool = this.requireEnabled();
    const phoneKey = hash(phone), ipKey = hash(ip), id = randomUUID();
    const code = this.config.get('SMS_PROVIDER') === 'test' && this.config.get('NODE_ENV') !== 'production'
      ? this.config.get<string>('SMS_TEST_CODE', '') : randomInt(0, 1000000).toString().padStart(6, '0');
    const digest = this.codeHash(phone, code);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Sorted locks serialize per-phone and per-IP quotas across API processes.
      for (const key of [`phone:${phoneKey}`, `ip:${ipKey}`].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const counts = (await client.query(`SELECT
        count(*) FILTER (WHERE phone_key=$1 AND created_at>now()-interval '60 seconds') AS minute,
        count(*) FILTER (WHERE phone_key=$1 AND created_at>now()-interval '1 hour') AS hour,
        count(*) FILTER (WHERE phone_key=$1) AS day,
        count(*) FILTER (WHERE ip_key=$2 AND created_at>now()-interval '1 hour') AS ip
        FROM bio_auth_sends WHERE created_at>now()-interval '1 day' AND (phone_key=$1 OR ip_key=$2)`, [phoneKey, ipKey])).rows[0];
      if (+counts.minute >= 1 || +counts.hour >= 5 || +counts.day >= 10 || +counts.ip >= 20) throw new HttpException('发送太频繁，请稍后再试', 429);
      await client.query('INSERT INTO bio_auth_sends(id,phone_key,ip_key) VALUES($1,$2,$3)', [id, phoneKey, ipKey]);
      await client.query(`INSERT INTO bio_auth_codes(phone,digest,expires_at) VALUES($1,$2,now()+interval '5 minutes')
        ON CONFLICT(phone) DO UPDATE SET digest=$2,expires_at=now()+interval '5 minutes',attempts=0,ready=false`, [phone, digest]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    // Failed or uncertain sends still consume quota; no retry can cause an SMS storm.
    await this.sms.send(phone, code);
    await pool.query('UPDATE bio_auth_codes SET ready=true WHERE phone=$1 AND digest=$2', [phone, digest]);
    await pool.query("DELETE FROM bio_auth_sends WHERE created_at < now()-interval '2 days'");
    await pool.query('DELETE FROM bio_auth_sessions WHERE expires_at < now()');
    await pool.query("DELETE FROM bio_auth_codes WHERE expires_at < now()-interval '1 day'");
    return { retryAfter: 60, expiresIn: 300 };
  }
  async login(phone: string, code: string) {
    const pool = this.requireEnabled(), client = await pool.connect();
    let result: { token: string; expiresAt: string; user: { id: string; phone: string } } | undefined;
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT *, expires_at>now() AS valid FROM bio_auth_codes WHERE phone=$1 FOR UPDATE', [phone])).rows[0];
      if (row && row.ready && row.valid && row.attempts < 5) {
        await client.query('UPDATE bio_auth_codes SET attempts=attempts+1 WHERE phone=$1', [phone]);
        if (timingSafeEqual(Buffer.from(row.digest, 'hex'), Buffer.from(this.codeHash(phone, code), 'hex'))) {
          const user = (await client.query(`INSERT INTO bio_auth_users(id,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id,phone`, [randomUUID(), phone])).rows[0];
          const token = randomBytes(32).toString('base64url');
          const expires = (await client.query(`INSERT INTO bio_auth_sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING expires_at`, [hash(token), user.id])).rows[0];
          await client.query('DELETE FROM bio_auth_codes WHERE phone=$1', [phone]);
          result = { token, expiresAt: expires.expires_at.toISOString(), user: { id: user.id, phone: `${phone.slice(0,3)}****${phone.slice(-4)}` } };
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    if (!result) throw new UnauthorizedException('验证码错误或已失效，请重新获取');
    return result;
  }
  async identity(authorization?: string, protocols?: string): Promise<string> {
    const token = bearer(authorization, protocols);
    if (!token) throw new UnauthorizedException('请先登录');
    const row = (await this.requireEnabled().query('SELECT user_id FROM bio_auth_sessions WHERE digest=$1 AND expires_at>now()', [hash(token)])).rows[0];
    if (!row) throw new UnauthorizedException('登录已过期，请重新登录');
    return row.user_id;
  }
  async me(authorization?: string) {
    const id = await this.identity(authorization);
    const row = (await this.pool!.query('SELECT phone FROM bio_auth_users WHERE id=$1', [id])).rows[0];
    return { id, phone: `${row.phone.slice(0,3)}****${row.phone.slice(-4)}` };
  }
  async logout(authorization?: string) {
    const token = bearer(authorization);
    if (token) await this.requireEnabled().query('DELETE FROM bio_auth_sessions WHERE digest=$1', [hash(token)]);
    return { loggedOut: true };
  }
}

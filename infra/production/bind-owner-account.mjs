// Explicit operator migration. Use only after backup; never invoked at app startup.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AUTH_SCHEMA } from '../../apps/api/dist/auth/schema.js';
const { Pool } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
const tables = ['bio_memory_sessions', 'bio_memory_calls', 'bio_memory_messages', 'bio_memories', 'bio_memory_overview_revisions', 'bio_memory_jobs', 'bio_memory_runs'];
export async function bindOwner(pool, phone, apply = false) {
  if (!/^1[3-9]\d{9}$/.test(phone || '')) throw new Error('OWNER_PHONE must be a mainland China phone number');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bio-auth-schema-v1'))");
    await client.query(AUTH_SCHEMA);
    await client.query('LOCK TABLE bio_auth_users IN SHARE ROW EXCLUSIVE MODE');
    const owner = (await client.query("SELECT id,version FROM bio_memory_users WHERE id='owner' FOR UPDATE")).rows[0];
    if (!owner) throw new Error('Legacy owner does not exist; refusing to create an empty replacement');
    const bound = (await client.query("SELECT id,phone FROM bio_auth_users WHERE id='owner' OR phone=$1 FOR UPDATE", [phone])).rows;
    if (bound.some(row => row.id !== 'owner' || row.phone !== phone)) throw new Error('Phone or owner already belongs to a different account; explicit merge required');
    if ((await client.query("SELECT 1 FROM bio_memory_calls WHERE user_id='owner' AND status<>'ended' LIMIT 1")).rowCount) throw new Error('Owner has active/disconnected calls; retry after calls finish');
    if ((await client.query("SELECT 1 FROM bio_memory_jobs WHERE user_id='owner' AND status='running' LIMIT 1")).rowCount) throw new Error('Owner memory worker is running; stop API before migration');
    const counts = {};
    for (const table of tables) counts[table] = Number((await client.query(`SELECT count(*) AS total FROM ${table} WHERE user_id='owner'`)).rows[0].total);
    if (!bound.length) await client.query("INSERT INTO bio_auth_users(id,phone) VALUES('owner',$1)", [phone]);
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { applied: apply, alreadyBound: bound.length === 1, phone: `${phone.slice(0,3)}****${phone.slice(-4)}`, overviewVersion: owner.version, counts };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MEMORY_DATABASE_URL) throw new Error('MEMORY_DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.MEMORY_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try { console.log(JSON.stringify(await bindOwner(pool, process.env.OWNER_PHONE, process.argv.includes('--apply')), null, 2)); }
  finally { await pool.end(); }
}

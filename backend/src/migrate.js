import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Applies migrations in filename order, each in its own transaction, once.
export async function migrate(pool, log = console) {
    const c = await pool.connect();
    try {
        await c.query('SELECT pg_advisory_lock(726011)'); // one migrator at a time
        await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
        const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
            if (done.has(f)) continue;
            const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/CREATE TABLE schema_migrations[^;]*;/, '');
            await c.query('BEGIN');
            try { await c.query(sql); await c.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]); await c.query('COMMIT'); log.info?.(`migration applied: ${f}`); }
            catch (e) { await c.query('ROLLBACK'); throw new Error(`Migration ${f} failed: ${e.message}`); }
        }
    } finally { await c.query('SELECT pg_advisory_unlock(726011)').catch(() => {}); c.release(); }
}

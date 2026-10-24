import pg from 'pg';
// numeric -> JS number for amounts (2-8 dp, well within double precision for lease values)
pg.types.setTypeParser(1700, v => v === null ? null : Number(v));
pg.types.setTypeParser(1082, v => v); // date stays 'YYYY-MM-DD'

export function createPool(url) {
    return new pg.Pool({ connectionString: url, max: 15, idleTimeoutMillis: 30000 });
}
// Run fn inside a transaction; rolls back on any error.
export async function tx(pool, fn) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally { c.release(); }
}

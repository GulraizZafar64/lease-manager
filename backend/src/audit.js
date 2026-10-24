import { sha256 } from './security/crypto.js';
// Canonical JSON (sorted keys) so the hash is stable after PostgreSQL JSONB reorders keys.
export const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
// Append to the hash-chained audit log. Each company has its own chain; the platform's chain has
// company_id null. Serialised per chain with an advisory lock so a chain has no forks.
// companyId defaults to the acting user's company.
export async function audit(client, { user, companyId, action, objectType, objectId, entityId, detail = {}, ip }) {
    const cid = companyId !== undefined ? companyId : (user?.company_id ?? null);
    await client.query("SELECT pg_advisory_xact_lock(726012, hashtext(coalesce($1::text, 'platform')))", [cid]);
    const prev = (await client.query('SELECT hash FROM audit_log WHERE company_id IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1', [cid])).rows[0];
    const prevHash = prev ? prev.hash : 'GENESIS';
    const at = new Date().toISOString();
    const body = canonical([at, user?.id || null, action, objectType || null, objectId || null, entityId || null, detail]);
    const hash = sha256(prevHash + body);
    await client.query(`INSERT INTO audit_log(company_id,at,user_id,user_name,role,action,object_type,object_id,entity_id,detail,ip,prev_hash,hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [cid, at, user?.id || null, user?.name || null, user?.role || null, action, objectType || null, objectId || null, entityId || null, detail, ip || null, prevHash, hash]);
}
// Recomputes one chain (a company's, or the platform's when companyId is null). Returns the first broken row, if any.
export async function verifyAuditChain(pool, companyId = null) {
    const { rows } = await pool.query('SELECT * FROM audit_log WHERE company_id IS NOT DISTINCT FROM $1 ORDER BY id', [companyId]);
    let prev = rows.length ? rows[0].prev_hash : 'GENESIS';
    for (const r of rows) {
        const body = canonical([new Date(r.at).toISOString(), r.user_id, r.action, r.object_type, r.object_id, r.entity_id, r.detail]);
        if (r.prev_hash !== prev || sha256(prev + body) !== r.hash) return { ok: false, brokenAt: Number(r.id), checked: rows.length };
        prev = r.hash;
    }
    return { ok: true, checked: rows.length };
}
// Every chain: the platform's and each company's.
export async function verifyAllAuditChains(pool) {
    const ids = (await pool.query('SELECT DISTINCT company_id FROM audit_log')).rows.map(r => r.company_id);
    const out = [];
    for (const id of ids) out.push({ companyId: id, ...(await verifyAuditChain(pool, id)) });
    return out;
}

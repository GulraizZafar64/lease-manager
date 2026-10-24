import { z } from 'zod';
import { hashPassword, randomToken } from './security/crypto.js';
import { HttpError, forbid, canManageRole, PERMS } from './rbac.js';
import { checkRoles } from './roles.js';
import { requireAuth, publicUser, loadUser } from './auth.js';
import { audit, verifyAuditChain } from './audit.js';
import { tx } from './db.js';

const ccy = z.string().regex(/^[A-Z]{3}$/);
const tempPassword = () => randomToken(12).replace(/[-_]/g, 'x') + '!7a';

// Entity codes and names are unique in a company
const DUP_ENTITY = e => e.code === '23505' ? new HttpError(409, 'Another entity in your company already uses this name or code.', 'duplicate_entity') : e;

// Entity IDs must all belong to the company.
async function checkEntities(db, companyId, ids) {
    if (!ids.length) return;
    const n = (await db.query('SELECT count(*)::int n FROM entities WHERE company_id=$1 AND id = ANY($2)', [companyId, ids])).rows[0].n;
    if (n !== new Set(ids).size) throw new HttpError(400, 'Unknown entity.', 'bad_entity');
}
// A user of the caller's company, or 404 (other companies' users and deleted users are not revealed).
async function companyUser(db, req, id) {
    const u = await loadUser(db, id);
    if (!u || u.company_id !== req.user.company_id || u.deleted_at) throw new HttpError(404, 'Not found', 'not_found');
    return u;
}

export function adminRoutes(app, cfg) {
    const auth = p => ({ preHandler: requireAuth(cfg, p) });
    /* ---- Users (deleted users keep their row for history and are left out everywhere) ---- */
    app.get('/api/users', auth('admin.users'), async (req) => {
        const { rows } = await app.pg.query('SELECT id FROM users WHERE company_id=$1 AND deleted_at IS NULL ORDER BY name', [req.user.company_id]);
        return Promise.all(rows.map(async r => publicUser(await loadUser(app.pg, r.id))));
    });
    const perms = z.array(z.enum(PERMS)).max(PERMS.length).transform(a => [...new Set(a)]);
    const title = z.string().trim().max(120).nullable().transform(t => t || null);
    const userBody = z.object({ email: z.string().trim().email().max(200), name: z.string().trim().min(1).max(120), title: title.default(null), role: z.string().max(60), entityIds: z.array(z.string().uuid()).default([]), approvalLimit: z.number().nonnegative().nullable().default(null), extraPerms: perms.default([]) }).strict();
    const emailTaken = async (c, cid, email, exceptId = null) => (await c.query('SELECT 1 FROM users WHERE company_id=$1 AND lower(email)=lower($2) AND deleted_at IS NULL AND id IS DISTINCT FROM $3', [cid, email, exceptId])).rowCount > 0;
    const DUP_EMAIL = () => new HttpError(409, 'Another user in your company already has this email address.', 'duplicate_email');
    // A super administrator may not end up without another active one
    async function keepOneSuperadmin(c, target) {
        const n = (await c.query("SELECT count(*)::int n FROM users WHERE company_id=$1 AND role='superadmin' AND status='active' AND deleted_at IS NULL AND id<>$2", [target.company_id, target.id])).rows[0].n;
        if (!n) throw new HttpError(409, 'Keep at least one active super administrator.', 'last_superadmin');
    }
    async function setEntities(c, target, ids) {
        await checkEntities(c, target.company_id, ids);
        await c.query('DELETE FROM user_entities WHERE user_id=$1', [target.id]);
        for (const e of ids) await c.query('INSERT INTO user_entities(company_id,user_id,entity_id) VALUES ($1,$2,$3)', [target.company_id, target.id, e]);
    }
    app.post('/api/users', auth('admin.users'), async (req) => {
        const b = userBody.parse(req.body);
        if (!canManageRole(req.user, b.role)) throw forbid('Only a super administrator can create super administrators.');
        const temp = tempPassword();
        const cid = req.user.company_id;
        const id = await tx(app.pg, async c => {
            if (await emailTaken(c, cid, b.email)) throw DUP_EMAIL();
            await checkRoles(c, cid, [b.role]);
            await checkEntities(c, cid, b.entityIds);
            const { rows } = await c.query('INSERT INTO users(company_id,email,name,title,role,password_hash,approval_limit,extra_perms,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [cid, b.email, b.name, b.title, b.role, await hashPassword(temp), b.approvalLimit, b.extraPerms, req.user.id]);
            for (const e of b.entityIds) await c.query('INSERT INTO user_entities(company_id,user_id,entity_id) VALUES ($1,$2,$3)', [cid, rows[0].id, e]);
            await audit(c, { user: req.user, action: 'user.create', objectType: 'user', objectId: rows[0].id, detail: { email: b.email, role: b.role, entityIds: b.entityIds, approvalLimit: b.approvalLimit, extraPerms: b.extraPerms }, ip: req.ip });
            return rows[0].id;
        });
        // The temporary password is shown once to the administrator and must be changed at first sign-in.
        return { user: publicUser(await loadUser(app.pg, id)), temporaryPassword: temp };
    });
    app.patch('/api/users/:id', auth('admin.users'), async (req) => {
        // no defaults: omitted fields stay unchanged
        const b = z.object({ email: z.string().trim().email().max(200).optional(), name: z.string().trim().min(1).max(120).optional(), title: title.optional(), role: z.string().max(60).optional(), entityIds: z.array(z.string().uuid()).optional(), approvalLimit: z.number().nonnegative().nullable().optional(), extraPerms: perms.optional(), status: z.enum(['active', 'disabled']).optional() }).strict().parse(req.body);
        const target = await companyUser(app.pg, req, req.params.id);
        if (!canManageRole(req.user, target.role) || (b.role && !canManageRole(req.user, b.role))) throw forbid('Only a super administrator can change super administrators.');
        const roleChange = b.role && b.role !== target.role;
        if (target.id === req.user.id && (roleChange || b.status === 'disabled' || b.extraPerms)) throw forbid('You cannot change your own role or permissions, or disable yourself.');
        await tx(app.pg, async c => {
            if (roleChange) await checkRoles(c, target.company_id, [b.role]);
            if (target.role === 'superadmin' && ((roleChange && b.role !== 'superadmin') || b.status === 'disabled')) await keepOneSuperadmin(c, target);
            if (b.email && b.email.toLowerCase() !== target.email.toLowerCase() && await emailTaken(c, target.company_id, b.email, target.id)) throw DUP_EMAIL();
            await c.query(`UPDATE users SET email=coalesce($2,email), name=coalesce($3,name), role=coalesce($4,role), status=coalesce($5,status),
                    title=CASE WHEN $6::boolean THEN $7 ELSE title END, approval_limit=CASE WHEN $8::boolean THEN $9 ELSE approval_limit END, extra_perms=coalesce($10,extra_perms) WHERE id=$1`,
                [target.id, b.email ?? null, b.name ?? null, b.role ?? null, b.status ?? null, b.title !== undefined, b.title ?? null, b.approvalLimit !== undefined, b.approvalLimit ?? null, b.extraPerms ?? null]);
            if (b.entityIds) await setEntities(c, target, b.entityIds);
            // Changes take effect immediately: every request re-reads the user, so permissions, entities and limits apply at once.
            // A disabled user's sessions stop working at once and say why; they are removed on re-enabling, so none comes back.
            // A new role or email means signing in again.
            if (roleChange || (b.email && b.email.toLowerCase() !== target.email.toLowerCase()) || (b.status === 'active' && target.status === 'disabled')) await c.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
            await audit(c, { user: req.user, action: 'user.update', objectType: 'user', objectId: target.id, detail: { before: { email: target.email, role: target.role, status: target.status, entityIds: target.entityIds, approvalLimit: target.approval_limit, extraPerms: target.extra_perms }, after: b }, ip: req.ip });
        });
        return publicUser(await loadUser(app.pg, target.id));
    });
    // Delete: the person can no longer sign in and is left out of lists; their name stays on past work and in the audit log.
    app.delete('/api/users/:id', auth('admin.users'), async (req) => {
        const target = await companyUser(app.pg, req, req.params.id);
        if (!canManageRole(req.user, target.role)) throw forbid('Only a super administrator can delete super administrators.');
        if (target.id === req.user.id) throw forbid('You cannot delete your own account.');
        await tx(app.pg, async c => {
            if (target.role === 'superadmin' && target.status === 'active') await keepOneSuperadmin(c, target);
            await c.query("UPDATE users SET deleted_at=now(), deleted_by=$2, status='disabled' WHERE id=$1", [target.id, req.user.id]);
            await c.query('DELETE FROM user_entities WHERE user_id=$1', [target.id]);
            await c.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
            await audit(c, { user: req.user, action: 'user.delete', objectType: 'user', objectId: target.id, detail: { email: target.email, name: target.name, role: target.role }, ip: req.ip });
        });
        return { ok: true };
    });
    for (const [path, what] of [['reset-password', 'password'], ['reset-mfa', 'mfa'], ['unlock', 'unlock']]) {
        app.post(`/api/users/:id/${path}`, auth('admin.users'), async (req) => {
            const target = await companyUser(app.pg, req, req.params.id);
            if (!canManageRole(req.user, target.role)) throw forbid('Only a super administrator can do this for a super administrator.');
            if (target.id === req.user.id && what !== 'unlock') throw forbid('Use Change password or ask another administrator.');
            const temp = what === 'password' ? tempPassword() : null;
            await tx(app.pg, async c => {
                if (what === 'password') await c.query('UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL WHERE id=$1', [target.id, await hashPassword(temp)]);
                else if (what === 'mfa') await c.query('UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_last_step=NULL WHERE id=$1', [target.id]);
                else await c.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [target.id]);
                if (what !== 'unlock') await c.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
                await audit(c, { user: req.user, action: `user.${what === 'unlock' ? 'unlock' : 'reset_' + what}`, objectType: 'user', objectId: target.id, ip: req.ip });
            });
            return { user: publicUser(await loadUser(app.pg, target.id)), ...(temp ? { temporaryPassword: temp } : {}) };
        });
    }
    /* ---- Entities ---- */
    app.get('/api/entities', auth('lease.view'), async (req) => {
        const f = req.user.entityIds.length ? req.user.entityIds : null;
        return (await app.pg.query('SELECT * FROM entities WHERE company_id=$1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY code', [req.user.company_id, f])).rows;
    });
    const entBody = z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(200), functionalCurrency: ccy, parentId: z.string().uuid().nullable().default(null), country: z.string().max(80).nullable().default(null) });
    app.post('/api/entities', auth('admin.settings'), async (req) => {
        const b = entBody.parse(req.body);
        return tx(app.pg, async c => {
            if (b.parentId) await checkEntities(c, req.user.company_id, [b.parentId]);
            const { rows } = await c.query('INSERT INTO entities(company_id,code,name,functional_currency,parent_id,country) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [req.user.company_id, b.code, b.name, b.functionalCurrency, b.parentId, b.country]).catch(e => { throw DUP_ENTITY(e); });
            await audit(c, { user: req.user, action: 'entity.create', objectType: 'entity', objectId: rows[0].id, entityId: rows[0].id, detail: b, ip: req.ip });
            return rows[0];
        });
    });
    // Edit: a new parent must be in the company and must not make a loop
    app.patch('/api/entities/:id', auth('admin.settings'), async (req) => {
        const b = z.object({ code: z.string().trim().min(1).max(20).optional(), name: z.string().trim().min(1).max(200).optional(), functionalCurrency: ccy.optional(), parentId: z.string().uuid().nullable().optional(), country: z.string().max(80).nullable().optional() }).strict().parse(req.body);
        const cid = req.user.company_id, id = req.params.id;
        return tx(app.pg, async c => {
            const before = (await c.query('SELECT * FROM entities WHERE company_id=$1 AND id=$2 FOR UPDATE', [cid, id])).rows[0];
            if (!before) throw new HttpError(404, 'Not found', 'not_found');
            if (b.parentId) {
                await checkEntities(c, cid, [b.parentId]);
                const loop = (await c.query(`WITH RECURSIVE up AS (SELECT id, parent_id FROM entities WHERE company_id=$1 AND id=$2
                    UNION SELECT e.id, e.parent_id FROM entities e JOIN up ON e.id = up.parent_id WHERE e.company_id=$1) SELECT 1 FROM up WHERE id=$3`, [cid, b.parentId, id])).rowCount;
                if (loop) throw new HttpError(400, 'An entity cannot sit under itself or one of its own subsidiaries.', 'bad_parent');
            }
            const { rows } = await c.query(`UPDATE entities SET code=coalesce($3,code), name=coalesce($4,name), functional_currency=coalesce($5,functional_currency),
                    parent_id=CASE WHEN $6::boolean THEN $7 ELSE parent_id END, country=CASE WHEN $8::boolean THEN $9 ELSE country END WHERE company_id=$1 AND id=$2 RETURNING *`,
                [cid, id, b.code ?? null, b.name ?? null, b.functionalCurrency ?? null, b.parentId !== undefined, b.parentId ?? null, b.country !== undefined, b.country ?? null]).catch(e => { throw DUP_ENTITY(e); });
            await audit(c, { user: req.user, action: 'entity.update', objectType: 'entity', objectId: id, entityId: id, detail: { before: { code: before.code, name: before.name, functionalCurrency: before.functional_currency, parentId: before.parent_id, country: before.country }, after: b }, ip: req.ip });
            return rows[0];
        });
    });
    // Delete an entity nothing refers to: no leases, no subsidiaries, no users limited to it
    app.delete('/api/entities/:id', auth('admin.settings'), async (req) => {
        const cid = req.user.company_id, id = req.params.id;
        await tx(app.pg, async c => {
            const e = (await c.query('SELECT * FROM entities WHERE company_id=$1 AND id=$2 FOR UPDATE', [cid, id])).rows[0];
            if (!e) throw new HttpError(404, 'Not found', 'not_found');
            const n = async sql => (await c.query(sql, [cid, id])).rows[0].n;
            const leases = await n('SELECT count(*)::int n FROM leases WHERE company_id=$1 AND entity_id=$2');
            const subs = await n('SELECT count(*)::int n FROM entities WHERE company_id=$1 AND parent_id=$2');
            const users = await n('SELECT count(*)::int n FROM user_entities ue JOIN users u ON u.id = ue.user_id WHERE ue.company_id=$1 AND ue.entity_id=$2 AND u.deleted_at IS NULL');
            const why = [leases && `${leases} lease${leases > 1 ? 's' : ''}`, subs && `${subs} subsidiar${subs > 1 ? 'ies' : 'y'}`, users && `${users} user${users > 1 ? 's' : ''} limited to it`].filter(Boolean);
            if (why.length) throw new HttpError(409, `${e.name} is still used: ${why.join(', ')}.`, 'entity_in_use');
            await c.query('DELETE FROM user_entities WHERE company_id=$1 AND entity_id=$2', [cid, id]);
            await c.query('DELETE FROM entities WHERE company_id=$1 AND id=$2', [cid, id]);
            await audit(c, { user: req.user, action: 'entity.delete', objectType: 'entity', objectId: id, detail: { code: e.code, name: e.name }, ip: req.ip });
        });
        return { ok: true };
    });
    /* ---- Settings (whitelisted keys) ---- */
    const SETTING_SCHEMAS = {
        base_currency: z.object({ currency: ccy }),
        period_lock: z.object({ lockedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
        rate_convention: z.object({ convention: z.enum(['effective', 'nominal']) }),
        approval_policy: z.record(z.array(z.object({ upTo: z.number().positive().nullable(), approvals: z.number().int().min(1).max(5), roles: z.array(z.string().max(60)).min(1) })).min(1)),
        segregation: z.object({ makerCannotCheck: z.boolean() })
    };
    app.get('/api/settings', auth('lease.view'), async (req) => Object.fromEntries((await app.pg.query('SELECT key,value FROM settings WHERE company_id=$1', [req.user.company_id])).rows.map(r => [r.key, r.value])));
    app.put('/api/settings/:key', auth('admin.settings'), async (req) => {
        const schema = SETTING_SCHEMAS[req.params.key]; if (!schema) throw new HttpError(404, 'Unknown setting', 'not_found');
        const v = schema.parse(req.body);
        await tx(app.pg, async c => {
            const cid = req.user.company_id;
            // Approvers: any of the company's roles that can approve
            if (req.params.key === 'approval_policy') await checkRoles(c, cid, Object.values(v).flat().flatMap(t => t.roles), 'approve');
            const before = (await c.query('SELECT value FROM settings WHERE company_id=$1 AND key=$2', [cid, req.params.key])).rows[0];
            await c.query('INSERT INTO settings(company_id,key,value,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id,key) DO UPDATE SET value=$3, updated_at=now(), updated_by=$4', [cid, req.params.key, v, req.user.id]);
            await audit(c, { user: req.user, action: 'settings.update', objectType: 'setting', objectId: req.params.key, detail: { before: before ? before.value : null, after: v }, ip: req.ip });
        });
        return v;
    });
    app.post('/api/fx-rates', auth('admin.settings'), async (req) => {
        const rows = z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), currency: ccy, rate: z.number().positive(), source: z.string().max(80).optional() })).min(1).max(5000).parse(req.body);
        await tx(app.pg, async c => {
            for (const r of rows) await c.query('INSERT INTO fx_rates(company_id,rate_date,currency,rate,source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id,rate_date,currency) DO UPDATE SET rate=$4, source=$5', [req.user.company_id, r.date, r.currency, r.rate, r.source || null]);
            await audit(c, { user: req.user, action: 'fx.import', detail: { count: rows.length }, ip: req.ip });
        });
        return { saved: rows.length };
    });
    app.get('/api/fx-rates', auth('lease.view'), async (req) =>
        (await app.pg.query("SELECT to_char(rate_date,'YYYY-MM-DD') AS date, currency, rate::float8 AS rate, source FROM fx_rates WHERE company_id=$1 ORDER BY rate_date DESC, currency", [req.user.company_id])).rows);
    app.post('/api/fx-rates/remove', auth('admin.settings'), async (req) => {
        const rows = z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), currency: ccy }).strict()).min(1).max(5000).parse(req.body);
        let removed = 0;
        await tx(app.pg, async c => {
            for (const r of rows) removed += (await c.query('DELETE FROM fx_rates WHERE company_id=$1 AND rate_date=$2 AND currency=$3', [req.user.company_id, r.date, r.currency])).rowCount;
            await audit(c, { user: req.user, action: 'fx.remove', detail: { rows }, ip: req.ip });
        });
        return { removed };
    });
    /* ---- Audit ---- */
    app.get('/api/audit', auth('audit.view'), async (req) => {
        const q = z.object({ limit: z.coerce.number().int().min(1).max(5000).default(500), objectId: z.string().optional() }).parse(req.query);
        return (await app.pg.query('SELECT id,at,user_id,user_name,role,action,object_type,object_id,entity_id,detail,ip FROM audit_log WHERE company_id=$3 AND ($2::text IS NULL OR object_id=$2) ORDER BY id DESC LIMIT $1', [q.limit, q.objectId || null, req.user.company_id])).rows;
    });
    app.get('/api/audit/verify', auth('audit.view'), async (req) => verifyAuditChain(app.pg, req.user.company_id));
}

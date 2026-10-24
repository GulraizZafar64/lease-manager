// Each company's roles and permissions: the built-in roles (permissions can be changed and reset)
// and custom roles. Permissions are read with the user on every request, so changes apply at once.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError, forbid, PERMS, ROLES, ROLE_DESC, ROLE_PERMS, REQUIRED_PERM, isBuiltinRole, rolePermsOf } from './rbac.js';
import { requireAuth } from './auth.js';
import { audit } from './audit.js';
import { tx } from './db.js';
import { DEFAULT_POLICY } from './leases.js';

const ROLE_SQL = `SELECT r.*, u.name AS updated_by_name FROM roles r LEFT JOIN users u ON u.id = r.updated_by WHERE r.company_id=$1`;

function publicRole(id, row, users) {
    const builtin = isBuiltinRole(id);
    return {
        id, label: builtin ? ROLES[id] : row.label, description: builtin ? ROLE_DESC[id] : row.description,
        perms: rolePermsOf(id, row && row.perms), custom: !builtin, changed: builtin && !!row,
        updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by_name : null, users: users[id] || 0,
    };
}
/** The company's roles: built-in ones in their order, then custom ones by name. */
export async function companyRoles(db, companyId) {
    const rows = (await db.query(`${ROLE_SQL} ORDER BY lower(r.label)`, [companyId])).rows;
    const users = Object.fromEntries((await db.query('SELECT role, count(*)::int n FROM users WHERE company_id=$1 AND deleted_at IS NULL GROUP BY role', [companyId])).rows.map(r => [r.role, r.n]));
    return Object.keys(ROLES).map(id => publicRole(id, rows.find(r => r.id === id), users))
        .concat(rows.filter(r => r.custom).map(r => publicRole(r.id, r, users)));
}
/** A role the company has (built-in or custom), with its permissions; null if none. */
export async function findRole(db, companyId, id) {
    if (isBuiltinRole(id)) {
        const row = (await db.query('SELECT perms FROM roles WHERE company_id=$1 AND id=$2', [companyId, id])).rows[0];
        return { id, perms: rolePermsOf(id, row && row.perms), custom: false };
    }
    const row = (await db.query('SELECT perms FROM roles WHERE company_id=$1 AND id=$2 AND custom', [companyId, id])).rows[0];
    return row ? { id, perms: rolePermsOf(id, row.perms), custom: true } : null;
}
/** Every role named must exist in the company; with perm, each must also hold it. */
export async function checkRoles(db, companyId, ids, perm) {
    for (const id of new Set(ids)) {
        const r = await findRole(db, companyId, id);
        if (!r) throw new HttpError(400, `There is no role "${id}".`, 'bad_role');
        if (perm && !r.perms.includes(perm)) throw new HttpError(400, `The role ${isBuiltinRole(id) ? ROLES[id] : id} does not have the ${perm} permission.`, 'bad_role');
    }
}

const perms = z.array(z.enum(PERMS)).max(PERMS.length).transform(a => [...new Set([REQUIRED_PERM, ...a])]);
const label = z.string().trim().min(1).max(60);
const description = z.string().trim().max(240);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'role';

export function roleRoutes(app, cfg) {
    // Anyone signed in may read the roles (the app shows role names and hides what a role cannot do)
    app.get('/api/roles', { preHandler: requireAuth(cfg, null) }, async (req) => companyRoles(app.pg, req.user.company_id));

    // Changing roles: super administrators only, so no one can raise their own permissions
    const superOnly = { preHandler: [requireAuth(cfg, 'admin.users'), async (req) => { if (req.user.role !== 'superadmin') throw forbid('Only a super administrator can change roles and permissions.'); }] };
    const labelTaken = async (c, cid, l, exceptId = null) =>
        Object.values(ROLES).some(b => b.toLowerCase() === l.toLowerCase()) ||
        (await c.query('SELECT 1 FROM roles WHERE company_id=$1 AND lower(label)=lower($2) AND id IS DISTINCT FROM $3', [cid, l, exceptId])).rowCount > 0;
    const DUP = () => new HttpError(409, 'A role with this name already exists.', 'duplicate_role');
    const one = async (cid, id) => (await companyRoles(app.pg, cid)).find(r => r.id === id);

    app.post('/api/roles', superOnly, async (req) => {
        const b = z.object({ label, description: description.default(''), perms }).strict().parse(req.body);
        const cid = req.user.company_id, id = `r-${slug(b.label)}-${randomBytes(2).toString('hex')}`;
        await tx(app.pg, async c => {
            if (await labelTaken(c, cid, b.label)) throw DUP();
            await c.query('INSERT INTO roles(company_id,id,label,description,perms,custom,updated_by) VALUES ($1,$2,$3,$4,$5,true,$6)', [cid, id, b.label, b.description, b.perms, req.user.id]);
            await audit(c, { user: req.user, action: 'role.create', objectType: 'role', objectId: id, detail: b, ip: req.ip });
        });
        return one(cid, id);
    });
    app.put('/api/roles/:id', superOnly, async (req) => {
        const id = req.params.id, cid = req.user.company_id;
        if (id === 'superadmin') throw new HttpError(400, 'The super administrator always has every permission.', 'role_locked');
        const builtin = isBuiltinRole(id);
        const b = z.object({ perms, ...(builtin ? {} : { label: label.optional(), description: description.optional() }) }).strict().parse(req.body);
        await tx(app.pg, async c => {
            const before = (await c.query('SELECT label, description, perms FROM roles WHERE company_id=$1 AND id=$2 FOR UPDATE', [cid, id])).rows[0];
            if (!builtin && !before) throw new HttpError(404, 'Not found', 'not_found');
            if (b.label && await labelTaken(c, cid, b.label, id)) throw DUP();
            const isDefault = builtin && [...b.perms].sort().join() === [...ROLE_PERMS[id]].sort().join();
            if (isDefault) await c.query('DELETE FROM roles WHERE company_id=$1 AND id=$2', [cid, id]); // back to the default: nothing to keep
            else if (builtin) await c.query(`INSERT INTO roles(company_id,id,label,description,perms,custom,updated_by) VALUES ($1,$2,$3,$4,$5,false,$6)
                ON CONFLICT (company_id,id) DO UPDATE SET perms=$5, updated_at=now(), updated_by=$6`, [cid, id, ROLES[id], ROLE_DESC[id], b.perms, req.user.id]);
            else await c.query('UPDATE roles SET label=coalesce($3,label), description=coalesce($4,description), perms=$5, updated_at=now(), updated_by=$6 WHERE company_id=$1 AND id=$2',
                [cid, id, b.label ?? null, b.description ?? null, b.perms, req.user.id]);
            await audit(c, { user: req.user, action: 'role.update', objectType: 'role', objectId: id, detail: { before: before || { perms: ROLE_PERMS[id] }, after: b }, ip: req.ip });
        });
        return one(cid, id);
    });
    // A built-in role back to its default permissions
    app.post('/api/roles/:id/reset', superOnly, async (req) => {
        const id = req.params.id, cid = req.user.company_id;
        if (!isBuiltinRole(id) || id === 'superadmin') throw new HttpError(400, 'Only a changed built-in role can be reset.', 'bad_role');
        await tx(app.pg, async c => {
            const gone = (await c.query('DELETE FROM roles WHERE company_id=$1 AND id=$2 RETURNING perms', [cid, id])).rows[0];
            if (gone) await audit(c, { user: req.user, action: 'role.reset', objectType: 'role', objectId: id, detail: { before: gone.perms, after: ROLE_PERMS[id] }, ip: req.ip });
        });
        return one(cid, id);
    });
    // A custom role nobody holds and the approval policy does not name
    app.delete('/api/roles/:id', superOnly, async (req) => {
        const id = req.params.id, cid = req.user.company_id;
        if (isBuiltinRole(id)) throw new HttpError(400, 'Built-in roles cannot be deleted.', 'bad_role');
        await tx(app.pg, async c => {
            const row = (await c.query('SELECT * FROM roles WHERE company_id=$1 AND id=$2 AND custom FOR UPDATE', [cid, id])).rows[0];
            if (!row) throw new HttpError(404, 'Not found', 'not_found');
            const n = (await c.query('SELECT count(*)::int n FROM users WHERE company_id=$1 AND role=$2 AND deleted_at IS NULL', [cid, id])).rows[0].n;
            if (n) throw new HttpError(409, `${n} user${n > 1 ? 's have' : ' has'} this role. Give them another role first.`, 'role_in_use');
            const pol = (await c.query("SELECT value FROM settings WHERE company_id=$1 AND key='approval_policy'", [cid])).rows[0]?.value || DEFAULT_POLICY;
            const uses = Object.keys(pol).filter(k => pol[k].some(t => t.roles.includes(id)));
            if (uses.length) throw new HttpError(409, `The approval policy uses this role (${uses.join(', ')}). Remove it there first.`, 'role_in_use');
            await c.query('DELETE FROM roles WHERE company_id=$1 AND id=$2', [cid, id]);
            await audit(c, { user: req.user, action: 'role.delete', objectType: 'role', objectId: id, detail: { label: row.label, perms: row.perms }, ip: req.ip });
        });
        return { ok: true };
    });
}

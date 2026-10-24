// ERP export files, AI-drafted disclosures, the company's data export and restore, and the audit log as the
// web app shows it (with the few actions only the browser sees, and retention purges).
import { z } from 'zod';
import { HttpError, forbid, can } from './rbac.js';
import { requireAuth } from './auth.js';
import { audit, canonical } from './audit.js';
import { sha256 } from './security/crypto.js';
import { tx } from './db.js';
import { clientLeases, decide } from './leases.js';
import { batches, lineHash, statements } from './banking.js';
import { readSettings } from './companySettings.js';
import { companyRoles } from './roles.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ident = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const text = max => z.string().max(max);
const anyOf = (cfg, perms) => async (req) => {
    await requireAuth(cfg, null)(req);
    if (!perms.some(p => can(req.user, p))) throw forbid();
};
const iso = t => t ? new Date(t).toISOString() : undefined;

/* ---- As the web app holds them ---- */
async function exportsOf(db, cid, id = null) {
    return (await db.query('SELECT * FROM erp_exports WHERE company_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY created_at', [cid, id])).rows.map(x => ({
        id: x.id, target: x.target, from: x.period_from, to: x.period_to, createdAt: iso(x.created_at), createdBy: x.created_by, count: x.entries, debits: x.debits, keys: x.keys, status: x.status,
        ...(x.notes ? { notes: x.notes } : {}), ...(x.marked_by ? { markedBy: x.marked_by } : {}),
    }));
}
async function draftsOf(db, cid, id = null) {
    const rows = (await db.query('SELECT * FROM ai_drafts WHERE company_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY created_at', [cid, id])).rows;
    if (!rows.length) return [];
    const appr = (await db.query("SELECT a.*, u.name FROM approvals a JOIN users u ON u.id=a.user_id WHERE a.company_id=$1 AND a.item_type='draft' AND a.decision='approve' AND a.item_id = ANY($2) ORDER BY a.at", [cid, rows.map(r => r.id)])).rows;
    const names = new Map((await db.query('SELECT id, name FROM users WHERE company_id=$1', [cid])).rows.map(u => [u.id, u.name]));
    return rows.map(d => ({
        id: d.id, title: d.title, from: d.period_from, to: d.period_to, text: d.text, source: d.source, status: d.status, version: d.version,
        createdAt: iso(d.created_at), createdBy: d.created_by, createdByName: names.get(d.created_by) || '', ...(d.edited_by ? { editedBy: d.edited_by } : {}),
        approvals: appr.filter(a => a.item_id === d.id && a.item_version === d.version).map(a => ({ by: a.user_id, name: a.name, role: a.role, at: iso(a.at) })),
    }));
}
async function lockRow(c, table, cid, id, what) {
    const r = (await c.query(`SELECT * FROM ${table} WHERE company_id=$1 AND id=$2 FOR UPDATE`, [cid, id])).rows[0];
    if (!r) throw new HttpError(404, `That ${what} is not on the server.`, 'not_found');
    return r;
}

/* ---- Restoring records from a backup: added when not already here; approvals are not carried over ---- */
const restoreLine = z.object({ id: ident, date, amount: z.number().finite(), ref: text(500).default(''), desc: text(2000).default(''), status: z.enum(['unmatched', 'suggested', 'matched', 'ignored']).default('unmatched'), duplicate: z.boolean().default(false), suggest: z.any().optional(), match: z.any().optional() }).passthrough();
const restoreBody = z.object({
    source: z.string().trim().min(1).max(200),
    bank: z.array(z.object({ id: ident, name: text(200).min(1), format: text(40).default(''), account: text(200).default(''), importedAt: text(40).optional(), importedBy: text(80).optional(), lines: z.array(restoreLine).max(1500) }).passthrough()).max(500).default([]),
    batches: z.array(z.object({ id: ident, name: text(200).min(1), currency: z.string().regex(/^[A-Z]{3}$/), valueDate: date, account: text(200).default(''), createdAt: text(40).optional(), createdBy: text(80).optional(), status: z.enum(['draft', 'pending', 'approved', 'released', 'rejected']), submittedAt: text(40).optional(), releasedAt: text(40).optional(),
        lines: z.array(z.object({ key: text(200), leaseId: text(40), dueDate: date, forType: text(40).default(''), amount: z.number().positive() }).passthrough()).min(1).max(5000) }).passthrough()).max(2000).default([]),
    exports: z.array(z.object({ id: ident, target: text(40).min(1), from: date, to: date, createdAt: text(40).optional(), createdBy: text(80).optional(), count: z.number().int().min(0), debits: z.number(), keys: z.array(text(400)).max(100000).default([]), status: z.enum(['generated', 'posted', 'failed']), notes: text(2000).optional(), markedBy: text(80).optional() }).passthrough()).max(5000).default([]),
    drafts: z.array(z.object({ id: ident, title: text(300).min(1), from: date, to: date, text: text(200000), source: text(300).default(''), createdAt: text(40).optional(), createdBy: text(80).optional(), editedBy: text(80).optional(), status: z.enum(['draft', 'final']) }).passthrough()).max(2000).default([]),
}).strict();
const when = s => { const t = s ? new Date(s) : null; return t && !isNaN(t) ? t : new Date(); };

/** The browser-only actions the server cannot see for itself (report exports, AI requests, screen locks…). */
const CLIENT_ACTIONS = ['export', 'ai', 'session.lock', 'session.switch', 'role.preview', 'access.request'];

export function recordRoutes(app, cfg) {
    const auth = p => ({ preHandler: requireAuth(cfg, p) });

    /* ---- ERP export files ---- */
    app.get('/api/erp-exports', { preHandler: anyOf(cfg, ['gl.export', 'audit.view']) }, async (req) => exportsOf(app.pg, req.user.company_id));
    app.post('/api/erp-exports', auth('gl.export'), async (req) => {
        const b = z.object({ id: ident, target: z.string().trim().min(1).max(40), from: date, to: date, count: z.number().int().min(0), debits: z.number().finite(), keys: z.array(text(400)).max(100000) }).parse(req.body);
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            await c.query('INSERT INTO erp_exports(company_id,id,target,period_from,period_to,entries,debits,keys,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [cid, b.id, b.target, b.from, b.to, b.count, b.debits, JSON.stringify(b.keys), req.user.id]);
            await audit(c, { user: req.user, action: 'gl.export', objectType: 'erp_export', objectId: b.id, detail: { target: b.target, from: b.from, to: b.to, entries: b.count, debits: b.debits }, ip: req.ip });
            return (await exportsOf(c, cid, b.id))[0];
        });
    });
    app.post('/api/erp-exports/:id/mark', auth('gl.export'), async (req) => {
        const b = z.object({ status: z.enum(['posted', 'failed']), notes: text(2000).default('') }).strict().parse(req.body);
        return tx(app.pg, async c => {
            const x = await lockRow(c, 'erp_exports', req.user.company_id, req.params.id, 'ERP file');
            if (x.status !== 'generated') throw new HttpError(409, 'This file has already been marked.', 'bad_state');
            await c.query('UPDATE erp_exports SET status=$3, notes=$4, marked_by=$5, marked_at=now() WHERE company_id=$1 AND id=$2', [x.company_id, x.id, b.status, b.notes || null, req.user.id]);
            await audit(c, { user: req.user, action: 'gl.sync', objectType: 'erp_export', objectId: x.id, detail: { target: x.target, status: b.status, notes: b.notes }, ip: req.ip });
            return { status: b.status };
        });
    });

    /* ---- AI-drafted disclosures: final after approval by someone other than the last editor ---- */
    app.get('/api/ai-drafts', auth('lease.view'), async (req) => draftsOf(app.pg, req.user.company_id));
    app.post('/api/ai-drafts', auth('ai.use'), async (req) => {
        const b = z.object({ id: ident, title: z.string().trim().min(1).max(300), from: date, to: date, text: text(200000), source: text(300).default('') }).parse(req.body);
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            await c.query('INSERT INTO ai_drafts(company_id,id,title,period_from,period_to,text,source,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [cid, b.id, b.title, b.from, b.to, b.text, b.source, req.user.id]);
            await audit(c, { user: req.user, action: 'ai.draft', objectType: 'ai_draft', objectId: b.id, detail: { title: b.title, from: b.from, to: b.to, source: b.source }, ip: req.ip });
            return (await draftsOf(c, cid, b.id))[0];
        });
    });
    app.put('/api/ai-drafts/:id', auth('ai.use'), async (req) => {
        const b = z.object({ text: text(200000) }).strict().parse(req.body);
        return tx(app.pg, async c => {
            const d = await lockRow(c, 'ai_drafts', req.user.company_id, req.params.id, 'draft');
            if (d.status === 'final') throw new HttpError(409, 'Approved drafts cannot be edited.', 'locked');
            await c.query('UPDATE ai_drafts SET text=$3, version=version+1, edited_by=$4, edited_at=now() WHERE company_id=$1 AND id=$2', [d.company_id, d.id, b.text, req.user.id]);
            await audit(c, { user: req.user, action: 'ai.draft_edited', objectType: 'ai_draft', objectId: d.id, detail: { title: d.title, version: d.version + 1, approvalsReset: true }, ip: req.ip });
            return { version: d.version + 1 };
        });
    });
    app.post('/api/ai-drafts/:id/approve', { preHandler: anyOf(cfg, ['approve', 'ai.approve']) }, async (req) => tx(app.pg, async c => {
        const d = await lockRow(c, 'ai_drafts', req.user.company_id, req.params.id, 'draft');
        if (d.status === 'final') throw new HttpError(409, 'This draft is already final.', 'bad_state');
        if (/\[TO CONFIRM/.test(d.text)) throw new HttpError(409, 'Resolve every TO CONFIRM item before approving.', 'to_confirm');
        const r = await decide(c, req.user, { itemType: 'draft', itemId: d.id, version: d.version, makerId: d.edited_by || d.created_by, amount: 0 });
        if (r.done) await c.query("UPDATE ai_drafts SET status='final' WHERE company_id=$1 AND id=$2", [d.company_id, d.id]);
        await audit(c, { user: req.user, action: r.done ? 'ai.approve' : 'ai.approval_given', objectType: 'ai_draft', objectId: d.id, detail: { title: d.title, version: d.version, given: r.given, needed: r.needed }, ip: req.ip });
        return { status: r.done ? 'final' : 'draft', approvals: r.given, needed: r.needed };
    }));
    app.delete('/api/ai-drafts/:id', auth('ai.use'), async (req) => tx(app.pg, async c => {
        const d = await lockRow(c, 'ai_drafts', req.user.company_id, req.params.id, 'draft');
        await c.query('DELETE FROM ai_drafts WHERE company_id=$1 AND id=$2', [d.company_id, d.id]);
        await c.query("DELETE FROM approvals WHERE company_id=$1 AND item_type='draft' AND item_id=$2", [d.company_id, d.id]);
        await audit(c, { user: req.user, action: 'ai.draft_deleted', objectType: 'ai_draft', objectId: d.id, detail: { title: d.title, status: d.status }, ip: req.ip });
        return { ok: true };
    }));

    /* ---- Audit log: browser-only actions, and retention purges ---- */
    app.post('/api/audit/client', auth(null), async (req) => {
        const b = z.object({ action: z.enum(CLIENT_ACTIONS), detail: text(600).default(''), leaseId: text(40).optional() }).strict().parse(req.body);
        await tx(app.pg, c => audit(c, { user: req.user, action: b.action, objectType: b.leaseId ? 'lease' : 'web', objectId: b.leaseId || null, detail: { text: b.detail, from: 'web app' }, ip: req.ip }));
        return { ok: true };
    });
    // Only entries older than the retention period the company has saved; the purge itself is logged.
    // The rows left still verify: the chain is checked from the first remaining entry.
    app.post('/api/audit/purge', auth('admin.data'), async (req) => {
        const { before } = z.object({ before: date }).strict().parse(req.body);
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            const ws = (await c.query("SELECT value FROM settings WHERE company_id=$1 AND key='workspace'", [cid])).rows[0]?.value || {};
            const years = Math.max(1, Number(ws.retention && ws.retention.auditYears) || 10);
            const limit = new Date(); limit.setUTCFullYear(limit.getUTCFullYear() - years);
            const latest = limit.toISOString().slice(0, 10);
            if (before > latest) throw new HttpError(400, `Entries can be purged only after the ${years}-year retention period (dated before ${latest}).`, 'retention');
            await c.query("SELECT pg_advisory_xact_lock(726012, hashtext($1::text))", [cid]); // no new entries while purging
            await c.query("SET LOCAL app.retention_purge = 'on'");
            const { rowCount } = await c.query('DELETE FROM audit_log WHERE company_id=$1 AND at < $2::date', [cid, before]);
            await c.query("SET LOCAL app.retention_purge = 'off'");
            await audit(c, { user: req.user, action: 'retention.purge', objectType: 'audit_log', detail: { before, deleted: rowCount, retentionYears: years }, ip: req.ip });
            return { deleted: rowCount };
        });
    });

    /* ---- The browser app's audit log, kept as an archive when a company moves to the server ---- */
    app.post('/api/audit/archive', auth('admin.data'), async (req) => {
        const b = z.object({ source: z.string().trim().min(1).max(200), entries: z.array(z.object({ id: z.string().min(1).max(80), at: z.string().max(40), actor: text(80).optional(), actorName: text(200).optional(), role: text(60).optional(), action: z.string().min(1).max(80), detail: text(2000).default(''), leaseId: text(40).optional(), entity: text(200).optional() }).passthrough()).min(1).max(5000) }).strict().parse(req.body);
        const cid = req.user.company_id;
        const entries = b.entries.filter(e => !isNaN(new Date(e.at)));
        return tx(app.pg, async c => {
            let added = 0;
            for (const e of entries) added += (await c.query('INSERT INTO browser_audit(company_id,entry_id,at,actor,actor_name,role,action,detail,lease_id,entity,source,imported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING',
                [cid, e.id, new Date(e.at), e.actor || null, e.actorName || null, e.role || null, e.action, e.detail, e.leaseId || null, e.entity || null, b.source, req.user.id])).rowCount;
            const rows = entries.map(e => [e.id, e.at, e.actor || null, e.actorName || null, e.role || null, e.action, e.detail, e.leaseId || null, e.entity || null]);
            await audit(c, { user: req.user, action: 'migration.audit_archive', objectType: 'browser_audit', detail: { source: b.source, received: b.entries.length, added, from: entries.map(e => e.at).sort()[0] || null, to: entries.map(e => e.at).sort().at(-1) || null, sha256: sha256(canonical(rows)) }, ip: req.ip });
            return { added, skipped: b.entries.length - added };
        });
    });
    app.get('/api/audit/archive', auth('audit.view'), async (req) => {
        const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
        return (await app.pg.query('SELECT entry_id AS id, at, actor, actor_name AS "actorName", role, action, detail, lease_id AS "leaseId", entity, source FROM browser_audit WHERE company_id=$1 ORDER BY at DESC LIMIT $2', [req.user.company_id, limit])).rows
            .map(r => ({ ...r, at: r.at.toISOString() }));
    });

    /* ---- The company's data: everything, as the web app holds it ---- */
    app.get('/api/company-export', auth('admin.data'), async (req) => {
        const cid = req.user.company_id, db = app.pg;
        const company = (await db.query('SELECT code, name, base_currency FROM companies WHERE id=$1', [cid])).rows[0];
        const users = (await db.query(`SELECT u.id, u.email, u.name, u.title, u.role, u.status, u.approval_limit, u.extra_perms, u.mfa_enabled, u.created_at, u.last_login_at, u.deleted_at,
            coalesce(array_agg(ue.entity_id) FILTER (WHERE ue.entity_id IS NOT NULL), '{}') AS entity_ids
            FROM users u LEFT JOIN user_entities ue ON ue.user_id=u.id WHERE u.company_id=$1 GROUP BY u.id ORDER BY u.created_at`, [cid])).rows;
        const out = {
            format: 'lease-manager-company', version: 1, exported: new Date().toISOString(), by: req.user.name, company,
            settings: await readSettings(db, cid),
            entities: (await db.query('SELECT id, code, name, functional_currency, parent_id, country, active FROM entities WHERE company_id=$1 ORDER BY code', [cid])).rows,
            fxRates: (await db.query('SELECT rate_date AS date, currency, rate FROM fx_rates WHERE company_id=$1 ORDER BY rate_date, currency', [cid])).rows,
            roles: await companyRoles(db, cid),
            users: users.map(u => ({ id: u.id, email: u.email, name: u.name, title: u.title, role: u.role, status: u.deleted_at ? 'deleted' : u.status, approvalLimit: u.approval_limit, extraPerms: u.extra_perms, entityIds: u.entity_ids, mfaEnabled: u.mfa_enabled, createdAt: iso(u.created_at), lastLoginAt: iso(u.last_login_at) })),
            leases: await clientLeases(db, req.user),
            bank: await statements(db, cid), batches: await batches(db, cid), exports: await exportsOf(db, cid), drafts: await draftsOf(db, cid),
            audit: (await db.query('SELECT id, at, user_id, user_name, role, action, object_type, object_id, entity_id, detail, prev_hash, hash FROM audit_log WHERE company_id=$1 ORDER BY id', [cid])).rows,
            browserAudit: (await db.query('SELECT entry_id AS id, at, actor, actor_name AS "actorName", role, action, detail, lease_id AS "leaseId", entity, source FROM browser_audit WHERE company_id=$1 ORDER BY at', [cid])).rows,
        };
        await tx(db, c => audit(c, { user: req.user, action: 'company.export', objectType: 'company', objectId: cid, detail: { leases: out.leases.length, statements: out.bank.length, batches: out.batches.length, exports: out.exports.length, drafts: out.drafts.length, auditEntries: out.audit.length, partial: !!(req.user.entityIds && req.user.entityIds.length) }, ip: req.ip }));
        return out;
    });

    // Statements, batches, ERP files and drafts from a backup, added when their ids are not already here.
    // Leases come back through POST /api/leases/import; settings through PATCH /api/company-settings.
    // Approvals are not carried over: approved or pending batches and final drafts need approving again,
    // and released batches come back as records that cannot produce a bank file.
    app.post('/api/company-restore', auth('admin.data'), async (req) => {
        const b = restoreBody.parse(req.body);
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            const known = new Set((await c.query('SELECT id FROM users WHERE company_id=$1', [cid])).rows.map(r => r.id));
            const who = id => (id && known.has(id) ? id : req.user.id);
            const has = async (table, id) => (await c.query(`SELECT 1 FROM ${table} WHERE company_id=$1 AND id=$2`, [cid, id])).rowCount > 0;
            const done = { bank: [], batches: [], exports: [], drafts: [] }, skipped = { bank: [], batches: [], exports: [], drafts: [] };
            for (const s of b.bank) {
                const taken = (await c.query('SELECT 1 FROM bank_lines WHERE company_id=$1 AND id = ANY($2) LIMIT 1', [cid, s.lines.map(l => l.id)])).rowCount;
                if (await has('bank_statements', s.id) || taken) { skipped.bank.push(s.id); continue; }
                await c.query('INSERT INTO bank_statements(company_id,id,name,format,account,imported_by,imported_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [cid, s.id, s.name, s.format, s.account, who(s.importedBy), when(s.importedAt)]);
                for (const [i, l] of s.lines.entries())
                    await c.query('INSERT INTO bank_lines(company_id,statement_id,id,pos,line_date,amount,reference,description,hash,duplicate,status,suggest,match) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
                        [cid, s.id, l.id, i, l.date, l.amount, l.ref, l.desc, lineHash(`${l.date}|${l.amount}|${l.ref}|${l.desc}`), l.duplicate, l.status, l.status === 'suggested' && l.suggest ? l.suggest : null, l.status === 'matched' && l.match ? l.match : null]);
                done.bank.push(s.id);
            }
            for (const x of b.batches) {
                const lines = x.lines.map(l => ({ key: `${l.leaseId}|${l.dueDate}|${l.forType}`, leaseId: l.leaseId, dueDate: l.dueDate, forType: l.forType, amount: Math.round(l.amount * 100) / 100 }));
                const status = x.status === 'approved' ? 'pending' : x.status;
                const clash = ['draft', 'pending'].includes(status) && (await c.query("SELECT 1 FROM payment_batches, jsonb_array_elements(lines) l WHERE company_id=$1 AND status<>'rejected' AND l->>'key' = ANY($2) LIMIT 1", [cid, lines.map(l => l.key)])).rowCount;
                if (await has('payment_batches', x.id) || clash) { skipped.batches.push(x.id); continue; }
                await c.query('INSERT INTO payment_batches(company_id,id,name,currency,value_date,account,status,lines,total,created_by,created_at,submitted_at,released_at,restored) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
                    [cid, x.id, x.name, x.currency, x.valueDate, x.account, status, JSON.stringify(lines), Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100, who(x.createdBy), when(x.createdAt), status === 'draft' ? null : when(x.submittedAt), status === 'released' ? when(x.releasedAt) : null, status === 'released']);
                done.batches.push(x.id);
            }
            for (const x of b.exports) {
                if (await has('erp_exports', x.id)) { skipped.exports.push(x.id); continue; }
                await c.query('INSERT INTO erp_exports(company_id,id,target,period_from,period_to,entries,debits,keys,status,notes,created_by,created_at,marked_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
                    [cid, x.id, x.target, x.from, x.to, x.count, x.debits, JSON.stringify(x.keys), x.status, x.notes || null, who(x.createdBy), when(x.createdAt), x.status === 'generated' ? null : who(x.markedBy)]);
                done.exports.push(x.id);
            }
            for (const d of b.drafts) {
                if (await has('ai_drafts', d.id)) { skipped.drafts.push(d.id); continue; }
                await c.query('INSERT INTO ai_drafts(company_id,id,title,period_from,period_to,text,source,status,created_by,created_at,edited_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
                    [cid, d.id, d.title, d.from, d.to, d.text, d.source, 'draft', who(d.createdBy), when(d.createdAt), d.editedBy ? who(d.editedBy) : null]);
                done.drafts.push(d.id);
            }
            await audit(c, { user: req.user, action: 'company.restore', objectType: 'company', objectId: cid, detail: { source: b.source, restored: done, skipped }, ip: req.ip });
            return { restored: Object.fromEntries(Object.entries(done).map(([k, v]) => [k, v.length])), skipped };
        });
    });
}

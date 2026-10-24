// A company's settings as the web app uses them, in one place. The fields the server itself acts on are kept
// in their own setting keys (base_currency, period_lock, rate_convention, approval_policy, segregation);
// everything else is kept together under 'workspace'. Each field is checked, and saving needs the right permission.
import { z } from 'zod';
import { HttpError, forbid, can } from './rbac.js';
import { requireAuth } from './auth.js';
import { audit } from './audit.js';
import { tx } from './db.js';
import { findRole } from './roles.js';
import { DEFAULT_POLICY } from './leases.js';

const ccy = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max = 200) => z.string().max(max);
const amount = z.number().finite();
const tier = z.object({
    upTo: z.union([z.number().nonnegative(), z.null(), z.literal('')]).transform(v => v === '' ? null : v),
    approvals: z.number().int().min(1).max(5),
    roles: z.array(text(60)).min(1).max(50),
}).strict();

/** Every field the web app may save, with its type. Unknown fields are refused. */
export const FIELDS = {
    entity: text(), functionalCurrency: ccy, fyEndMonth: z.number().int().min(1).max(12),
    rateConvention: z.enum(['effective', 'nominal']), majorPartPct: amount.min(0).max(100), substantiallyAllPct: amount.min(0).max(100),
    lowValueThreshold: amount.min(0), lowValueCurrency: ccy, requireApproval: z.boolean(), segregateApproval: z.boolean(),
    interestCashFlow: z.enum(['financing', 'operating']), numberGrouping: z.enum(['international', 'south-asian']),
    displayUnit: z.union([z.literal(1), z.literal(1000), z.literal(1000000)]),
    fx: z.record(ccy, z.number().positive()), accounts: z.record(text(40), text()).refine(o => Object.keys(o).length <= 100),
    presentationCurrency: z.union([ccy, z.literal('')]), lockedThrough: z.union([date, z.literal('')]),
    defaultRate: z.union([amount.min(0).max(100), z.literal('')]),
    approvalPolicy: z.record(z.enum(['lease', 'change', 'batch', 'export', 'draft']), z.array(tier).min(1).max(10)),
    bankAccounts: z.array(z.object({ name: text(), bank: text(), iban: text(40), swift: text(20), currency: ccy, gl: text(), account: text(60).optional() }).strict()).max(50),
    erp: z.object({ target: text(40), company: text(40), docType: text(40), journal: text(40), batch: text(40), ledger: text(40), group: text(40) }).strict(),
    retention: z.object({ auditYears: z.number().int().min(1).max(100), idleMinutes: z.number().int().min(0).max(1440) }).strict(),
    exitPenaltyMonths: amount.min(0).max(120), lastBackup: text(40), lastBackupBy: text(),
};
// Who may change what: most fields need admin.settings; a few belong to other duties.
const PERM_FOR = { erp: ['gl.export'], retention: ['admin.data'], lastBackup: ['admin.data'], lastBackupBy: ['admin.data'] };
const mayChange = (user, field) => can(user, 'admin.settings') || (PERM_FOR[field] || []).some(p => can(user, p));

// Fields kept in the keys the server acts on, and how each maps
const TYPED = {
    functionalCurrency: ['base_currency', v => ({ currency: v }), s => s.currency],
    lockedThrough: ['period_lock', v => ({ lockedThrough: v || null }), s => s.lockedThrough || ''],
    rateConvention: ['rate_convention', v => ({ convention: v }), s => s.convention],
    approvalPolicy: ['approval_policy', v => v, s => s],
    segregateApproval: ['segregation', v => ({ makerCannotCheck: v }), s => s.makerCannotCheck],
};

export async function readSettings(db, companyId) {
    const rows = Object.fromEntries((await db.query('SELECT key, value FROM settings WHERE company_id=$1', [companyId])).rows.map(r => [r.key, r.value]));
    const out = { ...(rows.workspace || {}) };
    for (const [field, [key, , read]] of Object.entries(TYPED)) if (rows[key] !== undefined) out[field] = read(rows[key]);
    if (out.approvalPolicy === undefined) out.approvalPolicy = DEFAULT_POLICY;
    return out;
}
// Approvers must hold the permission for the item (AI-drafted disclosures: approve or ai.approve)
async function checkPolicy(db, companyId, policy) {
    for (const [type, tiers] of Object.entries(policy)) for (const id of new Set(tiers.flatMap(t => t.roles))) {
        const r = await findRole(db, companyId, id);
        if (!r) throw new HttpError(400, `There is no role "${id}".`, 'bad_role');
        const ok = r.perms.includes('approve') || (type === 'draft' && r.perms.includes('ai.approve'));
        if (!ok) throw new HttpError(400, `A role in the ${type} approval tiers cannot approve.`, 'bad_role');
    }
}

export function companySettingsRoutes(app, cfg) {
    app.get('/api/company-settings', { preHandler: requireAuth(cfg, 'lease.view') }, async (req) => readSettings(app.pg, req.user.company_id));

    // Only the fields sent change, so two people saving different sections do not undo each other
    app.patch('/api/company-settings', { preHandler: requireAuth(cfg, null) }, async (req) => {
        const b = z.object(Object.fromEntries(Object.entries(FIELDS).map(([k, s]) => [k, s.optional()]))).strict().parse(req.body);
        const fields = Object.keys(b);
        if (!fields.length) return readSettings(app.pg, req.user.company_id);
        const denied = fields.filter(f => !mayChange(req.user, f));
        if (denied.length) throw forbid(`Your role cannot change: ${denied.join(', ')}.`);
        const cid = req.user.company_id;
        await tx(app.pg, async c => {
            await c.query('SELECT pg_advisory_xact_lock(726013, hashtext($1::text))', [cid]); // one settings save per company at a time
            if (b.approvalPolicy) await checkPolicy(c, cid, b.approvalPolicy);
            const before = await readSettings(c, cid);
            const put = (key, value) => c.query('INSERT INTO settings(company_id,key,value,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id,key) DO UPDATE SET value=$3, updated_at=now(), updated_by=$4', [cid, key, JSON.stringify(value), req.user.id]);
            const rest = {};
            for (const f of fields) if (TYPED[f]) await put(TYPED[f][0], TYPED[f][1](b[f])); else rest[f] = b[f];
            if (Object.keys(rest).length) {
                const ws = (await c.query("SELECT value FROM settings WHERE company_id=$1 AND key='workspace'", [cid])).rows[0]?.value || {};
                await put('workspace', { ...ws, ...rest });
            }
            const changed = fields.filter(f => JSON.stringify(before[f]) !== JSON.stringify(b[f]));
            if (changed.length) await audit(c, { user: req.user, action: 'settings.update', objectType: 'setting', objectId: changed.join(','), detail: { before: Object.fromEntries(changed.map(f => [f, before[f] ?? null])), after: Object.fromEntries(changed.map(f => [f, b[f]])) }, ip: req.ip });
        });
        return readSettings(app.pg, cid);
    });
}

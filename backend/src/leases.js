import { z } from 'zod';
import Engine from './engine/engine.js';
import { HttpError, forbid, can, entityFilter, assertEntity } from './rbac.js';
import { requireAuth } from './auth.js';
import { audit } from './audit.js';
import { tx } from './db.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const num = z.union([z.number(), z.literal('')]).optional();
const terms = z.object({
    commencement: date, termMonths: z.number().int().min(1).max(1200), payment: z.number().nonnegative(),
    freqM: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]), timing: z.enum(['advance', 'arrears']),
    rentFreeMonths: num, discountRate: num, rateBasis: z.enum(['IBR', 'implicit', 'solve']).default('IBR'),
    escalation: z.object({ type: z.enum(['none', 'fixed', 'index']), rate: num, everyM: num, indexBase: num }).default({ type: 'none' }),
    extension: z.object({ months: num, payment: num, certain: z.boolean().default(false) }).default({}),
    termination: z.object({ month: num, penalty: num, certain: z.boolean().default(false), notice: z.any().optional() }).default({}),
    purchase: z.object({ price: num, certain: z.boolean().default(false) }).default({}),
    rvg: num, fairValue: num, lessorIDC: num, urv: num, idc: num, incentives: num, prepaid: num, restoration: num, deposit: num,
    usefulLifeM: num, ownershipTransfer: z.boolean().default(false), exemption: z.enum(['none', 'short-term', 'low-value']).default('none'),
    serviceComponent: num, combine: z.boolean().default(true), variableNote: z.string().max(500).optional(),
    carryingAmount: num, dealer: z.boolean().default(false), classification: z.enum(['auto', 'finance', 'operating']).default('auto'),
    marketRate: num, specialised: z.boolean().default(false), underlyingRemainingLifeM: num,
    gracePeriodDays: num, lateType: z.enum(['none', 'interest', 'fine', 'both']).optional(), lateRate: num, fineRate: num, partialRule: z.string().max(40).optional()
}).passthrough();
const ASSET_CLASSES = ['building', 'warehouse', 'retail', 'land', 'vehicle', 'equipment', 'it', 'other'];
const leaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-]{1,39}$/, 'Lease ID: 2-40 letters, digits, dot, dash or underscore');
// Complete enough to measure: checked when a lease is submitted, activated or imported as live
const leaseBody = z.object({
    id: leaseId, entityId: z.string().uuid(), role: z.enum(['lessee', 'lessor']),
    name: z.string().min(1).max(200), counterparty: z.string().min(1).max(200), contractNumber: z.string().max(80).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/), assetClass: z.enum(ASSET_CLASSES),
    location: z.string().max(120).optional(), area: num, areaUnit: z.string().max(20).optional(), costCentre: z.string().max(40).optional(), notes: z.string().max(4000).optional(),
    terms
});
// A draft may be incomplete; what is there must still have the right type
const text = max => z.string().max(max);
const blankable = s => z.union([s, z.literal('')]).optional();
const draftTerms = terms.partial().extend({ commencement: blankable(date), termMonths: blankable(z.number().int().min(1).max(1200)), payment: blankable(z.number().nonnegative()) }).passthrough();
const documentSchema = z.object({ name: text(300), addedAt: text(40), text: text(500000), hits: z.array(z.any()).max(5000).default([]), fields: z.record(z.any()).default({}) }).passthrough();
const bankSchema = z.object({ iban: text(40), account: text(60), bankName: text(200), swift: text(20) });
const draftBody = z.object({
    id: leaseId, entityId: z.string().uuid(), role: z.enum(['lessee', 'lessor']),
    name: text(200).default(''), counterparty: text(200).default(''), contractNumber: text(80).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/), assetClass: z.enum(ASSET_CLASSES).default('other'),
    location: text(120).optional(), area: num, areaUnit: text(20).optional(), costCentre: text(40).optional(), notes: text(4000).optional(),
    terms: draftTerms, documents: z.array(documentSchema).max(50).optional(), bank: bankSchema.optional(), parentId: text(40).optional(), createdAt: text(40).optional(),
});
/** Fields that describe a lease without changing its measurement: editable at any stage. */
const DETAIL_FIELDS = ['name', 'counterparty', 'contractNumber', 'assetClass', 'location', 'area', 'areaUnit', 'costCentre', 'notes', 'documents', 'bank', 'parentId'];
const EVENT_TYPES = Object.keys(Engine.EVENT_TYPES);

export async function getSetting(db, companyId, key, dflt) { const r = (await db.query('SELECT value FROM settings WHERE company_id=$1 AND key=$2', [companyId, key])).rows[0]; return r ? r.value : dflt; }
const workspace = (db, companyId) => getSetting(db, companyId, 'workspace', {});
export const DEFAULT_POLICY = {
    lease: [{ upTo: 100000000, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }, { upTo: null, approvals: 2, roles: ['controller', 'admin', 'superadmin'] }],
    change: [{ upTo: 25000000, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }, { upTo: null, approvals: 2, roles: ['controller', 'admin', 'superadmin'] }],
    batch: [{ upTo: 10000000, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }, { upTo: null, approvals: 2, roles: ['controller', 'admin', 'superadmin'] }],
    export: [{ upTo: null, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }],
    draft: [{ upTo: null, approvals: 1, roles: ['controller', 'admin', 'superadmin'] }]
};
// Units of the base currency per unit of ccy: the latest dated rate on or before the date, else the company's current rate
export async function rateToBase(db, companyId, ccy, onDate) {
    const base = (await getSetting(db, companyId, 'base_currency', { currency: 'PKR' })).currency;
    if (ccy === base) return 1;
    const r = (await db.query('SELECT rate FROM fx_rates WHERE company_id=$1 AND currency=$2 AND rate_date<=$3 ORDER BY rate_date DESC LIMIT 1', [companyId, ccy, onDate])).rows[0];
    if (r) return r.rate;
    const current = Number(((await workspace(db, companyId)).fx || {})[ccy]);
    if (current > 0) return current;
    throw new HttpError(409, `No exchange rate for ${ccy} on or before ${onDate}. Add it before approving.`, 'fx_missing');
}
export async function periodLockCheck(db, user, d, what) {
    const lock = (await getSetting(db, user.company_id, 'period_lock', { lockedThrough: null })).lockedThrough;
    if (lock && d <= lock && !can(user, 'period.override')) throw new HttpError(409, `${what} dated ${d} falls in a closed period (locked to ${lock}).`, 'period_locked');
    return lock && d <= lock; // true = override used
}
// Shape a stored lease for the engine: only approved events count
export function engineLease(row, events) {
    return { id: row.id, role: row.role, terms: row.data.terms, events: events.filter(e => e.status === 'approved').map(e => ({ ...e.params, id: e.id, type: e.type, effective: e.effective, status: 'approved' })) };
}
export async function loadLease(db, user, id) {
    const row = (await db.query('SELECT * FROM leases WHERE company_id=$1 AND id=$2', [user.company_id, id])).rows[0];
    if (!row) throw new HttpError(404, 'Not found', 'not_found');
    assertEntity(user, row.entity_id);
    const events = (await db.query('SELECT * FROM lease_events WHERE company_id=$1 AND lease_id=$2 ORDER BY effective, submitted_at', [user.company_id, id])).rows;
    return { row, events };
}
export async function engineSettings(db, companyId) {
    const ws = await workspace(db, companyId);
    return { rateConvention: (await getSetting(db, companyId, 'rate_convention', { convention: 'effective' })).convention, majorPartPct: Number(ws.majorPartPct) || 75, substantiallyAllPct: Number(ws.substantiallyAllPct) || 90 };
}
/** Whether new leases and changes wait for approval (Settings › Controls; on unless switched off). */
const approvalRequired = async (db, companyId) => (await workspace(db, companyId)).requireApproval !== false;
export const money = n => Math.round(n).toLocaleString('en-US');
const label = type => (Engine.EVENT_TYPES[type] || { label: type }).label;

/** Add an entry to the lease's history (shown on the lease page), written by the server. */
export async function addHistory(c, cid, id, user, text) {
    const entry = { at: new Date().toISOString(), actor: user.id, actorName: user.name, text };
    await c.query("UPDATE leases SET data = jsonb_set(data, '{history}', coalesce(data->'history', '[]'::jsonb) || $3::jsonb) WHERE company_id=$1 AND id=$2", [cid, id, JSON.stringify([entry])]);
}
/** A lease must be complete enough to measure before it is submitted, activated or imported as live. */
async function checkComplete(c, cid, id, entityId, role, data) {
    const r = leaseBody.safeParse({ ...data, id, entityId, role });
    if (!r.success) throw new HttpError(400, 'The lease is not complete: ' + r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), 'incomplete');
    Engine.run({ id, role, terms: data.terms, events: [] }, await engineSettings(c, cid)); // rejects terms the engine cannot measure
}
async function checkEntity(c, cid, entityId) {
    if (!(await c.query('SELECT 1 FROM entities WHERE company_id=$1 AND id=$2 AND active', [cid, entityId])).rowCount) throw new HttpError(400, 'Unknown entity', 'bad_entity');
}
const leaseData = b => { const { id, entityId, role, version, ...data } = b; return data; };
/** Remove a lease with its changes, payments and approvals (approvals are kept by item id, so a later lease with the same ID starts clean). */
async function dropLease(c, cid, id) {
    await c.query(`DELETE FROM approvals WHERE company_id=$1 AND ((item_type='lease' AND item_id=$2) OR (item_type='change' AND item_id IN (SELECT id::text FROM lease_events WHERE company_id=$1 AND lease_id=$2)))`, [cid, id]);
    await c.query('DELETE FROM leases WHERE company_id=$1 AND id=$2', [cid, id]);
}

/* ---- Leases as the web app holds them: the lease with its events, payments, approvals and history ---- */
const EVENT_META = new Set(['id', 'type', 'effective', 'status', 'reason', 'submittedBy', 'submittedByName', 'submittedOn', 'approvedBy', 'approvedByName', 'approvedOn', 'rejectedBy', 'rejectedByName', 'approvals']);
const eventParams = e => Object.fromEntries(Object.entries(e).filter(([k, v]) => !EVENT_META.has(k) && (v === null || ['number', 'string', 'boolean'].includes(typeof v))));
export async function clientLeases(db, user, ids = null) {
    const cid = user.company_id, f = entityFilter(user);
    const rows = (await db.query('SELECT * FROM leases WHERE company_id=$1 AND ($2::uuid[] IS NULL OR entity_id = ANY($2)) AND ($3::text[] IS NULL OR id = ANY($3)) ORDER BY id', [cid, f, ids])).rows;
    if (!rows.length) return [];
    const leaseIds = rows.map(r => r.id);
    const names = new Map((await db.query('SELECT id, name FROM users WHERE company_id=$1', [cid])).rows.map(u => [u.id, u.name]));
    const events = (await db.query('SELECT * FROM lease_events WHERE company_id=$1 AND lease_id = ANY($2) ORDER BY effective, submitted_at', [cid, leaseIds])).rows;
    const payments = (await db.query('SELECT * FROM payments WHERE company_id=$1 AND lease_id = ANY($2) ORDER BY paid_date, created_at', [cid, leaseIds])).rows;
    const approvals = (await db.query(`SELECT * FROM approvals WHERE company_id=$1 AND decision='approve' AND ((item_type='lease' AND item_id = ANY($2)) OR (item_type='change' AND item_id = ANY($3))) ORDER BY at`,
        [cid, leaseIds, events.map(e => e.id)])).rows;
    const approval = a => ({ by: a.user_id, name: names.get(a.user_id) || '', role: a.role, at: a.at.toISOString() });
    const day = t => t ? new Date(t).toISOString().slice(0, 10) : undefined;
    return rows.map(r => ({
        ...r.data, id: r.id, entityId: r.entity_id, role: r.role, status: r.status, version: r.version,
        createdAt: r.data.createdAt || day(r.created_at), updatedAt: r.updated_at.toISOString(), history: r.data.history || [],
        approvals: approvals.filter(a => a.item_type === 'lease' && a.item_id === r.id && a.item_version === r.version).map(approval),
        events: events.filter(e => e.lease_id === r.id).map(e => ({
            ...e.params, id: e.id, type: e.type, effective: e.effective, status: e.status, reason: e.reason,
            submittedBy: e.submitted_by, submittedByName: names.get(e.submitted_by) || '', submittedOn: day(e.submitted_at),
            ...(e.status === 'approved' ? { approvedBy: e.decided_by, approvedByName: names.get(e.decided_by) || '', approvedOn: day(e.decided_at) } : {}),
            ...(e.status === 'rejected' ? { rejectedBy: e.decided_by, rejectedByName: names.get(e.decided_by) || '' } : {}),
            approvals: approvals.filter(a => a.item_type === 'change' && a.item_id === e.id).map(approval),
        })),
        payments: payments.filter(p => p.lease_id === r.id).map(p => ({
            id: p.id, kind: p.kind, dueDate: p.due_date || p.paid_date, amount: p.amount, paidDate: p.paid_date,
            ...(p.for_type ? { forType: p.for_type } : {}), ...(p.reference ? { ref: p.reference } : {}), ...(p.bank_line_id ? { bankLineId: p.bank_line_id } : {}),
        })),
    }));
}

// Server-side approval rule: distinct approvers, none the maker, role per tier, limit >= amount (AI drafts: approve or ai.approve)
export async function decide(c, user, { itemType, itemId, version, makerId, amount }) {
    const pol = (await getSetting(c, user.company_id, 'approval_policy', DEFAULT_POLICY))[itemType] || DEFAULT_POLICY[itemType];
    const tier = pol.find(t => t.upTo === null || amount <= t.upTo) || pol[pol.length - 1];
    const seg = (await getSetting(c, user.company_id, 'segregation', { makerCannotCheck: true })).makerCannotCheck;
    if (!(can(user, 'approve') || (itemType === 'draft' && can(user, 'ai.approve')))) throw forbid();
    if (!tier.roles.includes(user.role)) throw forbid(`This amount needs approval by: ${tier.roles.join(', ')}.`);
    if (seg && makerId === user.id) throw forbid('You prepared this item. A different person must approve it.');
    if (user.approval_limit !== null && user.approval_limit !== undefined && amount > Number(user.approval_limit)) throw forbid(`The amount exceeds your approval limit.`);
    const prior = (await c.query("SELECT user_id FROM approvals WHERE company_id=$4 AND item_type=$1 AND item_id=$2 AND item_version IS NOT DISTINCT FROM $3 AND decision='approve'", [itemType, itemId, version, user.company_id])).rows;
    if (prior.some(p => p.user_id === user.id)) throw new HttpError(409, 'You have already approved this item.', 'already_approved');
    await c.query('INSERT INTO approvals(company_id,item_type,item_id,item_version,user_id,role,amount,decision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [user.company_id, itemType, itemId, version, user.id, user.role, amount, 'approve']);
    return { done: prior.length + 1 >= tier.approvals, given: prior.length + 1, needed: tier.approvals };
}
/** Size of a lease in the base currency, as approval tiers measure it. */
async function leaseAmount(c, row) {
    const res = Engine.run(engineLease(row, []), await engineSettings(c, row.company_id));
    const value = res.mode === 'lessee' ? res.initial.liability : res.mode === 'lessor-finance' ? res.initial.netInvestment : res.initial.total;
    return Math.abs(value) * await rateToBase(c, row.company_id, row.data.currency, row.data.terms.commencement);
}
/** Size of a change in the base currency, with the change counted as approved. */
async function eventAmount(c, row, events, e) {
    const res = Engine.run(engineLease(row, events.map(x => x.id === e.id ? { ...x, status: 'approved' } : x)), await engineSettings(c, row.company_id));
    const m = res.events.find(x => x.id === e.id) || {};
    const size = Math.abs(m.adjustment || 0) + Math.abs((m.partial && m.partial.gain) || 0) + (e.type === 'terminate' ? Math.abs(m.before ? m.before.L : 0) : 0) + (e.type === 'impair' ? Number(e.params.amount || 0) : 0);
    return size * await rateToBase(c, row.company_id, row.data.currency, e.effective);
}

export function leaseRoutes(app, cfg) {
    const auth = p => ({ preHandler: requireAuth(cfg, p) });
    const full = q => q.full === '1' || q.full === 'true';

    app.get('/api/leases', auth('lease.view'), async (req) => {
        if (full(req.query)) return clientLeases(app.pg, req.user);
        const asOf = date.optional().parse(req.query.asOf) || new Date().toISOString().slice(0, 10);
        const cid = req.user.company_id, f = entityFilter(req.user), S = await engineSettings(app.pg, cid);
        const rows = (await app.pg.query('SELECT * FROM leases WHERE company_id=$1 AND ($2::uuid[] IS NULL OR entity_id = ANY($2)) ORDER BY id', [cid, f])).rows;
        const evs = (await app.pg.query('SELECT * FROM lease_events WHERE company_id=$1 AND lease_id = ANY($2)', [cid, rows.map(r => r.id)])).rows;
        return rows.map(r => {
            let bal = null, mode = null;
            try { const res = Engine.run(engineLease(r, evs.filter(e => e.lease_id === r.id)), S); const b = Engine.balanceAt(res, asOf); bal = { liability: b.L, rou: b.A }; mode = res.mode; } catch (e) { /* drafts may not be measurable yet */ }
            return { id: r.id, entityId: r.entity_id, role: r.role, status: r.status, version: r.version, name: r.data.name, counterparty: r.data.counterparty, currency: r.data.currency, assetClass: r.data.assetClass, commencement: r.data.terms.commencement, mode, balances: bal, pendingEvents: evs.filter(e => e.lease_id === r.id && e.status === 'pending').length };
        });
    });
    app.get('/api/leases/:id', auth('lease.view'), async (req) => {
        const { row, events } = await loadLease(app.pg, req.user, req.params.id);
        if (full(req.query)) return (await clientLeases(app.pg, req.user, [row.id]))[0];
        const res = Engine.run(engineLease(row, events), await engineSettings(app.pg, row.company_id));
        const payments = (await app.pg.query('SELECT * FROM payments WHERE company_id=$1 AND lease_id=$2 ORDER BY paid_date', [row.company_id, row.id])).rows;
        const approvals = (await app.pg.query('SELECT a.*, u.name FROM approvals a JOIN users u ON u.id=a.user_id WHERE a.company_id=$5 AND ((item_type=$1 AND item_id=$2) OR (item_type=$3 AND item_id = ANY($4))) ORDER BY at', ['lease', row.id, 'change', events.map(e => e.id), row.company_id])).rows;
        return { lease: { ...row.data, id: row.id, entityId: row.entity_id, role: row.role, status: row.status, version: row.version }, events, payments, approvals, measurement: { mode: res.mode, initial: res.initial, termMonths: res.termMonths, events: res.events } };
    });
    app.get('/api/leases/:id/schedule', auth('lease.view'), async (req) => {
        const { row, events } = await loadLease(app.pg, req.user, req.params.id);
        const res = Engine.run(engineLease(row, events), await engineSettings(app.pg, row.company_id));
        const by = z.enum(['month', 'year']).default('month').parse(req.query.by);
        return { currency: row.data.currency, mode: res.mode, rows: by === 'month' ? res.rows : Engine.aggregate(res, r => Math.floor(r.t / 12)) };
    });
    app.get('/api/leases/:id/history', auth('lease.view'), async (req) => {
        await loadLease(app.pg, req.user, req.params.id);
        return (await app.pg.query('SELECT v.version, v.status, v.changed_at, v.reason, u.name AS changed_by FROM lease_versions v JOIN users u ON u.id=v.changed_by WHERE v.company_id=$1 AND v.lease_id=$2 ORDER BY version DESC', [req.user.company_id, req.params.id])).rows;
    });

    // New leases start as drafts, which may be incomplete; submitting checks them
    app.post('/api/leases', auth('lease.edit'), async (req) => {
        const b = draftBody.parse(req.body);
        assertEntity(req.user, b.entityId);
        const cid = req.user.company_id, data = { ...leaseData(b), history: [] };
        return tx(app.pg, async c => {
            if ((await c.query('SELECT 1 FROM leases WHERE company_id=$1 AND id=$2', [cid, b.id])).rowCount) throw new HttpError(409, 'That lease ID is already used.', 'duplicate');
            await checkEntity(c, cid, b.entityId);
            await c.query('INSERT INTO leases(company_id,id,entity_id,role,status,data,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [cid, b.id, b.entityId, b.role, 'draft', data, req.user.id]);
            await c.query('INSERT INTO lease_versions(company_id,lease_id,version,status,data,changed_by,reason) VALUES ($1,$2,1,$3,$4,$5,$6)', [cid, b.id, 'draft', data, req.user.id, 'Created']);
            await addHistory(c, cid, b.id, req.user, 'Saved as draft');
            await audit(c, { user: req.user, action: 'lease.create', objectType: 'lease', objectId: b.id, entityId: b.entityId, ip: req.ip });
            return { id: b.id, status: 'draft', version: 1 };
        });
    });
    // Measurement inputs change only before approval; a pending lease goes back to draft (its approvals lapse).
    // After activation, changes go through events (IFRS 16.39-46); descriptive details use PATCH .../details.
    app.put('/api/leases/:id', auth('lease.edit'), async (req) => {
        const b = draftBody.extend({ version: z.number().int() }).parse(req.body);
        if (b.id !== req.params.id) throw new HttpError(400, 'ID mismatch', 'bad_request');
        assertEntity(req.user, b.entityId);
        return tx(app.pg, async c => {
            const { row } = await loadLease(c, req.user, req.params.id);
            await c.query('SELECT 1 FROM leases WHERE company_id=$1 AND id=$2 FOR UPDATE', [row.company_id, row.id]);
            if (!['draft', 'rejected', 'pending'].includes(row.status)) throw new HttpError(409, 'Approved leases cannot be edited. Submit a remeasurement or modification instead.', 'locked');
            if (row.version !== b.version) throw new HttpError(409, 'Someone else changed this lease. Reload and try again.', 'version_conflict');
            await checkEntity(c, row.company_id, b.entityId);
            const data = { ...leaseData(b), history: row.data.history || [] };
            const v = row.version + 1;
            await c.query('UPDATE leases SET entity_id=$3, role=$4, data=$5, version=$6, status=$7, updated_by=$8, updated_at=now() WHERE company_id=$1 AND id=$2', [row.company_id, row.id, b.entityId, b.role, data, v, 'draft', req.user.id]);
            await c.query('INSERT INTO lease_versions(company_id,lease_id,version,status,data,changed_by,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [row.company_id, row.id, v, 'draft', data, req.user.id, 'Edited']);
            await addHistory(c, row.company_id, row.id, req.user, row.status === 'pending' ? 'Edited while awaiting approval; back to draft' : 'Edited');
            await audit(c, { user: req.user, action: 'lease.update', objectType: 'lease', objectId: row.id, entityId: b.entityId, detail: { version: v, wasStatus: row.status }, ip: req.ip });
            return { id: row.id, status: 'draft', version: v };
        });
    });
    // Descriptive details, at any stage: payee bank details belong to payment batches, documents to whoever imports contracts
    app.patch('/api/leases/:id/details', auth('lease.view'), async (req) => {
        const b = draftBody.pick(Object.fromEntries(DETAIL_FIELDS.map(k => [k, true]))).partial().strict().parse(req.body);
        const fields = Object.keys(b);
        const needs = f => f === 'bank' ? ['payment.batch', 'lease.edit'] : f === 'documents' ? ['lease.edit', 'lease.import'] : ['lease.edit'];
        const denied = fields.filter(f => !needs(f).some(p => can(req.user, p)));
        if (denied.length) throw forbid(`Your role cannot change: ${denied.join(', ')}.`);
        return tx(app.pg, async c => {
            const { row } = await loadLease(c, req.user, req.params.id);
            await c.query('SELECT 1 FROM leases WHERE company_id=$1 AND id=$2 FOR UPDATE', [row.company_id, row.id]);
            const changed = fields.filter(f => JSON.stringify(row.data[f] ?? null) !== JSON.stringify(b[f] ?? null));
            if (!changed.length) return { id: row.id, changed: [] };
            await c.query('UPDATE leases SET data = data || $3::jsonb, updated_by=$4, updated_at=now() WHERE company_id=$1 AND id=$2', [row.company_id, row.id, JSON.stringify(Object.fromEntries(changed.map(f => [f, b[f]]))), req.user.id]);
            const what = changed.map(f => f === 'bank' ? 'payee bank details' : f === 'documents' ? 'documents' : f).join(', ');
            await addHistory(c, row.company_id, row.id, req.user, `Details changed: ${what}`);
            await audit(c, { user: req.user, action: 'lease.details', objectType: 'lease', objectId: row.id, entityId: row.entity_id,
                detail: { before: Object.fromEntries(changed.map(f => [f, f === 'documents' ? (row.data.documents || []).map(d => d.name) : row.data[f] ?? null])), after: Object.fromEntries(changed.map(f => [f, f === 'documents' ? b.documents.map(d => d.name) : b[f]])) }, ip: req.ip });
            return { id: row.id, changed };
        });
    });
    // Submit for approval, or activate at once when the company does not require approval
    app.post('/api/leases/:id/submit', auth('lease.edit'), async (req) => tx(app.pg, async c => {
        const { row } = await loadLease(c, req.user, req.params.id);
        if (!['draft', 'rejected'].includes(row.status)) throw new HttpError(409, 'Only drafts can be submitted.', 'bad_state');
        await checkComplete(c, row.company_id, row.id, row.entity_id, row.role, row.data);
        if (!(await approvalRequired(c, row.company_id))) {
            const override = await periodLockCheck(c, req.user, row.data.terms.commencement, 'Lease commencement');
            await c.query("UPDATE leases SET status='active', submitted_by=$3, submitted_at=now() WHERE company_id=$1 AND id=$2", [row.company_id, row.id, req.user.id]);
            await addHistory(c, row.company_id, row.id, req.user, 'Created and activated (approval not required)');
            await audit(c, { user: req.user, action: 'lease.activated', objectType: 'lease', objectId: row.id, entityId: row.entity_id, detail: { version: row.version, approvalRequired: false, periodOverride: override }, ip: req.ip });
            return { status: 'active' };
        }
        await c.query("UPDATE leases SET status='pending', submitted_by=$3, submitted_at=now() WHERE company_id=$1 AND id=$2", [row.company_id, row.id, req.user.id]);
        await addHistory(c, row.company_id, row.id, req.user, 'Submitted for approval');
        await audit(c, { user: req.user, action: 'lease.submit', objectType: 'lease', objectId: row.id, entityId: row.entity_id, detail: { version: row.version }, ip: req.ip });
        return { status: 'pending' };
    }));
    app.post('/api/leases/:id/approve', auth('approve'), async (req) => tx(app.pg, async c => {
        const { row } = await loadLease(c, req.user, req.params.id);
        await c.query('SELECT 1 FROM leases WHERE company_id=$1 AND id=$2 FOR UPDATE', [row.company_id, row.id]); // serialise concurrent approvals
        if (row.status !== 'pending') throw new HttpError(409, 'This lease is not awaiting approval.', 'bad_state');
        const amount = await leaseAmount(c, row);
        const r = await decide(c, req.user, { itemType: 'lease', itemId: row.id, version: row.version, makerId: row.submitted_by, amount });
        const override = r.done ? await periodLockCheck(c, req.user, row.data.terms.commencement, 'Lease commencement') : false;
        if (r.done) await c.query("UPDATE leases SET status='active' WHERE company_id=$1 AND id=$2", [row.company_id, row.id]);
        const base = (await getSetting(c, row.company_id, 'base_currency', { currency: '' })).currency;
        await addHistory(c, row.company_id, row.id, req.user, r.done ? `Approved and activated (${money(amount)} ${base})` : `Approval ${r.given} of ${r.needed} given`);
        await audit(c, { user: req.user, action: r.done ? 'lease.approved' : 'lease.approval_given', objectType: 'lease', objectId: row.id, entityId: row.entity_id, detail: { version: row.version, amountBase: Math.round(amount), given: r.given, needed: r.needed, periodOverride: override }, ip: req.ip });
        return { status: r.done ? 'active' : 'pending', approvals: r.given, needed: r.needed };
    }));
    app.post('/api/leases/:id/reject', auth('approve'), async (req) => tx(app.pg, async c => {
        const { comment } = z.object({ comment: z.string().max(1000).default('') }).parse(req.body || {});
        const { row } = await loadLease(c, req.user, req.params.id);
        if (row.status !== 'pending') throw new HttpError(409, 'This lease is not awaiting approval.', 'bad_state');
        await c.query("UPDATE leases SET status='rejected' WHERE company_id=$1 AND id=$2", [row.company_id, row.id]);
        await c.query("DELETE FROM approvals WHERE company_id=$1 AND item_type='lease' AND item_id=$2 AND item_version=$3", [row.company_id, row.id, row.version]);
        await addHistory(c, row.company_id, row.id, req.user, comment ? `Rejected: ${comment}` : 'Rejected');
        await audit(c, { user: req.user, action: 'lease.rejected', objectType: 'lease', objectId: row.id, entityId: row.entity_id, detail: { comment }, ip: req.ip });
        return { status: 'rejected' };
    }));
    // Drafts and rejected leases; live ones only by someone who manages the company's data (retention, clean-up)
    app.delete('/api/leases/:id', auth('lease.delete'), async (req) => tx(app.pg, async c => {
        const { row } = await loadLease(c, req.user, req.params.id);
        if (!['draft', 'rejected'].includes(row.status) && !can(req.user, 'admin.data')) throw new HttpError(409, 'Only drafts and rejected leases can be deleted.', 'bad_state');
        await dropLease(c, row.company_id, row.id);
        await audit(c, { user: req.user, action: 'lease.delete', objectType: 'lease', objectId: row.id, entityId: row.entity_id, detail: { status: row.status, lastVersion: row.data }, ip: req.ip });
        return { ok: true };
    }));

    /* ---- Remeasurements, modifications, terminations ---- */
    app.post('/api/leases/:id/events', auth('lease.change'), async (req) => {
        const b = z.object({ type: z.enum(EVENT_TYPES), effective: date, reason: z.string().trim().min(1).max(1000), params: z.record(z.union([z.number(), z.string(), z.boolean(), z.null()])).default({}) }).parse(req.body);
        return tx(app.pg, async c => {
            const { row, events } = await loadLease(c, req.user, req.params.id);
            if (row.status !== 'active') throw new HttpError(409, 'Only active leases can be remeasured or modified.', 'bad_state');
            const cid = row.company_id;
            // A separate-lease modification leaves this lease as it is: recorded at once; the new lease goes through approval itself
            if (b.type === 'mod-separate') {
                const { rows } = await c.query('INSERT INTO lease_events(company_id,lease_id,type,effective,params,reason,status,submitted_by,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,now()) RETURNING *', [cid, row.id, b.type, b.effective, b.params, b.reason, 'approved', req.user.id]);
                await addHistory(c, cid, row.id, req.user, `Separate lease opened for additional right of use: ${b.reason}`);
                await audit(c, { user: req.user, action: 'event.recorded', objectType: 'event', objectId: rows[0].id, entityId: row.entity_id, detail: { leaseId: row.id, type: b.type, effective: b.effective }, ip: req.ip });
                return { event: rows[0], status: 'approved' };
            }
            if (b.effective <= row.data.terms.commencement) throw new HttpError(400, 'The effective date must be after commencement.', 'bad_date');
            if (Engine.EVENT_TYPES[b.type].rate === 'revised' && !(Number(b.params.newRate) > 0)) throw new HttpError(400, 'This change needs a revised discount rate (newRate).', 'rate_required');
            const override = await periodLockCheck(c, req.user, b.effective, 'Change');
            const trial = engineLease(row, events.concat([{ id: 'trial', type: b.type, effective: b.effective, params: b.params, status: 'approved' }]));
            const res = Engine.run(trial, await engineSettings(c, cid));
            const ev = res.events.find(e => e.id === 'trial');
            if (!ev) throw new HttpError(400, 'The effective date is outside the lease term.', 'bad_date');
            const required = await approvalRequired(c, cid);
            const { rows } = await c.query('INSERT INTO lease_events(company_id,lease_id,type,effective,params,reason,status,submitted_by,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
                [cid, row.id, b.type, b.effective, b.params, b.reason, required ? 'pending' : 'approved', req.user.id, required ? null : req.user.id, required ? null : new Date()]);
            await addHistory(c, cid, row.id, req.user, `${label(b.type)} ${required ? 'submitted for approval' : 'applied'}, effective ${b.effective}: ${b.reason}`);
            await audit(c, { user: req.user, action: required ? 'event.submit' : 'event.applied', objectType: 'event', objectId: rows[0].id, entityId: row.entity_id, detail: { leaseId: row.id, type: b.type, effective: b.effective, params: b.params, preview: { before: ev.before, after: ev.after, adjustment: ev.adjustment ?? null }, ...(required ? {} : { approvalRequired: false, periodOverride: override }) }, ip: req.ip });
            return { event: rows[0], preview: ev, status: required ? 'pending' : 'approved' };
        });
    });
    app.post('/api/events/:id/:decision', auth('approve'), async (req) => {
        const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
        return tx(app.pg, async c => {
            const e = (await c.query('SELECT * FROM lease_events WHERE company_id=$1 AND id=$2 FOR UPDATE', [req.user.company_id, z.string().uuid().parse(req.params.id)])).rows[0];
            if (!e) throw new HttpError(404, 'Not found', 'not_found');
            const { row, events } = await loadLease(c, req.user, e.lease_id);
            if (e.status !== 'pending') throw new HttpError(409, 'This change is not awaiting approval.', 'bad_state');
            if (decision === 'reject') {
                const { comment } = z.object({ comment: z.string().max(1000).default('') }).parse(req.body || {});
                await c.query("UPDATE lease_events SET status='rejected', decided_at=now(), decided_by=$3 WHERE company_id=$1 AND id=$2", [e.company_id, e.id, req.user.id]);
                await addHistory(c, row.company_id, row.id, req.user, `Rejected: ${label(e.type)}${comment ? ` (${comment})` : ''}`);
                await audit(c, { user: req.user, action: 'event.rejected', objectType: 'event', objectId: e.id, entityId: row.entity_id, detail: { leaseId: row.id, comment }, ip: req.ip });
                return { status: 'rejected' };
            }
            const amount = await eventAmount(c, row, events, e);
            const r = await decide(c, req.user, { itemType: 'change', itemId: e.id, version: null, makerId: e.submitted_by, amount });
            const override = r.done ? await periodLockCheck(c, req.user, e.effective, 'Change') : false;
            if (r.done) await c.query("UPDATE lease_events SET status='approved', decided_at=now(), decided_by=$3 WHERE company_id=$1 AND id=$2", [e.company_id, e.id, req.user.id]);
            const base = (await getSetting(c, row.company_id, 'base_currency', { currency: '' })).currency;
            await addHistory(c, row.company_id, row.id, req.user, `${r.done ? 'Approved' : `Approval ${r.given} of ${r.needed} given`}: ${label(e.type)}, effective ${e.effective} (${money(amount)} ${base})`);
            await audit(c, { user: req.user, action: r.done ? 'event.approved' : 'event.approval_given', objectType: 'event', objectId: e.id, entityId: row.entity_id, detail: { leaseId: row.id, amountBase: Math.round(amount), given: r.given, needed: r.needed, periodOverride: override }, ip: req.ip });
            return { status: r.done ? 'approved' : 'pending', approvals: r.given, needed: r.needed };
        });
    });

    /* ---- Payments ---- */
    app.post('/api/leases/:id/payments', auth('payment.record'), async (req) => {
        const b = z.object({ kind: z.enum(['scheduled', 'variable']), dueDate: date.optional(), forType: z.string().max(40).optional(), amount: z.number().positive(), paidDate: date, reference: z.string().max(200).optional(), ref: z.string().max(200).optional() }).parse(req.body);
        const reference = b.reference ?? b.ref;
        return tx(app.pg, async c => {
            const { row } = await loadLease(c, req.user, req.params.id);
            if (row.status !== 'active') throw new HttpError(409, 'Payments can be recorded only on active leases.', 'bad_state');
            if (b.kind === 'scheduled' && !b.dueDate) throw new HttpError(400, 'Scheduled payments need the instalment due date.', 'bad_request');
            const override = await periodLockCheck(c, req.user, b.paidDate, 'Payment');
            const { rows } = await c.query('INSERT INTO payments(company_id,lease_id,kind,due_date,for_type,amount,paid_date,reference,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [row.company_id, row.id, b.kind, b.dueDate || null, b.forType || null, b.amount, b.paidDate, reference || null, req.user.id]);
            await addHistory(c, row.company_id, row.id, req.user, `${b.kind === 'variable' ? 'Variable payment' : row.role === 'lessor' ? 'Receipt' : 'Payment'} of ${money(b.amount)} recorded`);
            await audit(c, { user: req.user, action: 'payment.record', objectType: 'payment', objectId: rows[0].id, entityId: row.entity_id, detail: { leaseId: row.id, ...b, periodOverride: override }, ip: req.ip });
            return rows[0];
        });
    });

    /* ---- Bringing in leases as they are: sample portfolio, backups, data from a browser ---- */
    // Leases keep their status, approved changes and payments. Only someone who manages the company's data may do this.
    const importLease = draftBody.extend({
        status: z.enum(['draft', 'pending', 'active', 'rejected']),
        events: z.array(z.object({ type: z.enum(EVENT_TYPES), effective: date, status: z.enum(['pending', 'approved', 'rejected']), reason: z.string().max(1000).optional() }).passthrough()).max(500).default([]),
        payments: z.array(z.object({ kind: z.enum(['scheduled', 'variable']), dueDate: date.optional(), forType: z.string().max(40).optional(), amount: z.number().positive(), paidDate: date, ref: z.string().max(200).optional(), bankLineId: z.string().max(80).optional() }).passthrough()).max(5000).default([]),
        history: z.array(z.object({ at: text(40), actor: text(80).optional(), actorName: text(200).optional(), text: text(2000) }).passthrough()).max(2000).default([]),
    });
    // Checking only: a lease whose entity is not on the server yet (it will be added first) is checked without it
    const checkLease = importLease.extend({ entityId: z.string().uuid().optional() });
    const NO_ENTITY = '00000000-0000-0000-0000-000000000000';
    /** Check one lease and, unless only checking, bring it in. Problems are thrown as HttpError naming the lease. */
    async function importOne(c, user, raw, i, { replace, source, dry }) {
        const cid = user.company_id, name = `${raw && raw.id ? raw.id : `Lease ${i + 1}`}`;
        const parsed = (dry ? checkLease : importLease).safeParse(raw);
        if (!parsed.success) throw new HttpError(400, `${name}: ` + parsed.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; '), 'validation');
        const l = parsed.data;
        try {
            if (l.entityId) { assertEntity(user, l.entityId); await checkEntity(c, cid, l.entityId); }
            const { status, events, payments, history, ...rest } = l;
            const data = { ...leaseData(rest), history: history.concat([{ at: new Date().toISOString(), actor: user.id, actorName: user.name, text: `Imported (${source})` }]) };
            if (status !== 'draft') await checkComplete(c, cid, l.id, l.entityId || NO_ENTITY, l.role, data);
            if (status === 'active' && events.length) Engine.run(engineLease({ id: l.id, role: l.role, data }, events.map(e => ({ ...e, id: e.id || e.type, params: eventParams(e) }))), await engineSettings(c, cid));
            const exists = (await c.query('SELECT 1 FROM leases WHERE company_id=$1 AND id=$2', [cid, l.id])).rowCount > 0;
            if (dry) return exists ? 'existing' : 'ok';
            if (exists && !replace) return 'skipped';
            if (exists) await dropLease(c, cid, l.id);
            await c.query('INSERT INTO leases(company_id,id,entity_id,role,status,data,created_by,updated_by,submitted_by,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)', [cid, l.id, l.entityId, l.role, status, data, user.id, status === 'draft' ? null : user.id, status === 'draft' ? null : new Date()]);
            await c.query('INSERT INTO lease_versions(company_id,lease_id,version,status,data,changed_by,reason) VALUES ($1,$2,1,$3,$4,$5,$6)', [cid, l.id, status, data, user.id, `Imported (${source})`]);
            for (const e of events) await c.query('INSERT INTO lease_events(company_id,lease_id,type,effective,params,reason,status,submitted_by,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [cid, l.id, e.type, e.effective, eventParams(e), e.reason || 'Imported', e.status, user.id, e.status === 'pending' ? null : user.id, e.status === 'pending' ? null : new Date()]);
            for (const p of payments) await c.query('INSERT INTO payments(company_id,lease_id,kind,due_date,for_type,amount,paid_date,reference,bank_line_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [cid, l.id, p.kind, p.dueDate || null, p.forType || null, p.amount, p.paidDate, p.ref || null, p.bankLineId || null, user.id]);
            return exists ? 'replaced' : 'imported';
        } catch (e) {
            if (e instanceof HttpError) throw new HttpError(e.status, `${name}: ${e.message}`, e.code);
            if (e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) throw e; // a database error, not a problem with the lease
            throw new HttpError(400, `${name}: the terms cannot be measured (${e.message})`, 'unmeasurable');
        }
    }
    // check: true reports, lease by lease, what would happen (new, already here, or the problem), and changes nothing
    app.post('/api/leases/import', auth('admin.data'), async (req) => {
        const b = z.object({ leases: z.array(z.any()).min(1).max(5000), replace: z.boolean().default(false), source: z.string().trim().min(1).max(200), check: z.boolean().default(false) }).strict().parse(req.body);
        if (b.check) {
            const out = { ok: [], existing: [], problems: [] };
            for (const [i, raw] of b.leases.entries()) {
                try { out[await importOne(app.pg, req.user, raw, i, { ...b, dry: true }) === 'existing' ? 'existing' : 'ok'].push(raw.id); }
                catch (e) { if (!(e instanceof HttpError)) throw e; out.problems.push({ id: raw && raw.id ? String(raw.id) : `#${i + 1}`, code: e.code, message: e.message }); }
            }
            return out;
        }
        const imported = [], skipped = [];
        await tx(app.pg, async c => {
            for (const [i, raw] of b.leases.entries()) {
                const r = await importOne(c, req.user, raw, i, { ...b, dry: false });
                if (r === 'skipped') { skipped.push(raw.id); continue; }
                await audit(c, { user: req.user, action: 'lease.import', objectType: 'lease', objectId: raw.id, entityId: raw.entityId, detail: { source: b.source, status: raw.status, events: (raw.events || []).length, payments: (raw.payments || []).length, replaced: r === 'replaced' }, ip: req.ip });
                imported.push(raw.id);
            }
        });
        return { imported, skipped };
    });
}

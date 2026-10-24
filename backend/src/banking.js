// Bank statements and reconciliation, and payment batches (maker-checker, bank files).
// The web app reads the statement files and scores likely matches; the server keeps the statements,
// records the payment a match stands for, and checks every step (permissions, period lock, approvals).
import { z } from 'zod';
import Engine from './engine/engine.js';
import { HttpError, forbid, can } from './rbac.js';
import { requireAuth } from './auth.js';
import { audit } from './audit.js';
import { tx } from './db.js';
import { addHistory, decide, engineLease, engineSettings, getSetting, loadLease, money, periodLockCheck, rateToBase } from './leases.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ident = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const text = max => z.string().max(max);

/** The web app's fingerprint of a statement line (FNV-1a), used to spot lines imported before. */
export function lineHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
export function ibanValid(iban) {
    const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    if (s.startsWith('PK') && s.length !== 24) return false;
    const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let m = 0; for (const d of r) m = (m * 10 + Number(d)) % 97;
    return m === 1;
}
/** Someone holding any of the permissions. */
const anyOf = (cfg, perms) => async (req) => {
    await requireAuth(cfg, null)(req);
    if (!perms.some(p => can(req.user, p))) throw forbid();
};

/* ---- Statements as the web app holds them ---- */
export async function statements(db, cid, id = null) {
    const st = (await db.query('SELECT * FROM bank_statements WHERE company_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY imported_at', [cid, id])).rows;
    if (!st.length) return [];
    const lines = (await db.query('SELECT * FROM bank_lines WHERE company_id=$1 AND statement_id = ANY($2) ORDER BY pos', [cid, st.map(s => s.id)])).rows;
    return st.map(s => ({
        id: s.id, name: s.name, format: s.format, account: s.account, importedAt: s.imported_at.toISOString(), importedBy: s.imported_by,
        lines: lines.filter(l => l.statement_id === s.id).map(l => ({
            id: l.id, h: l.hash, date: l.line_date, amount: l.amount, ref: l.reference, desc: l.description, status: l.status, duplicate: l.duplicate,
            ...(l.suggest ? { suggest: l.suggest } : {}), ...(l.match ? { match: l.match } : {}),
        })),
    }));
}
async function lockLine(c, cid, id) {
    const l = (await c.query('SELECT * FROM bank_lines WHERE company_id=$1 AND id=$2 FOR UPDATE', [cid, id])).rows[0];
    if (!l) throw new HttpError(404, 'That bank line is not on the server.', 'not_found');
    return l;
}

/** Match one bank line to an instalment: records the payment, or links the bank line to one already recorded. */
async function matchLine(c, user, m, ip) {
    const cid = user.company_id, ln = await lockLine(c, cid, m.lineId);
    if (ln.duplicate) throw new HttpError(409, 'This line repeats one from an earlier statement.', 'duplicate_line');
    if (ln.status === 'matched') throw new HttpError(409, 'This bank line is already matched.', 'already_matched');
    const { row, events } = await loadLease(c, user, m.leaseId);
    await c.query('SELECT 1 FROM leases WHERE company_id=$1 AND id=$2 FOR UPDATE', [cid, row.id]);
    if (row.status !== 'active') throw new HttpError(409, 'Payments can be recorded only on active leases.', 'bad_state');
    const res = Engine.run(engineLease(row, events), await engineSettings(c, cid));
    const due = res.cashflows.find(f => f.date === m.dueDate && (f.type || '') === m.forType && f.amount > 0);
    if (!due) throw new HttpError(400, `${row.id} has no instalment due ${m.dueDate}.`, 'no_instalment');
    const override = await periodLockCheck(c, user, ln.line_date, 'Bank match');
    const amount = Math.round(Math.abs(ln.amount));
    const recs = (await c.query("SELECT * FROM payments WHERE company_id=$1 AND lease_id=$2 AND kind='scheduled' AND due_date=$3 ORDER BY paid_date, created_at", [cid, row.id, m.dueDate])).rows;
    let payment = null;
    if (!(await c.query('SELECT 1 FROM payments WHERE company_id=$1 AND lease_id=$2 AND bank_line_id=$3', [cid, row.id, ln.id])).rowCount) {
        const paid = recs.filter(p => !p.for_type || p.for_type === m.forType).reduce((s, p) => s + p.amount, 0);
        if (Math.round(due.amount) - paid <= 0.5) { // paid already: link the bank line to a payment not yet linked
            const p = recs.find(x => !x.bank_line_id);
            if (p) { await c.query('UPDATE payments SET bank_line_id=$3 WHERE company_id=$1 AND id=$2', [cid, p.id, ln.id]); payment = { id: p.id, linked: true }; }
        } else {
            const ref = `Bank: ${(ln.reference || ln.description).slice(0, 60)}`;
            const { rows } = await c.query('INSERT INTO payments(company_id,lease_id,kind,due_date,for_type,amount,paid_date,reference,bank_line_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
                [cid, row.id, 'scheduled', m.dueDate, m.forType || null, amount, ln.line_date, ref, ln.id, user.id]);
            payment = { id: rows[0].id, linked: false };
        }
        await addHistory(c, cid, row.id, user, `${m.auto ? 'Auto-reconciled' : 'Reconciled'} bank line ${ln.line_date} ${money(Math.abs(ln.amount))} to instalment due ${m.dueDate}`);
    }
    const match = { leaseId: row.id, dueDate: m.dueDate, key: `${row.id}|${m.dueDate}|${m.forType}`, by: user.id, auto: !!m.auto };
    await c.query("UPDATE bank_lines SET status='matched', match=$3, suggest=NULL WHERE company_id=$1 AND id=$2", [cid, ln.id, match]);
    await audit(c, { user, action: 'bank.match', objectType: 'bank_line', objectId: ln.id, entityId: row.entity_id, detail: { statementId: ln.statement_id, leaseId: row.id, dueDate: m.dueDate, amount: ln.amount, auto: !!m.auto, payment, periodOverride: override }, ip });
    return match;
}

/* ---- Payment batches as the web app holds them ---- */
export async function batches(db, cid, id = null) {
    const rows = (await db.query('SELECT * FROM payment_batches WHERE company_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY created_at', [cid, id])).rows;
    if (!rows.length) return [];
    const appr = (await db.query("SELECT a.*, u.name FROM approvals a JOIN users u ON u.id=a.user_id WHERE a.company_id=$1 AND a.item_type='batch' AND a.decision='approve' AND a.item_id = ANY($2) ORDER BY a.at", [cid, rows.map(r => r.id)])).rows;
    const names = new Map((await db.query('SELECT id, name FROM users WHERE company_id=$1', [cid])).rows.map(u => [u.id, u.name]));
    return rows.map(b => ({
        id: b.id, name: b.name, currency: b.currency, valueDate: b.value_date, account: b.account, createdAt: b.created_at.toISOString(), createdBy: b.created_by, createdByName: names.get(b.created_by) || '',
        status: b.status, lines: b.lines, total: b.total,
        approvals: appr.filter(a => a.item_id === b.id).map(a => ({ by: a.user_id, name: a.name, role: a.role, at: a.at.toISOString() })),
        ...(b.submitted_at ? { submittedAt: b.submitted_at.toISOString() } : {}), ...(b.released_at ? { releasedAt: b.released_at.toISOString() } : {}),
    }));
}
async function lockBatch(c, cid, id) {
    const b = (await c.query('SELECT * FROM payment_batches WHERE company_id=$1 AND id=$2 FOR UPDATE', [cid, id])).rows[0];
    if (!b) throw new HttpError(404, 'That batch is not on the server.', 'not_found');
    return b;
}

export function bankingRoutes(app, cfg) {
    const auth = p => ({ preHandler: requireAuth(cfg, p) });

    /* ---- Statements ---- */
    app.get('/api/bank/statements', { preHandler: anyOf(cfg, ['bank.reconcile', 'audit.view']) }, async (req) => statements(app.pg, req.user.company_id));

    // Lines are fingerprinted here; one seen in an earlier statement is kept but marked as a duplicate
    app.post('/api/bank/statements', auth('bank.reconcile'), async (req) => {
        const b = z.object({
            id: ident, name: z.string().trim().min(1).max(200), format: z.string().trim().min(1).max(40), account: text(200).default(''),
            lines: z.array(z.object({ id: ident, date, amount: z.number().finite(), ref: text(500).default(''), desc: text(2000).default('') }).passthrough()).min(1).max(1500),
        }).parse(req.body);
        if (new Set(b.lines.map(l => l.id)).size !== b.lines.length) throw new HttpError(400, 'Line ids repeat.', 'bad_request');
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            if ((await c.query('SELECT 1 FROM bank_statements WHERE company_id=$1 AND id=$2', [cid, b.id])).rowCount) throw new HttpError(409, 'That statement is already on the server.', 'duplicate');
            const hashes = b.lines.map(l => lineHash(`${l.date}|${l.amount}|${l.ref}|${l.desc}`));
            const seen = new Set((await c.query('SELECT hash FROM bank_lines WHERE company_id=$1 AND hash = ANY($2)', [cid, hashes])).rows.map(r => r.hash));
            await c.query('INSERT INTO bank_statements(company_id,id,name,format,account,imported_by) VALUES ($1,$2,$3,$4,$5,$6)', [cid, b.id, b.name, b.format, b.account, req.user.id]);
            for (const [i, l] of b.lines.entries())
                await c.query('INSERT INTO bank_lines(company_id,statement_id,id,pos,line_date,amount,reference,description,hash,duplicate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                    [cid, b.id, l.id, i, l.date, l.amount, l.ref, l.desc, hashes[i], seen.has(hashes[i])]);
            const dups = hashes.filter(h => seen.has(h)).length;
            await audit(c, { user: req.user, action: 'bank.import', objectType: 'bank_statement', objectId: b.id, detail: { name: b.name, format: b.format, account: b.account, lines: b.lines.length, duplicates: dups }, ip: req.ip });
            return (await statements(c, cid, b.id))[0];
        });
    });
    // Payments already recorded from the statement stay recorded
    app.delete('/api/bank/statements/:id', auth('bank.reconcile'), async (req) => tx(app.pg, async c => {
        const cid = req.user.company_id;
        const s = (await c.query('SELECT s.*, (SELECT count(*)::int FROM bank_lines l WHERE l.company_id=s.company_id AND l.statement_id=s.id AND l.status=$3) AS matched FROM bank_statements s WHERE s.company_id=$1 AND s.id=$2 FOR UPDATE', [cid, req.params.id, 'matched'])).rows[0];
        if (!s) throw new HttpError(404, 'That statement is not on the server.', 'not_found');
        await c.query('DELETE FROM bank_statements WHERE company_id=$1 AND id=$2', [cid, s.id]);
        await audit(c, { user: req.user, action: 'bank.delete', objectType: 'bank_statement', objectId: s.id, detail: { name: s.name, matched: s.matched }, ip: req.ip });
        return { ok: true };
    }));
    // Suggestions from the web app's scoring, and lines marked as not lease-related (matching has its own route)
    app.patch('/api/bank/statements/:id/lines', auth('bank.reconcile'), async (req) => {
        const b = z.object({ lines: z.array(z.object({ id: ident, status: z.enum(['unmatched', 'suggested', 'ignored']), suggest: z.object({ key: text(200), score: z.number() }).nullable().optional() })).min(1).max(1500) }).strict().parse(req.body);
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            const cur = new Map((await c.query('SELECT id, status FROM bank_lines WHERE company_id=$1 AND statement_id=$2 AND id = ANY($3) FOR UPDATE', [cid, req.params.id, b.lines.map(l => l.id)])).rows.map(r => [r.id, r.status]));
            const missing = b.lines.filter(l => !cur.has(l.id)), matched = b.lines.filter(l => cur.get(l.id) === 'matched');
            if (missing.length) throw new HttpError(404, 'Some lines are not in this statement.', 'not_found');
            if (matched.length) throw new HttpError(409, 'Unmatch a matched line before changing it.', 'already_matched');
            for (const l of b.lines) await c.query('UPDATE bank_lines SET status=$3, suggest=$4 WHERE company_id=$1 AND id=$2', [cid, l.id, l.status, l.status === 'suggested' ? l.suggest || null : null]);
            const ignored = b.lines.filter(l => l.status === 'ignored' && cur.get(l.id) !== 'ignored').map(l => l.id);
            if (ignored.length) await audit(c, { user: req.user, action: 'bank.ignore', objectType: 'bank_statement', objectId: req.params.id, detail: { lines: ignored }, ip: req.ip });
            return { updated: b.lines.length };
        });
    });
    // Each match in its own transaction, so one refused match does not undo the others
    app.post('/api/bank/match', auth('bank.reconcile'), async (req) => {
        const b = z.object({ matches: z.array(z.object({ lineId: ident, leaseId: z.string().min(1).max(40), dueDate: date, forType: text(40).default(''), auto: z.boolean().default(false) })).min(1).max(1500) }).strict().parse(req.body);
        const results = [];
        for (const m of b.matches) {
            try { results.push({ lineId: m.lineId, ok: true, match: await tx(app.pg, c => matchLine(c, req.user, m, req.ip)) }); }
            catch (e) { if (!(e instanceof HttpError)) throw e; results.push({ lineId: m.lineId, ok: false, error: e.code, message: e.message }); }
        }
        return { results };
    });
    // The payment recorded from the line stays; reverse it on the lease if it was wrong
    app.post('/api/bank/lines/:id/unmatch', auth('bank.reconcile'), async (req) => tx(app.pg, async c => {
        const ln = await lockLine(c, req.user.company_id, req.params.id);
        if (ln.status !== 'matched') throw new HttpError(409, 'This bank line is not matched.', 'bad_state');
        await c.query("UPDATE bank_lines SET status='unmatched', match=NULL WHERE company_id=$1 AND id=$2", [ln.company_id, ln.id]);
        await audit(c, { user: req.user, action: 'bank.unmatch', objectType: 'bank_line', objectId: ln.id, detail: { statementId: ln.statement_id, was: ln.match }, ip: req.ip });
        return { status: 'unmatched' };
    }));

    /* ---- Payment batches ---- */
    app.get('/api/batches', { preHandler: anyOf(cfg, ['payment.batch', 'approve', 'audit.view']) }, async (req) => batches(app.pg, req.user.company_id));

    app.post('/api/batches', auth('payment.batch'), async (req) => {
        const b = z.object({
            id: ident, name: z.string().trim().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/), valueDate: date, account: text(200).default(''),
            lines: z.array(z.object({ key: text(200), leaseId: z.string().min(1).max(40), dueDate: date, forType: text(40).default(''), amount: z.number().positive() })).min(1).max(5000),
        }).parse(req.body);
        const cid = req.user.company_id;
        return tx(app.pg, async c => {
            await c.query("SELECT pg_advisory_xact_lock(726013, hashtext($1::text))", [cid]); // a payment goes into one batch at a time
            if ((await c.query('SELECT 1 FROM payment_batches WHERE company_id=$1 AND id=$2', [cid, b.id])).rowCount) throw new HttpError(409, 'That batch is already on the server.', 'duplicate');
            const lines = b.lines.map(l => ({ key: `${l.leaseId}|${l.dueDate}|${l.forType}`, leaseId: l.leaseId, dueDate: l.dueDate, forType: l.forType, amount: Math.round(l.amount * 100) / 100 }));
            if (new Set(lines.map(l => l.key)).size !== lines.length) throw new HttpError(400, 'A payment appears twice in the batch.', 'bad_request');
            for (const id of new Set(lines.map(l => l.leaseId))) {
                const { row } = await loadLease(c, req.user, id);
                if (row.status !== 'active') throw new HttpError(409, `${id} is not active.`, 'bad_state');
                if (row.data.currency !== b.currency) throw new HttpError(400, `${id} is in ${row.data.currency}, not ${b.currency}. One batch per currency.`, 'bad_currency');
            }
            const taken = (await c.query("SELECT l->>'key' AS key FROM payment_batches, jsonb_array_elements(lines) l WHERE company_id=$1 AND status<>'rejected' AND l->>'key' = ANY($2)", [cid, lines.map(l => l.key)])).rows;
            if (taken.length) throw new HttpError(409, `Already in a batch: ${taken.map(t => t.key.split('|').slice(0, 2).join(' due ')).join(', ')}.`, 'in_batch');
            const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
            await c.query('INSERT INTO payment_batches(company_id,id,name,currency,value_date,account,lines,total,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [cid, b.id, b.name, b.currency, b.valueDate, b.account, JSON.stringify(lines), total, req.user.id]);
            await audit(c, { user: req.user, action: 'batch.create', objectType: 'batch', objectId: b.id, detail: { name: b.name, currency: b.currency, valueDate: b.valueDate, payments: lines.length, total }, ip: req.ip });
            return (await batches(c, cid, b.id))[0];
        });
    });
    app.delete('/api/batches/:id', auth('payment.batch'), async (req) => tx(app.pg, async c => {
        const b = await lockBatch(c, req.user.company_id, req.params.id);
        if (b.status !== 'draft') throw new HttpError(409, 'Only draft batches can be deleted.', 'bad_state');
        await c.query('DELETE FROM payment_batches WHERE company_id=$1 AND id=$2', [b.company_id, b.id]);
        await audit(c, { user: req.user, action: 'batch.delete', objectType: 'batch', objectId: b.id, detail: { name: b.name, total: b.total }, ip: req.ip });
        return { ok: true };
    }));
    // Every payee needs valid bank details before a batch goes for approval
    app.post('/api/batches/:id/submit', auth('payment.batch'), async (req) => tx(app.pg, async c => {
        const cid = req.user.company_id, b = await lockBatch(c, cid, req.params.id);
        if (b.status !== 'draft') throw new HttpError(409, 'Only draft batches can be submitted.', 'bad_state');
        const ids = [...new Set(b.lines.map(l => l.leaseId))];
        const banks = new Map((await c.query('SELECT id, data->\'bank\' AS bank FROM leases WHERE company_id=$1 AND id = ANY($2)', [cid, ids])).rows.map(r => [r.id, r.bank || {}]));
        const missing = ids.filter(id => { const bk = banks.get(id); return !bk || !(ibanValid(bk.iban) || bk.account); });
        if (missing.length) throw new HttpError(409, `Add valid bank details for ${missing.join(', ')} first.`, 'payee_details');
        await c.query("UPDATE payment_batches SET status='pending', submitted_at=now() WHERE company_id=$1 AND id=$2", [cid, b.id]);
        await audit(c, { user: req.user, action: 'batch.submit', objectType: 'batch', objectId: b.id, detail: { name: b.name, currency: b.currency, total: b.total }, ip: req.ip });
        return { status: 'pending' };
    }));
    // Approval tiers, limits and segregation as for leases; the size is the total in the base currency on the value date
    app.post('/api/batches/:id/approve', auth('approve'), async (req) => tx(app.pg, async c => {
        const cid = req.user.company_id, b = await lockBatch(c, cid, req.params.id);
        if (b.status !== 'pending') throw new HttpError(409, 'This batch is not awaiting approval.', 'bad_state');
        const amount = b.total * await rateToBase(c, cid, b.currency, b.value_date);
        const r = await decide(c, req.user, { itemType: 'batch', itemId: b.id, version: null, makerId: b.created_by, amount });
        if (r.done) await c.query("UPDATE payment_batches SET status='approved', decided_by=$3, decided_at=now() WHERE company_id=$1 AND id=$2", [cid, b.id, req.user.id]);
        const base = (await getSetting(c, cid, 'base_currency', { currency: '' })).currency;
        await audit(c, { user: req.user, action: r.done ? 'batch.approved' : 'batch.approval_given', objectType: 'batch', objectId: b.id, detail: { name: b.name, amountBase: Math.round(amount), base, given: r.given, needed: r.needed }, ip: req.ip });
        return { status: r.done ? 'approved' : 'pending', approvals: r.given, needed: r.needed };
    }));
    app.post('/api/batches/:id/reject', auth('approve'), async (req) => tx(app.pg, async c => {
        const { comment } = z.object({ comment: z.string().max(1000).default('') }).parse(req.body || {});
        const cid = req.user.company_id, b = await lockBatch(c, cid, req.params.id);
        if (b.status !== 'pending') throw new HttpError(409, 'This batch is not awaiting approval.', 'bad_state');
        await c.query("UPDATE payment_batches SET status='rejected', decided_by=$3, decided_at=now() WHERE company_id=$1 AND id=$2", [cid, b.id, req.user.id]);
        await c.query("DELETE FROM approvals WHERE company_id=$1 AND item_type='batch' AND item_id=$2", [cid, b.id]);
        await audit(c, { user: req.user, action: 'batch.rejected', objectType: 'batch', objectId: b.id, detail: { name: b.name, comment }, ip: req.ip });
        return { status: 'rejected' };
    }));
    // The bank file is made in the browser from the approved batch; the server records each release
    app.post('/api/batches/:id/release', { preHandler: anyOf(cfg, ['payment.batch', 'approve']) }, async (req) => tx(app.pg, async c => {
        const { format } = z.object({ format: z.enum(['xml', 'csv']).optional() }).parse(req.body || {});
        const cid = req.user.company_id, b = await lockBatch(c, cid, req.params.id);
        if (!['approved', 'released'].includes(b.status)) throw new HttpError(409, 'Only approved batches can be released to the bank.', 'bad_state');
        if (b.restored) throw new HttpError(409, 'This batch was restored from a backup and is kept as a record. Create a new batch to pay again.', 'restored');
        await c.query("UPDATE payment_batches SET status='released', released_by=$3, released_at=now() WHERE company_id=$1 AND id=$2", [cid, b.id, req.user.id]);
        await audit(c, { user: req.user, action: 'batch.release', objectType: 'batch', objectId: b.id, detail: { name: b.name, total: b.total, format: format || null, again: b.status === 'released' }, ip: req.ip });
        return { status: 'released' };
    }));
}

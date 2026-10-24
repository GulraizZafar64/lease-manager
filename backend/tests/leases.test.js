// Leases as the web app works with them: drafts, the full lease record, history, details, approval switched off, imports.
// Runs against a real PostgreSQL database (TEST_DATABASE_URL); the schema is rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hotp, timeStep } from '../src/security/totp.js';
import { verifyAuditChain } from '../src/audit.js';

const url = process.env.TEST_DATABASE_URL;
const H = { 'x-requested-with': 'lease-manager' };
let app;
const jar = {}, ids = {};
async function call(who, method, path, body) {
    const r = await app.inject({ method, url: path, payload: body, headers: { ...H, ...(jar[who] ? { cookie: jar[who] } : {}) } });
    const set = r.headers['set-cookie']; if (set) jar[who] = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
async function onboard(who, email, temp) {
    await call(who, 'POST', '/api/auth/login', { email, password: temp });
    const secret = (await call(who, 'POST', '/api/auth/mfa/setup')).body.secret;
    await call(who, 'POST', '/api/auth/mfa/verify', { code: hotp(secret, timeStep()) });
    assert.equal((await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Saffron-Ledger-Kappa-27' })).status, 200);
}
async function addUser(who, role) {
    const r = await call('boss', 'POST', '/api/users', { email: `${who}@kappa.test`, name: `User ${who}`, role }); assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[who] = r.body.user.id; await onboard(who, `${who}@kappa.test`, r.body.temporaryPassword);
}
const full = async (who, id) => (await call(who, 'GET', `/api/leases/${id}?full=1`)).body;
const lease = (id, over = {}) => ({ id, entityId: ids.ent, role: 'lessee', name: 'Office', counterparty: 'Landlord Ltd', currency: 'PKR', assetClass: 'building',
    terms: { commencement: '2025-01-01', termMonths: 60, payment: 100000, freqM: 1, timing: 'advance', discountRate: 12 }, ...over });

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 6).toString('base64'), cookieSecure: false, requireMfa: true }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.co = (await app.pg.query("INSERT INTO companies(code,name,base_currency) VALUES ('kappa','Kappa Foods','PKR') RETURNING id")).rows[0].id;
    await app.pg.query("INSERT INTO settings(company_id,key,value) VALUES ($1,'base_currency','{\"currency\":\"PKR\"}')", [ids.co]);
    ids.ent = (await app.pg.query("INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,'K01','Kappa Foods','PKR') RETURNING id", [ids.co])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@kappa.test','Boss','superadmin',$2)", [ids.co, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@kappa.test', 'Temp-Boss-Pass-001');
    for (const [k, role] of [['prep', 'preparer'], ['ctl', 'controller'], ['tre', 'treasury']]) await addUser(k, role);
});
test.after(async () => app && app.close());

test('drafts may be incomplete; submitting checks them', async () => {
    let r = await call('prep', 'POST', '/api/leases', { id: 'K-1', entityId: ids.ent, role: 'lessee', currency: 'PKR', terms: { commencement: '', termMonths: '', payment: '', freqM: 1, timing: 'advance' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('prep', 'POST', '/api/leases/K-1/submit'); assert.equal(r.status, 400); assert.equal(r.body.error, 'incomplete'); assert.match(r.body.message, /name|commencement/);
    r = await call('prep', 'PUT', '/api/leases/K-1', { ...lease('K-1'), version: 1 }); assert.equal(r.status, 200); assert.equal(r.body.version, 2);
    r = await call('prep', 'POST', '/api/leases/K-1/submit'); assert.equal(r.body.status, 'pending');
});

test('the full lease record: history written by the server; editing a pending lease sends it back to draft', async () => {
    let l = await full('prep', 'K-1');
    assert.equal(l.status, 'pending'); assert.equal(l.entityId, ids.ent); assert.equal(l.version, 2); assert.deepEqual(l.events, []); assert.deepEqual(l.payments, []);
    assert.deepEqual(l.history.map(h => h.text), ['Saved as draft', 'Edited', 'Submitted for approval']); assert.equal(l.history[0].actorName, 'User prep');
    let r = await call('prep', 'PUT', '/api/leases/K-1', { ...lease('K-1', { name: 'Office, floor 2' }), version: 2, history: [{ at: 'x', text: 'forged' }] });
    assert.equal(r.body.status, 'draft');
    l = await full('prep', 'K-1'); assert.equal(l.name, 'Office, floor 2'); assert.ok(!l.history.some(h => h.text === 'forged'), 'history comes from the server only');
    await call('prep', 'POST', '/api/leases/K-1/submit');
    r = await call('ctl', 'POST', '/api/leases/K-1/approve'); assert.equal(r.body.status, 'active');
    l = await full('ctl', 'K-1'); assert.equal(l.approvals.length, 1); assert.equal(l.approvals[0].name, 'User ctl'); assert.match(l.history.at(-1).text, /^Approved and activated \([\d,]+ PKR\)$/);
    r = await call('ctl', 'GET', '/api/leases?full=1'); assert.equal(r.body.length, 1); assert.equal(r.body[0].id, 'K-1');
});

test('details of a live lease: descriptive fields only, each with its permission', async () => {
    let r = await call('tre', 'PATCH', '/api/leases/K-1/details', { bank: { iban: 'PK36SCBL0000001123456702', account: '', bankName: 'Standard Chartered', swift: 'SCBLPKKA' } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.changed, ['bank']);
    r = await call('tre', 'PATCH', '/api/leases/K-1/details', { notes: 'x' }); assert.equal(r.status, 403);
    r = await call('prep', 'PATCH', '/api/leases/K-1/details', { notes: 'Renewal talks in 2029', documents: [{ name: 'lease.pdf', addedAt: '2025-01-02', text: 'Lease agreement…', hits: [], fields: {} }] }); assert.equal(r.status, 200);
    r = await call('prep', 'PATCH', '/api/leases/K-1/details', { terms: { payment: 1 } }); assert.equal(r.status, 400, 'measurement inputs are not details');
    r = await call('prep', 'PUT', '/api/leases/K-1', { ...lease('K-1'), version: 3 }); assert.equal(r.status, 409);
    const l = await full('ctl', 'K-1'); assert.equal(l.notes, 'Renewal talks in 2029'); assert.equal(l.bank.bankName, 'Standard Chartered'); assert.equal(l.documents[0].name, 'lease.pdf'); assert.equal(l.terms.payment, 100000);
});

test('changes and payments appear in the lease record', async () => {
    let r = await call('prep', 'POST', '/api/leases/K-1/events', { type: 'reassess-index', effective: '2026-01-01', reason: 'CPI', params: { newPayment: 110000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'pending'); const ev = r.body.event.id;
    r = await call('ctl', 'POST', `/api/events/${ev}/approve`); assert.equal(r.body.status, 'approved');
    r = await call('tre', 'POST', '/api/leases/K-1/payments', { kind: 'scheduled', dueDate: '2025-01-01', amount: 100000, paidDate: '2025-01-03', ref: 'TRX-1' }); assert.equal(r.status, 200);
    r = await call('prep', 'POST', '/api/leases/K-1/events', { type: 'mod-separate', effective: '2026-03-01', reason: 'Extra floor', params: {} }); assert.equal(r.body.status, 'approved', 'a separate lease leaves this one unchanged');
    const l = await full('prep', 'K-1');
    const e = l.events.find(x => x.id === ev);
    assert.equal(e.status, 'approved'); assert.equal(e.newPayment, 110000); assert.equal(e.approvedByName, 'User ctl'); assert.equal(e.submittedByName, 'User prep'); assert.equal(e.approvals.length, 1);
    assert.deepEqual(l.payments.map(p => [p.kind, p.dueDate, p.amount, p.paidDate, p.ref]), [['scheduled', '2025-01-01', 100000, '2025-01-03', 'TRX-1']]);
    assert.ok(l.history.some(h => /Payment of 100,000 recorded/.test(h.text)));
    assert.ok(l.history.some(h => /Approved: Reassessment|Approved: .*index/i.test(h.text)), l.history.map(h => h.text).join(' | '));
});

test('with approval switched off, leases activate on submit and changes apply at once', async () => {
    await call('boss', 'PATCH', '/api/company-settings', { requireApproval: false });
    let r = await call('prep', 'POST', '/api/leases', lease('K-2')); assert.equal(r.status, 200);
    r = await call('prep', 'POST', '/api/leases/K-2/submit'); assert.equal(r.body.status, 'active');
    r = await call('prep', 'POST', '/api/leases/K-2/events', { type: 'terminate', effective: '2027-01-01', reason: 'Early exit', params: { penalty: 50000 } }); assert.equal(r.body.status, 'approved');
    await call('boss', 'PATCH', '/api/company-settings', { requireApproval: true });
    r = await call('prep', 'POST', '/api/leases', lease('K-3')); await call('prep', 'POST', '/api/leases/K-3/submit');
    r = await call('ctl', 'POST', '/api/leases/K-3/reject'); assert.equal(r.body.status, 'rejected', 'a reason is optional');
});

test('a lease in another currency is approved with the company’s current rate when no dated rate exists', async () => {
    await call('prep', 'POST', '/api/leases', lease('K-USD', { currency: 'USD', terms: { ...lease('x').terms, payment: 1000 } }));
    await call('prep', 'POST', '/api/leases/K-USD/submit');
    let r = await call('ctl', 'POST', '/api/leases/K-USD/approve'); assert.equal(r.status, 409); assert.equal(r.body.error, 'fx_missing');
    await call('boss', 'PATCH', '/api/company-settings', { fx: { USD: 280 } });
    r = await call('ctl', 'POST', '/api/leases/K-USD/approve'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'active');
});

test('importing leases as they are (sample portfolio, backups): data managers only', async () => {
    const live = { ...lease('S-1'), status: 'active', history: [{ at: '2025-01-01T00:00:00Z', actor: 'sample', actorName: 'Sample data', text: 'Loaded as sample data' }],
        events: [{ id: 'e1', type: 'reassess-index', effective: '2026-01-01', status: 'approved', reason: 'CPI', newPayment: 105000 }],
        payments: [{ id: 'p1', kind: 'scheduled', dueDate: '2025-01-01', amount: 100000, paidDate: '2025-01-01', ref: 'S' }] };
    let r = await call('prep', 'POST', '/api/leases/import', { leases: [live], source: 'Sample portfolio' }); assert.equal(r.status, 403);
    r = await call('boss', 'POST', '/api/leases/import', { leases: [live, { ...lease('S-2'), status: 'draft', terms: { commencement: '' } }], source: 'Sample portfolio' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.imported, ['S-1', 'S-2']);
    let l = await full('boss', 'S-1');
    assert.equal(l.status, 'active'); assert.equal(l.events[0].newPayment, 105000); assert.equal(l.events[0].status, 'approved'); assert.equal(l.payments.length, 1);
    assert.deepEqual(l.history.map(h => h.text), ['Loaded as sample data', 'Imported (Sample portfolio)']);
    r = await call('boss', 'POST', '/api/leases/import', { leases: [live], source: 'Backup' }); assert.deepEqual(r.body.skipped, ['S-1']);
    r = await call('boss', 'POST', '/api/leases/import', { leases: [{ ...live, payments: [] }], replace: true, source: 'Backup' }); assert.deepEqual(r.body.imported, ['S-1']);
    l = await full('boss', 'S-1'); assert.equal(l.payments.length, 0);
    r = await call('boss', 'POST', '/api/leases/import', { leases: [{ ...live, id: 'S-3', terms: { commencement: '' } }], source: 'Backup' }); assert.equal(r.status, 400, 'live leases must be complete');
    // Deleting: drafts by whoever may delete; live leases only by data managers
    r = await call('prep', 'DELETE', '/api/leases/S-1'); assert.equal(r.status, 409);
    r = await call('boss', 'DELETE', '/api/leases/S-1'); assert.equal(r.status, 200);
    // A deleted lease's approvals go with it: a new lease with the same ID starts with none
    r = await call('boss', 'DELETE', '/api/leases/K-1'); assert.equal(r.status, 200);
    await call('prep', 'POST', '/api/leases', lease('K-1')); await call('prep', 'POST', '/api/leases/K-1/submit');
    assert.deepEqual((await full('ctl', 'K-1')).approvals, []);
    r = await call('ctl', 'POST', '/api/leases/K-1/approve'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'active');
    const acts = (await app.pg.query('SELECT action FROM audit_log WHERE company_id=$1', [ids.co])).rows.map(x => x.action);
    for (const a of ['lease.create', 'lease.update', 'lease.details', 'lease.activated', 'event.applied', 'event.recorded', 'lease.import', 'lease.delete']) assert.ok(acts.includes(a), a);
    assert.equal((await verifyAuditChain(app.pg, ids.co)).ok, true);
});

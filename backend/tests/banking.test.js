// Bank statements, reconciliation and payment batches.
// Runs against a real PostgreSQL database (TEST_DATABASE_URL); the schema is rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hotp, timeStep } from '../src/security/totp.js';
import { verifyAuditChain } from '../src/audit.js';
import { ibanValid, lineHash } from '../src/banking.js';

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
    assert.equal((await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Saffron-Ledger-Lambda-27' })).status, 200);
}
async function addUser(who, role) {
    const r = await call('boss', 'POST', '/api/users', { email: `${who}@lambda.test`, name: `User ${who}`, role }); assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[who] = r.body.user.id; await onboard(who, `${who}@lambda.test`, r.body.temporaryPassword);
}
const full = async (who, id) => (await call(who, 'GET', `/api/leases/${id}?full=1`)).body;
const statement = async id => (await call('tre', 'GET', '/api/bank/statements')).body.find(s => s.id === id);
const line = (id, date, amount, desc, ref = '') => ({ id, date, amount, desc, ref });
const lease = (id, over = {}) => ({ id, entityId: ids.ent, role: 'lessee', name: 'Office', counterparty: 'Landlord Ltd', currency: 'PKR', assetClass: 'building',
    terms: { commencement: '2025-01-01', termMonths: 60, payment: 100000, freqM: 1, timing: 'advance', discountRate: 12 }, ...over });
const match = (lineId, dueDate, over = {}) => ({ lineId, leaseId: 'L-1', dueDate, forType: 'rent', ...over });
const batch = (id, lines, over = {}) => ({ id, name: `Lease payments ${id}`, currency: 'PKR', valueDate: '2025-04-01', account: 'Operating', lines: lines.map(([leaseId, dueDate, amount]) => ({ key: `${leaseId}|${dueDate}|rent`, leaseId, dueDate, forType: 'rent', amount })), ...over });

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 7).toString('base64'), cookieSecure: false, requireMfa: true }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.co = (await app.pg.query("INSERT INTO companies(code,name,base_currency) VALUES ('lambda','Lambda Retail','PKR') RETURNING id")).rows[0].id;
    await app.pg.query("INSERT INTO settings(company_id,key,value) VALUES ($1,'base_currency','{\"currency\":\"PKR\"}')", [ids.co]);
    ids.ent = (await app.pg.query("INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,'L01','Lambda Retail','PKR') RETURNING id", [ids.co])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@lambda.test','Boss','superadmin',$2)", [ids.co, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@lambda.test', 'Temp-Boss-Pass-001');
    for (const [k, role] of [['prep', 'preparer'], ['ctl', 'controller'], ['tre', 'treasury']]) await addUser(k, role);
    for (const l of [lease('L-1'), lease('L-2', { currency: 'USD', terms: { ...lease('L-2').terms, payment: 2000 } })]) {
        assert.equal((await call('prep', 'POST', '/api/leases', l)).status, 200);
        await call('prep', 'POST', `/api/leases/${l.id}/submit`);
    }
    await call('boss', 'PATCH', '/api/company-settings', { fx: { USD: 280 } });
    for (const id of ['L-1', 'L-2']) assert.equal((await call('ctl', 'POST', `/api/leases/${id}/approve`)).body.status, 'active');
});
test.after(async () => app && app.close());

test('the server checks IBANs and fingerprints lines as the web app does', () => {
    assert.ok(ibanValid('PK36SCBL0000001123456702')); assert.ok(!ibanValid('PK36SCBL0000001123456703')); assert.ok(ibanValid('GB82 WEST 1234 5698 7654 32'));
    assert.equal(lineHash('2025-02-02|-100000|FT123|L-1 rent'), lineHash('2025-02-02|-100000|FT123|L-1 rent')); assert.notEqual(lineHash('a'), lineHash('b'));
});

test('statements: imported by treasury, lines seen before marked as duplicates, read by auditors too', async () => {
    let r = await call('tre', 'POST', '/api/bank/statements', { id: 'st-1', name: 'feb.csv', format: 'CSV', account: 'Operating', lines: [
        line('bl-1', '2025-02-02', -100000, 'L-1 February rent', 'FT001'), line('bl-2', '2025-03-03', -100000, 'L-1 March rent', 'FT002'), line('bl-3', '2025-02-15', -5000, 'Utilities'), line('bl-4', '2025-04-02', -100000, 'L-1 April rent', 'FT004')] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lines.length, 4); assert.ok(r.body.lines.every(l => !l.duplicate && l.status === 'unmatched' && l.h)); assert.equal(r.body.lines[0].amount, -100000);
    r = await call('tre', 'POST', '/api/bank/statements', { id: 'st-2', name: 'feb-again.csv', format: 'CSV', lines: [line('bl-9', '2025-02-02', -100000, 'L-1 February rent', 'FT001'), line('bl-10', '2025-05-02', -100000, 'L-1 May rent')] });
    assert.deepEqual(r.body.lines.map(l => l.duplicate), [true, false]);
    assert.equal((await call('tre', 'POST', '/api/bank/statements', { id: 'st-1', name: 'x', format: 'CSV', lines: [line('bl-11', '2025-02-02', 1, 'x')] })).status, 409);
    assert.equal((await call('prep', 'POST', '/api/bank/statements', { id: 'st-3', name: 'x', format: 'CSV', lines: [line('bl-12', '2025-02-02', 1, 'x')] })).status, 403);
    assert.equal((await call('ctl', 'GET', '/api/bank/statements')).body.length, 2, 'controllers read them (audit)');
    assert.equal((await call('prep', 'GET', '/api/bank/statements')).status, 403);
});

test('matching records the payment, or links the line to a payment already recorded; refusals do not undo other matches', async () => {
    let r = await call('tre', 'POST', '/api/bank/match', { matches: [match('bl-1', '2025-02-01')] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.results[0].ok, true); assert.equal(r.body.results[0].match.key, 'L-1|2025-02-01|rent');
    let l = await full('tre', 'L-1');
    assert.equal(l.payments.length, 1); assert.deepEqual([l.payments[0].amount, l.payments[0].paidDate, l.payments[0].bankLineId, l.payments[0].ref], [100000, '2025-02-02', 'bl-1', 'Bank: FT001']);
    assert.equal(l.history.at(-1).text, 'Reconciled bank line 2025-02-02 100,000 to instalment due 2025-02-01');
    // March was paid and recorded by hand before the statement arrived: the line is linked, not paid twice
    assert.equal((await call('prep', 'POST', '/api/leases/L-1/payments', { kind: 'scheduled', dueDate: '2025-03-01', forType: 'rent', amount: 100000, paidDate: '2025-03-03' })).status, 200);
    r = await call('tre', 'POST', '/api/bank/match', { matches: [match('bl-2', '2025-03-01', { auto: true }), match('bl-1', '2025-02-01'), match('bl-9', '2025-02-01'), match('bl-4', '2025-04-15'), match('bl-10', '2025-05-01', { leaseId: 'NOPE' })] });
    assert.deepEqual(r.body.results.map(x => x.ok ? 'ok' : x.error), ['ok', 'already_matched', 'duplicate_line', 'no_instalment', 'not_found']);
    l = await full('tre', 'L-1');
    const march = l.payments.filter(p => p.dueDate === '2025-03-01'); assert.equal(march.length, 1); assert.equal(march[0].bankLineId, 'bl-2');
    assert.equal((await statement('st-1')).lines[1].match.auto, true);
    assert.equal((await call('prep', 'POST', '/api/bank/match', { matches: [match('bl-4', '2025-04-01')] })).status, 403);
    // Unmatching keeps the payment
    assert.equal((await call('tre', 'POST', '/api/bank/lines/bl-1/unmatch')).body.status, 'unmatched');
    assert.equal((await statement('st-1')).lines[0].status, 'unmatched'); assert.equal((await full('tre', 'L-1')).payments.length, 2);
    assert.equal((await call('tre', 'POST', '/api/bank/lines/bl-1/unmatch')).status, 409);
    // Matched again: the payment it recorded is found, nothing is added
    assert.equal((await call('tre', 'POST', '/api/bank/match', { matches: [match('bl-1', '2025-02-01')] })).body.results[0].ok, true);
    assert.equal((await full('tre', 'L-1')).payments.length, 2);
});

test('suggestions and lines that are not lease-related; matched lines are unmatched first', async () => {
    let r = await call('tre', 'PATCH', '/api/bank/statements/st-1/lines', { lines: [{ id: 'bl-3', status: 'ignored' }, { id: 'bl-4', status: 'suggested', suggest: { key: 'L-1|2025-04-01|rent', score: 90 } }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await statement('st-1');
    assert.equal(s.lines[2].status, 'ignored'); assert.deepEqual(s.lines[3].suggest, { key: 'L-1|2025-04-01|rent', score: 90 });
    assert.equal((await call('tre', 'PATCH', '/api/bank/statements/st-1/lines', { lines: [{ id: 'bl-1', status: 'ignored' }] })).status, 409);
    assert.equal((await call('tre', 'PATCH', '/api/bank/statements/st-1/lines', { lines: [{ id: 'bl-9', status: 'ignored' }] })).status, 404, 'line of another statement');
});

test('the period lock applies to matches', async () => {
    assert.equal((await call('boss', 'PATCH', '/api/company-settings', { lockedThrough: '2025-04-30' })).status, 200);
    const r = await call('tre', 'POST', '/api/bank/match', { matches: [match('bl-4', '2025-04-01')] });
    assert.equal(r.body.results[0].error, 'period_locked');
    assert.equal((await call('boss', 'PATCH', '/api/company-settings', { lockedThrough: '' })).status, 200);
});

test('deleting a statement keeps the payments recorded from it', async () => {
    assert.equal((await call('tre', 'DELETE', '/api/bank/statements/st-1')).status, 200);
    assert.equal(await statement('st-1'), undefined);
    assert.equal((await full('tre', 'L-1')).payments.length, 2);
});

test('payment batches: one batch per payment and currency, payee details before submitting, maker-checker, release', async () => {
    let r = await call('tre', 'POST', '/api/batches', batch('pb-1', [['L-1', '2025-04-01', 100000], ['L-1', '2025-05-01', 100000]]));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'draft'); assert.equal(r.body.total, 200000); assert.equal(r.body.createdBy, ids.tre);
    assert.equal((await call('tre', 'POST', '/api/batches', batch('pb-2', [['L-1', '2025-05-01', 100000]]))).body.error, 'in_batch');
    assert.equal((await call('tre', 'POST', '/api/batches', batch('pb-2', [['L-2', '2025-05-01', 2000]]))).body.error, 'bad_currency');
    assert.equal((await call('prep', 'POST', '/api/batches', batch('pb-2', [['L-1', '2025-06-01', 100000]]))).status, 403);

    r = await call('tre', 'POST', '/api/batches/pb-1/submit'); assert.equal(r.body.error, 'payee_details'); assert.match(r.body.message, /L-1/);
    await call('tre', 'PATCH', '/api/leases/L-1/details', { bank: { iban: 'PK36SCBL0000001123456702', account: '', bankName: 'Standard Chartered', swift: 'SCBLPKKA' } });
    assert.equal((await call('tre', 'POST', '/api/batches/pb-1/submit')).body.status, 'pending');
    assert.equal((await call('tre', 'POST', '/api/batches/pb-1/release')).status, 409, 'not approved yet');
    assert.equal((await call('tre', 'POST', '/api/batches/pb-1/approve')).status, 403);
    assert.equal((await call('tre', 'DELETE', '/api/batches/pb-1')).status, 409);
    r = await call('ctl', 'POST', '/api/batches/pb-1/approve'); assert.equal(r.body.status, 'approved', JSON.stringify(r.body));
    let b = (await call('ctl', 'GET', '/api/batches')).body.find(x => x.id === 'pb-1');
    assert.deepEqual(b.approvals.map(a => [a.name, a.role]), [['User ctl', 'controller']]);
    assert.equal((await call('tre', 'POST', '/api/batches/pb-1/release', { format: 'xml' })).body.status, 'released');
    assert.equal((await call('tre', 'POST', '/api/batches/pb-1/release', { format: 'csv' })).body.status, 'released', 'the file can be downloaded again');
    b = (await call('tre', 'GET', '/api/batches')).body.find(x => x.id === 'pb-1'); assert.ok(b.releasedAt && b.submittedAt);

    // Whoever prepared a batch cannot approve it; a rejected batch frees its payments
    assert.equal((await call('boss', 'POST', '/api/batches', batch('pb-3', [['L-1', '2025-06-01', 100000]]))).status, 200);
    await call('boss', 'POST', '/api/batches/pb-3/submit');
    r = await call('boss', 'POST', '/api/batches/pb-3/approve'); assert.equal(r.status, 403); assert.match(r.body.message, /prepared/);
    assert.equal((await call('ctl', 'POST', '/api/batches/pb-3/reject', { comment: 'Wrong value date' })).body.status, 'rejected');
    assert.equal((await call('tre', 'POST', '/api/batches', batch('pb-4', [['L-1', '2025-06-01', 100000]]))).status, 200);
    assert.equal((await call('tre', 'DELETE', '/api/batches/pb-4')).status, 200);
    assert.equal((await call('prep', 'GET', '/api/batches')).status, 403);
});

test('a batch above the first tier needs two approvers, sized in the base currency', async () => {
    // USD 40,000 at 280 = PKR 11.2m, above the PKR 10m single-approval tier
    await call('tre', 'PATCH', '/api/leases/L-2/details', { bank: { iban: '', account: '001-778899', bankName: 'Citibank', swift: '' } });
    assert.equal((await call('tre', 'POST', '/api/batches', batch('pb-5', [['L-2', '2025-04-01', 40000]], { currency: 'USD' }))).status, 200);
    await call('tre', 'POST', '/api/batches/pb-5/submit');
    let r = await call('ctl', 'POST', '/api/batches/pb-5/approve'); assert.deepEqual([r.body.status, r.body.approvals, r.body.needed], ['pending', 1, 2]);
    assert.equal((await call('ctl', 'POST', '/api/batches/pb-5/approve')).body.error, 'already_approved');
    r = await call('boss', 'POST', '/api/batches/pb-5/approve'); assert.equal(r.body.status, 'approved');
});

test('the audit chain is intact', async () => {
    const v = await verifyAuditChain(app.pg, ids.co); assert.ok(v.ok, JSON.stringify(v));
    const acts = (await app.pg.query('SELECT DISTINCT action FROM audit_log WHERE company_id=$1', [ids.co])).rows.map(r => r.action);
    for (const a of ['bank.import', 'bank.match', 'bank.unmatch', 'bank.ignore', 'bank.delete', 'batch.create', 'batch.submit', 'batch.approved', 'batch.approval_given', 'batch.rejected', 'batch.release', 'batch.delete']) assert.ok(acts.includes(a), a);
});

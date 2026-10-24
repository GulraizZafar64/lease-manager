// Bringing a company's browser data to the server: checking leases before bringing them, and the browser's audit archive.
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
    assert.equal((await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Saffron-Ledger-Omicron-27' })).status, 200);
}
const terms = { commencement: '2024-01-01', termMonths: 36, payment: 50000, freqM: 1, timing: 'advance', discountRate: 11 };
const lease = (id, over = {}) => ({ id, entityId: ids.ent, role: 'lessee', name: 'Shop', counterparty: 'Mall Ltd', currency: 'PKR', assetClass: 'retail', status: 'active', terms, events: [], payments: [], history: [{ at: '2024-01-01T09:00:00Z', actor: 'u-mei', actorName: 'Mei Lin', text: 'Submitted for approval' }], ...over });
const count = async () => Number((await app.pg.query('SELECT count(*) FROM leases WHERE company_id=$1', [ids.co])).rows[0].count);

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 9).toString('base64'), cookieSecure: false, requireMfa: true }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.co = (await app.pg.query("INSERT INTO companies(code,name,base_currency) VALUES ('omicron','Omicron Stores','PKR') RETURNING id")).rows[0].id;
    await app.pg.query("INSERT INTO settings(company_id,key,value) VALUES ($1,'base_currency','{\"currency\":\"PKR\"}')", [ids.co]);
    ids.ent = (await app.pg.query("INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,'O01','Omicron Stores','PKR') RETURNING id", [ids.co])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@omicron.test','Boss','superadmin',$2)", [ids.co, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@omicron.test', 'Temp-Boss-Pass-001');
    const r = await call('boss', 'POST', '/api/users', { email: 'aud@omicron.test', name: 'Auditor', role: 'auditor' });
    await onboard('aud', 'aud@omicron.test', r.body.temporaryPassword);
    assert.equal((await call('boss', 'POST', '/api/leases/import', { leases: [lease('O-1')], source: 'test' })).status, 200);
});
test.after(async () => app && app.close());

test('checking leases before bringing them: each one new, already here, or its problem; nothing changes', async () => {
    const leases = [
        lease('O-1'), lease('O-2'),
        lease('O-3', { entityId: undefined }), // its entity is added before the leases are brought
        lease('O-4', { terms: { ...terms, payment: '' } }),
        lease('O-5', { status: 'draft', name: '', terms: { commencement: '' } }),
        lease('O-6', { entityId: '11111111-1111-1111-1111-111111111111' }),
        lease('O-7', { events: [{ type: 'reassess-index', effective: '2025-13-40', status: 'approved', reason: 'CPI', newPayment: 55000 }] }),
        { id: 'bad id!', role: 'lessee' },
    ];
    const before = await count();
    const r = await call('boss', 'POST', '/api/leases/import', { leases, source: 'browser check', check: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.ok, ['O-2', 'O-3', 'O-5']); assert.deepEqual(r.body.existing, ['O-1']);
    assert.deepEqual(r.body.problems.map(p => [p.id, p.code]), [['O-4', 'incomplete'], ['O-6', 'bad_entity'], ['O-7', 'unmeasurable'], ['bad id!', 'validation']]);
    assert.match(r.body.problems[0].message, /^O-4: The lease is not complete: terms.payment/);
    assert.equal(await count(), before, 'checking changes nothing');
    assert.equal((await call('aud', 'POST', '/api/leases/import', { leases, source: 'x', check: true })).status, 403);
});

test('bringing leases in: a problem names the lease, and nothing of the batch is kept', async () => {
    let r = await call('boss', 'POST', '/api/leases/import', { leases: [lease('O-2'), lease('O-4', { terms: { ...terms, payment: '' } })], source: 'browser' });
    assert.equal(r.status, 400); assert.match(r.body.message, /^O-4: /);
    assert.equal((await call('boss', 'GET', '/api/leases/O-2')).status, 404);
    r = await call('boss', 'POST', '/api/leases/import', { leases: [lease('O-2')], source: 'browser' });
    assert.deepEqual(r.body.imported, ['O-2']);
    const l = (await call('boss', 'GET', '/api/leases/O-2?full=1')).body;
    assert.deepEqual(l.history.map(h => h.actorName), ['Mei Lin', 'Boss'], 'the browser history is kept, then the import');
});

test("the browser app's audit log is kept as an archive, once, fingerprinted in the server's log", async () => {
    const entries = [
        { id: '20240101090000001-a', at: '2024-01-01T09:00:00.000Z', actor: 'u-mei', actorName: 'Mei Lin', role: 'preparer', action: 'lease', detail: 'Submitted for approval', leaseId: 'O-1', entity: 'Omicron Stores' },
        { id: '20240102090000001-b', at: '2024-01-02T09:00:00.000Z', actor: 'u-daniel', actorName: 'Daniel Okafor', role: 'controller', action: 'lease', detail: 'Approved and activated', leaseId: 'O-1' },
        { id: '20240103090000001-c', at: '2024-01-03T09:00:00.000Z', actor: 'u-alex', actorName: 'Alex Morgan', role: 'superadmin', action: 'backup', detail: 'Backup downloaded' },
    ];
    let r = await call('boss', 'POST', '/api/audit/archive', { source: 'This browser (Demo Company)', entries });
    assert.deepEqual(r.body, { added: 3, skipped: 0 });
    r = await call('boss', 'POST', '/api/audit/archive', { source: 'This browser (Demo Company)', entries });
    assert.deepEqual(r.body, { added: 0, skipped: 3 }, 'bringing it twice adds nothing');
    const arch = (await call('aud', 'GET', '/api/audit/archive')).body;
    assert.deepEqual(arch.map(a => a.actorName), ['Alex Morgan', 'Daniel Okafor', 'Mei Lin']); assert.equal(arch[2].leaseId, 'O-1');
    const log = (await call('aud', 'GET', '/api/audit?limit=5')).body.filter(x => x.action === 'migration.audit_archive');
    assert.equal(log.length, 2); assert.match(log[1].detail.sha256, /^[0-9a-f]{64}$/); assert.equal(log[1].detail.from, '2024-01-01T09:00:00.000Z');
    assert.equal((await call('aud', 'POST', '/api/audit/archive', { source: 'x', entries })).status, 403);
    assert.equal((await call('boss', 'GET', '/api/company-export')).body.browserAudit.length, 3);
    assert.ok((await verifyAuditChain(app.pg, ids.co)).ok);
});

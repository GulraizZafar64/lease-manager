// ERP export files, AI drafts, browser-only audit entries, retention purges, the company data export and restore.
// Runs against a real PostgreSQL database (TEST_DATABASE_URL); the schema is rebuilt.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hotp, timeStep } from '../src/security/totp.js';
import { audit, verifyAuditChain } from '../src/audit.js';

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
    assert.equal((await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Saffron-Ledger-Nu-27' })).status, 200);
}
async function addUser(who, role) {
    const r = await call('boss', 'POST', '/api/users', { email: `${who}@nu.test`, name: `User ${who}`, role }); assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[who] = r.body.user.id; await onboard(who, `${who}@nu.test`, r.body.temporaryPassword);
}
async function newCompany(code, name) {
    const id = (await app.pg.query('INSERT INTO companies(code,name,base_currency) VALUES ($1,$2,$3) RETURNING id', [code, name, 'PKR'])).rows[0].id;
    await app.pg.query("INSERT INTO settings(company_id,key,value) VALUES ($1,'base_currency','{\"currency\":\"PKR\"}')", [id]);
    return id;
}
const draft = (id, text, over = {}) => ({ id, title: `Lease disclosures ${id}`, from: '2025-01-01', to: '2025-12-31', text, source: 'AI (Claude) from computed note and portfolio', ...over });

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 8).toString('base64'), cookieSecure: false, requireMfa: true }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.co = await newCompany('nu', 'Nu Textiles');
    ids.ent = (await app.pg.query("INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,'N01','Nu Textiles','PKR') RETURNING id", [ids.co])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@nu.test','Boss','superadmin',$2)", [ids.co, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@nu.test', 'Temp-Boss-Pass-001');
    ids.boss = (await call('boss', 'GET', '/api/auth/me')).body.user.id;
    for (const [k, role] of [['prep', 'preparer'], ['ctl', 'controller'], ['tre', 'treasury']]) await addUser(k, role);
    await call('prep', 'POST', '/api/leases', { id: 'N-1', entityId: ids.ent, role: 'lessee', name: 'Mill', counterparty: 'Estate Ltd', currency: 'PKR', assetClass: 'building', terms: { commencement: '2025-01-01', termMonths: 60, payment: 100000, freqM: 1, timing: 'advance', discountRate: 12 } });
    await call('prep', 'POST', '/api/leases/N-1/submit');
    assert.equal((await call('ctl', 'POST', '/api/leases/N-1/approve')).body.status, 'active');
});
test.after(async () => app && app.close());

test('ERP export files: recorded by whoever exports, read by auditors, marked once', async () => {
    let r = await call('prep', 'POST', '/api/erp-exports', { id: 'ex-1', target: 'sap', from: '2025-01-01', to: '2025-01-31', count: 3, debits: 312500.5, keys: ['N-1|2025-01-01|rent', 'N-1|2025-01-31|interest'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.count, r.body.debits, r.body.createdBy], ['generated', 3, 312500.5, ids.prep]);
    assert.equal((await call('tre', 'POST', '/api/erp-exports', { id: 'ex-2', target: 'sap', from: '2025-01-01', to: '2025-01-31', count: 0, debits: 0, keys: [] })).status, 403);
    assert.equal((await call('tre', 'GET', '/api/erp-exports')).status, 403);
    assert.equal((await call('ctl', 'GET', '/api/erp-exports')).body.length, 1);
    r = await call('prep', 'POST', '/api/erp-exports/ex-1/mark', { status: 'posted', notes: 'SAP doc 1900000123' }); assert.equal(r.body.status, 'posted');
    assert.equal((await call('prep', 'POST', '/api/erp-exports/ex-1/mark', { status: 'failed' })).status, 409);
    const x = (await call('ctl', 'GET', '/api/erp-exports')).body[0]; assert.deepEqual([x.status, x.notes, x.markedBy], ['posted', 'SAP doc 1900000123', ids.prep]);
});

test('AI drafts: TO CONFIRM items block approval, the editor cannot approve, editing needs approval again', async () => {
    assert.equal((await call('prep', 'POST', '/api/ai-drafts', draft('dr-1', 'Leases of mills [N-1]. Covenants [TO CONFIRM: bank covenants].'))).status, 200);
    assert.equal((await call('prep', 'POST', '/api/ai-drafts/dr-1/approve')).status, 403, 'preparers do not approve');
    assert.equal((await call('ctl', 'POST', '/api/ai-drafts/dr-1/approve')).body.error, 'to_confirm');
    assert.equal((await call('prep', 'PUT', '/api/ai-drafts/dr-1', { text: 'Leases of mills [N-1]. No covenants.' })).body.version, 2);
    // Two approvals needed: one given, then an edit sends it back to none
    assert.equal((await call('boss', 'PATCH', '/api/company-settings', { approvalPolicy: { draft: [{ upTo: null, approvals: 2, roles: ['controller', 'superadmin'] }] } })).status, 200);
    assert.equal((await call('ctl', 'POST', '/api/ai-drafts/dr-1/approve')).body.status, 'draft');
    let d = (await call('ctl', 'GET', '/api/ai-drafts')).body[0]; assert.deepEqual(d.approvals.map(a => a.name), ['User ctl']);
    await call('ctl', 'PUT', '/api/ai-drafts/dr-1', { text: 'Leases of mills [N-1]. No covenants. Terms of 5 years [N-1].' });
    d = (await call('ctl', 'GET', '/api/ai-drafts')).body[0]; assert.deepEqual([d.version, d.approvals.length, d.editedBy], [3, 0, ids.ctl]);
    assert.match((await call('ctl', 'POST', '/api/ai-drafts/dr-1/approve')).body.message, /prepared/, 'the last editor cannot approve');
    assert.equal((await call('boss', 'POST', '/api/ai-drafts/dr-1/approve')).body.status, 'draft');
    await call('boss', 'PATCH', '/api/company-settings', { approvalPolicy: { draft: [{ upTo: null, approvals: 1, roles: ['controller', 'superadmin'] }] } });
    assert.equal((await call('prep', 'GET', '/api/ai-drafts')).body[0].status, 'draft');
    // Back to one approval: a policy change does not finalise anything by itself; after the preparer's edit, the controller's approval does
    await call('prep', 'PUT', '/api/ai-drafts/dr-1', { text: 'Leases of mills [N-1]. No covenants. Terms of 5 years [N-1]. Final.' });
    assert.equal((await call('ctl', 'POST', '/api/ai-drafts/dr-1/approve')).body.status, 'final');
    assert.equal((await call('prep', 'PUT', '/api/ai-drafts/dr-1', { text: 'x' })).status, 409);
    assert.equal((await call('tre', 'GET', '/api/ai-drafts')).body[0].status, 'final', 'everyone reads them');
    assert.equal((await call('prep', 'POST', '/api/ai-drafts', draft('dr-2', 'Spare'))).status, 200);
    assert.equal((await call('prep', 'DELETE', '/api/ai-drafts/dr-2')).status, 200);
});

test('browser-only actions are added to the audit log; other actions are not accepted from the browser', async () => {
    assert.equal((await call('tre', 'POST', '/api/audit/client', { action: 'export', detail: 'Maturity analysis as xlsx' })).status, 200);
    assert.equal((await call('tre', 'POST', '/api/audit/client', { action: 'batch.approved', detail: 'forged' })).status, 400);
    const log = (await call('ctl', 'GET', '/api/audit?limit=50')).body;
    const e = log.find(x => x.action === 'export'); assert.equal(e.detail.text, 'Maturity analysis as xlsx'); assert.equal(e.user_name, 'User tre');
    assert.equal((await call('tre', 'GET', '/api/audit')).status, 403);
});

test('retention purge: only entries older than the retention period; the rest still verify', async () => {
    const { hashPassword } = await import('../src/security/crypto.js');
    const old = await newCompany('xi', 'Xi Old Records');
    mock.timers.enable({ apis: ['Date'], now: new Date('2012-03-01T10:00:00Z') });
    try { for (const n of [1, 2, 3]) await audit(app.pg, { companyId: old, action: 'lease.create', objectType: 'lease', objectId: `OLD-${n}` }); }
    finally { mock.timers.reset(); }
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'admin@xi.test','Xi Admin','superadmin',$2)", [old, await hashPassword('Temp-Xi-Pass-001')]);
    await call('xi', 'POST', '/api/auth/login', { email: 'admin@xi.test', password: 'Temp-Xi-Pass-001' });
    const secret = (await call('xi', 'POST', '/api/auth/mfa/setup')).body.secret;
    await call('xi', 'POST', '/api/auth/mfa/verify', { code: hotp(secret, timeStep()) });
    await call('xi', 'POST', '/api/auth/password', { current: 'Temp-Xi-Pass-001', next: 'Saffron-Ledger-Xi-27' });
    let r = await call('xi', 'POST', '/api/audit/purge', { before: '2024-01-01' }); assert.equal(r.status, 400); assert.equal(r.body.error, 'retention');
    r = await call('xi', 'POST', '/api/audit/purge', { before: '2013-01-01' }); assert.equal(r.body.deleted, 3, JSON.stringify(r.body));
    assert.ok((await verifyAuditChain(app.pg, old)).ok);
    const left = (await app.pg.query('SELECT action FROM audit_log WHERE company_id=$1 ORDER BY id', [old])).rows.map(x => x.action);
    assert.ok(!left.includes('lease.create') && left.at(-1) === 'retention.purge');
    await assert.rejects(app.pg.query('DELETE FROM audit_log WHERE company_id=$1', [old]), /append-only/, 'still append-only outside a purge');
    assert.equal((await call('prep', 'POST', '/api/audit/purge', { before: '2013-01-01' })).status, 403);
});

test('company data export: everything, without secrets; data managers only', async () => {
    const r = await call('boss', 'GET', '/api/company-export');
    assert.equal(r.status, 200);
    const d = r.body;
    assert.equal(d.format, 'lease-manager-company'); assert.equal(d.company.code, 'nu');
    assert.deepEqual([d.leases.length, d.exports.length, d.drafts.length, d.entities.length], [1, 1, 1, 1]);
    assert.equal(d.leases[0].history.at(-1).text.slice(0, 22), 'Approved and activated');
    assert.ok(d.users.length >= 4 && d.users.every(u => !('password_hash' in u) && !('mfa_secret_enc' in u)));
    assert.ok(d.audit.length > 10 && d.audit[0].hash);
    assert.ok(!/password_hash|mfa_secret|\$argon2|\$scrypt/.test(JSON.stringify(d)));
    assert.equal(d.settings.approvalPolicy.draft[0].approvals, 1);
    assert.equal((await call('ctl', 'GET', '/api/company-export')).status, 403);
});

test('restore: records added when new; approvals are not carried over; restored releases cannot pay again', async () => {
    const body = {
        source: 'IFRS16_backup_2025-06-30.json',
        bank: [{ id: 'st-r1', name: 'jan.csv', format: 'CSV', account: '', lines: [{ id: 'bl-r1', date: '2025-01-02', amount: -100000, ref: 'FT1', desc: 'N-1 rent', status: 'matched', duplicate: false, match: { leaseId: 'N-1', dueDate: '2025-01-01', key: 'N-1|2025-01-01|rent', by: 'someone-else', auto: true } }] }],
        batches: [
            { id: 'pb-r1', name: 'Approved before', currency: 'PKR', valueDate: '2025-03-01', status: 'approved', createdBy: 'local-user', lines: [{ key: 'N-1|2025-03-01|rent', leaseId: 'N-1', dueDate: '2025-03-01', forType: 'rent', amount: 100000 }], approvals: [{ by: 'x', name: 'Forged', role: 'controller', at: '2025-02-28' }] },
            { id: 'pb-r2', name: 'Paid before', currency: 'PKR', valueDate: '2025-02-01', status: 'released', createdBy: ids.tre, releasedAt: '2025-02-01T09:00:00Z', lines: [{ key: 'N-1|2025-02-01|rent', leaseId: 'N-1', dueDate: '2025-02-01', forType: 'rent', amount: 100000 }] },
        ],
        exports: [{ id: 'ex-1', target: 'sap', from: '2025-01-01', to: '2025-01-31', count: 1, debits: 1, keys: [], status: 'generated' }, { id: 'ex-r2', target: 'odoo', from: '2025-02-01', to: '2025-02-28', count: 4, debits: 400, keys: ['N-1|2025-02-01|rent'], status: 'posted', notes: 'JE/2025/02', markedBy: ids.prep }],
        drafts: [{ id: 'dr-r1', title: 'Disclosures 2024', from: '2024-01-01', to: '2024-12-31', text: 'Approved text', status: 'final', createdBy: ids.prep }],
    };
    assert.equal((await call('ctl', 'POST', '/api/company-restore', body)).status, 403);
    const r = await call('boss', 'POST', '/api/company-restore', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.restored, { bank: 1, batches: 2, exports: 1, drafts: 1 }); assert.deepEqual(r.body.skipped.exports, ['ex-1']);
    const bs = (await call('boss', 'GET', '/api/batches')).body;
    const b1 = bs.find(b => b.id === 'pb-r1'), b2 = bs.find(b => b.id === 'pb-r2');
    assert.deepEqual([b1.status, b1.approvals.length, b1.createdBy], ['pending', 0, ids.boss], 'approved before: approved again here');
    assert.equal(b2.status, 'released'); assert.equal(b2.createdBy, ids.tre);
    assert.equal((await call('tre', 'POST', '/api/batches/pb-r2/release')).body.error, 'restored');
    assert.equal((await call('ctl', 'GET', '/api/ai-drafts')).body.find(d => d.id === 'dr-r1').status, 'draft');
    const st = (await call('tre', 'GET', '/api/bank/statements')).body[0]; assert.equal(st.lines[0].status, 'matched'); assert.ok(st.lines[0].h);
    assert.deepEqual((await call('boss', 'POST', '/api/company-restore', body)).body.restored, { bank: 0, batches: 0, exports: 0, drafts: 0 }, 'a second restore adds nothing');
});

test('the audit chains are intact', async () => {
    for (const { id } of (await app.pg.query('SELECT id FROM companies')).rows) { const v = await verifyAuditChain(app.pg, id); assert.ok(v.ok, JSON.stringify(v)); }
    const acts = new Set((await app.pg.query('SELECT action FROM audit_log WHERE company_id=$1', [ids.co])).rows.map(r => r.action));
    for (const a of ['gl.export', 'gl.sync', 'ai.draft', 'ai.draft_edited', 'ai.approval_given', 'ai.approve', 'ai.draft_deleted', 'export', 'company.export', 'company.restore']) assert.ok(acts.has(a), a);
});

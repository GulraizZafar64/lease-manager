// Company settings, entities and exchange rates as the web app saves them.
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
    assert.equal((await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Copper-Lantern-Delta-31' })).status, 200);
}
async function addUser(who, role, extra = {}) {
    const r = await call('boss', 'POST', '/api/users', { email: `${who}@eps.test`, name: who, role, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[who] = r.body.user.id; await onboard(who, `${who}@eps.test`, r.body.temporaryPassword);
}

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 4).toString('base64'), cookieSecure: false, requireMfa: true }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    for (const code of ['eps', 'zeta']) ids[code] = (await app.pg.query("INSERT INTO companies(code,name) VALUES ($1,$1) RETURNING id", [code])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@eps.test','Boss','superadmin',$3), ($2,'boss@zeta.test','Zeta Boss','superadmin',$3)", [ids.eps, ids.zeta, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@eps.test', 'Temp-Boss-Pass-001');
    await onboard('zboss', 'boss@zeta.test', 'Temp-Boss-Pass-001');
    await addUser('prep', 'preparer');
    await addUser('view', 'viewer');
});
test.after(async () => app && app.close());

test('settings: saved fields are read back by everyone in the company, and only there', async () => {
    let r = await call('view', 'GET', '/api/company-settings'); assert.equal(r.status, 200); assert.ok(r.body.approvalPolicy.lease, 'the default policy');
    r = await call('boss', 'PATCH', '/api/company-settings', { functionalCurrency: 'AED', fyEndMonth: 12, displayUnit: 1000, accounts: { rou: '1610 ROU' }, fx: { USD: 3.67 }, lockedThrough: '2025-12-31', segregateApproval: false, rateConvention: 'nominal' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.functionalCurrency, 'AED'); assert.equal(r.body.lockedThrough, '2025-12-31');
    r = await call('view', 'GET', '/api/company-settings');
    assert.equal(r.body.fyEndMonth, 12); assert.deepEqual(r.body.fx, { USD: 3.67 }); assert.equal(r.body.segregateApproval, false); assert.equal(r.body.rateConvention, 'nominal');
    // The fields the server acts on are its own setting keys
    const keys = Object.fromEntries((await app.pg.query('SELECT key, value FROM settings WHERE company_id=$1', [ids.eps])).rows.map(x => [x.key, x.value]));
    assert.deepEqual(keys.base_currency, { currency: 'AED' }); assert.deepEqual(keys.period_lock, { lockedThrough: '2025-12-31' }); assert.deepEqual(keys.segregation, { makerCannotCheck: false });
    r = await call('zboss', 'GET', '/api/company-settings'); assert.equal(r.body.functionalCurrency, undefined, 'another company is unaffected');
    // Saving one field keeps the others
    await call('boss', 'PATCH', '/api/company-settings', { displayUnit: 1 });
    r = await call('boss', 'GET', '/api/company-settings'); assert.equal(r.body.fyEndMonth, 12); assert.equal(r.body.displayUnit, 1);
    r = await call('boss', 'PATCH', '/api/company-settings', { lockedThrough: '' }); assert.equal(r.body.lockedThrough, '');
});

test('settings: fields are checked; unknown fields and per-person ones are refused', async () => {
    for (const bad of [{ functionalCurrency: 'dollars' }, { fyEndMonth: 13 }, { theme: 'dark' }, { displayUnit: 7 }, { bankAccounts: [{ name: 'x' }] }, { approvalPolicy: { lease: [] } }]) {
        const r = await call('boss', 'PATCH', '/api/company-settings', bad); assert.equal(r.status, 400, JSON.stringify(bad));
    }
});

test('settings: each section needs its permission', async () => {
    let r = await call('view', 'PATCH', '/api/company-settings', { fyEndMonth: 3 }); assert.equal(r.status, 403);
    r = await call('prep', 'PATCH', '/api/company-settings', { erp: { target: 'sap', company: '2000', docType: 'SA', journal: 'J', batch: 'B', ledger: '', group: '' } });
    assert.equal(r.status, 200, 'ERP export options belong to whoever exports (gl.export)');
    r = await call('prep', 'PATCH', '/api/company-settings', { erp: { target: 'sap', company: '2000', docType: 'SA', journal: 'J', batch: 'B', ledger: '', group: '' }, fyEndMonth: 3 });
    assert.equal(r.status, 403); assert.match(r.body.message, /fyEndMonth/);
    r = await call('prep', 'PATCH', '/api/company-settings', { retention: { auditYears: 7, idleMinutes: 15 } }); assert.equal(r.status, 403);
});

test('settings: approvers in the policy must be able to approve', async () => {
    const pol = roles => ({ approvalPolicy: { lease: [{ upTo: '', approvals: 1, roles }], draft: [{ upTo: null, approvals: 1, roles: ['controller'] }] } });
    let r = await call('boss', 'PATCH', '/api/company-settings', pol(['viewer'])); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_role');
    r = await call('boss', 'PATCH', '/api/company-settings', pol(['controller', 'admin'])); assert.equal(r.status, 200);
    assert.equal(r.body.approvalPolicy.lease[0].upTo, null, 'blank upper limit means no limit');
    const stored = (await app.pg.query("SELECT value FROM settings WHERE company_id=$1 AND key='approval_policy'", [ids.eps])).rows[0].value;
    assert.deepEqual(stored.lease[0].roles, ['controller', 'admin'], 'the server’s approvals use the same policy');
});

test('entities: add, edit, no loops, delete only when unused', async () => {
    let r = await call('boss', 'POST', '/api/entities', { code: 'HQ', name: 'Eps Holdings', functionalCurrency: 'AED' }); ids.hq = r.body.id;
    r = await call('boss', 'POST', '/api/entities', { code: 'SUB', name: 'Eps Retail', functionalCurrency: 'AED', parentId: ids.hq }); ids.sub = r.body.id;
    r = await call('boss', 'PATCH', `/api/entities/${ids.sub}`, { name: 'Eps Retail LLC', country: 'UAE' }); assert.equal(r.status, 200); assert.equal(r.body.name, 'Eps Retail LLC'); assert.equal(r.body.parent_id, ids.hq);
    r = await call('boss', 'PATCH', `/api/entities/${ids.hq}`, { parentId: ids.sub }); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_parent');
    r = await call('boss', 'PATCH', `/api/entities/${ids.hq}`, { parentId: ids.hq }); assert.equal(r.body.error, 'bad_parent');
    r = await call('boss', 'PATCH', `/api/entities/${ids.sub}`, { code: 'HQ' }); assert.equal(r.status, 409, 'codes are unique in the company'); assert.equal(r.body.error, 'duplicate_entity');
    r = await call('zboss', 'PATCH', `/api/entities/${ids.sub}`, { name: 'x' }); assert.equal(r.status, 404);
    r = await call('prep', 'PATCH', `/api/entities/${ids.sub}`, { name: 'x' }); assert.equal(r.status, 403);
    r = await call('boss', 'DELETE', `/api/entities/${ids.hq}`); assert.equal(r.status, 409); assert.match(r.body.message, /1 subsidiary/);
    await call('boss', 'PATCH', `/api/users/${ids.view}`, { entityIds: [ids.sub] });
    r = await call('boss', 'DELETE', `/api/entities/${ids.sub}`); assert.equal(r.status, 409); assert.match(r.body.message, /1 user limited to it/);
    await call('boss', 'PATCH', `/api/users/${ids.view}`, { entityIds: [] });
    r = await call('prep', 'POST', '/api/leases', { id: 'EP-1', entityId: ids.sub, role: 'lessee', name: 'Shop', counterparty: 'Mall', currency: 'AED', assetClass: 'retail', terms: { commencement: '2026-01-01', termMonths: 24, payment: 1000, freqM: 1, timing: 'advance', discountRate: 6 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('boss', 'DELETE', `/api/entities/${ids.sub}`); assert.match(r.body.message, /1 lease/);
    await call('prep', 'DELETE', '/api/leases/EP-1');
    r = await call('boss', 'DELETE', `/api/entities/${ids.sub}`); assert.equal(r.status, 200);
    r = await call('boss', 'GET', '/api/entities'); assert.deepEqual(r.body.map(e => e.code), ['HQ']);
});

test('exchange rates: add, read back, remove', async () => {
    let r = await call('boss', 'POST', '/api/fx-rates', [{ date: '2026-06-30', currency: 'USD', rate: 3.6725 }, { date: '2026-06-30', currency: 'EUR', rate: 4.01 }, { date: '2026-03-31', currency: 'USD', rate: 3.673 }]);
    assert.equal(r.status, 200);
    r = await call('view', 'GET', '/api/fx-rates'); assert.deepEqual(r.body.map(x => [x.date, x.currency, x.rate]), [['2026-06-30', 'EUR', 4.01], ['2026-06-30', 'USD', 3.6725], ['2026-03-31', 'USD', 3.673]]);
    r = await call('view', 'POST', '/api/fx-rates/remove', [{ date: '2026-06-30', currency: 'EUR' }]); assert.equal(r.status, 403);
    r = await call('boss', 'POST', '/api/fx-rates/remove', [{ date: '2026-06-30', currency: 'EUR' }, { date: '2026-06-30', currency: 'USD' }]); assert.equal(r.body.removed, 2);
    r = await call('zboss', 'GET', '/api/fx-rates'); assert.deepEqual(r.body, []);
    const acts = (await app.pg.query('SELECT action FROM audit_log WHERE company_id=$1', [ids.eps])).rows.map(x => x.action);
    for (const a of ['settings.update', 'entity.create', 'entity.update', 'entity.delete', 'fx.import', 'fx.remove']) assert.ok(acts.includes(a), a);
    assert.equal((await verifyAuditChain(app.pg, ids.eps)).ok, true);
});

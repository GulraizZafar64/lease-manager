// End-to-end API tests against a real PostgreSQL database (TEST_DATABASE_URL). The schema is rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hotp, timeStep } from '../src/security/totp.js';

const url = process.env.TEST_DATABASE_URL;
const H = { 'x-requested-with': 'lease-manager' };
let app, cfg;
const jar = {};
const ids = {};
async function call(who, method, path, body) {
    const r = await app.inject({ method, url: path, payload: body, headers: { ...H, ...(jar[who] ? { cookie: jar[who] } : {}) } });
    const set = r.headers['set-cookie']; if (set) jar[who] = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const code = secret => hotp(secret, timeStep());
// Full first sign-in: password, MFA enrolment, forced password change
async function onboard(who, email, temp) {
    let r = await call(who, 'POST', '/api/auth/login', { email, password: temp }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.next, 'mfa_enrol');
    r = await call(who, 'POST', '/api/auth/mfa/setup'); assert.equal(r.status, 200);
    const secret = r.body.secret;
    r = await call(who, 'POST', '/api/auth/mfa/verify', { code: code(secret) }); assert.equal(r.status, 200); assert.equal(r.body.next, 'change_password');
    r = await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Kite-Monsoon-Ledger-2026' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    return secret;
}
const ie14 = (id, entityId, payment = 50000) => ({ id, entityId, role: 'lessee', name: 'Office floor', counterparty: 'Landlord Ltd', currency: 'PKR', assetClass: 'building',
    terms: { commencement: '2021-01-01', termMonths: 120, payment, freqM: 12, timing: 'advance', discountRate: 5 } });

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    cfg = loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 9).toString('base64'), cookieSecure: false, requireMfa: true, maxFailedLogins: 5 });
    app = await buildApp(cfg, { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.aml = (await app.pg.query("INSERT INTO companies(code,name) VALUES ('aml','Allied Marketing') RETURNING id")).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'owner@aml.pk','Owner','superadmin',$2)", [ids.aml, await hashPassword('Temp-Owner-Pass-01')]);
});
test.after(async () => app && app.close());

test('health and engine validation', async () => {
    const r = await call('x', 'GET', '/api/health'); assert.equal(r.status, 200); assert.equal(r.body.engineValidation, '14/14');
});
test('state-changing requests need the anti-forgery header', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@aml.pk', password: 'x' } });
    assert.equal(r.statusCode, 403);
});
test('super administrator first sign-in enforces MFA and password change', async () => {
    let r = await call('owner', 'POST', '/api/auth/login', { email: 'owner@aml.pk', password: 'Temp-Owner-Pass-01' });
    assert.equal(r.body.next, 'mfa_enrol');
    r = await call('owner', 'GET', '/api/leases'); assert.equal(r.status, 401); assert.equal(r.body.error, 'mfa_required');
    const s = (await call('owner', 'POST', '/api/auth/mfa/setup')).body.secret;
    r = await call('owner', 'POST', '/api/auth/mfa/verify', { code: '000000' }); assert.equal(r.status, 401);
    r = await call('owner', 'POST', '/api/auth/mfa/verify', { code: code(s) }); assert.equal(r.status, 200);
    r = await call('owner', 'GET', '/api/leases'); assert.equal(r.status, 403); assert.equal(r.body.error, 'password_change_required');
    r = await call('owner', 'POST', '/api/auth/password', { current: 'Temp-Owner-Pass-01', next: 'password1234567' }); assert.equal(r.status, 400);
    r = await call('owner', 'POST', '/api/auth/password', { current: 'Temp-Owner-Pass-01', next: 'Kite-Monsoon-Ledger-77' }); assert.equal(r.status, 200);
    r = await call('owner', 'GET', '/api/leases'); assert.equal(r.status, 200);
});
test('administration: entities and users', async () => {
    let r = await call('owner', 'POST', '/api/entities', { code: 'AML', name: 'Allied Marketing (Pvt) Ltd', functionalCurrency: 'PKR' }); assert.equal(r.status, 200); ids.e1 = r.body.id;
    r = await call('owner', 'POST', '/api/entities', { code: 'SUB', name: 'Subsidiary', functionalCurrency: 'PKR' }); ids.e2 = r.body.id;
    for (const [k, role, extra] of [['prep', 'preparer', { entityIds: [] }], ['ctl1', 'controller', {}], ['ctl2', 'controller', {}], ['low', 'controller', { approvalLimit: 1000 }], ['view', 'viewer', {}], ['subprep', 'preparer', { entityIds: [] }], ['adm', 'admin', {}]]) {
        r = await call('owner', 'POST', '/api/users', { email: `${k}@aml.pk`, name: `User ${k}`, role, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body));
        ids[k] = r.body.user.id; await onboard(k, `${k}@aml.pk`, r.body.temporaryPassword);
    }
    r = await call('owner', 'PATCH', `/api/users/${ids.subprep}`, { entityIds: [ids.e2] }); assert.equal(r.status, 200); assert.deepEqual(r.body.entityIds, [ids.e2]);
    assert.equal((await call('owner', 'GET', `/api/users`)).body.find(u => u.id === ids.low).approvalLimit, 1000); // patch without fields keeps values
});
test('only a super administrator manages super administrators; last one is protected', async () => {
    let r = await call('adm', 'POST', '/api/users', { email: 'x@aml.pk', name: 'X', role: 'superadmin' }); assert.equal(r.status, 403);
    r = await call('adm', 'GET', '/api/users'); const owner = r.body.find(u => u.role === 'superadmin');
    r = await call('adm', 'PATCH', `/api/users/${owner.id}`, { status: 'disabled' }); assert.equal(r.status, 403);
    r = await call('owner', 'PATCH', `/api/users/${owner.id}`, { role: 'admin' }); assert.equal(r.status, 403); // cannot change own role
    r = await call('view', 'GET', '/api/users'); assert.equal(r.status, 403);
});
test('account locks after repeated failures, with a generic message', async () => {
    for (let i = 0; i < 5; i++) { const r = await call('attacker', 'POST', '/api/auth/login', { email: 'view@aml.pk', password: 'wrong-' + i }); assert.equal(r.status, 401); }
    const r = await call('attacker', 'POST', '/api/auth/login', { email: 'view@aml.pk', password: 'Kite-Monsoon-Ledger-2026' });
    assert.equal(r.status, 401); assert.match(r.body.message, /incorrect, or the account is locked/);
    const u = await call('attacker', 'POST', '/api/auth/login', { email: 'nobody@aml.pk', password: 'x' }); assert.equal(u.body.message, r.body.message);
    await app.pg.query("UPDATE users SET locked_until=NULL WHERE email='view@aml.pk'");
});
test('maker-checker on new leases, role checks, and locking after approval', async () => {
    let r = await call('view', 'POST', '/api/leases', ie14('L-001', ids.e1)); assert.equal(r.status, 403);
    r = await call('prep', 'POST', '/api/leases', ie14('L-001', ids.e1)); assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('prep', 'POST', '/api/leases', { ...ie14('L-BAD', ids.e1), terms: { ...ie14('x', ids.e1).terms, freqM: 2 } }); assert.equal(r.status, 400);
    r = await call('prep', 'POST', '/api/leases/L-001/submit'); assert.equal(r.body.status, 'pending');
    r = await call('prep', 'POST', '/api/leases/L-001/approve'); assert.equal(r.status, 403); // maker has no approve permission
    r = await call('low', 'POST', '/api/leases/L-001/approve'); assert.equal(r.status, 403); assert.match(r.body.message, /limit/);
    r = await call('ctl1', 'POST', '/api/leases/L-001/approve'); assert.equal(r.status, 200); assert.equal(r.body.status, 'active');
    r = await call('prep', 'PUT', '/api/leases/L-001', { ...ie14('L-001', ids.e1), version: 1 }); assert.equal(r.status, 409);
    r = await call('view', 'GET', '/api/leases/L-001'); assert.equal(r.status, 200);
    assert.ok(Math.abs(r.body.measurement.initial.liability - 355391) < 2, 'server computes IFRS 16 IE14 liability');
});
test('segregation: an approver cannot approve what they submitted', async () => {
    await app.pg.query("UPDATE users SET role='admin' WHERE id=$1", [ids.ctl2]); // admins can both prepare and approve
    let r = await call('ctl2', 'POST', '/api/leases', ie14('L-SOD', ids.e1)); assert.equal(r.status, 200);
    await call('ctl2', 'POST', '/api/leases/L-SOD/submit');
    r = await call('ctl2', 'POST', '/api/leases/L-SOD/approve'); assert.equal(r.status, 403); assert.match(r.body.message, /different person/);
    await app.pg.query("UPDATE users SET role='controller' WHERE id=$1", [ids.ctl2]);
});
test('large leases need two distinct approvers', async () => {
    let r = await call('prep', 'POST', '/api/leases', ie14('L-BIG', ids.e1, 20000000)); assert.equal(r.status, 200);
    await call('prep', 'POST', '/api/leases/L-BIG/submit');
    r = await call('ctl1', 'POST', '/api/leases/L-BIG/approve'); assert.equal(r.body.status, 'pending'); assert.equal(r.body.needed, 2);
    r = await call('ctl1', 'POST', '/api/leases/L-BIG/approve'); assert.equal(r.status, 409);
    r = await call('ctl2', 'POST', '/api/leases/L-BIG/approve'); assert.equal(r.body.status, 'active');
});
test('entity restriction hides other entities’ leases', async () => {
    let r = await call('subprep', 'GET', '/api/leases'); assert.equal(r.body.length, 0);
    r = await call('subprep', 'GET', '/api/leases/L-001'); assert.equal(r.status, 404);
    r = await call('subprep', 'POST', '/api/leases', ie14('L-SUB', ids.e1)); assert.equal(r.status, 404);
    r = await call('subprep', 'POST', '/api/leases', ie14('L-SUB', ids.e2)); assert.equal(r.status, 200);
});
test('remeasurement goes through approval and the server measures it (IFRS 16 IE14)', async () => {
    let r = await call('prep', 'POST', '/api/leases/L-001/events', { type: 'reassess-index', effective: '2023-01-01', reason: 'CPI moved from 125 to 135', params: { newPayment: 54000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(Math.abs(r.body.preview.remeasured - 366464) < 2);
    const evId = r.body.event.id;
    r = await call('prep', 'POST', '/api/leases/L-001/events', { type: 'mod-change', effective: '2023-01-01', reason: 'x', params: { newPayment: 1 } }); assert.equal(r.status, 400); // revised rate required
    r = await call('ctl1', 'POST', `/api/events/${evId}/approve`); assert.equal(r.body.status, 'approved');
    r = await call('view', 'GET', '/api/leases/L-001'); const ev = r.body.measurement.events[0];
    assert.ok(Math.abs(ev.adjustment - 27145) < 2);
});
test('period lock blocks back-dated postings unless overridden', async () => {
    let r = await call('owner', 'PUT', '/api/settings/period_lock', { lockedThrough: '2030-12-31' }); assert.equal(r.status, 200);
    r = await call('prep', 'POST', '/api/leases/L-001/payments', { kind: 'scheduled', dueDate: '2022-01-01', amount: 50000, paidDate: '2022-01-01' }); assert.equal(r.status, 409);
    r = await call('owner', 'POST', '/api/leases/L-001/payments', { kind: 'scheduled', dueDate: '2022-01-01', amount: 50000, paidDate: '2022-01-01' }); assert.equal(r.status, 200);
    await call('owner', 'PUT', '/api/settings/period_lock', { lockedThrough: null });
});
test('audit log is append-only and tamper-evident', async () => {
    let r = await call('ctl1', 'GET', '/api/audit/verify'); assert.equal(r.body.ok, true); assert.ok(r.body.checked > 40);
    await assert.rejects(app.pg.query("UPDATE audit_log SET action='x' WHERE id=1"), /append-only/);
    await assert.rejects(app.pg.query('DELETE FROM audit_log WHERE id=1'), /append-only/);
    // Simulate a DBA bypassing the trigger: the hash chain exposes it
    await app.pg.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await app.pg.query("UPDATE audit_log SET detail='{\"edited\":true}' WHERE id=3");
    await app.pg.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    r = await call('ctl1', 'GET', '/api/audit/verify'); assert.equal(r.body.ok, false); assert.equal(r.body.brokenAt, 3);
    r = await call('prep', 'GET', '/api/audit'); assert.equal(r.status, 403);
});
test('disabling a user ends their sessions immediately; logout ends the session', async () => {
    let r = await call('owner', 'PATCH', `/api/users/${ids.view}`, { status: 'disabled' }); assert.equal(r.status, 200);
    r = await call('view', 'GET', '/api/leases'); assert.equal(r.status, 401);
    await call('prep', 'POST', '/api/auth/logout');
    r = await call('prep', 'GET', '/api/leases'); assert.equal(r.status, 401);
});

/* ---- Multiple companies ---- */
test('migration-era data stays in its company; a second company starts empty', async () => {
    const r = await call('owner', 'GET', '/api/auth/me'); assert.equal(r.status, 200);
    assert.equal(r.body.company.code, 'aml'); assert.equal(r.body.user.companyId, ids.aml);
});
test('the same email in two companies: sign-in asks which company, and each account is separate', async () => {
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.beta = (await app.pg.query("INSERT INTO companies(code,name) VALUES ('beta','Beta Retail') RETURNING id")).rows[0].id;
    // Same person, same password in both companies
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'owner@aml.pk','Owner at Beta','superadmin',$2)", [ids.beta, await hashPassword('Kite-Monsoon-Ledger-77')]);
    let r = await call('both', 'POST', '/api/auth/login', { email: 'owner@aml.pk', password: 'Kite-Monsoon-Ledger-77' });
    assert.equal(r.status, 200); assert.equal(r.body.next, 'choose_company');
    assert.deepEqual(r.body.companies.map(c => c.code).sort(), ['aml', 'beta']);
    assert.equal(jar.both, undefined, 'no session until a company is chosen');
    r = await call('beta', 'POST', '/api/auth/login', { email: 'owner@aml.pk', password: 'Kite-Monsoon-Ledger-77', companyId: ids.beta });
    assert.equal(r.body.next, 'mfa_enrol'); assert.equal(r.body.company.code, 'beta');
    const secret = (await call('beta', 'POST', '/api/auth/mfa/setup')).body.secret;
    r = await call('beta', 'POST', '/api/auth/mfa/verify', { code: code(secret) }); assert.equal(r.status, 200);
    r = await call('beta', 'POST', '/api/auth/password', { current: 'Kite-Monsoon-Ledger-77', next: 'Beta-Harbour-Lantern-31' }); assert.equal(r.status, 200);
    // A different password now opens only the Beta account
    r = await call('beta2', 'POST', '/api/auth/login', { email: 'owner@aml.pk', password: 'Beta-Harbour-Lantern-31' });
    assert.equal(r.body.next, 'mfa_verify'); assert.equal(r.body.company.code, 'beta');
});
test('a company sees only its own users, entities, leases, settings and audit log', async () => {
    let r = await call('beta', 'GET', '/api/users'); assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(u => u.name), ['Owner at Beta']);
    r = await call('beta', 'GET', '/api/entities'); assert.deepEqual(r.body, []);
    r = await call('beta', 'GET', '/api/leases'); assert.deepEqual(r.body, []);
    r = await call('beta', 'GET', '/api/leases/L-001'); assert.equal(r.status, 404);
    r = await call('beta', 'GET', '/api/leases/L-001/history'); assert.equal(r.status, 404);
    r = await call('beta', 'PATCH', `/api/users/${ids.prep}`, { name: 'Hijacked' }); assert.equal(r.status, 404);
    r = await call('beta', 'POST', `/api/users/${ids.prep}/reset-password`); assert.equal(r.status, 404);
    r = await call('beta', 'GET', '/api/audit'); assert.ok(r.body.length > 0); assert.ok(r.body.every(a => a.object_id !== 'L-001'));
    // Business keys may repeat across companies
    r = await call('beta', 'POST', '/api/entities', { code: 'AML', name: 'Allied Marketing (Pvt) Ltd', functionalCurrency: 'PKR' }); assert.equal(r.status, 200); ids.betaE = r.body.id;
    r = await call('beta', 'POST', '/api/users', { email: 'prep@aml.pk', name: 'Beta preparer', role: 'preparer' }); assert.equal(r.status, 200);
    r = await call('beta', 'POST', '/api/leases', ie14('L-001', ids.betaE, 99000)); assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('view2', 'GET', '/api/leases/L-001'); // nobody signed in as view2
    assert.equal(r.status, 401);
    r = await call('owner', 'GET', '/api/leases/L-001'); assert.equal(r.body.lease.terms.payment, 50000, 'Allied Marketing’s L-001 is untouched');
    r = await call('beta', 'GET', '/api/leases/L-001'); assert.equal(r.body.lease.terms.payment, 99000);
    // Another company's entity cannot be used
    r = await call('beta', 'POST', '/api/leases', ie14('L-X', ids.e1)); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_entity'); // same answer as an entity that does not exist
    r = await call('beta', 'POST', '/api/users', { email: 'x@beta.pk', name: 'X', role: 'viewer', entityIds: [ids.e1] }); assert.equal(r.status, 400);
    // Settings are per company
    r = await call('beta', 'PUT', '/api/settings/period_lock', { lockedThrough: '2099-12-31' }); assert.equal(r.status, 200);
    r = await call('owner', 'GET', '/api/settings'); assert.equal(r.body.period_lock.lockedThrough, null);
    await call('beta', 'PUT', '/api/settings/period_lock', { lockedThrough: null });
});
test('each company has its own audit chain', async () => {
    let r = await call('beta', 'GET', '/api/audit/verify'); assert.equal(r.body.ok, true); assert.ok(r.body.checked >= 5);
    r = await call('owner', 'GET', '/api/audit/verify'); assert.equal(r.body.ok, false, 'Allied Marketing’s chain was tampered with earlier'); // Beta's is unaffected
});
test('an inactive company cannot sign in, and its open sessions stop working', async () => {
    await app.pg.query("UPDATE companies SET status='inactive' WHERE id=$1", [ids.beta]);
    let r = await call('beta', 'GET', '/api/leases'); assert.equal(r.status, 401); assert.equal(r.body.error, 'company_inactive');
    r = await call('beta3', 'POST', '/api/auth/login', { email: 'owner@aml.pk', password: 'Beta-Harbour-Lantern-31' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'company_inactive');
    r = await call('beta3', 'POST', '/api/auth/login', { email: 'owner@aml.pk', password: 'wrong-password-1' });
    assert.equal(r.status, 401); assert.equal(r.body.error, 'bad_credentials');
    // The other company is unaffected
    r = await call('owner', 'GET', '/api/leases'); assert.equal(r.status, 200);
    await app.pg.query("UPDATE companies SET status='active' WHERE id=$1", [ids.beta]);
    r = await call('beta', 'GET', '/api/leases'); assert.equal(r.status, 200);
});

/* ---- What the web app needs at sign-in ---- */
test('/auth/me lists the permissions; /auth/companies lists the person’s other companies', async () => {
    let r = await call('owner', 'GET', '/api/auth/me');
    assert.ok(r.body.permissions.includes('admin.users')); assert.equal(r.body.company.currency, 'PKR');
    r = await call('owner', 'GET', '/api/auth/companies'); assert.deepEqual(r.body.map(c => [c.code, c.role]), [['beta', 'superadmin']]);
    r = await call('beta', 'GET', '/api/auth/companies'); assert.deepEqual(r.body.map(c => c.code), ['aml']);
    await app.pg.query("UPDATE companies SET status='inactive' WHERE id=$1", [ids.beta]);
    r = await call('owner', 'GET', '/api/auth/companies'); assert.deepEqual(r.body, [], 'inactive companies are not offered');
    await app.pg.query("UPDATE companies SET status='active' WHERE id=$1", [ids.beta]);
    r = await call('nobody', 'GET', '/api/auth/companies'); assert.equal(r.status, 401);
});
test('“keep me signed in” off gives a browser-session cookie', async () => {
    const login = remember => app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { email: 'owner@aml.pk', password: 'Beta-Harbour-Lantern-31', remember } });
    const cookie = r => [].concat(r.headers['set-cookie']).join(';');
    assert.doesNotMatch(cookie(await login(false)), /Max-Age/i);
    assert.match(cookie(await login(true)), /Max-Age=\d+/i);
});
test('a session that ended says why', async () => {
    let r = await call('nobody', 'GET', '/api/auth/me'); assert.equal(r.status, 401); assert.equal(r.body.error, 'unauthenticated');
    await app.pg.query("UPDATE companies SET status='inactive' WHERE id=$1", [ids.beta]);
    r = await call('beta2', 'GET', '/api/auth/me'); assert.equal(r.status, 401); assert.equal(r.body.error, 'company_inactive');
    await app.pg.query("UPDATE companies SET status='active' WHERE id=$1", [ids.beta]);
    await app.pg.query("UPDATE sessions SET last_seen = now() - interval '2 hours' WHERE user_id IN (SELECT id FROM users WHERE company_id=$1)", [ids.beta]);
    r = await call('beta', 'GET', '/api/auth/me'); assert.equal(r.status, 401); assert.equal(r.body.error, 'session_expired');
    r = await call('beta2', 'GET', '/api/leases'); assert.equal(r.body.error, 'session_expired');
    r = await call('view', 'GET', '/api/auth/me'); assert.equal(r.status, 401); assert.equal(r.body.error, 'account_disabled');
    r = await call('owner', 'PATCH', `/api/users/${ids.view}`, { status: 'active' }); assert.equal(r.status, 200);
    r = await call('view', 'GET', '/api/auth/me'); assert.equal(r.body.error, 'session_expired', 'sessions from before do not come back');
});

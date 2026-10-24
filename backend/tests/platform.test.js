// Platform console API: the SaaS operator's sign-in and company management.
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
const code = secret => hotp(secret, timeStep());
const acme = (admins) => ({ name: 'Acme Holdings Ltd', code: 'acme', currency: 'USD', admins });

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    const cfg = loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 7).toString('base64'), cookieSecure: false, requireMfa: true, maxFailedLogins: 5 });
    app = await buildApp(cfg, { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    await app.pg.query("INSERT INTO platform_admins(email,name,password_hash) VALUES ('owner@saas.test','Platform Owner',$1)", [await hashPassword('Temp-Platform-Pass-01')]);
});
test.after(async () => app && app.close());

test('platform owner first sign-in enforces MFA and a new password', async () => {
    let r = await call('owner', 'POST', '/api/platform/auth/login', { email: 'owner@saas.test', password: 'Temp-Platform-Pass-01' });
    assert.equal(r.status, 200); assert.equal(r.body.next, 'mfa_enrol');
    r = await call('owner', 'GET', '/api/platform/companies'); assert.equal(r.status, 401); assert.equal(r.body.error, 'mfa_required');
    r = await call('owner', 'POST', '/api/platform/auth/mfa/setup'); assert.equal(r.status, 200); assert.match(r.body.otpauthUrl, /^otpauth:\/\/totp\//);
    ids.secret = r.body.secret;
    r = await call('owner', 'POST', '/api/platform/auth/mfa/verify', { code: '000000' }); assert.equal(r.status, 401);
    r = await call('owner', 'POST', '/api/platform/auth/mfa/verify', { code: code(ids.secret) }); assert.equal(r.body.next, 'change_password');
    r = await call('owner', 'GET', '/api/platform/companies'); assert.equal(r.status, 403); assert.equal(r.body.error, 'password_change_required');
    r = await call('owner', 'POST', '/api/platform/auth/password', { current: 'Temp-Platform-Pass-01', next: 'Orbit-Cedar-Platform-88' }); assert.equal(r.status, 200);
    r = await call('owner', 'GET', '/api/platform/auth/me'); assert.equal(r.body.admin.email, 'owner@saas.test'); assert.equal(r.body.mfaPassed, true);
    r = await call('owner', 'GET', '/api/platform/companies'); assert.equal(r.status, 200); assert.deepEqual(r.body, []);
});

test('company endpoints need a platform session', async () => {
    let r = await call('nobody', 'GET', '/api/platform/companies'); assert.equal(r.status, 401);
    r = await app.inject({ method: 'POST', url: '/api/platform/companies', payload: acme([{ name: 'A', email: 'a@acme.test' }]) });
    assert.equal(r.statusCode, 403, 'anti-forgery header required');
});

test('adding a company creates its super administrators, first entity and settings', async () => {
    let r = await call('owner', 'POST', '/api/platform/companies', acme([])); assert.equal(r.status, 400);
    r = await call('owner', 'POST', '/api/platform/companies', acme([{ name: 'Sara', email: 'sara@acme.test' }, { name: 'Sara again', email: 'SARA@acme.test' }]));
    assert.equal(r.status, 400); assert.match(r.body.message, /different email/);
    r = await call('owner', 'POST', '/api/platform/companies', { ...acme([{ name: 'Sara Ahmed', email: 'sara@acme.test' }, { name: 'John Smith', email: 'john@acme.test' }]), code: 'Acme' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { company, superAdmins } = r.body;
    ids.acme = company.id; ids.sara = superAdmins[0];
    assert.equal(company.code, 'acme'); assert.equal(company.status, 'active'); assert.equal(company.usersActive, 2); assert.equal(company.leases, 0);
    assert.deepEqual(company.superAdmins.map(a => a.email).sort(), ['john@acme.test', 'sara@acme.test']);
    assert.ok(superAdmins.every(a => a.temporaryPassword && a.temporaryPassword.length >= 12));
    r = await call('owner', 'POST', '/api/platform/companies', { ...acme([{ name: 'X', email: 'x@x.test' }]), name: 'Other name' }); assert.equal(r.status, 409); assert.equal(r.body.error, 'duplicate_code');
    r = await call('owner', 'POST', '/api/platform/companies', { ...acme([{ name: 'X', email: 'x@x.test' }]), code: 'acme2', name: 'acme holdings ltd' }); assert.equal(r.status, 409); assert.equal(r.body.error, 'duplicate_name');
    const ent = (await app.pg.query('SELECT name, functional_currency FROM entities WHERE company_id=$1', [ids.acme])).rows;
    assert.deepEqual(ent, [{ name: 'Acme Holdings Ltd', functional_currency: 'USD' }]);
    r = await call('owner', 'GET', '/api/platform/companies'); assert.equal(r.body.length, 1);
});

test('a new super administrator signs in to their company with the temporary password', async () => {
    let r = await call('sara', 'POST', '/api/auth/login', { email: 'sara@acme.test', password: ids.sara.temporaryPassword });
    assert.equal(r.status, 200); assert.equal(r.body.next, 'mfa_enrol'); assert.equal(r.body.company.code, 'acme');
    const s = (await call('sara', 'POST', '/api/auth/mfa/setup')).body.secret;
    await call('sara', 'POST', '/api/auth/mfa/verify', { code: code(s) });
    r = await call('sara', 'POST', '/api/auth/password', { current: ids.sara.temporaryPassword, next: 'Acme-Willow-Compass-42' }); assert.equal(r.status, 200);
    r = await call('sara', 'GET', '/api/users'); assert.equal(r.status, 200); assert.equal(r.body.length, 2);
    r = await call('sara', 'GET', '/api/entities'); assert.equal(r.body[0].name, 'Acme Holdings Ltd');
    // A company user's session does not open the platform console
    r = await call('sara', 'GET', '/api/platform/companies'); assert.equal(r.status, 401);
    // People the company deletes no longer count for the platform owner
    const john = (await call('sara', 'GET', '/api/users')).body.find(u => u.email === 'john@acme.test');
    r = await call('sara', 'DELETE', `/api/users/${john.id}`); assert.equal(r.status, 200);
    r = await call('owner', 'GET', '/api/platform/companies');
    assert.equal(r.body[0].usersTotal, 1); assert.deepEqual(r.body[0].superAdmins.map(a => a.email), ['sara@acme.test']);
});

test('deactivating a company ends its sessions and blocks sign-in; activating restores it', async () => {
    let r = await call('owner', 'PATCH', `/api/platform/companies/${ids.acme}`, { status: 'inactive' });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'inactive'); assert.ok(r.body.statusChangedAt);
    r = await call('sara', 'GET', '/api/users'); assert.equal(r.status, 401); assert.equal(r.body.error, 'company_inactive', 'the open session is told why');
    r = await call('sara2', 'POST', '/api/auth/login', { email: 'sara@acme.test', password: 'Acme-Willow-Compass-42' }); assert.equal(r.status, 403); assert.equal(r.body.error, 'company_inactive');
    r = await call('owner', 'PATCH', `/api/platform/companies/${ids.acme}`, { status: 'paused' }); assert.equal(r.status, 400);
    r = await call('owner', 'PATCH', `/api/platform/companies/${ids.acme}`, { status: 'active' }); assert.equal(r.body.status, 'active');
    r = await call('sara', 'GET', '/api/users'); assert.equal(r.status, 401); assert.equal(r.body.error, 'session_expired', 'sessions from before do not come back');
    r = await call('sara2', 'POST', '/api/auth/login', { email: 'sara@acme.test', password: 'Acme-Willow-Compass-42' }); assert.equal(r.status, 200); assert.equal(r.body.next, 'mfa_verify');
});

test('platform and company audit chains record the platform owner’s actions', async () => {
    const platform = await verifyAuditChain(app.pg, null); assert.equal(platform.ok, true); assert.ok(platform.checked >= 7);
    const company = await verifyAuditChain(app.pg, ids.acme); assert.equal(company.ok, true);
    const acts = (await app.pg.query('SELECT action FROM audit_log WHERE company_id IS NULL ORDER BY id')).rows.map(r => r.action);
    for (const a of ['platform.auth.mfa_enrolled', 'platform.auth.password_changed', 'company.create', 'company.deactivate', 'company.activate']) assert.ok(acts.includes(a), a);
});

test('platform sign-in locks after repeated failures; logout ends the session', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('x', 'POST', '/api/platform/auth/login', { email: 'owner@saas.test', password: 'wrong-' + i })).status, 401);
    let r = await call('x', 'POST', '/api/platform/auth/login', { email: 'owner@saas.test', password: 'Orbit-Cedar-Platform-88' }); assert.equal(r.status, 401);
    await app.pg.query('UPDATE platform_admins SET locked_until=NULL');
    await call('owner', 'POST', '/api/platform/auth/logout');
    r = await call('owner', 'GET', '/api/platform/companies'); assert.equal(r.status, 401);
});

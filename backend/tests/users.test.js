// User management API: profile fields, extra permissions, deletion that keeps history, resets and unlock.
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
const jar = {}, ids = {}, secrets = {};
async function call(who, method, path, body) {
    const r = await app.inject({ method, url: path, payload: body, headers: { ...H, ...(jar[who] ? { cookie: jar[who] } : {}) } });
    const set = r.headers['set-cookie']; if (set) jar[who] = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const code = secret => hotp(secret, timeStep());
async function onboard(who, email, temp, next = 'Juniper-Atlas-Harbour-19') {
    let r = await call(who, 'POST', '/api/auth/login', { email, password: temp }); assert.equal(r.body.next, 'mfa_enrol', JSON.stringify(r.body));
    secrets[who] = (await call(who, 'POST', '/api/auth/mfa/setup')).body.secret;
    r = await call(who, 'POST', '/api/auth/mfa/verify', { code: code(secrets[who]) }); assert.equal(r.body.next, 'change_password');
    r = await call(who, 'POST', '/api/auth/password', { current: temp, next }); assert.equal(r.status, 200, JSON.stringify(r.body));
}

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 5).toString('base64'), cookieSecure: false, requireMfa: true, maxFailedLogins: 3 }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.co = (await app.pg.query("INSERT INTO companies(code,name) VALUES ('gamma','Gamma Foods') RETURNING id")).rows[0].id;
    ids.ent = (await app.pg.query("INSERT INTO entities(company_id,code,name,functional_currency) VALUES ($1,'G01','Gamma Foods','PKR') RETURNING id", [ids.co])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@gamma.test','Boss','superadmin',$2)", [ids.co, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@gamma.test', 'Temp-Boss-Pass-001');
});
test.after(async () => app && app.close());

test('adding a user: title, entities, extra permissions; temporary password once; last sign-in recorded', async () => {
    let r = await call('boss', 'POST', '/api/users', { email: 'ana@gamma.test', name: 'Ana Silva', title: 'Lease Accountant', role: 'viewer', entityIds: [ids.ent], extraPerms: ['report.export', 'report.export', 'payment.record'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { user, temporaryPassword } = r.body; ids.ana = user.id;
    assert.equal(user.title, 'Lease Accountant'); assert.deepEqual(user.extraPerms.sort(), ['payment.record', 'report.export']); assert.deepEqual(user.entityIds, [ids.ent]);
    assert.equal(user.lastLoginAt, null); assert.equal(user.mustChangePassword, true);
    r = await call('boss', 'POST', '/api/users', { email: 'ANA@gamma.test', name: 'Dup', role: 'viewer' }); assert.equal(r.status, 409); assert.equal(r.body.error, 'duplicate_email');
    r = await call('boss', 'POST', '/api/users', { email: 'x@gamma.test', name: 'X', role: 'viewer', extraPerms: ['fly'] }); assert.equal(r.status, 400);
    await onboard('ana', 'ana@gamma.test', temporaryPassword);
    r = await call('ana', 'GET', '/api/auth/me');
    assert.ok(r.body.permissions.includes('payment.record'), 'extra permission granted'); assert.ok(!r.body.permissions.includes('lease.edit'));
    r = await call('boss', 'GET', '/api/users'); const ana = r.body.find(u => u.id === ids.ana);
    assert.ok(ana.lastLoginAt); assert.equal(ana.mfaEnabled, true);
});

test('editing: email, title, limit and permissions; a new email signs the person in again', async () => {
    let r = await call('boss', 'PATCH', `/api/users/${ids.ana}`, { title: null, approvalLimit: 5000, extraPerms: [] });
    assert.equal(r.status, 200); assert.equal(r.body.title, null); assert.equal(Number(r.body.approvalLimit), 5000);
    r = await call('ana', 'GET', '/api/auth/me'); assert.equal(r.status, 200, 'other changes keep the session'); assert.ok(!r.body.permissions.includes('payment.record'), 'and apply at once');
    r = await call('boss', 'PATCH', `/api/users/${ids.ana}`, { email: 'boss@gamma.test' }); assert.equal(r.body.error, 'duplicate_email');
    r = await call('boss', 'PATCH', `/api/users/${ids.ana}`, { email: 'ana.silva@gamma.test' }); assert.equal(r.status, 200);
    r = await call('ana', 'GET', '/api/auth/me'); assert.equal(r.status, 401);
    r = await call('boss', 'PATCH', `/api/users/${ids.ana}`, { nickname: 'x' }); assert.equal(r.status, 400, 'unknown fields are refused');
    r = await call('boss', 'PATCH', '/api/users/' + (await call('boss', 'GET', '/api/auth/me')).body.user.id, { extraPerms: ['ai.use'] }); assert.equal(r.status, 403);
});

test('a locked account is unlocked by an administrator', async () => {
    for (let i = 0; i < 3; i++) await call('x', 'POST', '/api/auth/login', { email: 'ana.silva@gamma.test', password: 'wrong-' + i });
    let r = await call('boss', 'GET', '/api/users'); assert.ok(r.body.find(u => u.id === ids.ana).lockedUntil);
    r = await call('ana', 'POST', '/api/auth/login', { email: 'ana.silva@gamma.test', password: 'Juniper-Atlas-Harbour-19' }); assert.equal(r.status, 401);
    r = await call('boss', 'POST', `/api/users/${ids.ana}/unlock`); assert.equal(r.status, 200); assert.equal(r.body.user.lockedUntil, null);
    r = await call('ana', 'POST', '/api/auth/login', { email: 'ana.silva@gamma.test', password: 'Juniper-Atlas-Harbour-19' }); assert.equal(r.body.next, 'mfa_verify');
});

test('resetting a password or two-step sign-in ends the person’s sessions', async () => {
    let r = await call('boss', 'POST', `/api/users/${ids.ana}/reset-password`); assert.equal(r.status, 200);
    const temp = r.body.temporaryPassword; assert.ok(temp.length >= 12); assert.equal(r.body.user.mustChangePassword, true);
    r = await call('boss', 'POST', `/api/users/${ids.ana}/reset-mfa`); assert.equal(r.body.user.mfaEnabled, false);
    await onboard('ana', 'ana.silva@gamma.test', temp, 'Saffron-Glacier-Ledger-52');
    r = await call('boss', 'POST', '/api/users/' + (await call('boss', 'GET', '/api/auth/me')).body.user.id + '/reset-password'); assert.equal(r.status, 403, 'not for your own account');
});

test('deleting keeps history, frees the email, and protects the last super administrator', async () => {
    const me = (await call('boss', 'GET', '/api/auth/me')).body.user.id;
    let r = await call('boss', 'DELETE', `/api/users/${me}`); assert.equal(r.status, 403);
    r = await call('boss', 'DELETE', `/api/users/${ids.ana}`); assert.equal(r.status, 200);
    r = await call('ana', 'GET', '/api/auth/me'); assert.equal(r.status, 401);
    r = await call('ana2', 'POST', '/api/auth/login', { email: 'ana.silva@gamma.test', password: 'Saffron-Glacier-Ledger-52' }); assert.equal(r.status, 401);
    r = await call('boss', 'GET', '/api/users'); assert.deepEqual(r.body.map(u => u.email), ['boss@gamma.test']);
    r = await call('boss', 'PATCH', `/api/users/${ids.ana}`, { name: 'x' }); assert.equal(r.status, 404, 'deleted users cannot be edited');
    assert.equal((await app.pg.query('SELECT name FROM users WHERE id=$1', [ids.ana])).rows[0].name, 'Ana Silva', 'the row stays for history');
    r = await call('boss', 'POST', '/api/users', { email: 'ana.silva@gamma.test', name: 'Ana Silva', role: 'preparer' }); assert.equal(r.status, 200, 'the email can be used again');
    // Another super administrator may be deleted (the last one is protected; see api.test.js)
    r = await call('boss', 'POST', '/api/users', { email: 'deputy@gamma.test', name: 'Deputy', role: 'superadmin' }); ids.deputy = r.body.user.id;
    r = await call('boss', 'DELETE', `/api/users/${ids.deputy}`); assert.equal(r.status, 200);
    const acts = (await app.pg.query("SELECT action FROM audit_log WHERE company_id=$1", [ids.co])).rows.map(x => x.action);
    for (const a of ['user.create', 'user.update', 'user.unlock', 'user.reset_password', 'user.reset_mfa', 'user.delete']) assert.ok(acts.includes(a), a);
    assert.equal((await verifyAuditChain(app.pg, ids.co)).ok, true);
});

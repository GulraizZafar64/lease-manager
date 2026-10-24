// REQUIRE_MFA=false: nobody is asked for an authenticator code; keys already set up are kept and used again when it is back on.
// Runs against a real PostgreSQL database (TEST_DATABASE_URL); the schema is rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hotp, timeStep } from '../src/security/totp.js';

const url = process.env.TEST_DATABASE_URL;
const H = { 'x-requested-with': 'lease-manager' };
const key = Buffer.alloc(32, 11).toString('base64');
let on, off, secret, ownerSecret;
const jar = {};
async function call(app, who, method, path, body) {
    const r = await app.inject({ method, url: path, payload: body, headers: { ...H, ...(jar[who] ? { cookie: jar[who] } : {}) } });
    const set = r.headers['set-cookie']; if (set) jar[who] = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    on = await buildApp(loadConfig({ databaseUrl: url, masterKey: key, cookieSecure: false, requireMfa: true }), { logger: false });
    off = await buildApp(loadConfig({ databaseUrl: url, masterKey: key, cookieSecure: false, requireMfa: false }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    const co = (await on.pg.query("INSERT INTO companies(code,name,base_currency) VALUES ('pi','Pi Foods','PKR') RETURNING id")).rows[0].id;
    await on.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'ana@pi.test','Ana','superadmin',$2)", [co, await hashPassword('Temp-Ana-Pass-001')]);
    await on.pg.query("INSERT INTO platform_admins(email,name,password_hash) VALUES ('owner@pi.test','Owner',$1)", [await hashPassword('Temp-Owner-Pass-01')]);
    // Ana and the owner set up two-step sign-in while it is required
    assert.equal((await call(on, 'a', 'POST', '/api/auth/login', { email: 'ana@pi.test', password: 'Temp-Ana-Pass-001' })).body.next, 'mfa_enrol');
    secret = (await call(on, 'a', 'POST', '/api/auth/mfa/setup')).body.secret;
    await call(on, 'a', 'POST', '/api/auth/mfa/verify', { code: hotp(secret, timeStep()) });
    assert.equal((await call(on, 'a', 'POST', '/api/auth/password', { current: 'Temp-Ana-Pass-001', next: 'Saffron-Ledger-Pi-27' })).status, 200);
    assert.equal((await call(on, 'o', 'POST', '/api/platform/auth/login', { email: 'owner@pi.test', password: 'Temp-Owner-Pass-01' })).body.next, 'mfa_enrol');
    ownerSecret = (await call(on, 'o', 'POST', '/api/platform/auth/mfa/setup')).body.secret;
    await call(on, 'o', 'POST', '/api/platform/auth/mfa/verify', { code: hotp(ownerSecret, timeStep()) });
    assert.equal((await call(on, 'o', 'POST', '/api/platform/auth/password', { current: 'Temp-Owner-Pass-01', next: 'Saffron-Ledger-Platform-27' })).status, 200);
});
test.after(async () => { await on?.close(); await off?.close(); });

test('switched off: password only, for people who set up two-step sign-in too', async () => {
    let r = await call(off, 'a2', 'POST', '/api/auth/login', { email: 'ana@pi.test', password: 'Saffron-Ledger-Pi-27' });
    assert.equal(r.body.next, 'done');
    r = await call(off, 'a2', 'GET', '/api/auth/me'); assert.equal(r.body.mfaPassed, true); assert.equal(r.body.user.mfaEnabled, true, 'the key is kept');
    assert.equal((await call(off, 'a2', 'GET', '/api/leases')).status, 200);
    r = await call(off, 'o2', 'POST', '/api/platform/auth/login', { email: 'owner@pi.test', password: 'Saffron-Ledger-Platform-27' });
    assert.equal(r.body.next, 'done');
    assert.equal((await call(off, 'o2', 'GET', '/api/platform/companies')).status, 200);
});

test('switched back on: the code is asked again, from the same authenticator app', async () => {
    let r = await call(on, 'a3', 'POST', '/api/auth/login', { email: 'ana@pi.test', password: 'Saffron-Ledger-Pi-27' });
    assert.equal(r.body.next, 'mfa_verify');
    assert.equal((await call(on, 'a3', 'GET', '/api/leases')).status, 401);
    await new Promise(res => setTimeout(res, 30000 - (Date.now() % 30000) + 200)); // a code not used at set-up
    assert.equal((await call(on, 'a3', 'POST', '/api/auth/mfa/verify', { code: hotp(secret, timeStep()) })).status, 200);
    assert.equal((await call(on, 'a3', 'GET', '/api/leases')).status, 200);
    r = await call(on, 'o3', 'POST', '/api/platform/auth/login', { email: 'owner@pi.test', password: 'Saffron-Ledger-Platform-27' });
    assert.equal(r.body.next, 'mfa_verify');
    assert.equal((await call(on, 'o3', 'POST', '/api/platform/auth/mfa/verify', { code: hotp(ownerSecret, timeStep()) })).status, 200);
});

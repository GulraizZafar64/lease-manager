// Roles API: each company's built-in role changes and custom roles, enforced on every request.
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
    const r = await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Willow-Beacon-Ledger-44' }); assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function addUser(who, email, role) {
    const r = await call('boss', 'POST', '/api/users', { email, name: who, role }); assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[who] = r.body.user.id; await onboard(who, email, r.body.temporaryPassword);
}
const perms = async who => (await call(who, 'GET', '/api/auth/me')).body.permissions;

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    app = await buildApp(loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 3).toString('base64'), cookieSecure: false, requireMfa: true }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    for (const [code, name] of [['delta', 'Delta Mills'], ['omega', 'Omega Trading']]) ids[code] = (await app.pg.query('INSERT INTO companies(code,name) VALUES ($1,$2) RETURNING id', [code, name])).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@delta.test','Boss','superadmin',$2), ($3,'boss@omega.test','Omega Boss','superadmin',$2)", [ids.delta, await hashPassword('Temp-Boss-Pass-001'), ids.omega]);
    await onboard('boss', 'boss@delta.test', 'Temp-Boss-Pass-001');
    await onboard('oboss', 'boss@omega.test', 'Temp-Boss-Pass-001');
    await addUser('adm', 'adm@delta.test', 'admin');
    await addUser('view', 'view@delta.test', 'viewer');
});
test.after(async () => app && app.close());

test('everyone signed in reads the company’s roles; built-in ones come first with their defaults', async () => {
    const r = await call('view', 'GET', '/api/roles'); assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(x => x.id), ['superadmin', 'admin', 'controller', 'preparer', 'treasury', 'auditor', 'viewer']);
    const viewer = r.body.find(x => x.id === 'viewer'); assert.deepEqual(viewer.perms, ['lease.view']); assert.equal(viewer.users, 1); assert.equal(viewer.changed, false);
    assert.equal(r.body[0].perms.length, 18);
});

test('only a super administrator changes roles', async () => {
    let r = await call('adm', 'PUT', '/api/roles/viewer', { perms: ['lease.view', 'report.export'] }); assert.equal(r.status, 403);
    r = await call('view', 'POST', '/api/roles', { label: 'X', perms: [] }); assert.equal(r.status, 403);
    r = await call('boss', 'PUT', '/api/roles/superadmin', { perms: ['lease.view'] }); assert.equal(r.status, 400);
});

test('changing a built-in role applies at once, only in that company, and can be reset', async () => {
    let r = await call('boss', 'PUT', '/api/roles/viewer', { perms: ['report.export'] });
    assert.equal(r.status, 200); assert.deepEqual(r.body.perms.sort(), ['lease.view', 'report.export'], 'lease.view is always kept'); assert.equal(r.body.changed, true); assert.equal(r.body.updatedBy, 'Boss');
    assert.ok((await perms('view')).includes('report.export'), 'the viewer’s open session has it at once');
    r = await call('oboss', 'GET', '/api/roles'); assert.deepEqual(r.body.find(x => x.id === 'viewer').perms, ['lease.view'], 'other companies keep the default');
    r = await call('boss', 'POST', '/api/roles/viewer/reset'); assert.equal(r.body.changed, false);
    assert.ok(!(await perms('view')).includes('report.export'));
    r = await call('boss', 'PUT', '/api/roles/admin', { perms: ['lease.view', 'admin.users'] }); assert.equal(r.status, 200);
    r = await call('adm', 'GET', '/api/leases'); assert.equal(r.status, 200, 'lease.view kept');
    r = await call('adm', 'GET', '/api/audit'); assert.equal(r.status, 403, 'the server enforces the changed role');
    r = await call('boss', 'PUT', '/api/roles/admin', { perms: (await call('oboss', 'GET', '/api/roles')).body.find(x => x.id === 'admin').perms });
    assert.equal(r.body.changed, false, 'saving the defaults is the same as resetting');
});

test('custom roles: create, assign, approve in the policy, rename, delete when unused', async () => {
    let r = await call('boss', 'POST', '/api/roles', { label: 'Regional controller', description: 'Approves for the region', perms: ['approve', 'audit.view'] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); const role = r.body; ids.role = role.id;
    assert.match(role.id, /^r-regional-controller-[0-9a-f]{4}$/); assert.equal(role.custom, true); assert.deepEqual(role.perms.sort(), ['approve', 'audit.view', 'lease.view']);
    r = await call('boss', 'POST', '/api/roles', { label: 'regional CONTROLLER', perms: [] }); assert.equal(r.body.error, 'duplicate_role');
    r = await call('boss', 'POST', '/api/roles', { label: 'Viewer', perms: [] }); assert.equal(r.body.error, 'duplicate_role', 'built-in names are taken');
    r = await call('oboss', 'PATCH', `/api/users/${ids.view}`, { role: ids.role }); assert.equal(r.status, 404);
    r = await call('boss', 'PATCH', `/api/users/${ids.view}`, { role: ids.role }); assert.equal(r.status, 200); assert.equal(r.body.role, ids.role);
    r = await call('view', 'GET', '/api/auth/me'); assert.equal(r.status, 401, 'a new role signs the person in again');
    r = await call('boss', 'POST', '/api/users', { email: 'x@delta.test', name: 'X', role: 'r-nonexistent-0000' }); assert.equal(r.body.error, 'bad_role');
    r = await call('boss', 'POST', '/api/users', { email: 'x@delta.test', name: 'X', role: (await call('oboss', 'POST', '/api/roles', { label: 'Omega only', perms: [] })).body.id }); assert.equal(r.body.error, 'bad_role', 'another company’s role');
    // Approval policy: any role that can approve
    const tier = roles => ({ lease: [{ upTo: null, approvals: 1, roles }] });
    r = await call('boss', 'PUT', '/api/settings/approval_policy', tier(['viewer'])); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_role');
    r = await call('boss', 'PUT', '/api/settings/approval_policy', tier([ids.role, 'controller'])); assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('boss', 'PUT', `/api/roles/${ids.role}`, { label: 'Area controller', perms: ['approve'] }); assert.equal(r.body.label, 'Area controller');
    r = await call('boss', 'DELETE', `/api/roles/${ids.role}`); assert.equal(r.status, 409); assert.match(r.body.message, /1 user has this role/);
    await call('boss', 'PATCH', `/api/users/${ids.view}`, { role: 'viewer' });
    r = await call('boss', 'DELETE', `/api/roles/${ids.role}`); assert.equal(r.status, 409); assert.match(r.body.message, /approval policy/);
    await call('boss', 'PUT', '/api/settings/approval_policy', tier(['controller']));
    r = await call('boss', 'DELETE', `/api/roles/${ids.role}`); assert.equal(r.status, 200);
    r = await call('boss', 'DELETE', '/api/roles/viewer'); assert.equal(r.status, 400);
    const acts = (await app.pg.query('SELECT action FROM audit_log WHERE company_id=$1', [ids.delta])).rows.map(x => x.action);
    for (const a of ['role.create', 'role.update', 'role.reset', 'role.delete']) assert.ok(acts.includes(a), a);
    assert.equal((await verifyAuditChain(app.pg, ids.delta)).ok, true);
});

test('a custom role named in the approval policy approves leases on the server; without approve it cannot', async () => {
    const ent = (await call('boss', 'POST', '/api/entities', { code: 'DM', name: 'Delta Mills', functionalCurrency: 'PKR' })).body.id;
    const role = (await call('boss', 'POST', '/api/roles', { label: 'Plant controller', perms: ['approve'] })).body;
    await addUser('maker', 'maker@delta.test', 'preparer');
    await addUser('checker', 'checker@delta.test', role.id);
    let r = await call('boss', 'PUT', '/api/settings/approval_policy', { lease: [{ upTo: null, approvals: 1, roles: [role.id] }], change: [{ upTo: null, approvals: 1, roles: [role.id] }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lease = id => ({ id, entityId: ent, role: 'lessee', name: 'Warehouse', counterparty: 'Landlord Ltd', currency: 'PKR', assetClass: 'building',
        terms: { commencement: '2025-01-01', termMonths: 36, payment: 100000, freqM: 12, timing: 'advance', discountRate: 10 } });
    for (const id of ['DL-1', 'DL-2']) {
        r = await call('maker', 'POST', '/api/leases', lease(id)); assert.equal(r.status, 200, JSON.stringify(r.body));
        await call('maker', 'POST', `/api/leases/${id}/submit`);
    }
    r = await call('boss', 'POST', '/api/leases/DL-1/approve'); assert.equal(r.status, 403, 'a super administrator not named in the tier'); assert.match(r.body.message, /needs approval by/);
    r = await call('checker', 'POST', '/api/leases/DL-1/approve'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'active');
    // Taking approve away from the role stops its holders at once
    await call('boss', 'PUT', `/api/roles/${role.id}`, { perms: [] });
    r = await call('checker', 'POST', '/api/leases/DL-2/approve'); assert.equal(r.status, 403);
});
